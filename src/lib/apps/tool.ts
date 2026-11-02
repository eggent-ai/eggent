/**
 * The agent's tool for the person's connected services ("Apps") - CRMs,
 * marketplaces, banks, payment and social accounts - through the deployment's
 * apps service (EGGENT_APPS_API_URL).
 *
 * The workspace holds no key of any of them: the service keeps them and makes
 * every call itself. A read comes back at once; a call that may change
 * something waits for the owner's yes, which the service asks for on its own
 * channel, and runs then. Connecting is the person's act on a page of the
 * deployment; the agent can only hand them the button.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const APPS_TOOL = "eggent_apps";

const CALL_TIMEOUT_MS = 60_000;

export function appsConfig(): { url: string; token: string } | null {
  const url = process.env.EGGENT_APPS_API_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const token = process.env.EGGENT_SERVICES_TOKEN?.trim() || process.env.EGGENT_USAGE_API_TOKEN?.trim();
  if (!token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

export function appsEnabled(): boolean {
  return appsConfig() !== null;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

async function ask(method: "GET" | "POST", route: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const config = appsConfig();
  if (!config) return { status: 503, data: { error: "Apps are not set up in this workspace." } };
  try {
    const response = await fetch(`${config.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${config.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      cache: "no-store",
    });
    const data = ((await response.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
    return { status: response.status, data };
  } catch {
    return { status: 503, data: { error: "The apps service did not answer. Try again in a minute." } };
  }
}

const APP_ID = /^[a-z0-9-]{2,40}$/;

export function createAppsTool() {
  return defineTool({
    name: APPS_TOOL,
    label: "Apps",
    description:
      "The person's connected services: Yandex (Disk, Metrica, Webmaster, Tracker), Bitrix24, amoCRM, MoySklad, Wildberries, Ozon, Yandex Market, YooKassa, T-Bank Business, Tochka, VK. " +
      "action list: which apps exist and which are connected. action guide + app: how to call that app (its paths or methods, hosts, quirks) - read it before the first call. " +
      "action call + app + path (+ method, host, query, body): one API call made by the service with the person's key; for Bitrix24 and VK, path is the API method name and body its params. " +
      "A read answers at once. A call that may change data does not run: it waits for the owner's yes on their own channel and answers pending with a request id - tell the person, and check it later with action request + request_id. " +
      "When an app is not connected the answer carries connect.url: give the person that link (the chat shows a Connect button) - never ask them to paste a key into the chat.",
    promptSnippet: "eggent_apps(action: list|guide|call|request, app?, method?, host?, path?, query?, body?, request_id?) - the person's connected services (CRM, marketplaces, banks, Yandex, VK)",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("guide"), Type.Literal("call"), Type.Literal("request")]),
      app: Type.Optional(Type.String({ description: "The app id from list, e.g. bitrix24, amocrm, ozon." })),
      method: Type.Optional(Type.String({ description: "HTTP method for REST apps: GET (default), POST, PUT, PATCH, DELETE." })),
      host: Type.Optional(Type.String({ description: "For apps with several APIs (yandex: disk|metrika|webmaster|tracker; wildberries: content|statistics|analytics|marketplace|prices|feedbacks|advert|common)." })),
      path: Type.Optional(Type.String({ description: "Path on the service (e.g. /api/v4/leads), or the method name for Bitrix24 and VK (e.g. crm.deal.list)." })),
      query: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Query parameters." })),
      body: Type.Optional(Type.Unknown({ description: "JSON body, or the method's params for Bitrix24 and VK." })),
      request_id: Type.Optional(Type.String({ description: "For action request: a pending request's id; without it, the latest ones." })),
    }),
    async execute(_id, params) {
      const action = params.action;
      const app = typeof params.app === "string" ? params.app.trim().toLowerCase() : "";
      if (action === "list") {
        const { data } = await ask("GET", "");
        return textResult(JSON.stringify(data, null, 2));
      }
      if (action === "request") {
        const id = typeof params.request_id === "string" && /^[0-9a-f-]{36}$/i.test(params.request_id) ? `/${params.request_id}` : "";
        const { data } = await ask("GET", `/requests${id}`);
        return textResult(JSON.stringify(data, null, 2));
      }
      if (!APP_ID.test(app)) return textResult(JSON.stringify({ error: "Name the app (its id from action list)." }));
      if (action === "guide") {
        const { data } = await ask("GET", `/${app}`);
        return textResult(JSON.stringify(withConnect(data), null, 2));
      }
      if (typeof params.path !== "string" || !params.path.trim()) return textResult(JSON.stringify({ error: "A call needs path." }));
      const { status, data } = await ask("POST", `/${app}/call`, {
        path: params.path,
        ...(params.method ? { method: params.method } : {}),
        ...(params.host ? { host: params.host } : {}),
        ...(params.query ? { query: params.query } : {}),
        ...(params.body !== undefined ? { body: params.body } : {}),
      });
      if (status === 202) {
        return textResult(JSON.stringify({
          ...data,
          note: "Not done yet: the owner has to allow it in their Telegram or by the link in their email. Tell the person it waits for their yes; check with action request.",
        }, null, 2));
      }
      return textResult(JSON.stringify(withConnect(data), null, 2));
    },
  });
}

/** A not-connected answer carries the link in `connect.url`, where the chat looks for a Connect button. */
function withConnect(data: Record<string, unknown>): Record<string, unknown> {
  const url = typeof data.connectUrl === "string" ? data.connectUrl : null;
  if (!url || data.connected === true) return data;
  return { ...data, connect: { url } };
}
