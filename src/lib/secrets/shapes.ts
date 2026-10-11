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
 *
 * Every pattern here runs over whatever a chat holds, including a page the agent
 * fetched or a message somebody crafted, on every save and every read. So each
 * one has to cost time in proportion to the text, whatever the text is. The way
 * a pattern loses that: it can fail after reading a long run of characters, and
 * can then start again from every position inside the same run. Three rules keep
 * it: a pattern is anchored on something that cannot occur inside the run it
 * reads (`://`, a vendor prefix), or may only start where a run begins
 * (NOT_IN_TOKEN), or reads a bounded stretch (the private-key body is paired by findPrivateKeys). `npm run test:secret-mask` feeds
 * each of them hostile text and holds it to a time.
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
  /** Judges what the pattern found, for shapes broad enough to catch a name that only looks like a key. */
  accept?: (matched: string) => boolean;
}

function global(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

const shape = (kind: SecretKind, re: RegExp, accept?: (matched: string) => boolean): SecretShape => ({
  kind,
  pattern: global(re),
  ...(accept ? { accept } : {}),
});

function supportsLookbehind(): boolean {
  try {
    new RegExp("(?<!a)b");
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a token may begin: not in the middle of a run of token characters.
 *
 * A pattern that reads a long run and then fails (a signed token that never
 * reaches its first dot) would otherwise be tried again from every `eyJ-` inside
 * the run, reading the rest of it each time. A browser without look-behind falls
 * back to a word boundary: the same matches, and the slow case on hostile text
 * is then the visitor's own tab.
 */
const NOT_IN_TOKEN = supportsLookbehind() ? "(?<![A-Za-z0-9_\\-])" : "\\b";

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
  shape("cloud-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/),
  shape("token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/),
  shape("token", /\bxapp-[A-Za-z0-9-]{20,}/),
  shape("token", new RegExp(`${NOT_IN_TOKEN}eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`)),
  // The header. The whole block, when it is all there, is found by findPrivateKeys below.
  shape("private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/),
  // Keys whose vendors give them a prefix of their own. Each is long enough, and specific
  // enough, to stand without a label beside it.
  shape("api-key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/),
  shape("token", /\bhf_[A-Za-z0-9]{30,}/),
  shape("api-key", /\bgsk_[A-Za-z0-9]{40,}/),
  shape("token", /\bglpat-[A-Za-z0-9_-]{20,}/),
  shape("api-key", /\btvly-[A-Za-z0-9_-]{20,}/),
  shape("token", /\bnpm_[A-Za-z0-9]{36}/),
  shape("api-key", /\bpplx-[A-Za-z0-9]{32,}/),
  shape("api-key", /\bxai-[A-Za-z0-9]{60,}/),
  shape("token", /\br8_[A-Za-z0-9]{30,}/),
  shape("token", /\bshp(?:at|ss|ca|pa)_[a-f0-9]{32}/),
  shape("api-key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/),
  shape("token", /\bdop_v1_[a-f0-9]{64}/),
  shape("token", /\bya29\.[A-Za-z0-9_-]{20,}/),
];

/**
 * The same ideas, tightened for the places where a mistake costs more than a
 * missed key: what a chat stores and what the composer warns about.
 *
 * The labelled catch-all above is right for an error message - redact too much
 * and nobody minds - but it matches `api_key = os.environ[...]`, which is how
 * every example in every answer about keys is written, and a bearer-looking word
 * in a sentence. Here a value counts only if it looks like a secret: long enough,
 * with a digit among its letters, and not a name.
 */
const LOOKS_SECRET = "(?=[A-Za-z0-9._\\-]{16,})(?=[A-Za-z0-9._\\-]*\\d)(?=[A-Za-z0-9._\\-]*[A-Za-z])[A-Za-z0-9._\\-]+";

/**
 * `self.oauth2_client.fetch_token`, `YOUR_API_KEY_123456789`, `process.env.KEY_2024`:
 * words joined by dots, dashes and underscores, with a number here and there. A
 * person wrote that, in code or in an example; a key is not made of words. It has
 * to be at least two of them, so one long unbroken run is never taken for a name.
 */
export function looksLikeAName(value: string): boolean {
  const parts = value.split(/[._\-]+/).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part) => /^[A-Za-z]{2,}\d{0,4}$/.test(part) || /^\d{1,10}$/.test(part));
}

/** The value a labelled or bearer match ends in: its last run of token characters. */
function valueOf(matched: string): string {
  return /[A-Za-z0-9._\-]+$/.exec(matched)?.[0] ?? "";
}

const notAName = (matched: string): boolean => !looksLikeAName(valueOf(matched));

const CREDENTIAL_LABEL = "(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|authorization)";

const STORAGE_VENDOR_SHAPES: SecretShape[] = [
  shape("token", new RegExp(`\\bBearer\\s+${LOOKS_SECRET}`, "i"), notAName),
  // The ones with a prefix of their own are specific enough to stand as they are.
  shape("api-key", /\bsk-[A-Za-z0-9._\-]{8,}/),
  shape("api-key", /\beggw_[A-Za-z0-9._\-]{8,}/),
  shape("api-key", /\bAIza[A-Za-z0-9._\-]{10,}/),
  shape("api-key", /\bAQ\.[A-Za-z0-9._\-]{10,}/),
  shape("token", /\bvk1\.a\.[A-Za-z0-9._\-]{10,}/),
  shape("bot-token", /\b\d{8,10}:AA[A-Za-z0-9._\-]{20,}/),
  // A label, which may sit inside an environment variable's name (WIDGET_API_KEY=...).
  shape("token", new RegExp(`\\b\\w*${CREDENTIAL_LABEL}["']?\\s*[:=]\\s*["']?${LOOKS_SECRET}`, "i"), notAName),
];

// The characters that end a web address in running text: a quote, a bracket, a space.
// A password with one of them in it is read as far as it goes; with a raw `@` in it, to
// the last `@` before the address ends.
const URL_STOP = "\\s/?#\"'`<>()\\[\\]{}|\\\\";

/**
 * `scheme://user:password@host`: the login and password are what is secret.
 *
 * Anchored on `://`, not on the scheme before it. Reading the scheme first meant
 * reading it again from every word boundary inside a long run of letters, dots
 * and dashes - a quadratic scan of exactly the text nobody checks.
 */
export const URL_CREDENTIALS: SecretShape = shape(
  "url-credentials",
  new RegExp(`:\\/\\/[^${URL_STOP}@:]{0,256}:[^${URL_STOP}]{1,1024}@`)
);

/**
 * One scan that says whether a text is worth reading with the shapes at all: each
 * of them starts from a prefix or a keyword listed here. The common text, which has
 * none, then costs a single pass.
 */
export const SECRET_TRIGGER = new RegExp(
  [
    "\\bsk[-_]", "eggw_", "AIza", "\\bAQ\\.", "vk1\\.a\\.", "\\d:AA", "\\bBearer\\b",
    "gh[pousr]_", "github_pat_", "A[KS]IA", "xox[abprs]-", "xapp-", "eyJ", "PRIVATE KEY",
    "\\brk_", "\\bhf_", "\\bgsk_", "glpat-", "tvly-", "\\bnpm_", "pplx-", "\\bxai-", "\\br8_",
    "shp(?:at|ss|ca|pa)_", "\\bSG\\.", "dop_v1_", "ya29\\.",
    URL_CREDENTIALS.pattern.source,
    "api[_-]?key", "apikey", "access[_-]?token", "auth[_-]?token", "client[_-]?secret", "secret[_-]?key", "authorization",
  ].join("|"),
  "i"
);

/** Whether the text holds any of these. `search` ignores a global pattern's state, which `test` would not. */
export function hasShape(text: string, shapes: readonly SecretShape[]): boolean {
  return shapes.some((entry) => text.search(entry.pattern) !== -1);
}

export interface SecretMatch {
  kind: SecretKind;
  start: number;
  end: number;
}

const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_FOOTER = /-----END [A-Z ]*PRIVATE KEY-----/g;
// No key is longer than a dozen kilobytes; a footer further off than that is somebody else's.
const PRIVATE_KEY_MAX_BODY = 12_000;

/**
 * Private keys, header to footer when both are there and the header alone when not.
 *
 * Done by pairing, not by one pattern that reads on from each header until it finds a
 * footer: a text full of headers and no footer would be read to its end once for every
 * header. Headers and footers are each found in one pass and paired in order.
 */
function findPrivateKeys(text: string): SecretMatch[] {
  const headers = [...text.matchAll(PRIVATE_KEY_HEADER)];
  if (headers.length === 0) return [];
  const footers = [...text.matchAll(PRIVATE_KEY_FOOTER)];
  const found: SecretMatch[] = [];
  let next = 0;
  for (const header of headers) {
    const start = header.index ?? 0;
    const bodyStart = start + header[0].length;
    while (next < footers.length && (footers[next].index ?? 0) < bodyStart) next += 1;
    const footer = footers[next];
    const footerStart = footer?.index ?? Infinity;
    const end = footer && footerStart - bodyStart <= PRIVATE_KEY_MAX_BODY ? footerStart + footer[0].length : bodyStart;
    found.push({ kind: "private-key", start, end });
  }
  return found;
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
      if (entry.accept && !entry.accept(match[0])) continue;
      found.push({ kind: entry.kind, start: match.index, end: match.index + match[0].length });
    }
  }
  found.push(...findPrivateKeys(text));
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
