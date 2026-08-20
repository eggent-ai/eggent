/**
 * Reproduces the workspace that held a valid gateway token and no model to run
 * it on, and checks that coming back to the included model repairs it.
 *
 * Run with Node 22:
 *   node --experimental-strip-types --import ./scripts/alias-loader-register.mjs \
 *        scripts/test-managed-provider-repair.ts
 *
 * The fault: models.json is editable from the settings screen, the included
 * model's entry was only ever written when the workspace was created, and
 * nothing put it back. Losing it left every chat answering "no model is
 * selected" while the settings screen still showed the included model as
 * connected.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-repair-"));
const agentDir = path.join(workDir, "pi-agent");
await fs.mkdir(agentDir, { recursive: true });

// Set before the module loads: the agent dir is read at import time.
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_USAGE_API_URL = "https://cloud.example.test/api/instances/demo/usage";
process.env.EGGENT_AI_MODEL_LOCKED = "1";
process.env.EGGENT_AI_MODEL_LABEL = "Eggent AI";
delete process.env.EGGENT_MANAGED_AI_ENFORCED;
delete process.env.EGGENT_AI_MODEL_BASE_URL;

const { enableEggentAiModelLock, getEggentAiModelLockState } = await import("../src/lib/pi/config-store.ts");

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

const OWN_PROVIDER = {
  name: "My proxy",
  baseUrl: "https://proxy.example.test/v1",
  api: "openai-completions",
  models: [{ id: "some-model" }],
};

async function seed(models: unknown): Promise<void> {
  await fs.writeFile(
    path.join(agentDir, "auth.json"),
    JSON.stringify({
      "eggent-ai": { type: "api_key", key: "eggw_test_token_not_a_real_credential" },
      "my-proxy": { type: "api_key", key: "sk-test-not-a-real-credential" },
    }, null, 2),
    { mode: 0o600 }
  );
  await fs.writeFile(
    path.join(agentDir, "models.json"),
    typeof models === "string" ? models : JSON.stringify(models, null, 2),
    "utf-8"
  );
  await fs.rm(path.join(agentDir, "settings.json"), { force: true });
  await fs.rm(path.join(agentDir, "eggent-ai-lock.json"), { force: true });
}

async function readModels(): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf-8"));
}

async function readSettings(): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(path.join(agentDir, "settings.json"), "utf-8"));
}

console.log("Coming back to the included model repairs its lost entry:");

await check("the eggent-ai entry comes back with a baseUrl and a model", async () => {
  await seed({ providers: { "my-proxy": OWN_PROVIDER } });
  const repair = await enableEggentAiModelLock(workDir);
  assert.equal(repair.repaired, true);
  assert.equal(repair.backupPath, undefined);
  const entry = (await readModels()).providers["eggent-ai"];
  assert.equal(entry.baseUrl, "https://cloud.example.test/v1");
  assert.equal(entry.api, "openai-completions");
  assert.equal(entry.models[0].id, "eggent-ai");
});

await check("the user's own provider survived the repair untouched", async () => {
  assert.deepEqual((await readModels()).providers["my-proxy"], OWN_PROVIDER);
});

await check("settings.json holds the model id, not the provider id", async () => {
  const settings = await readSettings();
  assert.equal(settings.defaultProvider, "eggent-ai");
  assert.equal(settings.defaultModel, "eggent-ai");
});

await check("the workspace is back on the included model afterwards", async () => {
  assert.equal((await getEggentAiModelLockState(workDir)).locked, true);
});

await check("an emptied models.json - the case that happened - repairs too", async () => {
  await seed({ providers: {} });
  const repair = await enableEggentAiModelLock(workDir);
  assert.equal(repair.repaired, true);
  assert.ok((await readModels()).providers["eggent-ai"].baseUrl);
});

await check("a stub with no baseUrl is rewritten wholesale", async () => {
  await seed({ providers: { "eggent-ai": { name: "Eggent AI", models: [{ id: "eggent-ai" }] } } });
  const repair = await enableEggentAiModelLock(workDir);
  assert.equal(repair.repaired, true);
  assert.equal((await readModels()).providers["eggent-ai"].baseUrl, "https://cloud.example.test/v1");
});

await check("an intact entry is left alone", async () => {
  const repair = await enableEggentAiModelLock(workDir);
  assert.equal(repair.repaired, false);
});

await check("an unreadable models.json is set aside, not overwritten", async () => {
  await seed("{ this is not JSON");
  const repair = await enableEggentAiModelLock(workDir);
  assert.equal(repair.repaired, true);
  assert.ok(repair.backupPath, "the path of the kept copy was not reported");
  assert.equal(await fs.readFile(repair.backupPath!, "utf-8"), "{ this is not JSON");
  assert.ok((await readModels()).providers["eggent-ai"].baseUrl);
});

await check("an explicit EGGENT_AI_MODEL_BASE_URL wins over the derived one", async () => {
  process.env.EGGENT_AI_MODEL_BASE_URL = "https://gateway.example.test/v1/";
  try {
    await seed({ providers: {} });
    await enableEggentAiModelLock(workDir);
    assert.equal((await readModels()).providers["eggent-ai"].baseUrl, "https://gateway.example.test/v1");
  } finally {
    delete process.env.EGGENT_AI_MODEL_BASE_URL;
  }
});

await check("with no gateway address it fails loudly instead of guessing", async () => {
  const usage = process.env.EGGENT_USAGE_API_URL;
  delete process.env.EGGENT_USAGE_API_URL;
  try {
    await seed({ providers: { "my-proxy": OWN_PROVIDER } });
    await assert.rejects(() => enableEggentAiModelLock(workDir));
    // Nothing was touched: the workspace is exactly as it was found.
    assert.deepEqual(Object.keys((await readModels()).providers), ["my-proxy"]);
  } finally {
    process.env.EGGENT_USAGE_API_URL = usage;
  }
});

await fs.rm(workDir, { recursive: true, force: true });

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed === 0 ? 0 : 1);
