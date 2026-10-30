/**
 * A letter to somebody else that waits for the person's yes, as the email
 * tool's answer carries it: the whole letter as the cloud froze it, and the
 * cloud's own page that decides. The web chat shows it with a button; the
 * button is a plain link, and only a browser the person remembered on the
 * cloud can decide there, never this workspace or its agent.
 */
export interface EmailApprovalCard {
  url: string;
  to: string[];
  subject: string;
  text: string;
  files: Array<{ name: string; size: number }>;
  until: string;
}

const APPROVE_PATH = /^\/email\/approve\/[0-9a-f-]{36}$/;

export function emailApprovalFromToolOutput(output: unknown): EmailApprovalCard | null {
  let value: unknown = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = (value as { approval?: unknown }).approval;
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  const raw = card as Record<string, unknown>;
  if (typeof raw.url !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!APPROVE_PATH.test(url.pathname) || url.search || url.hash) return null;
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []);
  const files = Array.isArray(raw.files)
    ? raw.files
        .map((file) => (file && typeof file === "object" ? (file as Record<string, unknown>) : {}))
        .filter((file) => typeof file.name === "string")
        .map((file) => ({ name: String(file.name), size: typeof file.size === "number" ? file.size : 0 }))
    : [];
  return {
    url: url.toString(),
    to: strings(raw.to),
    subject: typeof raw.subject === "string" ? raw.subject : "",
    text: typeof raw.text === "string" ? raw.text : "",
    files,
    until: typeof raw.until === "string" ? raw.until : "",
  };
}
