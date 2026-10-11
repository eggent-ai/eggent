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
  skProj: J("sk", "-", "proj-", filler(40)),
  skLong: J("sk", "-", "ant-api03-", filler(60)),
  aiza: J("AI", "za", filler(35)),
  eggent: J("egg", "w_", filler(32)),
  vk: J("vk1", ".a.", filler(60)),
  github: J("gh", "p_", filler(36)),
  githubFine: J("github", "_pat_", filler(50)),
  akia: J("AK", "IA", "ABCDEFGHIJKLMNOP"),
  xoxb: J("xo", "xb-", "1234567890-", filler(24)),
  jwt: J("ey", "J", "hbGciOiJIUzI1NiJ9", ".", "ey", "J", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV"),
  pem: J("-----BEGIN ", "PRIVATE KEY-----\n", filler(64), "\n", "-----END ", "PRIVATE KEY-----"),
};

// Vendors that give their keys a prefix of their own.
const VENDORS: Array<[string, string, string]> = [
  ["an sk_live_ key", J("sk", "_live_", filler(24)), "api-key"],
  ["an hf_ token", J("hf", "_", filler(34)), "token"],
  ["a gsk_ key", J("gsk", "_", filler(52)), "api-key"],
  ["a glpat- token", J("glpat", "-", filler(20)), "token"],
  ["a tvly- key", J("tvly", "-dev-", filler(32)), "api-key"],
  ["an npm token", J("npm", "_", filler(36)), "token"],
  ["a pplx- key", J("pplx", "-", filler(40)), "api-key"],
  ["an xai- key", J("xai", "-", filler(80)), "api-key"],
  ["an r8_ token", J("r8", "_", filler(37)), "token"],
  ["a shpat_ token", J("shp", "at_", "0123456789abcdef0123456789abcdef"), "token"],
  ["an SG. key", J("SG", ".", filler(22), ".", filler(43)), "api-key"],
  ["a dop_v1_ token", J("dop", "_v1_", "0123456789abcdef".repeat(4)), "token"],
  ["a ya29. token", J("ya", "29.", filler(60)), "token"],
  ["a temporary cloud key", J("AS", "IA", "ABCDEFGHIJKLMNOP"), "cloud-key"],
  ["an xapp- token", J("xa", "pp-", "1-A01ABCDEF-", filler(30)), "token"],
];

const shapes = await import("../src/lib/secrets/shapes.ts");
const mask = await import("../src/lib/secrets/mask.ts");
const { SPOKEN_CREDENTIAL } = await import("../src/lib/secrets/spoken.ts");
const { redactSecrets } = await import("../src/lib/pi/provider-failure.ts");

console.log("What is a credential\n");

