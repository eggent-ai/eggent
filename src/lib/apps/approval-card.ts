/**
 * A call (or a batch) to a connected service that waits for the person's yes,
 * as the apps tool's answer carries it: what will run, one line per call, and
 * the deployment's own page that decides. The web chat shows it with a
 * button; the button is a plain link, and only a browser the deployment knows
 * as the owner's decides there - never this workspace or its agent.
 */
export interface AppApprovalCard {
  url: string;
  app: string;
  calls: string[];
  until: string;
}

const APPROVE_PATH = /^\/apps\/approve\/[0-9a-f-]{36}$/;

export function appApprovalFromToolOutput(output: unknown): AppApprovalCard | null {
  let value: unknown = output;
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    value = ((value as { content: Array<{ text?: unknown }> }).content.find((part) => typeof part?.text === "string")?.text) ?? null;
  }
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
  return {
    url: url.toString(),
    app: typeof raw.app === "string" ? raw.app : "",
    calls: Array.isArray(raw.calls) ? raw.calls.filter((entry): entry is string => typeof entry === "string").slice(0, 10) : [],
    until: typeof raw.until === "string" ? raw.until : "",
  };
}
