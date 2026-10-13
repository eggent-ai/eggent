import fs from "fs/promises";
import path from "path";
import { pathIsSensitive } from "@/lib/files/zip-walk";
import type { MailFileUpload } from "@/lib/mail/client";
import type { MailContact } from "@/lib/mail/types";
import { squashName } from "@/lib/pi/project-mention";

/**
 * What goes out with a message from this workspace: the person it is for, and
 * the files of this workspace it carries.
 */

export const MAIL_MAX_FILES = 5;
export const MAIL_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** A contact by id, or by name the way people write it: "Ann", "ann ivanova", one word of it. */
export function resolveMailContact(contacts: MailContact[], wanted: string): { contact: MailContact } | { error: string } {
  const raw = (wanted || "").trim();
  if (!raw) return { error: "Say whom to write to: an id or a name from contacts." };
  const byId = contacts.find((contact) => contact.id === raw);
  if (byId) return { contact: byId };
  const key = squashName(raw);
  const exact = contacts.filter((contact) => squashName(contact.name) === key);
  if (exact.length === 1) return { contact: exact[0] };
  const starts = contacts.filter((contact) => {
    const words = contact.name.split(/\s+/).map((word) => squashName(word));
    return squashName(contact.name).startsWith(key) || words.includes(key);
  });
  if (starts.length === 1) return { contact: starts[0] };
  const names = contacts.map((contact) => `${contact.name} (${contact.id})`).join(", ") || "nobody";
  return {
    error: starts.length > 1 || exact.length > 1
      ? `More than one person fits "${raw}": ${names}. Ask which one, or use the id.`
      : `Nobody called "${raw}" can be written to. The contacts are: ${names}.`,
  };
}

/**
 * Files of this workspace to send: each must be a plain file inside the
 * workspace's data folder, not one that holds credentials, and within the size
 * a message takes. Relative paths are read from the folder the run works in.
 */
export async function readFilesForMail(
  paths: string[],
  options: { cwd?: string } = {}
): Promise<{ files: MailFileUpload[] } | { error: string }> {
  if (paths.length > MAIL_MAX_FILES) return { error: `At most ${MAIL_MAX_FILES} files go with one message.` };
  const dataDir = await fs.realpath(path.join(process.cwd(), "data")).catch(() => path.join(process.cwd(), "data"));
  const base = options.cwd || path.join(process.cwd(), "data", "projects");
  const files: MailFileUpload[] = [];
  for (const raw of paths) {
    const given = String(raw || "").trim();
    if (!given) continue;
    const resolved = path.resolve(base, given);
    const real = await fs.realpath(resolved).catch(() => null);
    const relative = real ? path.relative(dataDir, real) : "";
    if (!real || relative.startsWith("..") || path.isAbsolute(relative)) {
      return { error: `${given} is not a file of this workspace.` };
    }
    if (pathIsSensitive(relative)) return { error: `${given} holds credentials and is not sent.` };
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isFile()) return { error: `${given} is not a file.` };
    if (stat.size > MAIL_MAX_FILE_BYTES) return { error: `${given} is larger than ${MAIL_MAX_FILE_BYTES / 1024 / 1024} MB.` };
    files.push({ name: path.basename(real), data: await fs.readFile(real) });
  }
  return { files };
}
