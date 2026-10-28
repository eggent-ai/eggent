/**
 * A new password ends every session issued before it.
 *
 * Run with Node 22: npm run test:session-floor
 *
 * A session is a signed cookie and a signature cannot be taken back, so the
 * settings file names a moment (`auth.sessionsValidAfter`) and every place that
 * checks a session refuses one issued earlier: the middleware, the routes that
 * check for themselves, and a one-time sign-in link minted by such a session.
 * Changing the login and password here sets the moment and keeps this browser
 * signed in; the settings form can no longer touch the login at all; a login
 * that is an email address is accepted; the sign-in page learns where a lost
 * password is reset.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-session-floor-"));
process.chdir(workdir);
process.env.EGGENT_AUTH_SECRET = "session-floor-test-secret-0123456789";

const USERNAME = "owner@example.test";
const settingsFile = path.join(workdir, "data", "settings", "settings.json");
const { hashPassword } = await import("../src/lib/auth/password.ts");
function writeSettings(auth: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ auth: { enabled: true, username: USERNAME, passwordHash: hashPassword("correct horse battery"), mustChangeCredentials: false, ...auth } }));
}
function readAuth(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsFile, "utf-8")).auth;
}
writeSettings({});

const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const floor = await import("../src/lib/auth/session-floor.ts");
const { mintHandoffToken } = await import("../src/lib/auth/handoff.ts");
const middlewareModule = await import("../src/middleware.ts");
const status = await import("../src/app/api/auth/status/route.ts");
const credentials = await import("../src/app/api/auth/credentials/route.ts");
const redeem = await import("../src/app/api/auth/handoff/redeem/route.ts");
const settingsRoute = await import("../src/app/api/settings/route.ts");
const { checkTerminalRequest } = await import("../src/lib/terminal/guard.ts");
const { saveSettings } = await import("../src/lib/storage/settings-store.ts");
const { NextRequest } = await import("next/server.js");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

const ORIGIN = "https://workspace.example.test";
function request(pathname: string, init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", `${AUTH_COOKIE_NAME}=${init.cookie}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new NextRequest(`${ORIGIN}${pathname}`, {
    method: init.method || "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** A session as it would have been issued `secondsAgo` earlier. */
async function sessionIssuedAgo(secondsAgo: number): Promise<string> {
  const realNow = Date.now;
  Date.now = () => realNow() - secondsAgo * 1000;
  try {
    return await createSessionToken(USERNAME, false);
  } finally {
    Date.now = realNow;
  }
}

function cookieFrom(response: Response): string | null {
  const header = response.headers.get("set-cookie") || "";
  const match = new RegExp(`${AUTH_COOKIE_NAME}=([^;]*)`).exec(header);
  return match ? match[1] : null;
}

const old = await sessionIssuedAgo(120);
const fresh = await sessionIssuedAgo(0);

console.log("Before any reset\n");

await check("with no moment written, every signed session counts", async () => {
  assert.ok(await floor.verifyActiveSession(old));
  assert.ok(await floor.verifyActiveSession(fresh));
});

await check("the middleware runs on Node, where the settings file can be read", () => {
  assert.equal((middlewareModule.config as { runtime?: string }).runtime, "nodejs");
});

console.log("\nAfter a reset from outside (what a hosted workspace's reset writes)\n");

writeSettings({ sessionsValidAfter: Math.floor(Date.now() / 1000) - 60 });

await check("a session issued before the moment is refused, one issued after it is not", async () => {
  assert.equal(await floor.verifyActiveSession(old), null);
  assert.ok(await floor.verifyActiveSession(fresh));
});

await check("the middleware sends the old session to the sign-in page and refuses it on the API", async () => {
  const page = await middlewareModule.middleware(request("/dashboard", { cookie: old }));
  assert.equal(page.status, 307);
  assert.match(page.headers.get("location") || "", /\/login/);
  const api = await middlewareModule.middleware(request("/api/chats", { cookie: old }));
  assert.equal(api.status, 401);
  const ok = await middlewareModule.middleware(request("/dashboard", { cookie: fresh }));
  assert.equal(ok.headers.get("location"), null, "a fresh session was redirected");
});

