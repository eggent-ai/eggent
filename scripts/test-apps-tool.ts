/**
 * The agent's `eggent_apps` tool against a stand-in apps service: it is absent
 * without its environment, sends the services token, passes a call through as
 * asked, says plainly that a write waits for the owner, and puts the connect
 * link where the chat finds it for its Connect button.
 *
 *   node --experimental-strip-types --import ./scripts/alias-loader-register.mjs scripts/test-apps-tool.ts
 */
import assert from "node:assert/strict";
import http from "node:http";

let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const seen: Array<{ method: string; url: string; auth: string; body: string }> = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ method: req.method || "", url: req.url || "", auth: String(req.headers.authorization || ""), body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/apps") return res.end(JSON.stringify({ connectUrl: "https://ws.example.test/__eggent/apps", apps: [{ id: "crm-one", connected: false }] }));
    if (req.url === "/apps/crm-one") return res.end(JSON.stringify({ id: "crm-one", connected: false, connectUrl: "https://ws.example.test/__eggent/apps#crm-one", guide: "items.list" }));
    if (req.url?.startsWith("/apps/shop-one/methods")) return res.end(JSON.stringify({ app: "shop-one", total: 1, methods: [{ method: "POST", path: "/v1/stock/list", title: "Stock", kind: "read" }] }));
    if (req.url === "/apps/crm-two/call" && body.includes("POST")) {
      res.statusCode = 202;
      const asked = JSON.parse(body) as { origin?: string; calls?: unknown[] };
      return res.end(JSON.stringify({ pending: true, request: {
        id: "0f0e0d0c-0b0a-4908-8706-050403020100", status: "pending",
        waitsIn: asked.origin === "telegram" ? "telegram" : "browser",
        approveUrl: "https://cloud.example.test/apps/approve/0f0e0d0c-0b0a-4908-8706-050403020100",
        calls: (asked.calls ?? [asked]).map(() => "POST /api/v4/leads"),
        expiresAt: "2026-11-05T10:00:00.000Z",
      } }));
    }
    if (req.url === "/apps/crm-two/call") return res.end(JSON.stringify({ status: 200, ok: true, body: "{\"leads\":[]}" }));
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const { appsEnabled, createAppsTool } = await import("../src/lib/apps/tool.ts");
const { appApprovalFromToolOutput } = await import("../src/lib/apps/approval-card.ts");

type ToolLike = { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };
const run = async (params: Record<string, unknown>, origin?: "web" | "telegram" | "other") => {
  const tool = createAppsTool(origin ? { origin: () => origin } : {}) as unknown as ToolLike;
  const result = await tool.execute("t1", params);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
};

await check("without its environment there is no tool", () => {
  delete process.env.EGGENT_APPS_API_URL;
  assert.equal(appsEnabled(), false);
});

process.env.EGGENT_APPS_API_URL = `http://127.0.0.1:${port}/apps`;
process.env.EGGENT_SERVICES_TOKEN = "eggs_test_token";

await check("the list comes from the service, with the services token", async () => {
  const data = await run({ action: "list" });
  assert.equal((data.apps as unknown[]).length, 1);
  assert.equal(seen.at(-1)?.auth, "Bearer eggs_test_token");
  assert.equal(data.connect, undefined, "a list draws no Connect button");
});
await check("a guide of an app not connected gives the agent the page's link to pass on", async () => {
  const data = await run({ action: "guide", app: "crm-one" });
  assert.equal(data.connectUrl, "https://ws.example.test/__eggent/apps#crm-one");
  assert.equal(data.connected, false);
});
await check("a call goes through as asked", async () => {
  const data = await run({ action: "call", app: "crm-two", path: "/api/v4/leads", query: { limit: 5 } });
  assert.equal(data.ok, true);
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { path: "/api/v4/leads", query: { limit: 5 }, origin: "other" });
});
await check("a write that waits says so, and is not reported as done", async () => {
  const data = await run({ action: "call", app: "crm-two", method: "POST", path: "/api/v4/leads", body: [{ name: "x" }] });
  assert.equal(data.pending, true);
  assert.match(String(data.note), /Not done yet/);
});
await check("from the web chat a waiting write carries a card for the chat; from elsewhere it does not", async () => {
  const web = await run({ action: "call", app: "crm-two", method: "POST", path: "/api/v4/leads", body: [{ name: "x" }] }, "web");
  assert.equal(JSON.parse(seen.at(-1)!.body).origin, "web");
  const card = appApprovalFromToolOutput(JSON.stringify(web));
  assert.equal(card?.url, "https://cloud.example.test/apps/approve/0f0e0d0c-0b0a-4908-8706-050403020100");
  assert.deepEqual(card?.calls, ["POST /api/v4/leads"]);
  assert.match(String(web.note), /button/);
  const tg = await run({ action: "call", app: "crm-two", method: "POST", path: "/api/v4/leads", body: [] }, "telegram");
  assert.equal(tg.approval, undefined);
  assert.match(String(tg.note), /Telegram/);
});
await check("a batch goes as one request with every call", async () => {
  const data = await run({ action: "call", app: "crm-two", batch: [
    { method: "POST", path: "/api/v4/leads", body: [{ name: "a" }] },
    { method: "POST", path: "/api/v4/leads", body: [{ name: "b" }] },
  ] }, "web");
  const sent = JSON.parse(seen.at(-1)!.body);
  assert.equal(sent.calls.length, 2);
  assert.equal(sent.calls[1].body[0].name, "b");
  assert.equal(appApprovalFromToolOutput(JSON.stringify(data))?.calls.length, 2);
  const before = seen.length;
  assert.match(String((await run({ action: "call", app: "crm-two", batch: Array.from({ length: 11 }, () => ({ path: "/x" })) })).error), /1 to 10/);
  assert.match(String((await run({ action: "call", app: "crm-two", batch: [{ path: "" }] })).error), /path/);
  assert.equal(seen.length, before);
});
await check("a card is drawn only for this deployment's approval page shape", () => {
  const good = { approval: { url: "https://cloud.example.test/apps/approve/0f0e0d0c-0b0a-4908-8706-050403020100", calls: ["x"] } };
  assert.ok(appApprovalFromToolOutput(good));
  for (const url of ["javascript:alert(1)", "https://cloud.example.test/apps/approve/x", "https://cloud.example.test/apps/approve/0f0e0d0c-0b0a-4908-8706-050403020100?go=1"]) {
    assert.equal(appApprovalFromToolOutput({ approval: { url } }), null, url);
  }
});
await check("methods asks the service with the words and the section, and nothing else", async () => {
  const data = await run({ action: "methods", app: "shop-one", search: "stock warehouse", section: "Stocks & prices" });
  assert.equal(data.total, 1);
  const asked = new URL(seen.at(-1)!.url, "http://x");
  assert.equal(asked.pathname, "/apps/shop-one/methods");
  assert.equal(asked.searchParams.get("search"), "stock warehouse");
  assert.equal(asked.searchParams.get("section"), "Stocks & prices");
  assert.equal(seen.at(-1)!.method, "GET");
  await run({ action: "methods", app: "shop-one" });
  assert.equal(seen.at(-1)!.url, "/apps/shop-one/methods");
});
await check("a bad app id or a call with no path never reaches the service", async () => {
  const before = seen.length;
  assert.match(String((await run({ action: "guide", app: "../x" })).error), /Name the app/);
  assert.match(String((await run({ action: "methods", app: "a/b", search: "x" })).error), /Name the app/);
  assert.match(String((await run({ action: "call", app: "crm-two" })).error), /path/);
  assert.equal(seen.length, before);
});

server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
