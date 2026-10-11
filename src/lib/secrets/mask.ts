import { findSecrets, type SecretKind } from "@/lib/secrets/shapes";

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

// Every shape has a prefix or a keyword; one scan for any of them says whether
// a text is worth looking at, so the common text costs a single pass.
const ANYTHING_LIKE_A_SECRET =
  /(?:\bsk-|eggw_|AIza|\bAQ\.|vk1\.a\.|\d:AA|\bBearer\b|gh[pousr]_|github_pat_|AKIA|xox[abprs]-|eyJ|PRIVATE KEY|:\/\/[^\s/@:]+:[^\s/@]+@|api[_-]?key|apikey|access[_-]?token|authorization)/i;

export function maskSecrets(text: string): string {
  if (!ANYTHING_LIKE_A_SECRET.test(text)) return text;
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
    const next = walk(record[key], depth + 1);
    if (next !== record[key]) {
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
