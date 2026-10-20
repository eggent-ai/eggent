import fs from "node:fs/promises";
import path from "node:path";
import { versionRetention, versionsAvailable, versionsEnabled, versionsSwitchedOn } from "@/lib/files/versions/config";
import { checkTracked, versionTargetFor, type VersionTarget } from "@/lib/files/versions/capture";
import { comparisonOf } from "@/lib/files/versions/rules";
import { historyCapBytes } from "@/lib/files/versions/service";
import { getVersionStore } from "@/lib/files/versions/store";
import { extractVersionText } from "@/lib/files/versions/text";
import type { FileHistoryView, VersionInfo, VersionTextView, VersionUsageView } from "@/lib/files/versions/shape";

/**
 * What the history routes answer, kept out of the routes so the agent's own
 * command and the tests read the same thing the screen does.
 */

const CHAT_ID = /^[A-Za-z0-9_-]{1,100}$/;
const TITLE_TTL_MS = 10 * 60_000;
// A chat's title is near the start of its file; the file itself can be tens of megabytes.
const TITLE_READ_BYTES = 64 * 1024;
const titles = new Map<string, { at: number; title: string | null }>();

/** A chat's title for a version made in it, read from the start of its file rather than by loading the chat. */
async function chatTitle(chatId: string): Promise<string | null> {
  if (!CHAT_ID.test(chatId)) return null;
  const known = titles.get(chatId);
  if (known && Date.now() - known.at < TITLE_TTL_MS) return known.title;
  let title: string | null = null;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(path.join(process.cwd(), "data", "chats", `${chatId}.json`), "r");
    const buffer = Buffer.alloc(TITLE_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TITLE_READ_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const match = /"title"\s*:\s*("(?:[^"\\]|\\.){0,2000}")/.exec(head);
    if (match) {
      const parsed = JSON.parse(match[1]) as unknown;
      if (typeof parsed === "string" && parsed.trim()) title = parsed.trim().slice(0, 200);
    }
  } catch {
    // Deleted, never here, or a title past the start of the file: the version keeps its author without a name.
  } finally {
    await handle?.close().catch(() => undefined);
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
  // the newest version on screen is what the file holds - or, when what it
  // holds could not be kept, the screen is told so.
  let unkept: FileHistoryView["unkept"];
  if (enabled && (await store.journal(target.key))) {
    const outcome = await checkTracked(target.key).catch(() => undefined);
    if (outcome === "too-large" || outcome === "unreadable") unkept = outcome;
  }
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
      ...(unkept ? { unkept } : {}),
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
    capBytes: await historyCapBytes(),
    retention: versionRetention(),
  };
}
