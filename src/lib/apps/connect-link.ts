/** Client-safe: read by the chat to put a Connect button under an answer. */
/** The connect link an `eggent_apps` answer carries, for the card under the answer. */
export function appsConnectUrlFromToolOutput(output: unknown): string | null {
  let value: unknown = output;
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    const first = (value as { content: Array<{ text?: unknown }> }).content[0];
    value = typeof first?.text === "string" ? first.text : null;
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const connect = (value as { connect?: { url?: unknown } }).connect;
  const url = connect && typeof connect.url === "string" ? connect.url : null;
  return url && /^https?:\/\//.test(url) ? url : null;
}
