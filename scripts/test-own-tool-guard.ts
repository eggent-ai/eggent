/**
 * A call to the mcp proxy meant for one of the session's own tools is turned
 * back with that tool's name.
 *
 * Run with Node 22:
 *   npm run test:own-tool-guard
 *
 * Reads the real Eggent tool schemas, so the case that cost a new workspace
 * seven proxy calls in a row - mcp({action: "status", bot_token: "", mode: ""})
 * meant for eggent_manage_telegram - is checked against the tool as it ships.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-own-tool-guard-"));
process.chdir(root);
fs.mkdirSync(path.join(root, "data", "projects"), { recursive: true });
process.env.EGGENT_LEARNING = "off";

const { createEggentPiTools } = await import("../src/lib/pi/eggent-tools.ts");
const { meantForOwnTool, ownToolRedirect } = await import("../src/lib/pi/own-tool-guard.ts");

const { tools } = await createEggentPiTools({ chatId: "chat-g", scopeId: "none", cwd: path.join(root, "data", "projects") } as never);
const infos = (tools as unknown as Array<{ name: string; parameters: unknown }>).map((tool) => ({ name: tool.name, parameters: tool.parameters }));
// The proxy itself sits beside them, as it does in a session.
infos.push({ name: "mcp", parameters: { type: "object", properties: { tool: {}, args: {}, server: {}, action: {}, limit: {} } } });

await check("the telegram call from the new workspace goes to eggent_manage_telegram", () => {
  assert.equal(meantForOwnTool("mcp", { action: "status", bot_token: "", mode: "" }, infos), "eggent_manage_telegram");
  assert.equal(meantForOwnTool("mcp", { action: "status" }, infos), "eggent_manage_telegram");
  assert.equal(meantForOwnTool("mcp", { action: "link_shared", bot_token: "", mode: "polling", user_id: "" }, infos), "eggent_manage_telegram");
});

await check("a schedule action goes to the schedule tool", () => {
  assert.equal(meantForOwnTool("mcp", { action: "list" }, infos), "eggent_manage_schedules");
});

await check("the proxy's own calls are left alone", () => {
  assert.equal(meantForOwnTool("mcp", { connect: "notion" }, infos), null);
  assert.equal(meantForOwnTool("mcp", { tool: "search_pages", args: { query: "x" } }, infos), null);
  assert.equal(meantForOwnTool("mcp", { search: "status" }, infos), null);
  assert.equal(meantForOwnTool("mcp", { action: "auth-start", server: "notion" }, infos), null);
  assert.equal(meantForOwnTool("mcp", { action: "ui-messages" }, infos), null);
  assert.equal(meantForOwnTool("mcp", { server: "notion" }, infos), null);
  assert.equal(meantForOwnTool("mcp", {}, infos), null);
});

await check("a key no own tool takes, or an action none accepts, is left alone", () => {
  assert.equal(meantForOwnTool("mcp", { action: "status", flavour: "x" }, infos), null);
  assert.equal(meantForOwnTool("mcp", { action: "no-such-action" }, infos), null);
});

await check("only mcp calls are looked at", () => {
  assert.equal(meantForOwnTool("eggent_manage_telegram", { action: "status" }, infos), null);
});

await check("the redirect names the tool", () => {
  assert.match(ownToolRedirect("eggent_manage_telegram"), /call eggent_manage_telegram directly \(not mcp\)/);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
if (failed) process.exit(1);
