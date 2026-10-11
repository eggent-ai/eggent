import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isSecretFileName, planZip, ZipLimitError } from "@/lib/files/zip-walk";
import { projectFolderIsLink, workDirOrNull } from "@/lib/files/workspace-root";
import {
  looksLikePhoto,
  resolveTelegramDestination,
  sendTelegramDocument,
  sendTelegramPhoto,
  type TelegramDestination,
} from "@/lib/telegram/outbound";
import { afterTelegramDelivery } from "@/lib/telegram/conversation";
import { zipStream } from "@/lib/files/zip-writer";

/**
 * Sending a file the workspace holds to the person's own Telegram chat.
 *
 * Two doors lead here - the button under an answer in the browser, and the
 * /files command in Telegram - and both have to agree on what may be sent: a
 * plain file inside the folder it is named in, never a link out of it and never
 * a file that holds credentials. The person asked, so the file goes to their own
 * chat and nowhere else; naming another destination is not offered here.
 */

export const TELEGRAM_FILE_MAX_BYTES = 45 * 1024 * 1024;

export type SendFileOutcome =
  | { ok: true; name: string; size: number; sentAs: "photo" | "document" }
  | { ok: false; reason: "no-destination" | "not-found" | "too-large" | "failed"; error?: string };

export interface RunDestination {
  chatId: string | number;
  botToken?: string;
}

export async function resolveWorkspaceFile(
  project: string,
  relativePath: string
): Promise<{ absolute: string; name: string; size: number } | null> {
  const folder = workDirOrNull(project);
  if (!folder || (await projectFolderIsLink(project))) return null;
  const workDir = path.resolve(folder);
  const absolute = path.resolve(workDir, relativePath);
  if (absolute === workDir || !absolute.startsWith(workDir + path.sep)) return null;
  try {
    const stat = await fs.lstat(absolute);
    // A file with a second name somewhere else may be a door to a file that is not in this folder.
    if (!stat.isFile() || stat.nlink > 1) return null;
    const [realWork, realFile] = await Promise.all([fs.realpath(workDir), fs.realpath(absolute)]);
    if (!realFile.startsWith(realWork + path.sep)) return null;
    const name = path.basename(absolute);
    if (isSecretFileName(name)) return null;
    return { absolute, name, size: stat.size };
  } catch {
    return null;
  }
}

// O_NOFOLLOW is missing where there are no such links to follow.
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * The bytes of a file, read through the handle it was checked on. The path was
 * judged a moment ago; a link put in its place since is not followed.
 */
async function readPlainFile(absolute: string): Promise<Buffer | null> {
  let handle;
  try {
    handle = await fs.open(absolute, OPEN_FLAGS);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1 || info.size > TELEGRAM_FILE_MAX_BYTES) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function sendWorkspaceFileToTelegram(input: {
  project: string;
  path: string;
  /** The chat the person is in, so an answer from Telegram continues there. */
  chatId?: string;
  /** The chat this request arrived from, when it arrived from Telegram. */
  run?: RunDestination | null;
  /** Already worked out by a caller sending several files. */
  destination?: TelegramDestination | null;
}): Promise<SendFileOutcome> {
  const file = await resolveWorkspaceFile(input.project, input.path);
  if (!file) return { ok: false, reason: "not-found" };
  if (file.size > TELEGRAM_FILE_MAX_BYTES) return { ok: false, reason: "too-large" };
  const destination = input.destination ?? (await resolveTelegramDestination(input.run ?? null));
  if (!destination) return { ok: false, reason: "no-destination" };

  const buffer = await readPlainFile(file.absolute);
  if (!buffer) return { ok: false, reason: "not-found" };
  const payload = { buffer, name: file.name };
  const asPhoto = looksLikePhoto(file.name);
  const result = asPhoto ? await sendTelegramPhoto(destination, payload) : await sendTelegramDocument(destination, payload);
  if (!result.success) return { ok: false, reason: "failed", error: result.error };
  if (input.chatId) await afterTelegramDelivery({ destination, result, chatId: input.chatId });
  return { ok: true, name: file.name, size: file.size, sentAs: asPhoto ? "photo" : "document" };
}

/** What the relay carries as a document; an archive bigger than this is not offered to Telegram. */
const ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Several files as one archive, for when sending them one by one would be a
 * burst of messages. The archive is made in memory, so it is bounded by what
 * the relay carries.
 */
export async function sendWorkspaceFilesAsArchive(input: {
  project: string;
  paths: string[];
  chatId?: string;
  run?: RunDestination | null;
}): Promise<SendFileOutcome> {
  const destination = await resolveTelegramDestination(input.run ?? null);
  if (!destination) return { ok: false, reason: "no-destination" };
  const folder = workDirOrNull(input.project);
  if (!folder || (await projectFolderIsLink(input.project))) return { ok: false, reason: "not-found" };
  let plan;
  try {
    plan = await planZip(path.resolve(folder), input.paths, { maxBytes: ARCHIVE_MAX_BYTES * 2 });
  } catch (error) {
    if (error instanceof ZipLimitError && error.kind === "bytes") return { ok: false, reason: "too-large" };
    return { ok: false, reason: "not-found" };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of zipStream(plan.files, { root: plan.root })) {
    size += (chunk as Buffer).length;
    if (size > ARCHIVE_MAX_BYTES) return { ok: false, reason: "too-large" };
    chunks.push(chunk as Buffer);
  }
  const result = await sendTelegramDocument(destination, { buffer: Buffer.concat(chunks), name: "files.zip" });
  if (!result.success) return { ok: false, reason: "failed", error: result.error };
  if (input.chatId) await afterTelegramDelivery({ destination, result, chatId: input.chatId });
  return { ok: true, name: "files.zip", size, sentAs: "document" };
}
