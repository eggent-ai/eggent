/**
 * What the provider itself said, when it said anything.
 *
 * A turn that fails at the provider looks exactly like a turn that produced
 * nothing: no text, no tools, usage all zeros. The runtime records the real
 * cause on the assistant message as `stopReason: "error"` plus `errorMessage`,
 * and that field used to be dropped on the floor - the chat then explained a
 * precise refusal with a three-way guess about rate limits, quota or the key.
 *
 * One workspace lost an hour and forty minutes to that: the provider answered
 * "the bound service account is deleted or disabled", three times, and the user
 * was told his key might be wrong. It was not; the key was fine.
 *
 * So: when the provider explains itself, quote it. Probing is for the case
 * where it says nothing at all.
 */

/** A provider's own account of why a request failed. */
export interface ProviderFailure {
  /** HTTP status, when one can be found. */
  status?: number;
  /** The provider's own sentence, trimmed and stripped of anything secret. */
  message: string;
}

const MAX_MESSAGE_CHARS = 220;

/**
 * Anything that looks like a credential, whatever wrapper it arrives in.
 *
 * Error bodies echo request material more often than one would like, and this
 * text goes straight into a chat that is stored and re-sent to the model. The
 * patterns are deliberately broad: a redacted word costs nothing, a leaked key
 * costs a rotation.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._\-]{8,}/gi,
  /\bsk-[A-Za-z0-9._\-]{8,}/g,
  /\beggw_[A-Za-z0-9._\-]{8,}/g,
  /\bAIza[A-Za-z0-9._\-]{10,}/g,
  /\bAQ\.[A-Za-z0-9._\-]{10,}/g,
  /\bvk1\.a\.[A-Za-z0-9._\-]{10,}/g,
  /\b\d{8,10}:AA[A-Za-z0-9._\-]{20,}/g,
  /\b(?:api[_-]?key|apikey|access[_-]?token|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/gi,
];

function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/**
 * Providers wrap their message in whatever depth of JSON they please: Google
 * returns a JSON string whose `message` is itself a JSON document with the real
 * sentence two levels down. Walk to the deepest `message` that is not itself
 * parseable JSON, which is the human one.
 */
function deepestMessage(value: unknown, depth = 0): { message?: string; status?: number } {
  if (depth > 6) return {};
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      // Parsed on any string, not only one that opens with a brace: a body of
      // "null" is otherwise handed on as the sentence, and the chat then tells
      // the user the provider refused the request: null.
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && (typeof parsed === "object" || typeof parsed === "string")) {
        return deepestMessage(parsed, depth + 1);
      }
      // A bare null, number or boolean carries no explanation.
      return {};
    } catch {
      // Not JSON, so the string itself is what the provider said.
    }
    return { message: trimmed };
  }

  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;

  const status = [record.code, record.status, record.statusCode].find(
    (candidate): candidate is number => typeof candidate === "number" && candidate >= 100 && candidate < 600
  );

  // `error` first: every dialect in use nests the real body under it.
  for (const key of ["error", "message", "detail", "details", "reason"]) {
    const inner = record[key];
    if (inner === undefined || inner === null) continue;
    const found = deepestMessage(inner, depth + 1);
    if (found.message) return { message: found.message, status: found.status ?? status };
  }

  return status === undefined ? {} : { status };
}

/**
 * Read a runtime `errorMessage` into something worth showing a person.
 *
 * Returns null when there is nothing quotable - an empty field, or a body that
 * carries a status and no sentence. The caller then falls back to probing the
 * provider, which is what that path is for.
 */
export function describeProviderFailure(errorMessage?: unknown): ProviderFailure | null {
  if (typeof errorMessage !== "string") return null;
  const raw = errorMessage.trim();
  if (!raw) return null;

  const { message, status } = deepestMessage(raw);
  if (!message) return null;

  // A message that is only the status word ("Unauthorized", "error") explains
  // nothing the status code does not, so it is not worth a sentence of its own.
  const cleaned = redactSecrets(message).replace(/\s+/g, " ").trim();
  if (!cleaned || /^(error|unauthorized|forbidden|bad request|internal server error)$/i.test(cleaned)) {
    return status === undefined ? null : { status, message: cleaned || "" };
  }

  const clipped =
    cleaned.length > MAX_MESSAGE_CHARS ? `${cleaned.slice(0, MAX_MESSAGE_CHARS).trimEnd()}…` : cleaned;

  return { status, message: clipped };
}
