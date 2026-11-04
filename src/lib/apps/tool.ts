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

export interface AppsToolOptions {
  /** Where this turn came from: the web chat, a messenger, or nobody watching. */
  origin?: () => "web" | "telegram" | "other";
}

const MAX_BATCH = 10;

export function createAppsTool(options: AppsToolOptions = {}) {
  return defineTool({
    name: APPS_TOOL,
    label: "Apps",
    description:
      "The person's connected services - the CRMs, marketplaces, banks, analytics and other services this deployment offers; which ones exist comes from action list, never from memory. " +
      "action list: which apps exist and which are connected. action guide + app: how to call that app (hosts, quirks, and for big APIs the sections of its method list) - read it before the first call. " +
      "action methods + app + search (words of the task, e.g. \"stock warehouse\", \"refund\") or section: the matching methods from the service's own documentation - method, host, path, parameters (name* = required) and whether it reads or waits for the owner. For a big API look the method up here instead of calling a path from memory. " +
      "action call + app + path (+ method, host, query, body): one API call made by the service with the person's key; for apps called by method name, path is the method and body its params - the guide says which. " +
      "action call + app + batch (up to 10 calls, each {path, method?, host?, query?, body?}): several calls to one app at once - when a task changes several things (four payment drafts, ten prices), send them as one batch so the owner says yes once for all of them. " +
      "A read answers at once. A call or batch that may change data does not run: it waits for the owner's yes and answers pending with a request id - in the web chat the person sees it under your answer with a button; tell them in one line, and check it later with action request + request_id. " +
      "When the app the task needs is not connected (connected: false), give the person connectUrl as a markdown link to the Apps page, in one sentence - never ask them to paste a key into the chat, and say nothing about connecting an app that is connected.",
    promptSnippet: "eggent_apps(action: list|guide|methods|call|request, app?, search?, section?, method?, host?, path?, query?, body?, batch?, request_id?) - the person's connected services (CRM, marketplaces, banks, analytics and more)",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("guide"), Type.Literal("methods"), Type.Literal("call"), Type.Literal("request")]),
      app: Type.Optional(Type.String({ description: "The app id from list." })),
      search: Type.Optional(Type.String({ description: "For action methods: words of what to do, in Russian or English." })),
      section: Type.Optional(Type.String({ description: "For action methods: a section name from the guide, to list its methods." })),
      method: Type.Optional(Type.String({ description: "HTTP method for REST apps: GET (default), POST, PUT, PATCH, DELETE." })),
      host: Type.Optional(Type.String({ description: "For apps with several APIs, which one; the app's guide names them." })),
      path: Type.Optional(Type.String({ description: "Path on the service (e.g. /api/v4/items), or the method name for apps called by method (e.g. items.list)." })),
      query: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Query parameters." })),
      body: Type.Optional(Type.Unknown({ description: "JSON body, or the method's params for apps called by method." })),
      batch: Type.Optional(Type.Array(Type.Object({
        path: Type.String(),
        method: Type.Optional(Type.String()),
        host: Type.Optional(Type.String()),
        query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        body: Type.Optional(Type.Unknown()),
      }), { description: "For action call: up to 10 calls to the same app, asked as one." })),
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
        return textResult(JSON.stringify(data, null, 2));
      }
      if (action === "methods") {
        const search = typeof params.search === "string" ? params.search.trim().slice(0, 200) : "";
        const section = typeof params.section === "string" ? params.section.trim().slice(0, 120) : "";
        const query = new URLSearchParams();
        if (search) query.set("search", search);
        if (section) query.set("section", section);
        const { data } = await ask("GET", `/${app}/methods${query.size ? `?${query}` : ""}`);
        return textResult(JSON.stringify(data, null, 2));
      }
      const origin = options.origin?.() ?? "other";
      const batch = Array.isArray(params.batch) ? params.batch : null;
      if (batch) {
        if (!batch.length || batch.length > MAX_BATCH) return textResult(JSON.stringify({ error: `A batch holds 1 to ${MAX_BATCH} calls.` }));
        if (batch.some((item) => typeof item?.path !== "string" || !item.path.trim())) return textResult(JSON.stringify({ error: "Every call of a batch needs path." }));
      } else if (typeof params.path !== "string" || !params.path.trim()) {
        return textResult(JSON.stringify({ error: "A call needs path (or batch)." }));
      }
      const payload = batch
        ? { calls: batch.map((item) => callPayload(item)), origin }
        : { ...callPayload({ path: params.path as string, method: params.method, host: params.host, query: params.query, body: params.body }), origin };
      const { status, data } = await ask("POST", `/${app}/call`, payload);
      if (status === 202) {
        const request = (data.request && typeof data.request === "object" ? data.request : {}) as Record<string, unknown>;
        const card = origin === "web" && typeof request.approveUrl === "string";
        return textResult(JSON.stringify({
          ...data,
          ...(card
            ? {
                approval: {
                  url: request.approveUrl,
                  app,
                  calls: Array.isArray(request.calls) ? request.calls : [],
                  until: typeof request.expiresAt === "string" ? request.expiresAt : "",
                },
              }
            : {}),
          note: card
            ? "Not done yet. The person sees exactly what will run under your answer, with a button that opens the deployment's page where only they can allow it. You cannot allow it and there is no other way: in one line ask them to look and press the button, and do not repeat the details. Check later with action request."
            : request.waitsIn === "telegram"
              ? "Not done yet: the owner has to allow it in their Telegram. Tell the person it waits for their yes there; check with action request."
              : request.waitsIn === "email"
                ? "Not done yet: the owner has to allow it by the link in their email. Tell the person; check with action request."
                : "Not done yet: it waits for the owner's yes on the Apps page of this workspace. Tell the person; check with action request.",
        }, null, 2));
      }
      return textResult(JSON.stringify(data, null, 2));
    },
  });
}

function callPayload(item: { path: string; method?: unknown; host?: unknown; query?: unknown; body?: unknown }): Record<string, unknown> {
  return {
    path: item.path,
    ...(typeof item.method === "string" && item.method ? { method: item.method } : {}),
    ...(typeof item.host === "string" && item.host ? { host: item.host } : {}),
    ...(item.query && typeof item.query === "object" ? { query: item.query } : {}),
    ...(item.body !== undefined ? { body: item.body } : {}),
  };
}

