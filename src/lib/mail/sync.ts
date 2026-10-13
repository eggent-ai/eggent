import fs from "fs/promises";
import path from "path";
import { resolveLocalePreference } from "@/i18n/locales";
import { translate } from "@/i18n/messages";
import {
  confirmMailAttachmentCopied,
  downloadMailAttachment,
  fetchPendingMailAttachments,
  type PendingMailAttachment,
} from "@/lib/mail/client";
import { mailEnabled } from "@/lib/mail/config";
import type { MailAttachment, MailMessage } from "@/lib/mail/types";
import { getSettings } from "@/lib/storage/settings-store";

/**
 * This workspace's own copies of the files sent with its messages.
 *
 * The messages service keeps every file of a company's messages; each
 * workspace of a thread takes a copy into its own folder - the orchestrator's
 * files, under "Messages/<the other person>/" in the workspace's language - and
 * tells the service it has one. The service never writes into a workspace: the
 * workspace fetches, when it is awake, which is why a file sent to a sleeping
 * workspace appears there when it next wakes. The person sees the file in the
 * Files panel and on their laptop when the folder is synced, and the agent can
 * read it like any other file.
 *
 * Which file went where is remembered here (data/mail/copies.json), so a
 * message can link its file wherever the copy landed.
 */

const SYNC_KEY = "__EGGENT_MAIL_SYNC__";

function stateFile(): string {
  return path.join(process.cwd(), "data", "mail", "copies.json");
}

/** The orchestrator's files: where the Messages folder is. */
export function mailFilesRoot(): string {
  return path.join(process.cwd(), "data", "projects");
}

interface CopiesState {
  version: 1;
  copies: Record<string, string>;
}

async function readState(): Promise<CopiesState> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(), "utf-8")) as Partial<CopiesState>;
    const copies: Record<string, string> = {};
    for (const [id, relative] of Object.entries(parsed.copies || {})) {
      if (typeof relative === "string" && relative) copies[id] = relative;
    }
    return { version: 1, copies };
  } catch {
    return { version: 1, copies: {} };
  }
}

async function writeState(state: CopiesState): Promise<void> {
  const file = stateFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await fs.rename(temporary, file);
}

/**
 * A name that stays one name in a folder: no separators, nothing a file system
 * reads specially, not empty and not so long that a folder cannot hold it.
 */
export function safeMailSegment(raw: string, fallback: string): string {
  let name = String(raw || "").normalize("NFC").replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, "_").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (!name) name = fallback;
  if (name.length > 100) {
    const ext = path.extname(name).slice(0, 16);
    name = `${name.slice(0, 100 - ext.length)}${ext}`;
  }
  return name;
}

/** "Messages" in the workspace's language: where the copies go. */
export async function mailFolderName(): Promise<string> {
  const settings = await getSettings().catch(() => null);
  const locale = resolveLocalePreference(settings?.general?.language, process.env.EGGENT_DEFAULT_LANGUAGE || null);
  return safeMailSegment(translate(locale, "mail.folderName"), "Messages");
}

/** "report.pdf", then "report (2).pdf": a copy never replaces a file that is already there. */
async function writeNew(dir: string, name: string, data: Buffer): Promise<string> {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let attempt = 1; attempt <= 200; attempt += 1) {
    const candidate = attempt === 1 ? name : `${stem} (${attempt})${ext}`;
    try {
      await fs.writeFile(path.join(dir, candidate), data, { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not find a free name for ${name}.`);
}

async function copyOne(attachment: PendingMailAttachment, folder: string, state: CopiesState): Promise<boolean> {
  const known = state.copies[attachment.id];
  if (known) {
    // Copied before, and only the service was not told: tell it now.
    await confirmMailAttachmentCopied(attachment.id);
    return false;
  }
  const file = await downloadMailAttachment(attachment.id);
  const contactDir = safeMailSegment(attachment.contactName, attachment.contactId);
  const dir = path.join(mailFilesRoot(), folder, contactDir);
  await fs.mkdir(dir, { recursive: true });
  const written = await writeNew(dir, safeMailSegment(file.name || attachment.name, "file"), file.data);
  state.copies[attachment.id] = [folder, contactDir, written].join("/");
  await writeState(state);
  await confirmMailAttachmentCopied(attachment.id);
  return true;
}

/**
 * Takes a copy of every file of this workspace's threads that it does not
 * have yet. One sync at a time in this process; a second caller waits for the
 * one running rather than downloading the same files twice.
 */
export async function syncMailAttachments(): Promise<{ copied: number; failed: number }> {
  if (!mailEnabled()) return { copied: 0, failed: 0 };
  const holder = globalThis as typeof globalThis & { [SYNC_KEY]?: Promise<{ copied: number; failed: number }> };
  if (holder[SYNC_KEY]) return await holder[SYNC_KEY];
  const run = (async () => {
    const pending = await fetchPendingMailAttachments();
    if (!pending.length) return { copied: 0, failed: 0 };
    const folder = await mailFolderName();
    const state = await readState();
    let copied = 0;
    let failed = 0;
    for (const attachment of pending) {
      try {
        if (await copyOne(attachment, folder, state)) copied += 1;
      } catch (error) {
        failed += 1;
        console.warn(`[mail] could not copy ${attachment.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return { copied, failed };
  })();
  holder[SYNC_KEY] = run;
  try {
    return await run;
  } finally {
    if (holder[SYNC_KEY] === run) delete holder[SYNC_KEY];
  }
}

/** Where this workspace's copy of each file is, relative to the orchestrator's files. */
export async function mailCopies(): Promise<Record<string, string>> {
  return (await readState()).copies;
}

/** The messages, each file carrying where its copy is here when there is one that still exists. */
export async function withLocalCopies<T extends Pick<MailMessage, "attachments">>(messages: T[]): Promise<T[]> {
  const copies = await mailCopies();
  const out: T[] = [];
  for (const message of messages) {
    const attachments: MailAttachment[] = [];
    for (const attachment of message.attachments) {
      const relative = copies[attachment.id];
      const exists = relative ? await fs.stat(path.join(mailFilesRoot(), relative)).then((stat) => stat.isFile(), () => false) : false;
      attachments.push({ ...attachment, localPath: exists ? relative : null });
    }
    out.push({ ...message, attachments });
  }
  return out;
}

/** Whether any file of these messages has no copy here yet. */
export function lacksCopies(messages: Array<Pick<MailMessage, "attachments">>): boolean {
  return messages.some((message) => message.attachments.some((attachment) => !attachment.localPath));
}

/**
 * Keeps the copies coming while the workspace is up: shortly after boot, then
 * every couple of minutes. A screen that opens a thread also asks for a sync,
 * so a file someone is looking at does not wait for the next round.
 */
export function startMailSync(): void {
  if (!mailEnabled()) return;
  const KEY = "__EGGENT_MAIL_SYNC_TIMER__";
  const holder = globalThis as typeof globalThis & { [KEY]?: boolean };
  if (holder[KEY]) return;
  holder[KEY] = true;
  const tick = () => {
    syncMailAttachments()
      .then((result) => {
        if (result.copied || result.failed) console.log(`[mail] files copied: ${result.copied}${result.failed ? `, failed: ${result.failed}` : ""}`);
      })
      .catch((error) => console.warn(`[mail] sync: ${error instanceof Error ? error.message : error}`));
  };
  const first = setTimeout(tick, 20_000);
  (first as { unref?: () => void }).unref?.();
  const timer = setInterval(tick, 2 * 60_000);
  (timer as { unref?: () => void }).unref?.();
}
