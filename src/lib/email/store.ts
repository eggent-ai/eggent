import { constants as fsConstants } from "fs";
import fs from "fs/promises";
import path from "path";
import type { EmailSummary } from "@/lib/email/types";

/**
 * The workspace's own copy of its mail, under data/email/:
 * - index.json: the letters the service listed, newest kept, and how far the
 *   sync has read;
 * - files/<letter id>/<n>-<name>: a letter's files, fetched when it is read;
 * - sent.jsonl: what a self-hosted workspace sent through its own server.
 *
 * Everything written here was named by somebody outside: a sender chose the
 * file names and the service passes them on. So a name is cleaned to one
 * plain file name before it is used, every folder on the way is checked not to
 * be a link, and files are opened without following one - a link planted under
 * data/email cannot turn a letter's file into a write somewhere else.
 */

const INDEX_KEEP = 500;
const ID = /^\d{1,15}$/;
const INVISIBLE = /[\u0000-\u001f\u007f­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function emailStoreRoot(): string {
  return path.join(process.cwd(), "data", "email");
}

/** One plain file name: no folders, nothing invisible, no leading dots, at most 120 characters. */
export function safeFileName(raw: unknown, index: number): string {
  let name = String(raw ?? "")
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s_]+/, "")
    .replace(/[.\s]+$/, "");
  if (!name || /^_+$/.test(name)) name = `attachment-${index + 1}`;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if ([...name].length > 120) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
    name = `${[...name.slice(0, name.length - extension.length)].slice(0, 120 - extension.length).join("")}${extension}`;
  }
  return name;
}

/** Makes each folder of `parts` under the store, refusing any that is a link. */
async function folderInside(parts: string[]): Promise<string> {
  let current = emailStoreRoot();
  await fs.mkdir(path.dirname(current), { recursive: true });
  for (const part of ["", ...parts]) {
    if (part) {
      if (part === "." || part === ".." || part.includes("/") || part.includes("\\")) throw new Error(`Not a folder name: ${part}`);
      current = path.join(current, part);
    }
    const stat = await fs.lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error(`${path.relative(process.cwd(), current)} is a link; nothing is written through it.`);
    if (!stat) await fs.mkdir(current, { mode: 0o700 });
    else if (!stat.isDirectory()) throw new Error(`${path.relative(process.cwd(), current)} is not a folder.`);
  }
  return current;
}

async function writeNoFollow(file: string, data: Buffer | string, flags: number): Promise<void> {
  const handle = await fs.open(file, flags | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** A letter's file, saved under files/<id>/ and named by its number and its cleaned name. Its absolute path. */
export async function saveLetterFile(letterId: number, n: number, rawName: unknown, data: Buffer): Promise<string> {
  const id = String(Math.floor(letterId));
  if (!ID.test(id) || !Number.isInteger(n) || n < 0 || n > 99) throw new Error("Not a letter's file.");
  const folder = await folderInside(["files", id]);
  const file = path.join(folder, `${n + 1}-${safeFileName(rawName, n)}`);
  if (path.dirname(file) !== folder) throw new Error("Not a file name.");
  const existing = await fs.lstat(file).catch(() => null);
  if (existing?.isFile() && existing.size === data.length) return file;
  if (existing && !existing.isFile()) throw new Error(`${path.basename(file)} is not a plain file; it is left alone.`);
  await writeNoFollow(file, data, fsConstants.O_CREAT | fsConstants.O_TRUNC);
  return file;
}

interface IndexFile {
  version: 1;
  cursor: number;
  messages: EmailSummary[];
}

async function readIndex(): Promise<IndexFile> {
  try {
    const stat = await fs.lstat(path.join(emailStoreRoot(), "index.json"));
    if (!stat.isFile()) return { version: 1, cursor: 0, messages: [] };
    const parsed = JSON.parse(await fs.readFile(path.join(emailStoreRoot(), "index.json"), "utf8")) as Partial<IndexFile>;
    return {
      version: 1,
      cursor: Number.isFinite(parsed.cursor) ? Number(parsed.cursor) : 0,
      messages: Array.isArray(parsed.messages) ? parsed.messages.filter((entry) => entry && Number.isFinite(entry.id)) : [],
    };
  } catch {
    return { version: 1, cursor: 0, messages: [] };
  }
}

async function writeIndex(index: IndexFile): Promise<void> {
  const folder = await folderInside([]);
  const temp = path.join(folder, `index.json.${process.pid}.${Date.now()}.tmp`);
  await writeNoFollow(temp, `${JSON.stringify(index)}\n`, fsConstants.O_CREAT | fsConstants.O_EXCL);
  await fs.rename(temp, path.join(folder, "index.json"));
}

/** Adds what the service listed, newest kept; the cursor only moves forward. */
export async function rememberLetters(letters: EmailSummary[], cursor?: number): Promise<void> {
  const index = await readIndex();
  const byId = new Map(index.messages.map((entry) => [entry.id, entry]));
  for (const letter of letters) byId.set(letter.id, letter);
  index.messages = [...byId.values()].sort((a, b) => b.id - a.id).slice(0, INDEX_KEEP);
  if (typeof cursor === "number" && cursor > index.cursor) index.cursor = cursor;
  await writeIndex(index);
}

export async function syncCursor(): Promise<number> {
  return (await readIndex()).cursor;
}

export async function rememberedLetters(): Promise<EmailSummary[]> {
  return (await readIndex()).messages;
}

/** What a self-hosted workspace sent, one line a letter. */
export async function logSentLetter(entry: { to: string[]; subject: string; at: string; messageId: string; files: string[] }): Promise<void> {
  const folder = await folderInside([]);
  await writeNoFollow(path.join(folder, "sent.jsonl"), `${JSON.stringify(entry)}\n`, fsConstants.O_CREAT | fsConstants.O_APPEND);
}

export async function sentLetters(limit = 30): Promise<Array<{ to: string[]; subject: string; at: string; messageId: string; files: string[] }>> {
  const file = path.join(emailStoreRoot(), "sent.jsonl");
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile()) return [];
  const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
  return lines.slice(-limit).reverse().flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
