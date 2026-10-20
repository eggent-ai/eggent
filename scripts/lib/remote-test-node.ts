/**
 * One side of a paired workspace and computer, as a process, for the tests.
 *
 * The app keeps its data under the working directory it was started in and
 * reads that directory when its modules load, so two sides cannot live in one
 * process. This is the smallest server that puts the real chat routes behind a
 * port: Node's request in, the route's `Response` out, streamed. No middleware,
 * no pages - the routes themselves check what they check (the session, the
 * origin) and the test supplies the rest.
 *
 * Configured through the environment:
 *   NODE_ROOT         the directory to run in (its data/ is this side's data)
 *   NODE_PORT         0 for any
 *   PROVIDER_URL/KEY  the stub model, as an OpenAI-compatible endpoint
 *   EGGENT_REMOTE_*   as in a real install
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = process.env.NODE_ROOT;
if (!root) throw new Error("NODE_ROOT is required");
process.chdir(root);

const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      stub: {
        name: "Stub",
        baseUrl: `${process.env.PROVIDER_URL}/v1`,
        api: "openai-completions",
        models: [{ id: "stub-model", name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }],
      },
    },
  })
);
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ stub: { type: "api_key", key: process.env.PROVIDER_KEY || "test-key" } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-model" }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_LEARNING = "off";

const { NextRequest } = await import("next/server");
const chat = await import("../../src/app/api/chat/route.ts");
const stop = await import("../../src/app/api/chat/[chatId]/stop/route.ts");
const head = await import("../../src/app/api/chat/[chatId]/head/route.ts");
const stream = await import("../../src/app/api/chat/[chatId]/stream/route.ts");
const history = await import("../../src/app/api/chat/history/route.ts");
const activeRuns = await import("../../src/app/api/chat/active-runs/route.ts");
const home = await import("../../src/app/api/chat/home/route.ts");
const status = await import("../../src/app/api/remote/status/route.ts");
const respond = await import("../../src/app/api/pi-runs/[runId]/interactions/[interactionId]/respond/route.ts");
const external = await import("../../src/app/api/external/message/route.ts");

type Handler = (req: InstanceType<typeof NextRequest>, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> | Response;

interface Route {
  method: string;
  pattern: RegExp;
  names: string[];
  handler: Handler;
}

function route(method: string, pattern: string, handler: unknown): Route {
  const names: string[] = [];
  const source = pattern.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${source}$`), names, handler: handler as Handler };
}

const routes: Route[] = [
  route("POST", "/api/chat", chat.POST),
  route("POST", "/api/chat/home", home.POST),
  route("GET", "/api/chat/history", history.GET),
  route("GET", "/api/chat/active-runs", activeRuns.GET),
  route("POST", "/api/chat/:chatId/stop", stop.POST),
  route("GET", "/api/chat/:chatId/head", head.GET),
  route("GET", "/api/chat/:chatId/stream", stream.GET),
  route("GET", "/api/remote/status", status.GET),
  route("POST", "/api/pi-runs/:runId/interactions/:interactionId/respond", respond.POST),
  route("POST", "/api/external/message", external.POST),
];

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (part) => parts.push(Buffer.from(part)));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const method = req.method || "GET";
  let matched: { route: Route; params: Record<string, string> } | null = null;
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const match = candidate.pattern.exec(decodeURIComponent(url.pathname));
    if (!match) continue;
    matched = { route: candidate, params: Object.fromEntries(candidate.names.map((name, index) => [name, match[index + 1]])) };
    break;
  }
  if (!matched) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such route", path: url.pathname }));
    return;
  }

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (value !== undefined) headers.set(name, value);
    }
    const nextRequest = new NextRequest(url, { method, headers, body: body && body.length > 0 ? new Uint8Array(body) : undefined, signal: controller.signal });
    const response = await matched.route.handler(nextRequest, { params: Promise.resolve(matched.params) });
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      outHeaders[name] = value;
    });
    res.writeHead(response.status, outHeaders);
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise<void>((resolve) => res.once("drain", resolve));
        if (controller.signal.aborted) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    res.end();
  } catch (error) {
    console.error("[test-node] handler failed:", error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(Number(process.env.NODE_PORT || 0), "127.0.0.1", () => {
  const address = server.address();
  console.log(`READY ${typeof address === "object" && address ? address.port : 0}`);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
