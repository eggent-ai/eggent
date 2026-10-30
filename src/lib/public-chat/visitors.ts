import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Who is writing on a public link, and which conversations are theirs.
 *
 * A visitor gives a name and an email. Nobody has confirmed that email, so on
 * its own it proves nothing: anyone can type anyone's address. What gives a
 * browser a visitor's conversations is therefore a key, kept in a cookie the
 * page's scripts cannot read and stored here only as its hash:
 *
 * - An address seen for the first time starts a visitor, and the browser that
 *   typed it holds the key. Its conversations come back after a refresh.
 * - The same address from another browser gets nothing until it proves the
 *   address with a one-time code sent to it. Proving it gives that browser a
 *   key and takes the keys away from every browser that never proved it, since
 *   whoever typed the address first may not be its owner.
 * - An address nobody can send a code to (a workspace without the mail) starts
 *   a visitor of its own instead: nothing is joined to what somebody else typed.
 */

export interface VisitorKey {
  hash: string;
  createdAt: string;
}

export interface VisitorRecord {
  id: string;
  name: string;
  email: string;
  /** When the address was proved with a code; null while it is only what was typed. */
  confirmedAt: string | null;
  createdAt: string;
  keys: VisitorKey[];
  conversations: Array<{ id: string; createdAt: string }>;
  code?: { hash: string; expiresAt: string; attempts: number; sentAt: string };
}

interface VisitorFile {
  visitors: Record<string, VisitorRecord>;
}

export const VISITOR_COOKIE = "eggent_visitor";
export const VISITOR_COOKIE_MAX_AGE = 180 * 24 * 60 * 60;
const CODE_TTL_MS = 10 * 60_000;
const CODE_RESEND_MS = 60_000;
const CODE_ATTEMPTS = 5;
const MAX_KEYS = 10;
const MAX_CONVERSATIONS = 200;
export const MAX_VISITORS_PER_LINK = 20_000;

function dir(): string {
  return path.join(process.cwd(), "data", "public-visitors");
}

function fileOf(token: string): string {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new Error("Not a link token.");
  return path.join(dir(), `${token}.json`);
}

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

async function read(token: string): Promise<VisitorFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(fileOf(token), "utf-8")) as VisitorFile;
    return parsed && typeof parsed.visitors === "object" && parsed.visitors ? parsed : { visitors: {} };
  } catch {
    return { visitors: {} };
  }
}

async function write(token: string, data: VisitorFile): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  const target = fileOf(token);
  const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(temp, target);
}

// One change at a time per link in this process: two visitors arriving in the
// same second must not each write the file without the other.
const locks = new Map<string, Promise<unknown>>();
async function change<T>(token: string, work: (data: VisitorFile) => T | Promise<T>): Promise<T> {
  const previous = locks.get(token) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const data = await read(token);
    const result = await work(data);
    await write(token, data);
    return result;
  });
  locks.set(token, next);
  try {
    return await next;
  } finally {
    if (locks.get(token) === next) locks.delete(token);
  }
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || /[\s<>"',;\\]/.test(email)) return null;
  return /^[^@]+@[^@]+\.[^@.]+$/.test(email) ? email : null;
}

export function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 120 ? name : null;
}

/** `a***@example.com`: enough to recognise one's own address. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
}

function newKey(record: VisitorRecord): string {
  const key = crypto.randomBytes(24).toString("base64url");
  record.keys = [...record.keys, { hash: sha(key), createdAt: new Date().toISOString() }].slice(-MAX_KEYS);
  return `${record.id}.${key}`;
}

function parseCookie(value: string | undefined): { id: string; key: string } | null {
  const match = /^([a-f0-9]{12})\.([A-Za-z0-9_-]{20,64})$/.exec(value || "");
  return match ? { id: match[1], key: match[2] } : null;
}

/** The visitor whose key this browser holds, or null. */
export async function visitorOfCookie(token: string, cookie: string | undefined): Promise<VisitorRecord | null> {
  const parsed = parseCookie(cookie);
  if (!parsed) return null;
  const record = (await read(token)).visitors[parsed.id];
  if (!record) return null;
  const hash = sha(parsed.key);
  return record.keys.some((key) => sameHex(key.hash, hash)) ? record : null;
}

export type StartResult =
  | { kind: "started"; visitor: VisitorRecord; cookie: string }
  /** The address has a visitor already: a code went (or is going) to it. */
  | { kind: "code"; email: string; code: string | null; visitorId: string }
  | { kind: "full" };