await check("every shape is found, and named for what it is", () => {
  const expected: Array<[string, string, string]> = [
    ["a Telegram bot token", FAKE.botToken, "bot-token"],
    ["a provider key", FAKE.skProj, "api-key"],
    ["a provider key with a long prefix", FAKE.skLong, "api-key"],
    ["an AIza key", FAKE.aiza, "api-key"],
    ["a workspace gateway key", FAKE.eggent, "api-key"],
    ["a VK token", FAKE.vk, "token"],
    ["a GitHub token", FAKE.github, "token"],
    ["a fine-grained GitHub token", FAKE.githubFine, "token"],
    ["a cloud key", FAKE.akia, "cloud-key"],
    ["an xoxb- token", FAKE.xoxb, "token"],
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

await check("the vendors with a prefix of their own are found, each named for what it is", () => {
  for (const [what, text, kind] of VENDORS) {
    const found = shapes.findSecrets(`Here is ${what}: ${text} - thanks`);
    assert.equal(found.length, 1, `${what}: ${JSON.stringify(found)}`);
    assert.equal(found[0].kind, kind, `${what}: ${found[0].kind}`);
    assert.equal(mask.maskSecrets(`k=${text};`).includes(text.slice(8)), false, `${what} survived`);
  }
});
await check("a key in an environment variable is found by the variable's name", () => {
  const key = J(filler(12), "9", filler(20));
  for (const label of ["WIDGET_API_KEY", "export GADGET_API_KEY", "my_client_secret", "GITHUB_ACCESS_TOKEN", "auth_token", "client_secret", "SECRET_KEY"]) {
    for (const text of [`${label}=${key}`, `${label}: "${key}"`, `${label} = '${key}'`]) {
      const found = shapes.findSecrets(`before ${text} after`);
      assert.equal(found.length, 1, text);
      assert.equal(mask.maskSecrets(text).includes(key), false, `${text} survived`);
    }
  }
});
await check("a key that is the only thing in the text is found without any other hint", () => {
  assert.equal(mask.maskSecrets(`client_secret = "${J(filler(10), "7", filler(20))}"`), '[hidden token]"');
  assert.equal(mask.maskSecrets(`auth_token: ${J(filler(10), "7", filler(20))}`), "[hidden token]");
});
await check("a password with an @ in it is masked to the last one, and no further", () => {
  assert.equal(mask.maskSecrets("DB=postgres://app:p@ss@db.example.test:5432/main"), "DB=postgres://[hidden login]@db.example.test:5432/main");
  assert.equal(mask.maskSecrets("cache=redis://:s3cretPass@cache.example.test:6379/0"), "cache=redis://[hidden login]@cache.example.test:6379/0");
  assert.equal(
    mask.maskSecrets('{"url":"postgres://u:pw@h.example.test:5432","owner":"a@b.example.test"}'),
    '{"url":"postgres://[hidden login]@h.example.test:5432","owner":"a@b.example.test"}'
  );
  assert.equal(mask.maskSecrets("see (mongodb+srv://u:pw@c.example.test/db) and a@b.example.test"), "see (mongodb+srv://[hidden login]@c.example.test/db) and a@b.example.test");
});

console.log("\nWhat is not\n");

await check("code and prose about keys come through untouched", () => {
  const harmless = [
    'api_key = os.environ["SERVICE_API_KEY"]',
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
    "email me at a.b@example.test about order 20260412:AA is not a token",
    "version 1.2.3-beta.4 and build 20260412",
    // Names written by a person, not keys: words joined by dots and underscores, with a number.
    "api_key = self.oauth2_client.fetch_token",
    "access_token = process.env.SERVICE_API_KEY_2024",
    "Authorization: Bearer YOUR_API_KEY_123456789",
    "WIDGET_API_KEY=${WIDGET_API_KEY}",
    "export SERVICE_API_KEY=your-key-here",
    'client_secret = settings.service_oauth2_client_secret',
    // Identifiers with one-letter or letter-and-digit pieces are still names.
    "authorization: import_v417.z.string().optional()",
    "apiKey: config.v2.keys.main",
    "client_secret: settings.oauth2.client_secret_v2",
    "apiKey: ctx.env.API_KEY_V2",
    "auth_token: Settings.Auth.s3.token_default",
    "ssh://git@github.example.test:2222/org/repo.git and https://example.test:8080/x@y and http://localhost:3000/",
    "mail me@example.test, see https://user@example.test:443/path",
  ];
  for (const text of harmless) {
    assert.deepEqual(shapes.findSecrets(text), [], text);
    assert.equal(mask.maskSecrets(text), text, text);
  }
});

console.log("\nMasking\n");

await check("a credential is replaced and what is around it stays", () => {
  const text = `Use ${FAKE.skProj} for the model and ${FAKE.botToken} for the bot.`;
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
    title: `${FAKE.skProj} how do I`,
    messages: [{ id: "1", content: `my key is ${FAKE.skProj}`, parts: [{ type: "tool", args: { command: `curl -H "Authorization: Bearer ${filler(40)}"` }, output: `TOKEN=${FAKE.github}` }] }],
  };
  const frozen = JSON.stringify(chat);
  const masked = mask.withoutSecrets(chat);
  assert.equal(JSON.stringify(chat), frozen, "the input was changed");
  assert.doesNotMatch(JSON.stringify(masked), /sk-proj|ghp_|Bearer a7/);
  assert.equal(masked.messages[0].id, "1");
  assert.match(masked.title, /^\[hidden key\] how do I$/);
});
await check("a big text is no slower to pass than to read", () => {
  const big = "A line of ordinary prose about orders and weekly reports.\n".repeat(200_000);
  const started = Date.now();
  mask.maskSecrets(big);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms for ${big.length} characters`);
});
await check("hostile text costs time in proportion to its length, shape by shape", () => {
  // Each of these used to make one pattern read a long run again from every position inside it:
  // 100 KB of any of them took seconds, 200 KB half a minute.
  const rep = (piece: string, length = 150_000) => piece.repeat(Math.ceil(length / piece.length));
  const hostile: Record<string, string> = {
    "dots": `api_key ${rep("a.")}`,
    "dashes": rep("sk-"),
    "hyphenated words": rep("word-word-"),
    "signed-token starts": rep("eyJ-"),
    "signed-token segments": rep("eyJaaaaaaaaaa."),
    "key headers with no end": rep("-----BEGIN PRIVATE KEY-----"),
    "key headers and ends": rep("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"),
    "scheme markers": rep("://user:pa"),
    "xoxb-looking": rep("xoxb-"),
    "labels": rep("WIDGET_API_KEY="),
    "one long word": `${"x".repeat(150_000)}_API_KEY=`,
    // The cases above stop before a value, so the check on what a match ends in never ran.
    "a long prefix and a value": `${"x".repeat(150_000)}_API_KEY=Zz9aaaaaaaaaaaaaaaaaa`,
    "a long prefix, quoted, and a value": `${"y".repeat(150_000)}_SECRET_KEY: "Zz9aaaaaaaaaaaaaaaaaa"`,
    "a value that is a long dotted name": `api_key=${"a.".repeat(75_000)}9`,

    "passwords with ats": `http://u:${"p@".repeat(200_000)}`,
  };
  for (const [name, text] of Object.entries(hostile)) {
    const started = Date.now();
    shapes.findSecrets(text);
    mask.maskSecrets(text);
    const took = Date.now() - started;
    assert.ok(took < 1500, `${name}: ${took} ms for ${text.length} characters`);
  }
});
await check("a value kept under a key's own name is masked, and only when it is one", () => {
  const key = J(filler(12), "9", filler(20));
  const chat = {
    parts: [
      { type: "tool", args: { api_key: key, apiKey: key, "Client-Secret": key, access_token: key, password: "hunter2", authorization: `Bearer ${key}` }, id: "t1" },
      { type: "tool", args: { api_key: "os.environ", token: 12345, password: "your_password", secret: "short", name: "plain" } },
    ],
  };
  const frozen = JSON.stringify(chat);
  const masked = mask.withoutSecrets(chat);
  assert.equal(JSON.stringify(chat), frozen, "the input was changed");
  const first = masked.parts[0].args as Record<string, unknown>;
  assert.deepEqual(first, {
    api_key: "[hidden key]", apiKey: "[hidden key]", "Client-Secret": "[hidden key]", access_token: "[hidden token]",
    password: "[hidden password]", authorization: "[hidden token]",
  });
  assert.equal(masked.parts[0].id, "t1");
  assert.equal(masked.parts[1], chat.parts[1], "a part with nothing to mask was copied");
  assert.equal(JSON.stringify(mask.withoutSecrets(masked)), JSON.stringify(masked), "masking twice changed it");
});
await check("a value is masked under the name its tool wants it written in: environment variables and headers", () => {
  const key = J(filler(12), "9", filler(20));
  const config = {
    env: { WIDGET_API_KEY: key, SERVICE_API_KEY: key, MY_SERVICE_TOKEN: key, DB_PASSWORD: "hunter2", WEBHOOK_SECRET: key },
    headers: { "X-API-Key": key, "x-auth-token": key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    note: "ordinary text",
    maxTokens: 4096,
    tokens: "a b c d e f g h i j k l m n o p",
  };
  const masked = mask.withoutSecrets(config);
  assert.deepEqual(masked.env, {
    WIDGET_API_KEY: "[hidden key]", SERVICE_API_KEY: "[hidden key]", MY_SERVICE_TOKEN: "[hidden token]", DB_PASSWORD: "[hidden password]", WEBHOOK_SECRET: "[hidden token]",
  });
  assert.deepEqual(masked.headers, { "X-API-Key": "[hidden key]", "x-auth-token": "[hidden token]", Authorization: "[hidden token]", "Content-Type": "application/json" });
  assert.equal(masked.note, "ordinary text");
  assert.equal(masked.maxTokens, 4096);
  assert.equal(masked.tokens, config.tokens, "a name that merely contains the word was taken for a key");
  // ...and a name that is only a name stays.
  const names = { API_KEY: "process.env.SERVICE_API_KEY_2024", client_secret: "settings.oauth2.client_secret_v2", token: "short" };
  assert.deepEqual(mask.withoutSecrets(names), names);
});
await check("a private key is masked whole however long its body, and a header with no end is masked alone", () => {
  const long = J("-----BEGIN ", "PRIVATE KEY-----\n", filler(13_000), "\n", "-----END ", "PRIVATE KEY-----");
  assert.equal(mask.maskSecrets(`before ${long} after`), "before [hidden private key] after");
  assert.equal(mask.maskSecrets(`x ${J("-----BEGIN ", "PRIVATE KEY-----")} y`), "x [hidden private key] y");
});
await check("the composer's reading of 'the password is ...' costs time in proportion to the text too", () => {
  const started = Date.now();
  shapes.firstSecret("token-".repeat(14_000), { spoken: SPOKEN_CREDENTIAL });
  shapes.firstSecret(`password: ${"a-".repeat(40_000)}`, { spoken: SPOKEN_CREDENTIAL });
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
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
    messages: [{ id: "m", role: "user", content: `key ${FAKE.skLong}`, createdAt: "2026-03-01T00:00:00Z" }],
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
  write(`now with ${FAKE.aiza} in it`);
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
  fs.writeFileSync(file, JSON.stringify({ id, title: "Busy", createdAt: "x", updatedAt: "x", messages: [{ id: "m", role: "user", content: `k ${FAKE.skProj}`, createdAt: "x" }] }));
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

const dirtyChat = (id: string, secret: string) => JSON.stringify({ id, title: id.slice(0, 4), createdAt: "x", updatedAt: "x", messages: [{ id: "m", role: "user", content: `k ${secret}`, createdAt: "x" }] });
const markerFile = path.join(root, "data", "secrets-sweep.json");
const hourAgo = new Date(Date.now() - 3_600_000);

await check("a chat left for later is listed, and the next run looks at it and at what else was left", async () => {
  const busy = "77777777-7777-4777-8777-777777777777";
  const quiet = "88888888-8888-4888-8888-888888888888";
  fs.writeFileSync(path.join(chatsDir, `${busy}.json`), dirtyChat(busy, FAKE.skProj));
  fs.writeFileSync(path.join(chatsDir, `${quiet}.json`), dirtyChat(quiet, FAKE.skProj));
  fs.utimesSync(path.join(chatsDir, `${quiet}.json`), hourAgo, hourAgo);

  const first = await sweepStoredChats({ force: true, minAgeMs: 60_000 });
  assert.ok(first && first.retry.includes(`${busy}.json`), JSON.stringify(first));
  assert.ok(!first.retry.includes(`${quiet}.json`), "an old chat was left for later");
  assert.match(rawFile(busy), /sk-proj/, "a chat used a moment ago was rewritten");
  assert.doesNotMatch(rawFile(quiet), /sk-proj/, "an old chat was not masked");
  assert.deepEqual((JSON.parse(fs.readFileSync(markerFile, "utf-8")) as { retry: string[] }).retry, first.retry);

  const second = await sweepStoredChats();
  assert.ok(second && second.masked >= 1 && second.retry.length === 0, JSON.stringify(second));
  assert.doesNotMatch(rawFile(busy), /sk-proj/);
  assert.equal(await sweepStoredChats(), null, "it ran again with nothing left to do");
});
await check("a file that cannot be read is counted and not asked about again", async () => {
  const broken = "99999999-9999-4999-8999-999999999999";
  fs.writeFileSync(path.join(chatsDir, `${broken}.json`), "{ not json");
  const result = await sweepStoredChats({ force: true });
  assert.ok(result && result.failed >= 1 && !result.retry.includes(`${broken}.json`), JSON.stringify(result));
  assert.equal(await sweepStoredChats(), null);
  fs.rmSync(path.join(chatsDir, `${broken}.json`));
});
await check("a save that lands while the rewrite is being written is not written over", async () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const file = path.join(chatsDir, `${id}.json`);
  fs.writeFileSync(file, dirtyChat(id, FAKE.skProj));
  fs.utimesSync(file, hourAgo, hourAgo);
  const realStat = fs.promises.stat;
  let calls = 0;
  const patched = async (target: fs.PathLike, ...rest: unknown[]): Promise<fs.Stats> => {
    const result = await (realStat as unknown as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    if (String(target).endsWith(`${id}.json`)) {
      calls += 1;
      // The third look is the one after the temporary copy was written.
      if (calls === 3) return { ...result, mtimeMs: result.mtimeMs + 5000 } as fs.Stats;
    }
    return result;
  };
  Object.assign(fs.promises, { stat: patched });
  try {
    const result = await sweepStoredChats({ force: true });
    assert.ok(result && result.retry.includes(`${id}.json`), JSON.stringify(result));
  } finally {
    Object.assign(fs.promises, { stat: realStat });
  }
  assert.match(rawFile(id), /sk-proj/, "the file was rewritten over a newer save");
  assert.deepEqual(fs.readdirSync(chatsDir).filter((name) => name.includes(".sweep-")), [], "a temporary copy was left behind");
  fs.rmSync(file);
});
await check("a marker from an older shape list is not trusted, and its names are never paths", async () => {
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const file = path.join(chatsDir, `${id}.json`);
  fs.writeFileSync(file, dirtyChat(id, FAKE.skProj));
  fs.utimesSync(file, hourAgo, hourAgo);
  fs.writeFileSync(markerFile, JSON.stringify({ version: SWEEP_VERSION - 1, retry: [] }));
  const result = await sweepStoredChats();
  assert.ok(result && result.masked >= 1, JSON.stringify(result));
  assert.doesNotMatch(rawFile(id), /sk-proj/);

  const outside = path.join(root, "data", "outside.json");
  fs.writeFileSync(outside, dirtyChat("cccccccc-cccc-4ccc-8ccc-cccccccccccc", FAKE.skProj));
  fs.writeFileSync(markerFile, JSON.stringify({ version: SWEEP_VERSION, retry: ["../outside.json", "nested/x.json", "notes.txt"] }));
  const guarded = await sweepStoredChats();
  assert.ok(guarded && guarded.scanned === 0, JSON.stringify(guarded));
  assert.match(fs.readFileSync(outside, "utf-8"), /sk-proj/, "a file outside the chats folder was swept");
  fs.rmSync(outside);
});

await check("a chat whose file is dated in the future is not 'in use', and an orphaned copy is cleaned away", async () => {
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const file = path.join(chatsDir, `${id}.json`);
  fs.writeFileSync(file, dirtyChat(id, FAKE.skProj));
  const tomorrow = new Date(Date.now() + 86_400_000);
  fs.utimesSync(file, tomorrow, tomorrow);
  const orphan = path.join(chatsDir, `${id}.json.sweep-99999`);
  fs.writeFileSync(orphan, "half a rewrite");
  fs.utimesSync(orphan, hourAgo, hourAgo);
  const fresh = path.join(chatsDir, `${id}.json.sweep-88888`);
  fs.writeFileSync(fresh, "a rewrite in progress somewhere");
  // ...whereas one stamped a moment ahead of this clock is a chat written this instant (the stamp has
  // microseconds, Date.now() only milliseconds): that one is in use, and is left for later.
  const justNow = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const justNowFile = path.join(chatsDir, `${justNow}.json`);
  fs.writeFileSync(justNowFile, dirtyChat(justNow, FAKE.skProj));
  const aMomentAhead = new Date(Date.now() + 2000);
  fs.utimesSync(justNowFile, aMomentAhead, aMomentAhead);
  const result = await sweepStoredChats({ force: true, minAgeMs: 60_000 });
  assert.ok(result && !result.retry.includes(`${id}.json`), JSON.stringify(result));
  assert.ok(result.retry.includes(`${justNow}.json`), "a chat written this instant was swept under its owner");
  assert.match(rawFile(justNow), /sk-proj/);
  fs.rmSync(justNowFile);
  assert.doesNotMatch(rawFile(id), /sk-proj/, "a chat dated in the future was never swept");
  assert.equal(fs.existsSync(orphan), false, "the orphaned copy was left");
  assert.equal(fs.existsSync(fresh), true, "a copy that may be in use was removed");
  fs.rmSync(file); fs.rmSync(fresh);
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
  assert.equal(shapes.firstSecret(`use ${FAKE.skProj}`)?.kind, "api-key");
  assert.equal(shapes.firstSecret('api_key = os.environ["X"]'), null);
});

process.chdir(os.tmpdir());
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
