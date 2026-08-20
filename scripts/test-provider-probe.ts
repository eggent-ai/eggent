/**
 * Checks the provider diagnosis that gates what a failing workspace is told.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-provider-probe.ts
 *
 * Everything that can be decided without a network runs by default. The three
 * cases that need a live OpenAI-compatible endpoint are opt-in, because a test
 * suite should not depend on somebody else's uptime:
 *
 *   EGGENT_PROBE_TEST_BASE_URL=https://your-provider.example/v1 \
 *     node --experimental-strip-types scripts/test-provider-probe.ts
 *
 * No credential is needed for them. A 401 proves the endpoint is alive just as
 * well as a 200, which is the whole point of the probe.
 */
import assert from "node:assert/strict";
import { canProbeProviderApi, isLocalOnlyBaseUrl, probeModelProvider } from "../src/lib/pi/provider-probe.ts";

let failed = 0;
let ran = 0;
let skipped = 0;

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

console.log("isLocalOnlyBaseUrl - addresses a hosted workspace cannot reach:");
for (const url of [
  "http://127.0.0.1:1234",
  "http://127.0.0.1:1234/v1",
  "http://localhost:11434",
  "http://LOCALHOST:1234/v1",
  "http://192.168.1.50:1234",
  "http://10.0.0.5:8080",
  "http://172.16.4.4:1234",
  "http://172.31.255.1:1234",
  "http://0.0.0.0:1234",
  "http://[::1]:1234",
]) {
  await check(`local: ${url}`, () => assert.equal(isLocalOnlyBaseUrl(url), true));
}

console.log("\nisLocalOnlyBaseUrl - ordinary addresses must not match:");
for (const url of [
  "https://api.example.com/v1",
  "https://models.example.org/openai/v1",
  // Just outside the private ranges, where an off-by-one would show up.
  "http://172.32.0.1:1234",
  "http://11.0.0.1:1234",
  // Starts with "localhost" but is not it.
  "https://localhost.example.com/v1",
]) {
  await check(`remote: ${url}`, () => assert.equal(isLocalOnlyBaseUrl(url), false));
}
await check("nonsense instead of a URL is not local", () =>
  assert.equal(isLocalOnlyBaseUrl("not a url"), false)
);

console.log("\ncanProbeProviderApi - only the dialect the probe speaks:");
for (const api of ["openai-completions", "openai-responses", "azure-openai-responses", "OPENAI-COMPLETIONS"]) {
  await check(`probe: ${api}`, () => assert.equal(canProbeProviderApi(api), true));
}
await check("an unset dialect counts as OpenAI-compatible (the add_provider default)", () =>
  assert.equal(canProbeProviderApi(undefined), true)
);
// These authenticate differently; probing them the OpenAI way would report a
// rejected key for a key that is fine.
for (const api of [
  "anthropic-messages",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
  "openai-codex-responses",
]) {
  await check(`do not probe: ${api}`, () => assert.equal(canProbeProviderApi(api), false));
}

console.log("\nprobeModelProvider - classification:");
await check("not a URL -> not_checked, with no network call", async () => {
  const r = await probeModelProvider({ baseUrl: "ftp://example.com" });
  assert.equal(r.reason, "not_checked");
});
await check("host that does not resolve -> unreachable", async () => {
  const r = await probeModelProvider({ baseUrl: "https://nonexistent.invalid/v1", timeoutMs: 6000 });
  assert.equal(r.reason, "unreachable");
  assert.equal(r.ok, false);
});
await check("closed local port -> unreachable", async () => {
  const r = await probeModelProvider({ baseUrl: "http://127.0.0.1:59999/v1", timeoutMs: 4000 });
  assert.equal(r.reason, "unreachable");
});

const liveBaseUrl = process.env.EGGENT_PROBE_TEST_BASE_URL?.trim();
if (!liveBaseUrl) {
  skipped = 3;
  console.log("  skip  live endpoint cases (set EGGENT_PROBE_TEST_BASE_URL to run them)");
} else {
  await check("a live provider with no key -> unauthorized or a catalogue", async () => {
    const r = await probeModelProvider({ baseUrl: liveBaseUrl, timeoutMs: 15000 });
    // Both answers prove the endpoint itself is alive, which is what the probe
    // exists to establish. Which one comes back depends on whether that
    // provider lists its models to anonymous callers.
    assert.ok(
      r.reason === "unauthorized" || r.reason === "ok",
      `expected unauthorized or ok, got ${r.reason} (status=${r.status})`
    );
  });
  await check("a model the provider does not have -> model_missing", async () => {
    const r = await probeModelProvider({
      baseUrl: liveBaseUrl,
      model: "no-such-model-xyz-000",
      timeoutMs: 15000,
    });
    // A provider that hides its catalogue cannot tell a missing model from a
    // rejected key, and saying "unauthorized" there is the honest answer.
    assert.ok(
      r.reason === "model_missing" || r.reason === "unauthorized",
      `expected model_missing or unauthorized, got ${r.reason}`
    );
    if (r.reason === "model_missing") {
      assert.ok((r.models || []).length > 0, "a missing model must come with the list of what exists");
    }
  });
  await check("a model the provider does have -> ok", async () => {
    const list = await probeModelProvider({ baseUrl: liveBaseUrl, timeoutMs: 15000 });
    if (list.reason !== "ok") {
      console.log(`        (catalogue not public at ${liveBaseUrl}, nothing to name)`);
      return;
    }
    const first = (list.models || [])[0];
    assert.ok(first, "an ok catalogue must list at least one model");
    const r = await probeModelProvider({ baseUrl: liveBaseUrl, model: first, timeoutMs: 15000 });
    assert.equal(r.ok, true);
    assert.equal(r.reason, "ok");
  });
}

console.log(
  failed === 0
    ? `\nall ${ran} checks passed${skipped ? `, ${skipped} skipped` : ""}`
    : `\n${failed} of ${ran} failed`
);
process.exit(failed === 0 ? 0 : 1);
