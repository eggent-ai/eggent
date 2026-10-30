/**
 * The public links to this workspace's projects, as the hosting service keeps them.
 *
 * A hosted deployment sets EGGENT_PUBLIC_CHAT_API_URL; the workspace then asks
 * it, with the token its usage meter uses, whether a link is one of its own and
 * still open, and has it send a visitor their one-time code (it has the mail).
 * Without the variable a link's page answers that it is not open: the links are
 * made and closed by the service, so nothing here could say which exist.
 */

export interface PublicShare {
  token: string;
  projectId: string;
  title: string;
  welcome: string | null;
  /** Questions one visitor may ask in an hour. */
  maxMessagesPerHour: number;
}

export interface PublicChatConfig {
  url: string;
  token: string;
}

export function getPublicChatConfig(): PublicChatConfig | null {
  const url = process.env.EGGENT_PUBLIC_CHAT_API_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = process.env.EGGENT_USAGE_API_TOKEN?.trim();
  if (!token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export function shareTokenOf(raw: string): string | null {
  let token = "";
  try {
    token = decodeURIComponent(String(raw || "")).trim();
  } catch {
    return null;
  }
  return /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null;
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; share: PublicShare | null }>();

async function call(config: PublicChatConfig, method: "GET" | "POST", route: string, body?: unknown): Promise<Response> {
  return await fetch(`${config.url}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
}

/** The link, when it is one of this workspace's and open; null otherwise (and when nobody can say). */
export async function findPublicShare(token: string): Promise<PublicShare | null> {
  const config = getPublicChatConfig();
  if (!config) return null;
  const cached = cache.get(token);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.share;
  let share: PublicShare | null = null;
  try {
    const response = await call(config, "GET", `/shares/${encodeURIComponent(token)}`);
    if (response.ok) {
      const data = (await response.json()) as { share?: Partial<PublicShare> | null };
      const raw = data.share;
      if (raw && raw.token === token && typeof raw.projectId === "string" && raw.projectId) {
        share = {
          token,
          projectId: raw.projectId,
          title: typeof raw.title === "string" && raw.title ? raw.title : raw.projectId,
          welcome: typeof raw.welcome === "string" && raw.welcome ? raw.welcome : null,
          maxMessagesPerHour: typeof raw.maxMessagesPerHour === "number" && raw.maxMessagesPerHour > 0 ? raw.maxMessagesPerHour : 30,
        };
      }
    } else if (response.status !== 404) {
      // Not knowing is not "closed": an answer we failed to get is not remembered.
      return cached?.share ?? null;
    }
  } catch {
    return cached?.share ?? null;
  }
  cache.set(token, { at: Date.now(), share });
  return share;
}

/** Whether this workspace can send a visitor a code at all. */
export function visitorMailAvailable(): boolean {
  return getPublicChatConfig() !== null;
}

export type CodeLetterResult = { sent: true } | { sent: false; reason: "limited" | "failed" };

/** Have the service mail a visitor the code that proves the address is theirs. */
export async function sendVisitorCode(token: string, input: { email: string; code: string; locale: string }): Promise<CodeLetterResult> {
  const config = getPublicChatConfig();
  if (!config) return { sent: false, reason: "failed" };
  try {
    const response = await call(config, "POST", `/shares/${encodeURIComponent(token)}/code`, input);
    if (response.ok) return { sent: true };
    return { sent: false, reason: response.status === 429 ? "limited" : "failed" };
  } catch {
    return { sent: false, reason: "failed" };
  }
}