await check("a dot in the last segment of a path is no way past the check", async () => {
  // Only files at the top of the site skip it.
  for (const pathname of ["/api/projects/shop.x", "/api/chat/123.json", "/api/mail/attachments/7.pdf"]) {
    assert.equal((await middlewareModule.middleware(request(pathname, { cookie: old }))).status, 401, pathname);
    assert.equal((await middlewareModule.middleware(request(pathname))).status, 401, `${pathname} without a cookie`);
  }
  for (const pathname of ["/dashboard/abc.def", "/print.x/y.md"]) {
    const page = await middlewareModule.middleware(request(pathname, { cookie: old }));
    assert.match(page.headers.get("location") || "", /\/login/, pathname);
  }
  for (const pathname of ["/icon.svg", "/apple-icon.png", "/robots.txt"]) {
    assert.equal((await middlewareModule.middleware(request(pathname))).headers.get("x-middleware-next"), "1", pathname);
  }
  // The pages served to a sandboxed frame carry no cookie and stay open.
  assert.equal((await middlewareModule.middleware(request("/api/files/page/tok/site/index.html"))).headers.get("x-middleware-next"), "1");
});

await check("the status route says signed out for the old session and clears its cookie", async () => {
  const answer = await status.GET(request("/api/auth/status", { cookie: old }));
  assert.equal(answer.status, 401);
  assert.equal(cookieFrom(answer), "");
  const fine = await status.GET(request("/api/auth/status", { cookie: fresh }));
  assert.equal((await fine.json()).authenticated, true);
});

await check("routes that check for themselves refuse it too: the terminal guard, credentials", async () => {
  const sameSite = { "sec-fetch-site": "same-origin", origin: ORIGIN, host: new URL(ORIGIN).host };
  assert.equal(await checkTerminalRequest(request("/api/terminal/jobs", { cookie: old, headers: sameSite }), { write: false }), "unauthorized");
  assert.equal(await checkTerminalRequest(request("/api/terminal/jobs", { cookie: fresh, headers: sameSite }), { write: false }), null);
  const refused = await credentials.PUT(request("/api/auth/credentials", { method: "PUT", cookie: old, body: { username: USERNAME, password: "another long password" } }));
  assert.equal(refused.status, 401);
});

await check("a one-time link minted before the moment does not sign anybody in", async () => {
  const before = mintHandoffToken(USERNAME, Date.now() - 120_000).token;
  const after = mintHandoffToken(USERNAME).token;
  const refused = await redeem.POST(request("/api/auth/handoff/redeem", { method: "POST", body: { token: before } }));
  assert.equal(refused.status, 401);
  const accepted = await redeem.POST(request("/api/auth/handoff/redeem", { method: "POST", body: { token: after } }));
  assert.equal(accepted.status, 200);
  assert.ok(await floor.verifyActiveSession(cookieFrom(accepted) || ""), "the session it started is refused");
});

await check("a settings file caught halfway through a write keeps the moment it last named", async () => {
  const content = fs.readFileSync(settingsFile, "utf-8");
  fs.writeFileSync(settingsFile, content.slice(0, Math.floor(content.length / 2)));
  assert.equal(await floor.verifyActiveSession(old), null);
  fs.writeFileSync(settingsFile, content);
});

console.log("\nChanging the password here\n");

await check("a login that is an email address is accepted", async () => {
  writeSettings({});
  const response = await credentials.PUT(request("/api/auth/credentials", { method: "PUT", cookie: fresh, body: { username: "new.owner@example.test", password: "a new long password" } }));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(readAuth().username, "new.owner@example.test");
});

await check("it ends the other sessions and keeps this browser in", async () => {
  writeSettings({});
  const other = await sessionIssuedAgo(30);
  assert.ok(await floor.verifyActiveSession(other));
  const response = await credentials.PUT(request("/api/auth/credentials", { method: "PUT", cookie: fresh, body: { username: USERNAME, password: "a new long password" } }));
  assert.equal(response.status, 200);
  assert.equal(typeof readAuth().sessionsValidAfter, "number");
  assert.equal(await floor.verifyActiveSession(other), null, "another browser is still in");
  const mine = cookieFrom(response);
  assert.ok(mine && (await floor.verifyActiveSession(mine)), "this browser was signed out");
});

