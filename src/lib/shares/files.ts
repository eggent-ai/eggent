import fs from "node:fs/promises";
import path from "node:path";
import { absoluteInScope, keyOfFile } from "@/lib/files/project-keys";
import { captureBefore } from "@/lib/files/versions/capture";
import { pathIsSensitive } from "@/lib/files/zip-walk";
import { sharesEnabled } from "@/lib/shares/config";
import { fetchShareForKey, shareFileWith } from "@/lib/shares/client";
import { SHARE_MAX_FILE_BYTES, type FileShareStatus, type ShareRole, type ShareView } from "@/lib/shares/types";
import { watchSharedKey } from "@/lib/shares/watch";

/**
 * One of this workspace's own files and who it is shared with.
 *
 * A file is named by its path under the projects folder (project-keys.ts). It
 * is never sent anywhere: the service reads it from this workspace's folder
 * for the people it is shared with. What is checked here first is what would
 * only be refused there - a credential file, a file that is not there or is
 * too large - so the person is told at once.
 */

export type ShareFailure = "outside" | "sensitive" | "missing" | "notFile" | "tooLarge";

async function ownFile(absolute: string): Promise<{ key: string; name: string } | { error: ShareFailure }> {
  const key = await keyOfFile(absolute);
  if (!key) return { error: "outside" };
  if (pathIsSensitive(key)) return { error: "sensitive" };
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) return { error: "missing" };
  if (!stat.isFile()) return { error: "notFile" };
  if (stat.size > SHARE_MAX_FILE_BYTES) return { error: "tooLarge" };
  return { key, name: path.basename(absolute) };
}

/** A file of this workspace and its share, for the file's own screen. */
export async function fileShareStatus(projectId: string, filePath: string): Promise<{ status: FileShareStatus } | { error: "outside" }> {
  const absolute = absoluteInScope(projectId, filePath);
  const key = absolute ? await keyOfFile(absolute) : null;
  if (!absolute || !key) return { error: "outside" };
  const stat = await fs.lstat(absolute).catch(() => null);
  const current = {
    exists: Boolean(stat?.isFile()),
    tooLarge: Boolean(stat && stat.size > SHARE_MAX_FILE_BYTES),
    sensitive: pathIsSensitive(key),
  };
  if (!sharesEnabled()) return { status: { enabled: false, share: null, current, maxBytes: SHARE_MAX_FILE_BYTES } };
  const share = current.sensitive ? null : await fetchShareForKey(key);
  watchSharedKey(key, Boolean(share));
  return { status: { enabled: true, share, current, maxBytes: SHARE_MAX_FILE_BYTES } };
}

/**
 * Shares a file of this workspace; the list given is everybody who has it from
 * now on. Before anybody may change it, what it holds is kept in its history:
 * a colleague's change is written by the host, which the history only sees
 * happen, and a file whose history had not begun would lose what it held.
 */
export async function shareOwnFile(input: { absolute: string; people: Array<{ id: string; role: ShareRole }> }): Promise<{ share: ShareView } | { error: ShareFailure }> {
  const file = await ownFile(input.absolute);
  if ("error" in file) return file;
  if (input.people.some((person) => person.role === "edit")) await captureBefore(input.absolute).catch(() => undefined);
  const share = await shareFileWith({ key: file.key, fileName: file.name, people: input.people });
  watchSharedKey(file.key, true);
  return { share };
}