/**
 * Begin with a name and an address. `mail` says whether a code can be sent;
 * the caller sends it when a code is returned (null: one went out a moment ago).
 */
export async function startVisitor(token: string, input: { name: string; email: string; mail: boolean }): Promise<StartResult> {
  return await change(token, (data): StartResult => {
    const now = new Date();
    const existing = Object.values(data.visitors).find((visitor) => visitor.email === input.email);
    if (existing && input.mail) {
      if (existing.code && now.getTime() - Date.parse(existing.code.sentAt) < CODE_RESEND_MS && Date.parse(existing.code.expiresAt) > now.getTime()) {
        return { kind: "code", email: existing.email, code: null, visitorId: existing.id };
      }
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      existing.code = {
        hash: sha(`${token}:${existing.id}:${code}`),
        expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
        attempts: 0,
        sentAt: now.toISOString(),
      };
      return { kind: "code", email: existing.email, code, visitorId: existing.id };
    }
    if (Object.keys(data.visitors).length >= MAX_VISITORS_PER_LINK) return { kind: "full" };
    const record: VisitorRecord = {
      id: crypto.randomBytes(6).toString("hex"),
      name: input.name,
      email: input.email,
      confirmedAt: null,
      createdAt: now.toISOString(),
      keys: [],
      conversations: [],
    };
    const cookie = newKey(record);
    data.visitors[record.id] = record;
    return { kind: "started", visitor: record, cookie };
  });
}

/** A code that went out was not delivered: let the next try send another at once. */
export async function forgetCode(token: string, visitorId: string): Promise<void> {
  await change(token, (data) => {
    const record = data.visitors[visitorId];
    if (record) delete record.code;
  });
}

export type VerifyResult =
  | { kind: "verified"; visitor: VisitorRecord; cookie: string }
  | { kind: "wrong"; attemptsLeft: number }
  | { kind: "expired" };

/** Prove the address with the code; the browser that does holds the visitor's key from now on. */
export async function verifyVisitor(token: string, input: { email: string; code: string }): Promise<VerifyResult> {
  return await change(token, (data): VerifyResult => {
    const record = Object.values(data.visitors).find((visitor) => visitor.email === input.email);
    const code = record?.code;
    if (!record || !code || Date.parse(code.expiresAt) <= Date.now() || code.attempts >= CODE_ATTEMPTS) {
      if (record) delete record.code;
      return { kind: "expired" };
    }
    const typed = input.code.replace(/\D/g, "");
    if (!sameHex(code.hash, sha(`${token}:${record.id}:${typed}`))) {
      code.attempts += 1;
      const attemptsLeft = CODE_ATTEMPTS - code.attempts;
      if (attemptsLeft <= 0) delete record.code;
      return { kind: "wrong", attemptsLeft };
    }
    delete record.code;
    // Whoever typed this address before it was proved may not be its owner.
    if (!record.confirmedAt) record.keys = [];
    record.confirmedAt = new Date().toISOString();
    const cookie = newKey(record);
    return { kind: "verified", visitor: record, cookie };
  });
}

/** This browser lets go of the visitor ("not you?"). */
export async function forgetKey(token: string, cookie: string | undefined): Promise<void> {
  const parsed = parseCookie(cookie);
  if (!parsed) return;
  await change(token, (data) => {
    const record = data.visitors[parsed.id];
    if (!record) return;
    const hash = sha(parsed.key);
    record.keys = record.keys.filter((key) => !sameHex(key.hash, hash));
  });
}

export function conversationIdOf(raw: unknown): string | null {
  const id = typeof raw === "string" ? raw.trim() : "";
  return /^[a-f0-9]{16}$/.test(id) ? id : null;
}

export function newConversationId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/** The session a visitor's conversation is kept under in this workspace. */
export function visitorSessionId(token: string, visitorId: string, conversation: string): string {
  return `share:${token}:v${visitorId}:${conversation}`;
}

/** Note a new conversation as the visitor's; false when they have as many as they may. */
export async function addConversation(token: string, visitorId: string, conversation: string): Promise<boolean> {
  return await change(token, (data) => {
    const record = data.visitors[visitorId];
    if (!record) return false;
    if (record.conversations.some((item) => item.id === conversation)) return true;
    if (record.conversations.length >= MAX_CONVERSATIONS) return false;
    record.conversations.push({ id: conversation, createdAt: new Date().toISOString() });
    return true;
  });
}

export function ownsConversation(visitor: VisitorRecord, conversation: string): boolean {
  return visitor.conversations.some((item) => item.id === conversation);
}
