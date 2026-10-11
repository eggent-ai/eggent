/**
 * What a credential looks like.
 *
 * One list, read by everything that has to recognise one: the chat's error text
 * (a provider echoing the request back), the guard on what the agent may keep,
 * the warning in the composer, and the mask on what a chat stores. They used to
 * hold their own copies, which is how one of them knew about GitHub tokens and
 * the others did not.
 *
 * Shapes, not entropy. A vendor prefix, a private-key header, a password in a
 * link: things that are credentials almost whenever they appear. Looking at
 * "long strings of mixed characters" would catch more and be wrong often, and a
 * word masked by mistake in a stored chat cannot be got back. No Node imports:
 * the composer reads this in the browser.
 */

export type SecretKind =
  /** A Telegram bot token. */
  | "bot-token"
  /** A model provider's key. */
  | "api-key"
  /** A bearer token, a service token, a JWT. */
  | "token"
  /** A cloud account key. */
  | "cloud-key"
  | "private-key"
  /** A web address with a login and password in it. */
  | "url-credentials"
  /** Somebody saying "the password is ...". */
  | "password";

export interface SecretShape {
  kind: SecretKind;
  /** Global, so it can replace and list; never call `.test` or `.exec` on it - use `search`. */
  pattern: RegExp;
}

function global(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

const shape = (kind: SecretKind, re: RegExp): SecretShape => ({ kind, pattern: global(re) });

/** The shapes a provider's error text has always been scrubbed of. Order matters: the specific ones before the labelled catch-all. */
export const VENDOR_SHAPES: SecretShape[] = [
  shape("token", /\bBearer\s+[A-Za-z0-9._\-]{8,}/i),
  shape("api-key", /\bsk-[A-Za-z0-9._\-]{8,}/),
  shape("api-key", /\beggw_[A-Za-z0-9._\-]{8,}/),
  shape("api-key", /\bAIza[A-Za-z0-9._\-]{10,}/),
  shape("api-key", /\bAQ\.[A-Za-z0-9._\-]{10,}/),
  shape("token", /\bvk1\.a\.[A-Za-z0-9._\-]{10,}/),
  shape("bot-token", /\b\d{8,10}:AA[A-Za-z0-9._\-]{20,}/),
  shape("token", /\b(?:api[_-]?key|apikey|access[_-]?token|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i),
];

/** Shapes beyond those: other vendors' tokens, a signed token, a private key. */
export const MORE_SHAPES: SecretShape[] = [
  shape("token", /\bgh[pousr]_[A-Za-z0-9]{20,}/),
  shape("token", /\bgithub_pat_[A-Za-z0-9_]{20,}/),
  shape("cloud-key", /\bAKIA[0-9A-Z]{16}\b/),
  shape("token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/),
  shape("token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/),
  // The whole block when it is all there, the header alone when it is not.
  shape("private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/),
];

/**
 * The same ideas, tightened for the places where a mistake costs more than a
 * missed key: what a chat stores and what the composer warns about.
 *
 * The labelled catch-all above is right for an error message - redact too much
 * and nobody minds - but it matches `api_key = os.environ[...]`, which is how
 * every example in every answer about keys is written, and a bearer-looking word
 * in a sentence. Here a value counts only if it looks like a secret: long enough,
 * with a digit among its letters.
 */
const LOOKS_SECRET = "(?=[A-Za-z0-9._\\-]{16,})(?=[A-Za-z0-9._\\-]*\\d)(?=[A-Za-z0-9._\\-]*[A-Za-z])[A-Za-z0-9._\\-]+";
const STORAGE_VENDOR_SHAPES: SecretShape[] = [
  shape("token", new RegExp(`\\bBearer\\s+${LOOKS_SECRET}`, "i")),
  // The ones with a prefix of their own are specific enough to stand as they are.
  ...VENDOR_SHAPES.filter((entry) => /sk-|eggw_|AIza|AQ|vk1|:AA/.test(entry.pattern.source)),
  shape("token", new RegExp(`\\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|authorization|client[_-]?secret)["']?\\s*[:=]\\s*["']?${LOOKS_SECRET}`, "i")),
];

/** `scheme://user:password@host`: the login and password are what is secret. */
export const URL_CREDENTIALS: SecretShape = shape("url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i);

/** Whether the text holds any of these. `search` ignores a global pattern's state, which `test` would not. */
export function hasShape(text: string, shapes: readonly SecretShape[]): boolean {
  return shapes.some((entry) => text.search(entry.pattern) !== -1);
}

export interface SecretMatch {
  kind: SecretKind;
  start: number;
  end: number;
}

/**
 * Where the credentials are in a text, earliest first, without overlaps.
 *
 * `spoken` adds a label followed by something that looks like the secret itself
 * ("password: hunter2xyz"); it is the caller's, because what people call a
 * password depends on their language and the list of words lives with the
 * vocabulary.
 */
export function findSecrets(text: string, options: { spoken?: RegExp | null } = {}): SecretMatch[] {
  const found: SecretMatch[] = [];
  const all: SecretShape[] = [...STORAGE_VENDOR_SHAPES, ...MORE_SHAPES, URL_CREDENTIALS];
  if (options.spoken) all.push({ kind: "password", pattern: global(options.spoken) });
  for (const entry of all) {
    for (const match of text.matchAll(entry.pattern)) {
      if (match.index === undefined || match[0].length === 0) continue;
      found.push({ kind: entry.kind, start: match.index, end: match.index + match[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretMatch[] = [];
  for (const match of found) {
    const last = merged[merged.length - 1];
    if (last && match.start < last.end) continue;
    merged.push(match);
  }
  return merged;
}

export function firstSecret(text: string, options: { spoken?: RegExp | null } = {}): SecretMatch | null {
  return findSecrets(text, options)[0] ?? null;
}
