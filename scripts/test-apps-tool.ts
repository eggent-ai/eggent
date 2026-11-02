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
    if (req.url === "/apps") return res.end(JSON.stringify({ apps: [{ id: "bitrix24", connected: false }] }));
    if (req.url === "/apps/bitrix24") return res.end(JSON.stringify({ id: "bitrix24", connected: false, connectUrl: "https://ws.example.test/__eggent/apps#bitrix24", guide: "crm.deal.list" }));
    if (req.url === "/apps/amocrm/call" && body.includes("POST")) {
      res.statusCode = 202;
      return res.end(JSON.stringify({ pending: true, request: { id: "0f0e0d0c-0b0a-4908-8706-050403020100", status: "pending" } }));
    }
    if (req.url === "/apps/amocrm/call") return res.end(JSON.stringify({ status: 200, ok: true, body: "{\"leads\":[]}" }));
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const { appsEnabled, createAppsTool } = await import("../src/lib/apps/tool.ts");
const { appsConnectUrlFromToolOutput } = await import("../src/lib/apps/connect-link.ts");

type ToolLike = { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> };
const run = async (params: Record<string, unknown>) => {
  const tool = createAppsTool() as unknown as ToolLike;
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
});
await check("a guide of an app not connected carries connect.url for the chat's button", async () => {
  const data = await run({ action: "guide", app: "bitrix24" });
  assert.deepEqual(data.connect, { url: "https://ws.example.test/__eggent/apps#bitrix24" });
  assert.equal(appsConnectUrlFromToolOutput(JSON.stringify(data)), "https://ws.example.test/__eggent/apps#bitrix24");
  assert.equal(appsConnectUrlFromToolOutput({ content: [{ type: "text", text: JSON.stringify(data) }] }), "https://ws.example.test/__eggent/apps#bitrix24");
});
await check("a call goes through as asked", async () => {
  const data = await run({ action: "call", app: "amocrm", path: "/api/v4/leads", query: { limit: 5 } });
  assert.equal(data.ok, true);
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { path: "/api/v4/leads", query: { limit: 5 } });
});
await check("a write that waits says so, and is not reported as done", async () => {
  const data = await run({ action: "call", app: "amocrm", method: "POST", path: "/api/v4/leads", body: [{ name: "x" }] });
  assert.equal(data.pending, true);
  assert.match(String(data.note), /Not done yet/);
});
await check("a bad app id or a call with no path never reaches the service", async () => {
  const before = seen.length;
  assert.match(String((await run({ action: "guide", app: "../x" })).error), /Name the app/);
  assert.match(String((await run({ action: "call", app: "amocrm" })).error), /path/);
  assert.equal(seen.length, before);
});
await check("a link that is not http(s) is never a button", () => {
  assert.equal(appsConnectUrlFromToolOutput(JSON.stringify({ connect: { url: "javascript:alert(1)" } })), null);
});

server.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
