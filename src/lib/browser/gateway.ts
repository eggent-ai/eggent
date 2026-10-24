import { browserApiUrl, browserToken } from "@/lib/browser/config";

/** What the deployment says about this workspace's browser. */
export interface BrowserStatus {
  open: boolean;
  minutes: { monthly: number; used: number; left: number };
}

async function call(method: string, suffix: string): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${browserApiUrl()}${suffix}`, {
    method,
    headers: { authorization: `Bearer ${browserToken()}` },
    signal: AbortSignal.timeout(40_000),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, json };
}

function minutesOf(json: Record<string, unknown>): BrowserStatus["minutes"] {
  const minutes = (json.minutes || {}) as Record<string, unknown>;
  return { monthly: Number(minutes.monthly) || 0, used: Number(minutes.used) || 0, left: Number(minutes.left) || 0 };
}

export async function browserStatus(): Promise<BrowserStatus> {
  const answer = await call("GET", "/session");
  if (!answer.ok) throw new Error(String(answer.json.error || `status ${answer.status}`));
  return { open: Boolean(answer.json.open), minutes: minutesOf(answer.json) };
}

/** Opens the browser (or finds it open); the deployment's refusal is passed on as said. */
export async function openBrowser(): Promise<{ ok: boolean; error?: string; status: BrowserStatus | null }> {
  const answer = await call("POST", "/session");
  if (!answer.ok) return { ok: false, error: String(answer.json.error || `status ${answer.status}`), status: null };
  return { ok: true, status: { open: true, minutes: minutesOf(answer.json) } };
}

export async function closeBrowser(): Promise<void> {
  await call("DELETE", "/session");
}

export async function forgetBrowserLogins(): Promise<boolean> {
  return (await call("DELETE", "/profile")).ok;
}

export function browserCdpUrl(): string {
  return `${browserApiUrl().replace(/^http/, "ws")}/session/cdp`;
}
