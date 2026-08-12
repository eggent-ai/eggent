/**
 * Checks the provider diagnosis that gates what a failing workspace is told.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-provider-probe.ts
 * The network cases use public endpoints and no credentials — a 401 proves the
 * endpoint is alive just as well as a 200, which is the whole point.
 */
import assert from "node:assert/strict";
import { isLocalOnlyBaseUrl, probeModelProvider } from "../src/lib/pi/provider-probe.ts";

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

console.log("isLocalOnlyBaseUrl — адреса, которые из облака недостижимы:");
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
  await check(`локальный: ${url}`, () => assert.equal(isLocalOnlyBaseUrl(url), true));
}

console.log("\nisLocalOnlyBaseUrl — обычные адреса не должны попадать под правило:");
for (const url of [
  "https://api.deepseek.com/v1",
  "https://api.baza-ai.org/v1",
  "https://openrouter.ai/api/v1",
  "https://api.proxyapi.ru/openai/v1",
  "http://172.32.0.1:1234",
  "http://11.0.0.1:1234",
  "https://localhost.example.com/v1",
]) {
  await check(`внешний: ${url}`, () => assert.equal(isLocalOnlyBaseUrl(url), false));
}
await check("мусор вместо URL не считается локальным", () =>
  assert.equal(isLocalOnlyBaseUrl("not a url"), false)
);

console.log("\nprobeModelProvider — классификация (нужна сеть):");
await check("не-URL -> not_checked, без сетевого вызова", async () => {
  const r = await probeModelProvider({ baseUrl: "ftp://example.com" });
  assert.equal(r.reason, "not_checked");
});
await check("несуществующий хост -> unreachable", async () => {
  const r = await probeModelProvider({ baseUrl: "https://nonexistent.invalid/v1", timeoutMs: 6000 });
  assert.equal(r.reason, "unreachable");
  assert.equal(r.ok, false);
});
await check("закрытый локальный порт -> unreachable", async () => {
  const r = await probeModelProvider({ baseUrl: "http://127.0.0.1:59999/v1", timeoutMs: 4000 });
  assert.equal(r.reason, "unreachable");
});
await check("живой провайдер без ключа -> unauthorized", async () => {
  const r = await probeModelProvider({ baseUrl: "https://api.deepseek.com/v1", timeoutMs: 10000 });
  assert.equal(r.reason, "unauthorized");
  assert.ok(r.status === 401 || r.status === 403, `status=${r.status}`);
});
await check("открытый каталог -> ok со списком моделей", async () => {
  const r = await probeModelProvider({ baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 15000 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "ok");
  assert.ok((r.models || []).length > 0, "ожидался непустой список моделей");
});
await check("несуществующая модель у живого провайдера -> model_missing", async () => {
  const r = await probeModelProvider({
    baseUrl: "https://openrouter.ai/api/v1",
    model: "no-such-model-xyz-000",
    timeoutMs: 15000,
  });
  assert.equal(r.reason, "model_missing");
  assert.ok((r.models || []).length > 0, "в ответе должен быть список того, что есть");
});
await check("существующая модель у живого провайдера -> ok", async () => {
  const list = await probeModelProvider({ baseUrl: "https://openrouter.ai/api/v1", timeoutMs: 15000 });
  const first = (list.models || [])[0];
  assert.ok(first, "нужна хотя бы одна модель из каталога");
  const r = await probeModelProvider({ baseUrl: "https://openrouter.ai/api/v1", model: first, timeoutMs: 15000 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "ok");
});

console.log(
  failed === 0
    ? `\nвсе ${ran} проверок пройдены`
    : `\nпровалено ${failed} из ${ran}`
);
process.exit(failed === 0 ? 0 : 1);
