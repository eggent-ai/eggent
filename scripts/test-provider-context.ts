/**
 * Adding a provider keeps the context window its model list states.
 *
 * A model registered by id alone gets the runtime's default of 128k, and the
 * chat then reports that guess as the model's size - a million-token model
 * shown as 128k, which also makes compaction start far too early. Run:
 *   node --experimental-strip-types --import ./scripts/alias-loader-register.mjs \
 *     scripts/test-provider-context.ts
 *
 * No network: fetch is answered here, because the provider check refuses to
 * call loopback addresses and a real endpoint would make the test depend on it.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-context-"));
const agentDir = path.join(workDir, "pi-agent");
await fs.mkdir(agentDir, { recursive: true });

// Set before the module loads: the agent dir is read at import time.
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.EGGENT_MANAGED_AI_ENFORCED;
process.env.EGGENT_MODEL_CATALOG_REFRESH = "0";

let listing: unknown = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://models.example.test/")) {
    return new Response(JSON.stringify(listing), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { upsertCustomModelProvider } = await import("../src/lib/pi/config-store.ts");

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

async function registered(provider: string): Promise<Array<Record<string, unknown>>> {
  const parsed = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf-8"));
  return parsed.providers[provider].models;
}

try {
  console.log("add_provider - context windows from the provider's list:");

  listing = {
    data: [
      { id: "lab/long", context_length: 1_048_576, architecture: { input_modalities: ["text", "image"] } },
      { id: "lab/served-smaller", context_length: 1_048_576, top_provider: { context_length: 163_840 } },
      { id: "lab/silent" },
    ],
  };
  await check("stated windows are kept, an unstated one is left to the runtime", async () => {
    const result = await upsertCustomModelProvider({
      id: "aggregator",
      baseUrl: "https://models.example.test/v1",
      models: ["lab/long", "lab/served-smaller", "lab/silent"],
      apiKey: "test-key",
    });
    assert.equal(result.contextKnown, 2);
    const models = await registered("aggregator");
    assert.deepEqual(models[0], { id: "lab/long", input: ["text", "image"], contextWindow: 1_048_576 });
    assert.deepEqual(models[1], { id: "lab/served-smaller", contextWindow: 163_840 });
    assert.deepEqual(models[2], { id: "lab/silent" });
  });

  listing = { data: [{ id: "plain-1", object: "model" }, { id: "plain-2", object: "model" }] };
  await check("a list of ids only registers ids, as before", async () => {
    const result = await upsertCustomModelProvider({
      id: "plain",
      baseUrl: "https://models.example.test/v1",
      models: ["plain-1", "plain-2"],
      apiKey: "test-key",
    });
    assert.equal(result.contextKnown, 0);
    assert.deepEqual(await registered("plain"), [{ id: "plain-1" }, { id: "plain-2" }]);
  });

  await check("a loopback provider is not called and registers ids only", async () => {
    const result = await upsertCustomModelProvider({
      id: "local",
      baseUrl: "http://127.0.0.1:1/v1",
      models: ["llama"],
    });
    assert.equal(result.contextKnown, 0);
    assert.deepEqual(await registered("local"), [{ id: "llama" }]);
    // The first two providers are still there beside it.
    assert.equal((await registered("aggregator")).length, 3);
  });
} finally {
  globalThis.fetch = realFetch;
  await fs.rm(workDir, { recursive: true, force: true });
}

console.log(failed === 0 ? `\nall ${ran} checks passed` : `\n${failed} of ${ran} checks failed`);
if (failed > 0) process.exit(1);
