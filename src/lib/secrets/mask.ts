import { findSecrets, looksLikeAName, SECRET_TRIGGER, type SecretKind } from "@/lib/secrets/shapes";

/**
 * Keeping credentials out of what a chat stores.
 *
 * People paste keys into a chat, and the agent prints them from files it
 * reads. The stored copy of the conversation is then a plain text file that is
 * listed, synced to a laptop, quoted by the chat browser and read by every later
 * turn's tooling. The model's own context is another matter and is left alone:
 * it is what lets the agent use the key it was given. This is only the copy a
 * person and a file system see.
 *
 * Conservative on purpose: the shapes in secrets/shapes.ts and nothing broader,
 * because a word masked by mistake is not coming back. Idempotent: a mask is
 * itself something no shape matches, so masking twice changes nothing.
 */

const MASKS: Record<SecretKind, string> = {
  "bot-token": "[hidden bot token]",
  "api-key": "[hidden key]",
  token: "[hidden token]",
  "cloud-key": "[hidden key]",
  "private-key": "[hidden private key]",
  "url-credentials": "[hidden login]",
  password: "[hidden password]",
};

export function maskSecrets(text: string): string {
  if (!SECRET_TRIGGER.test(text)) return text;
  const matches = findSecrets(text);
  if (matches.length === 0) return text;
  let out = "";
  let at = 0;
  for (const match of matches) {
    out += text.slice(at, match.start);
    const original = text.slice(match.start, match.end);
    // A link keeps its scheme, so what it was still reads: `https://[hidden login]@host`.
    out += match.kind === "url-credentials" ? `${original.slice(0, original.indexOf("://") + 3)}${MASKS[match.kind]}@` : MASKS[match.kind];
    at = match.end;
  }
  return out + text.slice(at);
}

// A value kept under a name that says what it is: `{ api_key: "..." }` in a tool call's
// arguments is a key and a value in two strings, which no pattern over text ever sees
// together. Names are compared without case, dashes and underscores, and by how they end:
// `WIDGET_API_KEY` in an MCP server's env block and `X-Auth-Token` in a header are the same
// thing written the way their tool wants it. Longer endings come first.
const KEYED_ENDINGS: Array<[string, string]> = [
  ["clientsecret", MASKS["api-key"]],
  ["secretkey", MASKS["api-key"]],
  ["apikey", MASKS["api-key"]],
  ["accesstoken", MASKS.token],
  ["authtoken", MASKS.token],
  ["bottoken", MASKS["bot-token"]],
  ["privatekey", MASKS["private-key"]],
  ["authorization", MASKS.token],
  ["password", MASKS.password],
  ["passwd", MASKS.password],
  ["token", MASKS.token],
  ["secret", MASKS.token],
];

function keyedMaskFor(key: string): string | null {
  if (key.length > 48) return null;
  const name = key.toLowerCase().replace(/[_-]/g, "");
  for (const [ending, mask] of KEYED_ENDINGS) if (name.endsWith(ending)) return mask;
  return null;
}

// What a key's value looks like when it is a key and not a word: long, with a letter and
// a digit in it, the characters tokens are made of.
const KEY_VALUE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9._\-+/=~]{16,}$/;
// A password field holding its own name, or a template slot, is an example and not a password.
const PLACEHOLDER = /^(?:your[_ -]?password|password|passwd|changeme|string|\*+|x+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\})$/i;

function keyedMask(key: string, value: string): string | null {
  if (value.length < 4 || value.length > 4096) return null;
  const mask = keyedMaskFor(key);
  if (!mask || value.startsWith("[hidden ")) return null;
  if (mask === MASKS.password) return /\s/.test(value) || PLACEHOLDER.test(value) ? null : mask;
  if (/^(?:Bearer|Basic|Token)\s+\S{8,}$/i.test(value) && !/^\w+\s+(?:\$|<|\{)/.test(value)) return mask;
  return KEY_VALUE.test(value) && !looksLikeAName(value) ? mask : null;
}

function walk(value: unknown, depth: number): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (value === null || typeof value !== "object" || depth > 64) return value;

  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const next = walk(value[index], depth + 1);
      if (next !== value[index]) {
        copy ??= value.slice();
        copy[index] = next;
      }
    }
    return copy ?? value;
  }

  const record = value as Record<string, unknown>;
  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(record)) {
    const current = record[key];
    const next = typeof current === "string" ? keyedMask(key, current) ?? walk(current, depth + 1) : walk(current, depth + 1);
    if (next !== current) {
      copy ??= { ...record };
      copy[key] = next;
    }
  }
  return copy ?? record;
}

/**
 * The same value with every credential in any string of it masked. Never mutates
 * its input and returns the input itself when there was nothing to mask, so
 * running it over a chat on every save costs a walk and no copy.
 */
export function withoutSecrets<T>(value: T): T {
  return walk(value, 0) as T;
}
