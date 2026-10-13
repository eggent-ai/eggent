/**
 * What the chat screen decides about where a chat can run, with no server in it:
 * which places to offer, which refusals the way back fixes, and when the control
 * is left out because there is nothing to choose between.
 *
 * Run with Node 22:  npm run test:remote-client
 */
import assert from "node:assert/strict";
import { canRunHereInstead, choiceFor, nothingToChoose, parseHandoverFailure, placeChoices } from "../src/lib/remote/client.ts";
import type { RemoteDevice, RemoteStatus } from "../src/lib/remote/types.ts";

let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const device = (overrides: Partial<RemoteDevice> = {}): RemoteDevice => ({
  node: "device:MAC-1",
  name: "MacBook",
  online: true,
  accept: "ask",
  historyShared: true,
  lastSeenAt: null,
  ...overrides,
});
const cloudStatus = (devices: RemoteDevice[] = []): RemoteStatus => ({ enabled: true, node: "cloud", nodeName: "Cloud", devices, reachable: true });
const computerStatus = (reachable = true): RemoteStatus => ({ enabled: true, node: "device:MAC-1", nodeName: "MacBook", devices: [], reachable });

check("a workspace with no computer paired has one place, and the control is left out", () => {
  assert.deepEqual(placeChoices(cloudStatus()).map((choice) => choice.node), ["cloud"]);
  assert.equal(nothingToChoose(cloudStatus(), null), true);
  assert.equal(nothingToChoose(cloudStatus(), "cloud"), true);
});

check("a chat left pointing at a computer that is no longer paired keeps the control, for the way back", () => {
  assert.equal(nothingToChoose(cloudStatus(), "device:GONE"), false);
  assert.equal(choiceFor(cloudStatus(), "device:GONE"), null);
});

check("with a computer paired, the control is there - whether or not the computer is online", () => {
  assert.equal(nothingToChoose(cloudStatus([device()]), null), false);
  assert.equal(nothingToChoose(cloudStatus([device({ online: false })]), null), false);
});

check("a computer always has the cloud to choose, reachable or not", () => {
  assert.equal(nothingToChoose(computerStatus(), null), false);
  const unreachable = placeChoices(computerStatus(false));
  assert.deepEqual(unreachable.map((choice) => [choice.node, choice.available]), [["device:MAC-1", true], ["cloud", false]]);
});

check("a computer is offered only while it is there, takes tasks and has the history to carry one", () => {
  const choiceOf = (overrides: Partial<RemoteDevice>) => placeChoices(cloudStatus([device(overrides)]))[1];
  assert.equal(choiceOf({}).available, true);
  const offline = choiceOf({ online: false });
  assert.equal(offline.available, false);
  assert.equal(offline.available === false && offline.reason, "offline");
  const notTaking = choiceOf({ accept: null });
  assert.equal(notTaking.available === false && notTaking.reason, "offline");
  const noHistory = choiceOf({ historyShared: false });
  assert.equal(noHistory.available === false && noHistory.reason, "not-ready");
});

check("nothing is offered when the feature is off here", () => {
  assert.deepEqual(placeChoices({ enabled: false, node: null, nodeName: null, devices: [], reachable: true }), []);
  assert.deepEqual(placeChoices({ enabled: true, node: null, nodeName: null, devices: [], reachable: true }), []);
});

check("a chat with no home is where it is typed", () => {
  assert.equal(choiceFor(cloudStatus([device()]), null)?.node, "cloud");
  assert.equal(choiceFor(computerStatus(), undefined)?.node, "device:MAC-1");
  assert.equal(choiceFor(cloudStatus([device()]), "device:MAC-1")?.node, "device:MAC-1");
});

check("a refusal is read from what the route wrote, and nothing else is taken for one", () => {
  const written = JSON.stringify({ error: "The computer is not available.", code: "offline", home: "device:MAC-1" });
  assert.deepEqual(parseHandoverFailure(new Error(written)), { message: "The computer is not available.", code: "offline", home: "device:MAC-1" });
  assert.equal(parseHandoverFailure(new Error(JSON.stringify({ error: "x", code: "something-new" }))), null);
  assert.equal(parseHandoverFailure(new Error("Failed to fetch")), null);
  assert.equal(parseHandoverFailure(new Error("{ not json")), null);
  assert.equal(parseHandoverFailure(undefined), null);
  assert.equal(parseHandoverFailure(written)?.code, "offline");
});

check("running it here instead is offered for the refusals it fixes, and only those", () => {
  const fixes = ["offline", "not-ready", "denied", "timeout"] as const;
  for (const code of fixes) assert.equal(canRunHereInstead({ message: "", code }), true, code);
  for (const code of ["not-synced", "busy", "failed", "disabled"] as const) assert.equal(canRunHereInstead({ message: "", code }), false, code);
  assert.equal(canRunHereInstead({ message: "" }), false);
});

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
