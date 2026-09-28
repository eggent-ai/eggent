/**
 * Checks one-time sign-in links end to end on the real routes.
 *
 * Run with Node 22: npm run test:auth-handoff
 *
 * A link is minted by a signed-in client and spent by a browser that has no
 * session yet. What must hold: minting needs a session, spending needs none,
 * a token works once and only for ten minutes, the session it starts is the
 * one a password would have started, and a link minted before the workspace
 * changed its login does not sign anybody in afterwards.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-auth-handoff-"));
process.chdir(workdir);
process.env.EGGENT_AUTH_SECRET = "handoff-test-secret-0123456789abcdef";

const USERNAME = "owner@example.test";
const { hashPassword } = await import("../src/lib/auth/password.ts");
function writeLogin(username: string): void {
  fs.mkdirSync(path.join(workdir, "data", "settings"), { recursive: true });
  fs.writeFileSync(
    path.join(workdir, "data", "settings", "settings.json"),
    JSON.stringify({ auth: { enabled: true, username, passwordHash: hashPassword("correct horse battery") } })
  );
}
writeLogin(USERNAME);

const { HANDOFF_TTL_MS, mintHandoffToken, redeemHandoffToken } = await import("../src/lib/auth/handoff.ts");
const { AUTH_COOKIE_NAME, createSessionToken, verifySessionToken } = await import("../src/lib/auth/session.ts");
const mint = await import("../src/app/api/auth/handoff/route.ts");
const redeem = await import("../src/app/api/auth/handoff/redeem/route.ts");
const { middleware } = await import("../src/middleware.ts");
const { NextRequest } = await import("next/server.js");

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

const ORIGIN = "https://workspace.example.test";
async function mintRequest(cookie?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", `${AUTH_COOKIE_NAME}=${cookie}`);
  return mint.POST(new NextRequest(`${ORIGIN}/api/auth/handoff`, { method: "POST", headers }));
}
async function redeemRequest(token: unknown) {
  return redeem.POST(
    new NextRequest(`${ORIGIN}/api/auth/handoff/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
  );
}
function sessionCookieFrom(response: Response): string | null {
  const header = response.headers.get("set-cookie") || "";
  const match = header.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

console.log("the token itself:");
await check("a minted token works once", () => {
  const { token } = mintHandoffToken(USERNAME);
  assert.deepEqual(redeemHandoffToken(token), { username: USERNAME });
  assert.equal(redeemHandoffToken(token), null);
});
await check("a token is dead after ten minutes", () => {
  const now = Date.now();
  const { token } = mintHandoffToken(USERNAME, now);
  assert.equal(redeemHandoffToken(token, now + HANDOFF_TTL_MS + 1), null);
  // Spent by the failed attempt too, so waiting cannot bring it back.
  assert.equal(redeemHandoffToken(token, now), null);
});
await check("only a hash of the token is kept", () => {
  const { token } = mintHandoffToken(USERNAME);
  const store = (globalThis as { __eggentAuthHandoffs?: Map<string, unknown> }).__eggentAuthHandoffs;
  assert.ok(store && store.size > 0);
  assert.ok(![...store.keys()].includes(token));
  redeemHandoffToken(token);
});
await check("anything that was never a token is refused", () => {
  for (const value of [undefined, null, 42, "", "short", "x".repeat(500)]) {
    assert.equal(redeemHandoffToken(value), null);
  }
});
await check("a burst of mints cannot grow the store without bound", () => {
  for (let i = 0; i < 200; i += 1) mintHandoffToken(USERNAME);
  const store = (globalThis as { __eggentAuthHandoffs?: Map<string, unknown> }).__eggentAuthHandoffs;
  assert.ok(store && store.size <= 50, `store holds ${store?.size}`);
});

console.log("the routes:");
await check("minting without a session is refused", async () => {
  const response = await mintRequest();
  assert.equal(response.status, 401);
});
await check("minting with a forged session is refused", async () => {
  const response = await mintRequest("eyJ1Ijoib3duZXIifQ.not-a-signature");
  assert.equal(response.status, 401);
});

const ownerSession = await createSessionToken(USERNAME, false);
let minted: { token: string; path: string; expiresAt: string } | null = null;
await check("a signed-in client gets a link whose token rides in the fragment", async () => {
  const response = await mintRequest(ownerSession);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  minted = (await response.json()) as { token: string; path: string; expiresAt: string };
  assert.equal(minted.path, `/login#handoff=${minted.token}`);
  assert.ok(Date.parse(minted.expiresAt) > Date.now());
});
await check("spending it starts the session a password would have", async () => {
  assert.ok(minted, "no token minted");
  const response = await redeemRequest(minted.token);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { success?: boolean; mustChangeCredentials?: boolean };
  assert.equal(body.success, true);
  assert.equal(body.mustChangeCredentials, false);
  const cookie = sessionCookieFrom(response);
  assert.ok(cookie, "no session cookie set");
  const session = await verifySessionToken(cookie);
  assert.equal(session?.username, USERNAME);
  const header = response.headers.get("set-cookie") || "";
  assert.match(header, /HttpOnly/i);
  // Behind the proxy the request is https, so the cookie must say Secure.
  assert.match(header, /Secure/i);
});
await check("the same link does not work a second time", async () => {
  assert.ok(minted, "no token minted");
  const response = await redeemRequest(minted.token);
  assert.equal(response.status, 401);
  assert.equal(sessionCookieFrom(response), null);
});
await check("a link minted before the login changed signs nobody in", async () => {
  const response = await mintRequest(ownerSession);
  const { token } = (await response.json()) as { token: string };
  writeLogin("new-owner@example.test");
  try {
    const spent = await redeemRequest(token);
    assert.equal(spent.status, 401);
    assert.equal(sessionCookieFrom(spent), null);
  } finally {
    writeLogin(USERNAME);
  }
});
await check("a malformed body is a refusal, not a crash", async () => {
  const response = await redeem.POST(
    new NextRequest(`${ORIGIN}/api/auth/handoff/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
  );
  assert.equal(response.status, 401);
});

console.log("the middleware:");
await check("spending a link needs no session", async () => {
  const response = await middleware(new NextRequest(`${ORIGIN}/api/auth/handoff/redeem`, { method: "POST" }));
  assert.equal(response.headers.get("x-middleware-next"), "1");
});
await check("minting one does", async () => {
  const response = await middleware(new NextRequest(`${ORIGIN}/api/auth/handoff`, { method: "POST" }));
  assert.equal(response.status, 401);
});

console.log(`\n${ran - failed}/${ran} checks passed`);
fs.rmSync(workdir, { recursive: true, force: true });
if (failed > 0) process.exit(1);
