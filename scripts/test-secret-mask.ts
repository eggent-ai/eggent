/**
 * Credentials in a chat.
 *
 * What is judged here is the trade the whole feature makes: a credential must
 * not survive into the stored copy of a conversation, and ordinary text -
 * above all the code an answer about keys is full of - must come through
 * untouched, because a word masked by mistake is not coming back. So: every
 * shape caught, a long list of look-alikes left alone, masking that does the
 * same thing twice, a store that masks on the way in and on the way out, a
 * one-time sweep that rewrites only what it must, and the composer's reading of
 * "the password is ...".
 *
 * Fixture credentials are assembled from pieces so no scanner takes the test
 * file for a leak. No network. Run with Node 22:
 *   npm run test:secret-mask
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const filler = (length: number, seed = "a7K3x9Q2m5Z8"): string => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
const J = (...parts: string[]) => parts.join("");

const FAKE = {
  botToken: J("1234567890", ":", "AA", filler(33)),
  openai: J("sk", "-", "proj-", filler(40)),
  anthropic: J("sk", "-", "ant-api03-", filler(60)),
  google: J("AI", "za", filler(35)),
  eggent: J("egg", "w_", filler(32)),
  vk: J("vk1", ".a.", filler(60)),
  github: J("gh", "p_", filler(36)),
  githubFine: J("github", "_pat_", filler(50)),
  aws: J("AK", "IA", "ABCDEFGHIJKLMNOP"),
  slack: J("xo", "xb-", "1234567890-", filler(24)),
  jwt: J("ey", "J", "hbGciOiJIUzI1NiJ9", ".", "ey", "J", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"),
  pem: J("-----BEGIN ", "PRIVATE KEY-----\n", filler(64), "\n", "-----END ", "PRIVATE KEY-----"),
};

const shapes = await import("../src/lib/secrets/shapes.ts");
const mask = await import("../src/lib/secrets/mask.ts");
const { SPOKEN_CREDENTIAL } = await import("../src/lib/secrets/spoken.ts");
const { redactSecrets } = await import("../src/lib/pi/provider-failure.ts");

console.log("What is a credential\n");

await check("every shape is found, and named for what it is", () => {
  const expected: Array<[string, string, string]> = [
    ["a Telegram bot token", FAKE.botToken, "bot-token"],
    ["a provider key", FAKE.openai, "api-key"],
    ["a provider key with a long prefix", FAKE.anthropic, "api-key"],
    ["a Google key", FAKE.google, "api-key"],
    ["a workspace gateway key", FAKE.eggent, "api-key"],
    ["a VK token", FAKE.vk, "token"],
    ["a GitHub token", FAKE.github, "token"],
    ["a fine-grained GitHub token", FAKE.githubFine, "token"],
    ["a cloud key", FAKE.aws, "cloud-key"],
    ["a Slack token", FAKE.slack, "token"],
    ["a signed token", FAKE.jwt, "token"],
    ["a private key", FAKE.pem, "private-key"],
    ["a bearer header", `Authorization: Bearer ${filler(40)}`, "token"],
    ["a labelled key", `api_key = "${filler(32)}"`, "token"],
    ["a link with a password in it", "postgres://app:s3cretPass@db.example.test:5432/main", "url-credentials"],
  ];
  for (const [what, text, kind] of expected) {
    const found = shapes.findSecrets(`Here is ${what}: ${text} - thanks`);
    assert.ok(found.length >= 1, `${what}: nothing found`);
    assert.equal(found[0].kind, kind, `${what}: ${found[0].kind}`);
  }
});

await check("a private key is masked whole when the whole of it is there", () => {
  const masked = mask.maskSecrets(`before\n${FAKE.pem}\nafter`);
  assert.equal(masked, "before\n[hidden private key]\nafter");
});

console.log("\nWhat is not\n");

await check("code and prose about keys come through untouched", () => {
  const harmless = [
    'api_key = os.environ["OPENAI_API_KEY"]',
    "const apiKey = process.env.API_KEY;",
    "api_key: YOUR_API_KEY_HERE",
    "export ACCESS_TOKEN=${TOKEN}",
    "Authorization: Bearer ${TOKEN}",
    "Send it in the Authorization header as Bearer authentication.",
    "Put your key in `.env` and never commit the file.",
    "the password is correct",
    "password: required",
    "My key is on the keyring.",
    "see keys/api-key-guide.md and sk-learn docs",
    "git rev-parse says 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
    "id 123e4567-e89b-12d3-a456-426614174000",
    "https://example.test/path?token=abc and https://user@example.test/x",
    "email me at a.b@example.test about invoice 20260412:AA is not a token",
    "version 1.2.3-beta.4 and build 20260412",
  ];
  for (const text of harmless) {
    assert.deepEqual(shapes.findSecrets(text), [], text);
    assert.equal(mask.maskSecrets(text), text, text);
  }
});

console.log("\nMasking\n");

await check("a credential is replaced and what is around it stays", () => {
  const text = `Use ${FAKE.openai} for the model and ${FAKE.botToken} for the bot.`;
  assert.equal(mask.maskSecrets(text), "Use [hidden key] for the model and [hidden bot token] for the bot.");
});
await check("a link keeps its address and loses its login", () => {
  assert.equal(
    mask.maskSecrets("DATABASE_URL=postgres://app:s3cretPass@db.example.test:5432/main"),
    "DATABASE_URL=postgres://[hidden login]@db.example.test:5432/main"
  );
});
await check("masking twice is masking once", () => {
  const once = mask.maskSecrets(`${FAKE.github} and ${FAKE.jwt} and ${FAKE.pem}`);
  assert.equal(mask.maskSecrets(once), once);
  assert.equal(shapes.findSecrets(once).length, 0);
});
await check("text with nothing to mask is returned as it came, not copied", () => {
  const text = "nothing here".repeat(1000);
  assert.equal(mask.maskSecrets(text), text);
  const chat = { messages: [{ content: "hello", parts: [{ type: "text", text: "world" }] }] };
  assert.equal(mask.withoutSecrets(chat), chat);
});
await check("a nested value is masked wherever it sits, and the original is not touched", () => {
  const chat = {
    title: `${FAKE.openai} how do I`,
    messages: [{ id: "1", content: `my key is ${FAKE.openai}`, parts: [{ type: "tool", args: { command: `curl -H "Authorization: Bearer ${filler(40)}"` }, output: `TOKEN=${FAKE.github}` }] }],
  };
  const frozen = JSON.stringify(chat);
  const masked = mask.withoutSecrets(chat);
  assert.equal(JSON.stringify(chat), frozen, "the input was changed");
  assert.doesNotMatch(JSON.stringify(masked), /sk-proj|ghp_|Bearer a7/);
  assert.equal(masked.messages[0].id, "1");
  assert.match(masked.title, /^\[hidden key\] how do I$/);
});
await check("a big text is no slower to pass than to read", () => {
  const big = "A line of ordinary prose about invoices and weekly reports.\n".repeat(200_000);
  const started = Date.now();
  mask.maskSecrets(big);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms for ${big.length} characters`);
});
await check("the scrub on provider errors is as broad as ever", () => {
  assert.equal(redactSecrets(`failed with api_key=${filler(20)}`), "failed with [redacted]");
  assert.equal(redactSecrets(`Bearer ${filler(12)}`), "[redacted]");
});

console.log("\nThe stored chat\n");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-secret-mask-"));
process.chdir(root);
const chatsDir = path.join(root, "data", "chats");
fs.mkdirSync(chatsDir, { recursive: true });
const { createChat, getChat, saveChat } = await import("../src/lib/storage/chat-store.ts");
const { sweepStoredChats, SWEEP_VERSION } = await import("../src/lib/secrets/sweep.ts");

const rawFile = (id: string) => fs.readFileSync(path.join(chatsDir, `${id}.json`), "utf-8");

await check("a chat is masked on its way to disk", async () => {
  const chat = await createChat("11111111-1111-4111-8111-111111111111", "Keys");
  chat.messages.push({ id: "m1", role: "user", content: `here: ${FAKE.botToken}`, createdAt: new Date().toISOString() });
  await saveChat(chat);
  assert.doesNotMatch(rawFile(chat.id), /AAa7K3/);
  assert.match(rawFile(chat.id), /\[hidden bot token\]/);
});
await check("an older chat that still holds one is masked on its way out", async () => {
  const id = "22222222-2222-4222-8222-222222222222";
  fs.writeFileSync(path.join(chatsDir, `${id}.json`), JSON.stringify({
    id, title: "Old", createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z",
    messages: [{ id: "m", role: "user", content: `key ${FAKE.anthropic}`, createdAt: "2026-03-01T00:00:00Z" }],
  }));
  const chat = await getChat(id);
  assert.equal(chat?.messages[0].content, "key [hidden key]");
});
await check("saving a chat that was already masked changes nothing", async () => {
  const chat = await getChat("11111111-1111-4111-8111-111111111111");
  assert.ok(chat);
  const before = rawFile(chat.id);
  await saveChat(chat);
  assert.equal(rawFile(chat.id), before);
});

await check("a chat that was clean is not trusted once its file changes", async () => {
  const id = "66666666-6666-4666-8666-666666666666";
  const file = path.join(chatsDir, `${id}.json`);
  const write = (content: string) => fs.writeFileSync(file, JSON.stringify({ id, title: "T", createdAt: "x", updatedAt: "x", messages: [{ id: "m", role: "user", content, createdAt: "x" }] }));
  write("hello");
  assert.equal((await getChat(id))?.messages[0].content, "hello");
  assert.equal((await getChat(id))?.messages[0].content, "hello");
  write(`now with ${FAKE.google} in it`);
  assert.equal((await getChat(id))?.messages[0].content, "now with [hidden key] in it");
});

console.log("\nThe sweep\n");

await check("what old chats still hold is masked once, and only the files that held something are rewritten", async () => {
  const dirty = "33333333-3333-4333-8333-333333333333";
  const clean = "44444444-4444-4444-8444-444444444444";
  const old = "2026-03-01T00:00:00Z";
  fs.writeFileSync(path.join(chatsDir, `${dirty}.json`), JSON.stringify({ id: dirty, title: "Dirty", createdAt: old, updatedAt: old, messages: [{ id: "m", role: "assistant", content: `TOKEN=${FAKE.github}`, createdAt: old }] }));
  fs.writeFileSync(path.join(chatsDir, `${clean}.json`), JSON.stringify({ id: clean, title: "Clean", createdAt: old, updatedAt: old, messages: [{ id: "m", role: "user", content: "hello", createdAt: old }] }));
  const cleanBefore = fs.statSync(path.join(chatsDir, `${clean}.json`)).mtimeMs;
  fs.writeFileSync(path.join(chatsDir, "notes.txt"), `not a chat ${FAKE.github}`);

  const result = await sweepStoredChats();
  assert.ok(result && result.masked >= 2, JSON.stringify(result));
  assert.doesNotMatch(rawFile(dirty), /ghp_/);
  assert.equal(fs.statSync(path.join(chatsDir, `${clean}.json`)).mtimeMs, cleanBefore, "a clean chat was rewritten");
  assert.match(fs.readFileSync(path.join(chatsDir, "notes.txt"), "utf-8"), /ghp_/, "a file that is not a chat was touched");
  const marker = JSON.parse(fs.readFileSync(path.join(root, "data", "secrets-sweep.json"), "utf-8")) as { version: number };
  assert.equal(marker.version, SWEEP_VERSION);
});
await check("it does not run twice for one version, but can be asked to", async () => {
  assert.equal(await sweepStoredChats(), null);
  const forced = await sweepStoredChats({ force: true });
  assert.ok(forced && forced.masked === 0, JSON.stringify(forced));
});
await check("a chat saved while it was being read is left for its own next save", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const file = path.join(chatsDir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, title: "Busy", createdAt: "x", updatedAt: "x", messages: [{ id: "m", role: "user", content: `k ${FAKE.openai}`, createdAt: "x" }] }));
  // The sweep reads, then somebody saves: simulate by touching the file between its two looks.
  const realStat = fs.promises.stat;
  let calls = 0;
  const patched = async (target: fs.PathLike, ...rest: unknown[]): Promise<fs.Stats> => {
    const result = await (realStat as unknown as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    if (String(target).endsWith(`${id}.json`)) {
      calls += 1;
      if (calls === 2) return { ...result, mtimeMs: result.mtimeMs + 5000, size: result.size + 1 } as fs.Stats;
    }
    return result;
  };
  Object.assign(fs.promises, { stat: patched });
  try {
    const result = await sweepStoredChats({ force: true });
    assert.ok(result && result.skipped >= 1, JSON.stringify(result));
    assert.match(fs.readFileSync(file, "utf-8"), /sk-proj/, "the file was rewritten over a newer save");
  } finally {
    Object.assign(fs.promises, { stat: realStat });
  }
});

console.log("\nIn the composer\n");

await check("somebody saying the password is something is noticed, and a sentence about passwords is not", () => {
  const spoken = (text: string) => shapes.firstSecret(text, { spoken: SPOKEN_CREDENTIAL });
  assert.equal(spoken("the password is hunter2xyz")?.kind, "password");
  assert.equal(spoken("Password: Xk93mQ2zLp")?.kind, "password");
  assert.equal(spoken("the password is correct"), null);
  assert.equal(spoken("password: required"), null);
  assert.equal(spoken("I forgot my password, can you help?"), null);
});
await check("the composer sees what the store would mask, and nothing the store would not", () => {
  assert.equal(shapes.firstSecret(`use ${FAKE.openai}`)?.kind, "api-key");
  assert.equal(shapes.firstSecret('api_key = os.environ["X"]'), null);
});

process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
