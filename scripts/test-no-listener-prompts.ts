/**
 * A prompt on a run nobody can answer on.
 *
 * Telegram and the external API have no card to show, so a dialog an extension
 * opened - or a command that stopped to ask "overwrite? [y/N]" - waited for an
 * answer that could not come, with the whole turn behind it and the person's own
 * words queued behind that. Both now end at once when there is no one to ask,
 * and still wait when there is. No model, no network. Run with Node 22:
 *   npm run test:no-listener-prompts
 */
import assert from "node:assert/strict";
import os from "node:os";
import { createEggentPiExtensionUIContext } from "../src/lib/pi/interaction-ui-context.ts";
import { createEggentInteractiveBashTool } from "../src/lib/pi/interactive-bash-tool.ts";
import { listPendingInteractions, respondToPendingInteraction } from "../src/lib/pi/pending-interactions.ts";
import type { PiPendingInteraction } from "../src/lib/pi/interaction-types.ts";

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} was still waiting after ${ms} ms`)), ms)),
  ]);
}

console.log("An extension's dialog\n");

await check("with no card to show, a yes/no question is answered no at once, and nothing stays open", async () => {
  const ui = createEggentPiExtensionUIContext({ runId: "run-telegram" });
  const answer = await within(500, ui.confirm("Allow project MCP server?", "x"), "the dialog");
  assert.equal(answer, false);
  assert.equal(listPendingInteractions("run-telegram").length, 0);
});

await check("a choice or a typed answer is dismissed the same way", async () => {
  const ui = createEggentPiExtensionUIContext({ runId: "run-telegram-2" });
  assert.equal(await within(500, ui.select("Pick", ["a", "b"]), "the choice"), undefined);
  assert.equal(await within(500, ui.input("Name?"), "the input"), undefined);
});

await check("with a card to show, the question is asked and waits for the person", async () => {
  const seen: PiPendingInteraction[] = [];
  const ui = createEggentPiExtensionUIContext({ runId: "run-web", onInteraction: (interaction) => seen.push(interaction) });
  const answered = ui.confirm("Allow project MCP server?", "x");
  await sleep(20);
  const [open] = listPendingInteractions("run-web");
  assert.ok(open, "no question was put to the person");
  respondToPendingInteraction("run-web", open.id, { value: true });
  assert.equal(await within(500, answered, "the answer"), true);
  assert.ok(seen.length >= 1);
});

console.log("\nA command that stops to ask\n");

const ASKING = `printf 'Overwrite? [y/N] '; read answer; echo "got=[$answer]"`;

async function run(onInteraction?: (interaction: PiPendingInteraction) => void, runId = "run-bash"): Promise<string> {
  const tool = createEggentInteractiveBashTool({ cwd: os.tmpdir(), runId, onInteraction });
  // What a running session hands every tool: the bash tool reads the session's id.
  const ctx = { cwd: os.tmpdir(), sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined } };
  const result = await tool.execute("call-1", { command: ASKING }, undefined, undefined, ctx as never);
  return JSON.stringify(result);
}

await check("with no one to ask, the command sees the end of its input and carries on", async () => {
  const output = await within(8000, run(undefined, "run-bash-1"), "the command");
  assert.ok(output.includes("got=[]"), output);
  assert.equal(listPendingInteractions("run-bash-1").length, 0);
});

await check("with someone to ask, it waits for their answer and uses it", async () => {
  const running = run(() => undefined, "run-bash-2");
  let open: PiPendingInteraction | undefined;
  for (let waited = 0; waited < 3000 && !open; waited += 50) {
    await sleep(50);
    open = listPendingInteractions("run-bash-2")[0];
  }
  assert.ok(open, "the command's question was not put to anyone");
  respondToPendingInteraction("run-bash-2", open.id, { value: "y" });
  const output = await within(8000, running, "the command");
  assert.ok(output.includes("got=[y]"), output);
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
