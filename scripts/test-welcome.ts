/**
 * A new workspace's first question: when it stands, what may be reported, and
 * what the agent may leave with a Telegram link.
 *
 * Run with Node 22:
 *   node --experimental-strip-types --import ./scripts/alias-loader-register.mjs scripts/test-welcome.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-welcome-"));
process.chdir(root);

const { welcomeDue, validWelcomeEvent, reportWelcomeEvent, FIRST_SHIFT_SKILL } = await import("../src/lib/employees/welcome.ts");
const { hasAnyChat } = await import("../src/lib/storage/chat-store.ts");

let failed = 0;
async function check(name: string, fn: () => unknown) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : error}`); }
}

const skills = [{ name: FIRST_SHIFT_SKILL }, { name: "employee-marketer" }];
const chatsDir = path.join(root, "data", "chats");

await check("a new workspace with the skill gets the question", async () => {
  assert.equal(await hasAnyChat(), false);
  assert.equal(await welcomeDue(skills, 0, false), true);
});
await check("a deployment without the skill never does", async () => {
  assert.equal(await welcomeDue([{ name: "employee-marketer" }], 0, false), false);
  assert.equal(await welcomeDue([], 0, false), false);
});
await check("an employee hired, or one waiting to start, ends it", async () => {
  assert.equal(await welcomeDue(skills, 1, false), false);
  assert.equal(await welcomeDue(skills, 0, true), false);
});
await check("a single chat ends it, without reading the chat", async () => {
  await fs.mkdir(chatsDir, { recursive: true });
  await fs.writeFile(path.join(chatsDir, "a.json"), "this is not even json");
  assert.equal(await hasAnyChat(), true);
  assert.equal(await welcomeDue(skills, 0, false), false);
  await fs.rm(path.join(chatsDir, "a.json"));
});
await check("only names of steps may be reported", () => {
  for (const good of ["shown", "typed", "skipped", "apps", "button:marketer"]) assert.ok(validWelcomeEvent(good), good);
  for (const bad of ["", "button:", "button:../x", "what the person wrote", 1, null, undefined]) assert.ok(!validWelcomeEvent(bad), String(bad));
});
await check("a step goes to the deployment with the services token, and a failure holds nothing up", async () => {
  const seen: Array<{ url: string; auth: string | null; body: string }> = [];
  const real = globalThis.fetch;
  process.env.EGGENT_ONBOARDING_EVENT_URL = "https://cloud.example.test/api/instances/w/onboarding-event";
  process.env.EGGENT_SERVICES_TOKEN = "eggs_x";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: String(init.body) });
    throw new Error("down");
  }) as typeof fetch;
  await reportWelcomeEvent("shown");
  globalThis.fetch = real;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, "Bearer eggs_x");
  assert.equal(seen[0].body, JSON.stringify({ event: "shown" }));
  delete process.env.EGGENT_ONBOARDING_EVENT_URL;
  await reportWelcomeEvent("shown");
  assert.equal(seen.length, 1, "no address, no call");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall ok");
