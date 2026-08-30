/**
 * Checks that a provider's own refusal survives the trip to the user.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-provider-failure.ts
 *
 * A failing turn looks identical to an empty one - no text, no tools, zero
 * tokens - so the only thing separating "the provider is rate limiting you"
 * from "your account was disabled" is the message the provider sent. These
 * cases pin the parsing of the shapes real providers use, and pin the
 * redaction, because this text lands in a stored chat.
 *
 * No network and no credential: every input here is a recorded error body with
 * any identifying material replaced.
 */
import assert from "node:assert/strict";
import { describeProviderFailure } from "../src/lib/pi/provider-failure.ts";

let failed = 0;
let ran = 0;

function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("Provider failure descriptions\n");

// The shape that started this: an outer JSON envelope whose "message" is itself
// a JSON document, with the sentence worth reading two levels down.
const doublyNested = JSON.stringify({
  error: {
    message: JSON.stringify({
      error: {
        code: 401,
        message: "The bound service account is deleted or disabled. The service account bound to the API key must be active.",
        status: "UNAUTHENTICATED",
        details: [{ "@type": "type.example.test/ErrorInfo", reason: "ACCOUNT_STATE_INVALID" }],
      },
    }),
    code: 401,
    status: "Unauthorized",
  },
});

check("reads the innermost sentence out of a doubly nested body", () => {
  const result = describeProviderFailure(doublyNested);
  assert.ok(result, "expected a description");
  assert.equal(result.status, 401);
  assert.match(result.message, /service account is deleted or disabled/);
});

check("keeps a flat {error:{message}} body", () => {
  const result = describeProviderFailure(
    JSON.stringify({ error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: 429 } })
  );
  assert.ok(result);
  assert.equal(result.status, 429);
  assert.equal(result.message, "You exceeded your current quota.");
});

check("splits the status off a \"401: {…}\" body", () => {
  // The exact shape a live provider refusal arrives in.
  const result = describeProviderFailure(
    '401: {"message":"Authentication Fails, Your api key: ****0000 is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}'
  );
  assert.ok(result);
  assert.equal(result.status, 401);
  assert.equal(result.message, "Authentication Fails, Your api key: ****0000 is invalid");
  assert.ok(!result.message.includes("{"), "the body must not be shown as punctuation");
});

check("a status prefix with nothing after it is not a sentence", () => {
  // Nothing to quote, so the caller falls through to probing the provider,
  // which can still tell a dead address from a rejected key.
  assert.equal(describeProviderFailure("503: "), null);
  assert.equal(describeProviderFailure("500:"), null);
});

check("keeps a plain string that is not JSON at all", () => {
  const result = describeProviderFailure("upstream connect error or disconnect/reset before headers");
  assert.ok(result);
  assert.equal(result.status, undefined);
  assert.match(result.message, /upstream connect error/);
});

check("returns null when there is nothing to quote", () => {
  assert.equal(describeProviderFailure(undefined), null);
  assert.equal(describeProviderFailure(""), null);
  assert.equal(describeProviderFailure("   "), null);
  assert.equal(describeProviderFailure(42), null);
});

check("a body that says only the status word adds nothing", () => {
  const result = describeProviderFailure(JSON.stringify({ error: { message: "Unauthorized" } }));
  assert.equal(result, null);
});

check("redacts anything credential-shaped before it reaches a chat", () => {
  const bodies = [
    'Invalid key: sk-abcdefghijklmnopqrstuvwxyz012345',
    'header was "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"',
    'bad key AIzaSyDummyDummyDummyDummyDummyDummy0',
    'rejected AQ.Ab8DummyDummyDummyDummyDummyDummyXY',
    'token eggw_abcdefghijklmnopqrstuvwxyz01',
    'api_key="abcdefghijklmnopqrstuvwxyz"',
  ];
  for (const body of bodies) {
    const result = describeProviderFailure(JSON.stringify({ error: { message: body, code: 401 } }));
    assert.ok(result, `expected a description for: ${body}`);
    assert.match(result.message, /\[redacted\]/, `not redacted: ${result.message}`);
    for (const secretish of ["sk-abc", "AIzaSy", "AQ.Ab8", "eggw_abc", "Bearer abc"]) {
      assert.ok(!result.message.includes(secretish), `leaked ${secretish} in: ${result.message}`);
    }
  }
});

check("clips a body that would flood the chat", () => {
  const long = "x".repeat(5000);
  const result = describeProviderFailure(JSON.stringify({ error: { message: long, code: 500 } }));
  assert.ok(result);
  assert.ok(result.message.length <= 221, `too long: ${result.message.length}`);
  assert.ok(result.message.endsWith("…"));
});

check("collapses whitespace so a multi-line body stays one sentence", () => {
  const result = describeProviderFailure("model not found\n\n  try another one");
  assert.ok(result);
  assert.equal(result.message, "model not found try another one");
});

check("survives a body that is not an object and not a string", () => {
  assert.equal(describeProviderFailure(JSON.stringify(null)), null);
  assert.doesNotThrow(() => describeProviderFailure(JSON.stringify([1, 2, 3])));
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
