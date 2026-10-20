import fs from "node:fs/promises";
import path from "node:path";
import { versionRetention, versionsAvailable, versionsEnabled, versionsSwitchedOn } from "@/lib/files/versions/config";
import { checkTracked, versionTargetFor, type VersionTarget } from "@/lib/files/versions/capture";
import { comparisonOf } from "@/lib/files/versions/rules";
import { getVersionStore } from "@/lib/files/versions/store";
import { extractVersionText } from "@/lib/files/versions/text";
import type { FileHistoryView, VersionInfo, VersionTextView, VersionUsageView } from "@/lib/files/versions/shape";

/**
 * What the history routes answer, kept out of the routes so the agent's own
 * command and the tests read the same thing the screen does.
 */

const CHAT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TITLE_TTL_MS = 60_000;
const titles = new Map<string, { at: number; title: string | null }>();

/** A chat's title for a version made in it, without loading the whole chat into the app. */
async function chatTitle(chatId: string): Promise<string | null> {
  if (!CHAT_ID.test(chatId)) return null;
  const known = titles.get(chatId);
  if (known && Date.now() - known.at < TITLE_TTL_MS) return known.title;
  let title: string | null = null;
  try {
    const raw = await fs.readFile(path.join(process.cwd(), "data", "chats", `${chatId}.json`), "utf8");
    const parsed = JSON.parse(raw) as { title?: unknown };
    title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 200) : null;
  } catch {
    // Deleted, or never here: the version keeps its author without a name.
  }
  if (titles.size > 500) titles.clear();
  titles.set(chatId, { at: Date.now(), title });
  return title;
}

export async function historyOf(projectId: string, filePath: string): Promise<{ target: VersionTarget | null; view: FileHistoryView }> {
  const retention = versionRetention();
  const enabled = await versionsEnabled();
  const target = await versionTargetFor(projectId, filePath);
  if (!target) {
    return { target: null, view: { enabled, versioned: false, comparison: "none", versions: [], bytes: 0, retention } };
  }
  const store = getVersionStore();
  // A change made elsewhere since the last look is put in its place first, so
  // the newest version on screen is what the file holds.
  if (enabled && (await store.journal(target.key))) await checkTracked(target.key).catch(() => undefined);
  const journal = await store.journal(target.key);
  const versions: VersionInfo[] = [];
  for (const entry of [...(journal?.versions ?? [])].reverse()) {
    const { sha: _sha, ...info } = entry;
    void _sha;
    const title = info.by.chat ? await chatTitle(info.by.chat) : null;
    versions.push(title ? { ...info, chatTitle: title } : info);
  }
  return {
    target,
    view: {
      enabled,
      versioned: true,
      comparison: comparisonOf(target.name),
      versions,
      bytes: journal ? await store.historyBytes(target.key) : 0,
      retention,
    },
  };
}

export async function versionText(target: VersionTarget, n: number, labels: { slide: string }): Promise<VersionTextView | null> {
  const store = getVersionStore();
  const journal = await store.journal(target.key);
  const entry = journal?.versions.find((candidate) => candidate.n === n);
  if (!entry) return null;
  if (entry.deleted) return { n, kind: "none", text: "", deleted: true };
  const content = await store.content(target.key, n);
  if (!content) return null;
  const extracted = await extractVersionText(target.name, content, labels);
  return { n, kind: extracted.kind, text: extracted.text, ...(extracted.truncated ? { truncated: true } : {}) };
}

export async function versionUsage(): Promise<VersionUsageView> {
  const usage = await getVersionStore().usage();
  return {
    available: versionsAvailable(),
    enabled: await versionsSwitchedOn(),
    ...usage,
    retention: versionRetention(),
  };
}
