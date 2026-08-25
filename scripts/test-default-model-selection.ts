/**
 * Checks that pointing the workspace at a provider's model says whether it
 * actually happened.
 *
 * Run with Node 22:
 *   node --experimental-strip-types --import ./scripts/alias-loader-register.mjs \
 *        scripts/test-default-model-selection.ts
 *
 * The fault: both ways of failing returned the current settings unchanged, and
 * POST /api/pi/auth answered 200 with them. A key that saved but never took
 * effect was indistinguishable from one that did, so a workspace kept answering
 * on the included model - and kept spending its credits - while its owner had
 * been told he was on his own provider.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-default-model-"));
const agentDir = path.join(workDir, "pi-agent");
await fs.mkdir(agentDir, { recursive: true });

// Set before the module loads: the agent dir is read at import time.
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_AI_MODEL_LABEL = "Eggent AI";
delete process.env.EGGENT_AI_MODEL_LOCKED;
delete process.env.EGGENT_MANAGED_AI_LOCKED;
delete process.env.EGGENT_MANAGED_AI_ENFORCED;

const { setPiApiKeyCredential, setPiDefaultToFirstAvailableModel } = await import("../src/lib/pi/config-store.ts");

let failed = 0;
let ran = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const PROVIDER = {
  name: "My proxy",
  baseUrl: "https://proxy.example.test/v1",
  api: "openai-completions",
  models: [{ id: "proxy-small" }],
};

async function seed(options: { key?: string; lockOverride?: boolean; settings?: unknown }): Promise<void> {
  await fs.writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({ providers: { proxy: PROVIDER } }, null, 2)
  );
  await fs.writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify(options.key ? { proxy: { type: "api_key", key: options.key } } : {}, null, 2)
  );
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify(options.settings ?? {}, null, 2)
  );
  if (options.lockOverride === undefined) {
    await fs.rm(path.join(agentDir, "eggent-ai-lock.json"), { force: true });
  } else {
    await fs.writeFile(
      path.join(agentDir, "eggent-ai-lock.json"),
      JSON.stringify({ disabled: options.lockOverride }, null, 2)
    );
  }
}

async function readSettings(): Promise<{ defaultProvider?: string; defaultModel?: string }> {
  try {
    return JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf-8"));
  } catch {
    return {};
  }
}

console.log("default model selection");

// The case that cost a customer his trial balance: the key is on disk, but the
// provider offers nothing the runtime can run, so nothing is selected.
await seed({});
const noModel = await setPiDefaultToFirstAvailableModel("proxy", workDir);
await check("a provider with no usable model reports that it did not switch", () => {
  assert.equal(noModel.switched, false);
  assert.equal(noModel.reason, "no_available_model");
  assert.equal(noModel.provider, "proxy");
});
await check("and it leaves the workspace default alone rather than half-writing it", async () => {
  const settings = await readSettings();
  assert.ok(!settings.defaultProvider, `expected no default provider, got ${settings.defaultProvider}`);
});

// A provider that can answer is selected, and the caller learns which model.
await seed({ key: "sk-test-key" });
const switched = await setPiDefaultToFirstAvailableModel("proxy", workDir);
await check("a provider with a key and a model is selected", () => {
  assert.equal(switched.switched, true);
  assert.equal(switched.provider, "proxy");
  assert.equal(switched.model, "proxy-small");
});
await check("and the choice is written to settings.json", async () => {
  const settings = await readSettings();
  assert.equal(settings.defaultProvider, "proxy");
  assert.equal(settings.defaultModel, "proxy-small");
});

// While the included model is locked in, selection is refused - and must say so
// instead of returning a state that looks configured.
await seed({
  key: "sk-test-key",
  settings: { defaultProvider: "eggent-ai", defaultModel: "eggent-ai" },
});
await fs.writeFile(
  path.join(agentDir, "auth.json"),
  JSON.stringify({ "eggent-ai": { type: "api_key", key: "eggw_test" }, proxy: { type: "api_key", key: "sk-test-key" } }, null, 2)
);
const locked = await setPiDefaultToFirstAvailableModel("proxy", workDir);
await check("a locked workspace reports the lock rather than silence", () => {
  assert.equal(locked.switched, false);
  assert.equal(locked.reason, "model_locked");
});
await check("and the included model stays selected", async () => {
  const settings = await readSettings();
  assert.equal(settings.defaultProvider, "eggent-ai");
});

// The exact sequence POST /api/pi/auth runs: save the key, then move onto it.
// Reading the credential back has to see the write that just happened, or the
// selection silently finds nothing and the workspace stays where it was.
await seed({});
await setPiApiKeyCredential("proxy", "sk-freshly-pasted");
const afterPaste = await setPiDefaultToFirstAvailableModel("proxy", workDir);
await check("a key saved a moment ago is visible to the selection that follows it", () => {
  assert.equal(
    afterPaste.switched,
    true,
    `expected the freshly saved key to be usable, got reason=${afterPaste.reason}`
  );
  assert.equal(afterPaste.model, "proxy-small");
});

await fs.rm(workDir, { recursive: true, force: true });

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed > 0 ? 1 : 0);
