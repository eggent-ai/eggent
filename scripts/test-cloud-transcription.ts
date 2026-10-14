/**
 * A voice message goes to the included model's gateway while the workspace runs
 * on it, and to local whisper otherwise - or whenever the gateway does not
 * answer with a transcript, so a refusal never costs the person their message.
 *
 * Drives the real transcriber: a stub gateway on loopback, a throwaway agent
 * directory for the model lock, a stand-in whisper binary, the real ffmpeg.
 * Run: npm run test:cloud-transcription
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-stt-"));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir, { recursive: true });

// The gateway: answers what the current test wants and records what it got.
type Seen = { auth?: string; body: Record<string, unknown> };
const seen: Seen[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { text: "  from the cloud  " } };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    seen.push({ auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

// A whisper that writes "from whisper" where the transcriber reads it back.
const fakeWhisper = path.join(root, "whisper-cli");
fs.writeFileSync(fakeWhisper, `#!/bin/sh
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-of" ]; then prefix="$2"; fi
  shift
done
printf 'from whisper' > "$prefix.txt"
`, { mode: 0o755 });
const fakeModel = path.join(root, "ggml-test.bin");
fs.writeFileSync(fakeModel, "model");

process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EGGENT_AI_MODEL_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.EGGENT_STT_BINARY = fakeWhisper;
process.env.EGGENT_STT_MODEL_PATH = fakeModel;
delete process.env.EGGENT_MANAGED_AI_ENFORCED;
delete process.env.EGGENT_AI_MODEL_LOCKED;
delete process.env.EGGENT_MANAGED_AI_LOCKED;
delete process.env.EGGENT_MANAGED_AI_TOKEN;
delete process.env.EGGENT_USAGE_API_TOKEN;
delete process.env.EGGENT_STT_CLOUD;

function onIncludedModel(): void {
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "eggent-ai", defaultModel: "eggent-ai" }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "eggent-ai": { type: "api_key", key: "eggw_test_token" } }));
}
function onOwnProvider(): void {
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "my-own", defaultModel: "x" }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "my-own": { type: "api_key", key: "sk-own" }, "eggent-ai": { type: "api_key", key: "eggw_test_token" } }));
}

// A real recording: one second of tone, Ogg Opus as a browser or Telegram sends it.
const oggPath = path.join(root, "voice.ogg");
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", oggPath]);
const recording = fs.readFileSync(oggPath);

const { transcribeAudioBuffer } = await import("../src/lib/speech/transcriber.ts");
const { cloudUploadName, transcribeInCloud, CLOUD_TRANSCRIPTION_MAX_BYTES } = await import("../src/lib/speech/cloud-transcriber.ts");

console.log("on the included model the gateway transcribes:");
onIncludedModel();
seen.length = 0;
answer = { status: 200, body: { text: "  from the cloud  " } };
const cloud = await transcribeAudioBuffer({ buffer: recording, filename: "voice.ogg", mimeType: "audio/ogg", language: "ru" });
await check("the text came from the cloud", () => {
  assert.equal(cloud.transcript, "from the cloud");
  assert.equal(cloud.modelPath, "cloud");
});
await check("the request carries the gateway token, the whole recording and the language", () => {
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, "Bearer eggw_test_token");
  assert.equal(seen[0].body.audio, recording.toString("base64"));
  assert.equal(seen[0].body.filename, "voice.ogg");
  assert.equal(seen[0].body.mime_type, "audio/ogg");
  assert.equal(seen[0].body.language, "ru");
});
await check("no model is named: the gateway chooses", () => {
  assert.equal(seen[0].body.model, undefined);
});

console.log("\na refusal does not lose the message, whisper transcribes it:");
seen.length = 0;
answer = { status: 402, body: { error: { message: "balance", type: "eggent_ai_credit_exhausted" } } };
const refused = await transcribeAudioBuffer({ buffer: recording, filename: "voice.ogg", mimeType: "audio/ogg", language: "ru" });
await check("the gateway was asked, whisper answered", () => {
  assert.equal(seen.length, 1);
  assert.equal(refused.transcript, "from whisper");
  assert.equal(refused.modelPath, fakeModel);
});

seen.length = 0;
answer = { status: 200, body: { text: "" } };
const blank = await transcribeAudioBuffer({ buffer: recording, filename: "voice.ogg", mimeType: "audio/ogg" });
await check("an empty transcript from the gateway is whisper too", () => assert.equal(blank.transcript, "from whisper"));

console.log("\non its own provider the workspace never asks the gateway:");
onOwnProvider();
seen.length = 0;
answer = { status: 200, body: { text: "from the cloud" } };
const own = await transcribeAudioBuffer({ buffer: recording, filename: "voice.ogg", mimeType: "audio/ogg" });
await check("whisper, and no request to the gateway", () => {
  assert.equal(own.transcript, "from whisper");
  assert.equal(seen.length, 0);
});

console.log("\nthe cloud switched off by the environment:");
onIncludedModel();
process.env.EGGENT_STT_CLOUD = "off";
seen.length = 0;
const off = await transcribeAudioBuffer({ buffer: recording, filename: "voice.ogg", mimeType: "audio/ogg" });
delete process.env.EGGENT_STT_CLOUD;
await check("EGGENT_STT_CLOUD=off means whisper", () => {
  assert.equal(off.transcript, "from whisper");
  assert.equal(seen.length, 0);
});

console.log("\nthe name and type a recording is sent under:");
await check("a Telegram voice note (.oga) goes as .ogg", () => {
  assert.deepEqual(cloudUploadName(".oga", "audio/ogg"), { filename: "voice.ogg", mimeType: "audio/ogg" });
});
await check("a browser recording loses its codec parameters", () => {
  assert.deepEqual(cloudUploadName(".webm", "audio/webm;codecs=opus"), { filename: "voice.webm", mimeType: "audio/webm" });
});
await check("an unknown container stays local", () => {
  assert.equal(cloudUploadName(".audio", "application/octet-stream"), null);
});
await check("a recording over 25 MB stays local", async () => {
  let called = false;
  const result = await transcribeInCloud(
    { url: "http://unused.invalid", token: "eggw_x" },
    { buffer: Buffer.alloc(CLOUD_TRANSCRIPTION_MAX_BYTES + 1), extension: ".ogg", language: "auto" },
    { fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch }
  );
  assert.equal(result, null);
  assert.equal(called, false);
});
await check("a silent gateway times out instead of hanging", async () => {
  const result = await transcribeInCloud(
    { url: "http://unused.invalid", token: "eggw_x" },
    { buffer: recording, extension: ".ogg", language: "auto" },
    {
      timeoutMs: 50,
      fetchImpl: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch,
    }
  );
  assert.equal(result, null);
});

server.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
