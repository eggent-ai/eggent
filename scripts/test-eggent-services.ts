/**
 * One rule for what the included model does besides the chat: images, voice
 * and the learning look-back use it while the workspace answers on it, none of
 * them once it leaves, each can be turned back on alone, and leaving again
 * turns them off - along with any project put on one of its models.
 *
 * Drives the real config store on a throwaway agent directory and the real
 * project store on a throwaway data directory; nothing reaches a network.
 * Run: npm run test:eggent-services
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-services-"));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir, { recursive: true });
// The project store finds data/projects under the working directory.
process.chdir(root);
process.env.PI_CODING_AGENT_DIR = agentDir;
// Never called: everything here is decided from files.
process.env.EGGENT_AI_MODEL_BASE_URL = "http://127.0.0.1:9/v1";
for (const name of [
  "EGGENT_MANAGED_AI_ENFORCED",
  "EGGENT_AI_MODEL_LOCKED",
  "EGGENT_MANAGED_AI_LOCKED",
  "EGGENT_MANAGED_AI_TOKEN",
  "EGGENT_USAGE_API_TOKEN",
  "EGGENT_STT_CLOUD",
]) delete process.env[name];

function writeJson(name: string, value: unknown): void {
  fs.writeFileSync(path.join(agentDir, name), JSON.stringify(value, null, 2));
}
const exists = (name: string) => fs.existsSync(path.join(agentDir, name));

writeJson("auth.json", {
  "eggent-ai": { type: "api_key", key: "eggw_test_token" },
  own: { type: "api_key", key: "sk-own" },
  speaks: { type: "api_key", key: "sk-speaks" },
  sub: { type: "oauth", access: "token", refresh: "refresh", expires: 0 },
});
writeJson("models.json", {
  providers: {
    "eggent-ai": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-responses", models: [{ id: "m-small" }, { id: "m-big" }] },
    own: { baseUrl: "http://127.0.0.1:9/own/v1", api: "openai-completions", models: [{ id: "own-chat" }] },
    speaks: { baseUrl: "http://127.0.0.1:9/speaks", api: "anthropic-messages", models: [{ id: "speaks-chat" }] },
  },
});

function onIncludedModel(): void {
  writeJson("settings.json", { defaultProvider: "eggent-ai", defaultModel: "m-small" });
  fs.rmSync(path.join(agentDir, "eggent-ai-lock.json"), { force: true });
}
function onOwnProvider(): void {
  writeJson("settings.json", { defaultProvider: "own", defaultModel: "own-chat" });
}

const store = await import("../src/lib/pi/config-store.ts");
const projects = await import("../src/lib/storage/project-store.ts");
const { pickReviewCandidate } = await import("../src/lib/learning/review-model.ts");

console.log("on the included model everything uses it:");
onIncludedModel();
await check("images are the included model's", async () => {
  const images = await store.getImageGenerationState();
  assert.equal(images.enabled, true);
  assert.equal(images.provider, "eggent");
});
await check("voice goes to the included model's gateway", async () => {
  const speech = await store.getSpeechTranscriptionState();
  assert.equal(speech.use, "eggent");
  assert.equal(speech.automatic, true);
  assert.equal((await store.resolveSpeechBackend())?.kind, "eggent");
});
await check("the look-back may use it", async () => {
  assert.deepEqual(await store.learningModelPolicy("own"), { managedAllowed: true, managedFirst: false });
});
await check("nothing can be switched on top of it", async () => {
  await assert.rejects(store.setServiceChoice({ service: "speech", use: "eggent" }), /already/);
});

console.log("\non the workspace's own model nothing uses it:");
onOwnProvider();
await check("no images", async () => {
  const images = await store.getImageGenerationState();
  assert.equal(images.enabled, false);
  assert.equal(images.reason, "no_image_model_selected");
});
await check("voice is whisper here", async () => {
  assert.equal((await store.getSpeechTranscriptionState()).use, "local");
  assert.equal(await store.resolveSpeechBackend(), null);
});
await check("the look-back stays off it", async () => {
  assert.deepEqual(await store.learningModelPolicy("own"), { managedAllowed: false, managedFirst: false });
});
await check("unless the chat itself is on it, by a project's choice", async () => {
  assert.deepEqual(await store.learningModelPolicy("eggent-ai"), { managedAllowed: true, managedFirst: false });
});

console.log("\neach one can be turned back on alone:");
await check("images", async () => {
  await store.setServiceChoice({ service: "images", use: "eggent" });
  const images = await store.getImageGenerationState();
  assert.equal(images.provider, "eggent");
  assert.equal((await store.resolveImageBackend())?.managed, true);
});
await check("voice", async () => {
  await store.setServiceChoice({ service: "speech", use: "eggent" });
  const speech = await store.getSpeechTranscriptionState();
  assert.equal(speech.use, "eggent");
  assert.equal(speech.automatic, false);
  const backend = await store.resolveSpeechBackend();
  assert.equal(backend?.kind, "eggent");
  assert.equal(backend?.token, "eggw_test_token");
});
await check("the look-back, which then prefers it", async () => {
  await store.setServiceChoice({ service: "learning", use: "eggent" });
  assert.deepEqual(await store.learningModelPolicy("own"), { managedAllowed: true, managedFirst: true });
});
await check("all three are remembered in one file", async () => {
  assert.deepEqual(await store.readServiceOptIns(), { images: true, speech: true, learning: true });
});

console.log("\none choice per service:");
await check("an image provider replaces the included model for images", async () => {
  await store.setServiceChoice({ service: "images", use: "provider", provider: "own", model: "draw-1" });
  const images = await store.getImageGenerationState();
  assert.equal(images.provider, "custom");
  assert.equal(images.model, "draw-1");
  assert.equal((await store.readServiceOptIns()).images, false);
});
await check("turning images off forgets the provider", async () => {
  await store.setServiceChoice({ service: "images", use: "off" });
  assert.equal((await store.getImageGenerationState()).enabled, false);
  assert.equal(exists("image-generation.json"), false);
});
await check("a voice provider replaces the included model for voice", async () => {
  await store.setServiceChoice({ service: "speech", use: "provider", provider: "own", model: "listen-1" });
  const speech = await store.getSpeechTranscriptionState();
  assert.equal(speech.use, "provider");
  assert.equal(speech.reason, undefined);
  const backend = await store.resolveSpeechBackend();
  assert.equal(backend?.kind, "provider");
  assert.equal(backend?.url, "http://127.0.0.1:9/own/v1/audio/transcriptions");
  assert.equal(backend?.token, "sk-own");
  assert.equal((await store.readServiceOptIns()).speech, false);
});
await check("the included model for voice forgets the provider", async () => {
  await store.setServiceChoice({ service: "speech", use: "eggent" });
  assert.equal(exists("speech-transcription.json"), false);
  await store.setServiceChoice({ service: "speech", use: "local" });
  assert.equal((await store.getSpeechTranscriptionState()).use, "local");
});

console.log("\nwhat cannot serve is refused, not saved:");
await check("a subscription sign-in has no key for images", async () => {
  await assert.rejects(store.setServiceChoice({ service: "images", use: "provider", provider: "sub", model: "x" }), /API key/);
});
await check("nor for voice", async () => {
  await assert.rejects(store.setServiceChoice({ service: "speech", use: "provider", provider: "sub", model: "x" }), /API key/);
});
await check("a provider that does not speak the OpenAI API cannot transcribe", async () => {
  await assert.rejects(store.setServiceChoice({ service: "speech", use: "provider", provider: "speaks", model: "x" }), /OpenAI/);
});
await check("an unknown provider is not connected", async () => {
  await assert.rejects(store.setServiceChoice({ service: "speech", use: "provider", provider: "nobody", model: "x" }), /Connect nobody first/);
});
await check("none of those touched the voice choice", async () => {
  assert.equal((await store.getSpeechTranscriptionState()).use, "local");
});
await check("a provider that later loses its key is reported, and whisper answers", async () => {
  writeJson("speech-transcription.json", { provider: "sub", model: "x" });
  const speech = await store.getSpeechTranscriptionState();
  assert.equal(speech.use, "provider");
  assert.equal(speech.reason, "provider_has_no_key");
  assert.equal(await store.resolveSpeechBackend(), null);
  await store.setServiceChoice({ service: "speech", use: "local" });
});

console.log("\nthe look-back's model:");
const available = [
  { provider: "eggent-ai", id: "m-small" },
  { provider: "eggent-ai", id: "m-big" },
  { provider: "own", id: "own-chat" },
];
const isManaged = (provider: string) => provider === "eggent-ai";
await check("the deployment's model is not taken off the included model's turf", () => {
  const picked = pickReviewCandidate({ available, override: "m-small", preferred: { provider: "own", id: "own-chat" }, managedAllowed: false, managedFirst: false, isManaged });
  assert.deepEqual(picked, { provider: "own", id: "own-chat" });
});
await check("where the included model is allowed, the deployment's model wins", () => {
  const picked = pickReviewCandidate({ available, override: "m-small", preferred: { provider: "eggent-ai", id: "m-big" }, managedAllowed: true, managedFirst: false, isManaged });
  assert.deepEqual(picked, { provider: "eggent-ai", id: "m-small" });
});
await check("turned on with no model named, the included default answers, not the chat's model", () => {
  const picked = pickReviewCandidate({ available, preferred: { provider: "own", id: "own-chat" }, managedAllowed: true, managedFirst: true, isManaged, managedDefaultId: "m-big" });
  assert.deepEqual(picked, { provider: "eggent-ai", id: "m-big" });
});
await check("off it with nothing usable, nothing is picked here", () => {
  const picked = pickReviewCandidate({ available: available.slice(0, 2), override: "m-small", managedAllowed: false, managedFirst: false, isManaged });
  assert.equal(picked, undefined);
});

console.log("\ncoming back and leaving again:");
async function makeProject(id: string, model: Record<string, unknown>): Promise<void> {
  await projects.createProject({ id, name: id, description: "", instructions: "", memoryMode: "isolated" });
  await projects.saveProjectModelSettingsFile(id, JSON.stringify(model));
}
const projectModel = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(root, "data", "projects", id, "model.json"), "utf-8")) as Record<string, unknown>;

await makeProject("on-included", { inheritsGlobal: false, provider: "eggent-ai", model: "m-big", note: "kept" });
await makeProject("on-own", { inheritsGlobal: false, provider: "own", model: "own-chat" });
await makeProject("following", { inheritsGlobal: true });

await store.setServiceChoice({ service: "images", use: "eggent" });
await store.setServiceChoice({ service: "learning", use: "eggent" });
await check("coming back clears what was turned on while away", async () => {
  await store.enableEggentAiModelLock();
  assert.equal((await store.getEggentAiModelLockState()).locked, true);
  assert.equal(exists("eggent-ai-services.json"), false);
});
await check("coming back leaves projects alone", () => {
  assert.equal(projectModel("on-included").inheritsGlobal, false);
});

// Something turned on and somehow kept - a hand edit, a file synced in - is
// still turned off by leaving.
writeJson("eggent-ai-services.json", { images: true, speech: true, learning: true });
await check("leaving turns every service off", async () => {
  await store.disableEggentAiModelLock();
  assert.equal((await store.getEggentAiModelLockState()).locked, false);
  assert.deepEqual(await store.readServiceOptIns(), { images: false, speech: false, learning: false });
  assert.equal((await store.getImageGenerationState()).enabled, false);
});
await check("a project on an included model follows the workspace now, and remembers its pick", () => {
  assert.deepEqual(projectModel("on-included"), { inheritsGlobal: true, provider: "eggent-ai", model: "m-big", note: "kept" });
});
await check("a project on another provider, or following already, is untouched", () => {
  assert.deepEqual(projectModel("on-own"), { inheritsGlobal: false, provider: "own", model: "own-chat" });
  assert.deepEqual(projectModel("following"), { inheritsGlobal: true });
});

console.log("\na switch that does not go through leaves projects where they were:");
onIncludedModel();
await projects.saveProjectModelSettingsFile("on-included", JSON.stringify({ inheritsGlobal: false, provider: "eggent-ai", model: "m-big" }));
await check("a refused switch puts the lock back and keeps the project on the included model", async () => {
  await assert.rejects(store.switchToModelProvider("own", "no-such-model"));
  assert.equal((await store.getEggentAiModelLockState()).locked, true);
  assert.equal(projectModel("on-included").inheritsGlobal, false);
});
await check("a switch that does go through moves it", async () => {
  await store.switchToModelProvider("own", "own-chat");
  assert.equal((await store.getEggentAiModelLockState()).locked, false);
  assert.equal(projectModel("on-included").inheritsGlobal, true);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