await check("a malformed address is refused with a sentence about addresses", async () => {
  const bad = await credentials.PUT(request("/api/auth/credentials", { method: "PUT", cookie: await sessionIssuedAgo(0), body: { username: "owner@nowhere", password: "a new long password" } }));
  assert.equal(bad.status, 400);
  assert.match(String((await bad.json()).error), /email/i);
  const plain = await credentials.PUT(request("/api/auth/credentials", { method: "PUT", cookie: await sessionIssuedAgo(0), body: { username: "has space", password: "a new long password" } }));
  assert.equal(plain.status, 400);
});

console.log("\nWrites that race a reset\n");

const lockDir = path.join(path.dirname(settingsFile), ".lock");
/** What a hosted workspace's reset does inside the container, while it holds the lock. */
function resetFromOutside(hash: string, floor: number): void {
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  settings.auth = { ...settings.auth, passwordHash: hash, sessionsValidAfter: floor };
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
}

await check("a write that started before a reset cannot put the old password back", async () => {
  writeSettings({});
  fs.mkdirSync(lockDir);
  const pending = saveSettings({ general: { darkMode: true, language: "en" } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  resetFromOutside("scrypt$new$hash", 1_950_000_000);
  fs.rmdirSync(lockDir);
  await pending;
  const saved = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  assert.equal(saved.auth.passwordHash, "scrypt$new$hash", "the old password came back");
  assert.equal(saved.auth.sessionsValidAfter, 1_950_000_000, "the ended sessions came back");
  assert.equal(saved.general.darkMode, true);
});

await check("a password change by a session that a reset ended meanwhile is refused", async () => {
  writeSettings({});
  const mine = await sessionIssuedAgo(5);
  fs.mkdirSync(lockDir);
  const pending = credentials.PUT(request("/api/auth/credentials", { method: "PUT", cookie: mine, body: { username: USERNAME, password: "the intruder's choice" } }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  resetFromOutside("scrypt$owner$reset", Math.floor(Date.now() / 1000));
  fs.rmdirSync(lockDir);
  const answer = await pending;
  assert.equal(answer.status, 401);
  assert.equal(readAuth().passwordHash, "scrypt$owner$reset");
});

await check("the moment sessions were ended only moves forward", async () => {
  writeSettings({ sessionsValidAfter: 1_950_000_000 });
  await saveSettings({ auth: { ...readAuth(), sessionsValidAfter: 5 } as never });
  assert.equal(readAuth().sessionsValidAfter, 1_950_000_000);
});

await check("writes leave no half-written or temporary files behind", async () => {
  for (let i = 0; i < 5; i += 1) await saveSettings({ general: { darkMode: i % 2 === 0, language: "en" } });
  const left = fs.readdirSync(path.dirname(settingsFile)).filter((name) => name !== "settings.json");
  assert.deepEqual(left, []);
});

console.log("\nThe settings form and the sign-in page\n");

await check("the settings form cannot change the login, the password or the moment", async () => {
  writeSettings({ sessionsValidAfter: 1_900_000_000 });
  const before = readAuth();
  const response = await settingsRoute.PUT(request("/api/settings", {
    method: "PUT",
    body: { auth: { enabled: false, username: "someone-else", passwordHash: "scrypt$x$y", sessionsValidAfter: 0 }, general: { darkMode: true, language: "en" } },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(readAuth(), before);
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf-8")).general.darkMode, true, "the rest of the form was not saved");
});

await check("the sign-in page learns where a lost password is reset, and only a web address", async () => {
  process.env.EGGENT_PASSWORD_RESET_URL = "https://cloud.example.test/account/reset?w=owner";
  const answer = await (await status.GET(request("/api/auth/status"))).json();
  assert.equal(answer.passwordResetUrl, "https://cloud.example.test/account/reset?w=owner");
  process.env.EGGENT_PASSWORD_RESET_URL = "javascript:alert(1)";
  assert.equal((await (await status.GET(request("/api/auth/status"))).json()).passwordResetUrl, null);
  delete process.env.EGGENT_PASSWORD_RESET_URL;
  assert.equal((await (await status.GET(request("/api/auth/status"))).json()).passwordResetUrl, null);
});

fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
