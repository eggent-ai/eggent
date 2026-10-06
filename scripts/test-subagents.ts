/**
 * Subagents, end to end: the real runtime, the real pi-subagents extension, a
 * stub provider.
 *
 * The failure this exists for: the model launched its helpers with
 * run_in_background, the turn ended, Eggent disposed the session the way it
 * does after every turn, and the helpers kept working for a parent that no
 * longer existed. Four of five finished with real results that nobody ever
 * read; the fifth sat in the extension's queue and never started, because
 * starting it went through the disposed parent; and the chat said the work was
 * done. The stub below behaves exactly like that model did.
 *
 * Needs an installed copy of @tintinweb/pi-subagents. EGGENT_SUBAGENTS_EXTENSIONS
 * takes a comma-separated list of package directories, so several versions can
 * be checked in one run; without it the usual install locations are tried, and
 * the test is skipped when none is there. No network, no credential.
 *
 * Run with Node 22: node --experimental-strip-types --import ./scripts/alias-loader-register.mjs scripts/test-subagents.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createSubagentPolicyExtension, SubagentMonitor, watchSubagents } from "../src/lib/pi/subagents.ts";
import {
  describeStepTarget,
  encodeTranscriptCwd,
  SubagentProgressTracker,
  subagentTaskDir,
} from "../src/lib/pi/subagent-progress.ts";
import { parseSubagentActivity, parseTokenCount, splitAgentResult } from "../src/lib/pi/subagent-format.ts";
import type { SubagentSnapshot } from "../src/lib/pi/types.ts";

const PROVIDER = "stub";
const MODEL = "stub-model";
const TASK_MARK = "HELPER-TASK:";
const TOPICS = ["alpha", "beta", "gamma", "delta", "epsilon"];

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

function extensionCandidates(): string[] {
  const fromEnv = (process.env.EGGENT_SUBAGENTS_EXTENSIONS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  // The image's own seed first: that is the copy a new workspace gets.
  return [
    "/opt/eggent-pi-seed/npm/node_modules/@tintinweb/pi-subagents",
    path.join(process.cwd(), "data", "pi-agent", "npm", "node_modules", "@tintinweb", "pi-subagents"),
    path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@tintinweb", "pi-subagents"),
  ].filter((candidate) => fs.existsSync(path.join(candidate, "package.json"))).slice(0, 1);
}

// Before 0.14 the extension handed its helpers the model registry the SDK no
// longer reads, so a helper reaches no provider at all ("No API key found").
// Nothing in the fleet runs one; a copy that old tests the extension, not Eggent.
const OLDEST_SUPPORTED = [0, 14, 0];

function isSupportedVersion(version: string | undefined): boolean {
  const parts = (version ?? "").split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < OLDEST_SUPPORTED.length; index += 1) {
    const value = Number.isFinite(parts[index]) ? parts[index] : 0;
    if (value !== OLDEST_SUPPORTED[index]) return value > OLDEST_SUPPORTED[index];
  }
  return true;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

type StubMessage = { role?: string; content?: unknown; tool_calls?: unknown[] };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
  }
  return "";
}

/**
 * The parent asks for one helper per topic, in the background - the way the
 * model in the reported chat did - and summarises whatever came back. A helper
 * reads a file once, so it has a step to report, then answers.
 *
 * Two gates make the reported timing exact instead of a race. The parent's
 * closing reply waits until the helpers have got going (that model spent seven
 * seconds on it), and a helper's answer can be held until the parent's session
 * is gone (those helpers took a minute).
 */
async function startStubProvider(options: { holdHelpers: boolean }): Promise<{
  url: string;
  parentCalls: () => number;
  helperStarts: () => number[];
  helperEnds: () => number[];
  abandoned: () => number;
  parentToolReplies: () => string[];
  releaseHelpers: () => void;
  close: () => Promise<void>;
}> {
  let parentCalls = 0;
  let abandoned = 0;
  const helperStarts: number[] = [];
  const helperEnds: number[] = [];
  const parentToolReplies: string[] = [];
  let releaseHelpers = () => {};
  const helpersReleased = options.holdHelpers
    ? new Promise<void>((resolve) => { releaseHelpers = resolve; })
    : Promise.resolve();

  // Until no helper has started for a while, or long enough to be sure none will.
  const helpersUnderway = async () => {
    const deadline = Date.now() + 8000;
    let seen = -1;
    while (Date.now() < deadline) {
      if (helperStarts.length > 0 && helperStarts.length === seen) return;
      seen = helperStarts.length;
      await wait(600);
    }
  };

  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    let body = "";
    req.on("data", (part) => {
      body += String(part);
    });
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as { messages?: StubMessage[] };
      const messages = payload.messages ?? [];
      const firstUser = textOf(messages.find((message) => message.role === "user")?.content);
      const toolMessages = messages.filter((message) => message.role === "tool");
      const send = (write: () => void) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(chunk({ role: "assistant" }));
        write();
        res.write("data: [DONE]\n\n");
        res.end();
      };

      const helperTopic = firstUser.includes(TASK_MARK)
        ? firstUser.slice(firstUser.indexOf(TASK_MARK) + TASK_MARK.length).split(/\s/)[0]
        : null;

      if (helperTopic) {
        if (toolMessages.length === 0) {
          helperStarts.push(Date.now());
          setTimeout(() => send(() => {
            res.write(chunk({
              tool_calls: [{
                index: 0,
                id: `read-${helperTopic}`,
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: `${helperTopic}.txt` }) },
              }],
            }));
            res.write(chunk({}, "tool_calls"));
          }), 150);
          return;
        }
        // A helper stopped while it waits here closes its request; that is
        // counted, and it gets no answer.
        let gone = false;
        res.on("close", () => { if (!res.writableEnded) gone = true; });
        void helpersReleased.then(() => setTimeout(() => {
          if (gone) {
            abandoned += 1;
            return;
          }
          helperEnds.push(Date.now());
          send(() => {
            res.write(chunk({ content: `Finding for ${helperTopic}: ${textOf(toolMessages[0]?.content).trim()}` }));
            res.write(chunk({}, "stop"));
          });
        }, 150));
        return;
      }

      parentCalls += 1;
      if (toolMessages.length === 0) {
        send(() => {
          res.write(chunk({ content: "Starting the helpers.\n" }));
          res.write(chunk({
            tool_calls: TOPICS.map((topic, index) => ({
              index,
              id: `agent-${topic}`,
              type: "function",
              function: {
                name: "Agent",
                arguments: JSON.stringify({
                  description: `Research ${topic}`,
                  subagent_type: "general-purpose",
                  run_in_background: true,
                  prompt: `${TASK_MARK}${topic} Read ${topic}.txt and report what it says.`,
                }),
              },
            })),
          }));
          res.write(chunk({}, "tool_calls"));
        });
        return;
      }
      for (const message of toolMessages) parentToolReplies.push(textOf(message.content));
      const findings = toolMessages
        .map((message) => textOf(message.content).match(/Finding for \w+: [^\n]+/)?.[0])
        .filter(Boolean);
      const reply = () => send(() => {
        res.write(chunk({ content: findings.length ? `Summary: ${findings.join(" | ")}` : "Summary: the helpers are still running." }));
        res.write(chunk({}, "stop"));
      });
      if (findings.length) reply();
      else void helpersUnderway().then(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    parentCalls: () => parentCalls,
    helperStarts: () => [...helperStarts],
    helperEnds: () => [...helperEnds],
    abandoned: () => abandoned,
    parentToolReplies: () => [...parentToolReplies],
    releaseHelpers: () => releaseHelpers(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TurnOutcome {
  assistantText: string;
  toolUpdates: number;
  agentResults: string[];
  agentErrors: string[];
  staleErrors: string[];
  helperStarts: number[];
  helperEnds: number[];
  parentCalls: number;
  parentToolReplies: string[];
  snapshots: Map<string, SubagentSnapshot>;
  reports: number;
  runningAfterTurn: number;
  abandoned: number;
}

async function runTurn(extensionDir: string, options: {
  withEggentPolicy: boolean;
  maxParallel?: number;
  /** Without the policy: watch the detached helpers and stop them on dispose, as the session does. */
  stopDetachedOnDispose?: boolean;
}): Promise<TurnOutcome> {
  const stub = await startStubProvider({ holdHelpers: !options.withEggentPolicy });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-subagents-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "work");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  for (const topic of TOPICS) fs.writeFileSync(path.join(cwd, `${topic}.txt`), `${topic} is fine\n`);
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [PROVIDER]: {
        name: "Stub",
        baseUrl: stub.url,
        api: "openai-completions",
        models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 32768, maxTokens: 2048 }],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }, null, 2));

  const staleErrors: string[] = [];
  const onRejection = (reason: unknown) => {
    staleErrors.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", onRejection);

  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const registry = new ModelRegistry(runtime);
  await registry.refresh();
  const model = registry.getAll().find((entry) => entry.provider === PROVIDER && entry.id === MODEL);

  const monitor = new SubagentMonitor();
  const policy = options.withEggentPolicy
    ? createSubagentPolicyExtension({ maxParallel: options.maxParallel, monitor })
    : null;
  const watcher = !options.withEggentPolicy && options.stopDetachedOnDispose
    ? { name: "test-subagent-watcher", factory: (pi: Parameters<typeof watchSubagents>[0]) => watchSubagents(pi, monitor) }
    : null;

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [extensionDir],
    extensionFactories: [policy, watcher].filter((factory) => factory !== null),
    noSkills: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  await session.bindExtensions({ mode: "rpc" });

  // What the chat runner does: follow each helper, from the tool's progress and
  // from the transcript the extension writes for it.
  const snapshots = new Map<string, SubagentSnapshot>();
  let reports = 0;
  const tracker = new SubagentProgressTracker({
    sessionId: session.sessionId,
    cwd: session.sessionManager.getCwd(),
    throttleMs: 50,
    pollMs: 100,
    onChange: (snapshot) => {
      reports += 1;
      snapshots.set(snapshot.toolCallId, snapshot);
    },
  });

  let assistantText = "";
  let toolUpdates = 0;
  const agentResults: string[] = [];
  const agentErrors: string[] = [];
  const unsubscribe = session.subscribe((event: unknown) => {
    const record = event as Record<string, unknown>;
    tracker.handle(record);
    if (record.type === "message_update") {
      const delta = record.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.delta === "string") assistantText += delta.delta;
    }
    if (record.type === "tool_execution_update" && record.toolName === "Agent") toolUpdates += 1;
    if (record.type === "tool_execution_end" && record.toolName === "Agent") {
      const result = record.result as { content?: Array<{ text?: string }> } | undefined;
      const text = (result?.content ?? []).map((part) => part.text ?? "").join("");
      (record.isError === true ? agentErrors : agentResults).push(text);
    }
  });

  await session.prompt("Research five topics with five helpers.");
  unsubscribe();
  tracker.dispose();
  const runningAfterTurn = monitor.running().length;
  // What Eggent does at the end of every turn - including, in the session's own
  // dispose, stopping whatever is still unfinished and waiting for the answer.
  if (options.stopDetachedOnDispose) await monitor.stopAll().settled;
  session.dispose();
  // The detached helpers finish only now, for a parent that is gone.
  stub.releaseHelpers();
  await wait(options.withEggentPolicy ? 300 : 2500);
  if (process.env.EGGENT_SUBAGENTS_DEBUG) {
    console.log("  debug:", JSON.stringify({ starts: stub.helperStarts().length, ends: stub.helperEnds().length, stale: staleErrors }));
  }

  process.off("unhandledRejection", onRejection);
  const outcome: TurnOutcome = {
    assistantText,
    toolUpdates,
    agentResults,
    agentErrors,
    staleErrors,
    helperStarts: stub.helperStarts(),
    helperEnds: stub.helperEnds(),
    parentCalls: stub.parentCalls(),
    parentToolReplies: stub.parentToolReplies(),
    snapshots,
    reports,
    runningAfterTurn,
    abandoned: stub.abandoned(),
  };
  await stub.close();
  fs.rmSync(root, { recursive: true, force: true });
  return outcome;
}

console.log("Reading the Agent tool\n");

check("an activity naming tools becomes those tools", () => {
  assert.deepEqual(parseSubagentActivity("web_search…"), { kind: "tool", tools: ["web_search"] });
  assert.deepEqual(parseSubagentActivity("reading 2 files, running command…"), { kind: "tool", tools: ["read", "bash"] });
});
check("thinking, a queue and prose are told apart", () => {
  assert.deepEqual(parseSubagentActivity("thinking…"), { kind: "thinking" });
  assert.deepEqual(parseSubagentActivity("queued — waiting for a foreground slot (2 ahead)"), { kind: "queued" });
  assert.equal(parseSubagentActivity("The three most important items are…")?.kind, "writing");
});
check("the headline the extension adds for the model is not part of the result", () => {
  assert.deepEqual(
    splitAgentResult("Agent completed in 1m 10s (9 tool uses, 12.3k token).\n\n1. First finding"),
    { result: "1. First finding" }
  );
  assert.deepEqual(
    splitAgentResult("Agent failed: provider refused\n\nPartial output:\nhalf"),
    { result: "Partial output:\nhalf", error: "provider refused" }
  );
});
check("token counts come back as numbers", () => {
  assert.equal(parseTokenCount("12.3k token"), 12300);
  assert.equal(parseTokenCount("1.2M token"), 1200000);
  assert.equal(parseTokenCount(""), undefined);
});
check("a step names what it was pointed at", () => {
  assert.equal(describeStepTarget("web_search", { queries: ["first query", "second"] }), "first query (+1)");
  assert.equal(describeStepTarget("fetch_content", { url: "https://example.test/page" }), "https://example.test/page");
  assert.equal(describeStepTarget("read", { path: "notes.txt" }), "notes.txt");
});
check("and never keeps a secret it was handed", () => {
  const target = describeStepTarget("bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.test" }) ?? "";
  assert.ok(!target.includes("abcdefghijklmnop"), target);
});
check("the transcript directory is the extension's own", () => {
  assert.equal(encodeTranscriptCwd("/app/data/projects"), "app-data-projects");
  assert.ok(subagentTaskDir("/app/data/projects", "chat-1", "/tmp").endsWith(path.join("app-data-projects", "chat-1", "tasks")));
});

const candidates = extensionCandidates();
if (!candidates.length) {
  console.log("\nSubagents end to end: skipped - no copy of @tintinweb/pi-subagents found (set EGGENT_SUBAGENTS_EXTENSIONS).");
  console.log(`\n${ran} checks, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

for (const extensionDir of candidates) {
  const version = (JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf-8")) as { version?: string }).version;
  if (!isSupportedVersion(version)) {
    console.log(`\nSubagents end to end: skipped pi-subagents ${version} at ${extensionDir} - older than ${OLDEST_SUPPORTED.join(".")}, whose helpers cannot reach a provider on this SDK.`);
    continue;
  }
  console.log(`\nSubagents end to end, pi-subagents ${version ?? "?"}\n`);

  const bare = await runTurn(extensionDir, { withEggentPolicy: false });
  check("without the policy the helpers are detached, as in the reported chat", () => {
    assert.ok(bare.agentResults.every((text) => /in background/i.test(text)), bare.agentResults.join(" / "));
  });
  check("...and the parent answers without a single finding", () => {
    assert.ok(!/Finding for/.test(bare.assistantText), bare.assistantText);
  });
  check("...while the helpers that started finish for nobody", () => {
    assert.ok(bare.helperEnds.length > 0, "no helper finished");
    assert.equal(bare.parentCalls, 2);
  });
  if (bare.agentResults.some((text) => /queued/i.test(text))) {
    check("...and the one left in the extension's queue never starts", () => {
      assert.ok(bare.helperStarts.length < TOPICS.length, `${bare.helperStarts.length} of ${TOPICS.length} started`);
    });
  }

  const guarded = await runTurn(extensionDir, { withEggentPolicy: false, stopDetachedOnDispose: true });
  check("a helper left detached is seen as still running when the turn ends", () => {
    assert.ok(guarded.runningAfterTurn > 0, `${guarded.runningAfterTurn} running`);
  });
  check("...and disposing the session stops it instead of letting it work for nobody", () => {
    assert.equal(guarded.helperEnds.length, 0, `${guarded.helperEnds.length} finished anyway`);
    assert.ok(guarded.abandoned > 0, "no helper request was dropped");
  });

  const fixed = await runTurn(extensionDir, { withEggentPolicy: true });
  check("with the policy every helper reports back inside the turn", () => {
    assert.equal(fixed.agentResults.length, TOPICS.length);
    for (const topic of TOPICS) {
      assert.ok(fixed.agentResults.some((text) => text.includes(`Finding for ${topic}: ${topic} is fine`)), `no result for ${topic}: ${fixed.agentResults.join(" / ")}`);
    }
  });
  check("the parent continues with all of the results", () => {
    for (const topic of TOPICS) assert.ok(fixed.assistantText.includes(`Finding for ${topic}`), fixed.assistantText);
    assert.equal(fixed.parentCalls, 2);
  });
  check("the helpers ran at the same time, not one after another", () => {
    assert.equal(fixed.helperStarts.length, TOPICS.length);
    const lastStart = Math.max(...fixed.helperStarts);
    const firstEnd = Math.min(...fixed.helperEnds);
    assert.ok(lastStart <= firstEnd, `last helper started ${lastStart - firstEnd}ms after the first one finished`);
  });
  check("progress is reported while they work", () => assert.ok(fixed.toolUpdates > 0, `${fixed.toolUpdates} updates`));
  check("nothing is left to fail against a disposed session", () => {
    assert.deepEqual(fixed.staleErrors.filter((message) => /stale/i.test(message)), []);
  });
  check("each helper ends up done, under the name it was given", () => {
    assert.equal(fixed.snapshots.size, TOPICS.length);
    for (const snapshot of fixed.snapshots.values()) {
      assert.equal(snapshot.status, "done", JSON.stringify(snapshot));
      assert.match(snapshot.description, /^Research \w+$/);
      assert.ok(snapshot.endedAt, "no end time");
    }
  });
  check("what each helper did is read from its own transcript", () => {
    for (const topic of TOPICS) {
      const snapshot = [...fixed.snapshots.values()].find((item) => item.description === `Research ${topic}`);
      assert.ok(snapshot, `no snapshot for ${topic}`);
      assert.deepEqual(snapshot.steps, [{ tool: "read", target: `${topic}.txt` }]);
    }
  });
  check("nothing is left running once the turn is over", () => {
    assert.equal(fixed.runningAfterTurn, 0);
  });
  check("progress is throttled rather than sent twelve times a second", () => {
    assert.ok(fixed.reports < fixed.toolUpdates, `${fixed.reports} reports for ${fixed.toolUpdates} updates`);
  });

  const capped = await runTurn(extensionDir, { withEggentPolicy: true, maxParallel: 2 });
  check("past the limit a helper is not started, and the model is told why", () => {
    assert.equal(capped.agentResults.length, 2, capped.agentResults.join(" / "));
    assert.equal(capped.agentErrors.length, TOPICS.length - 2);
    assert.ok(capped.agentErrors.every((text) => text.includes("Not started")), capped.agentErrors.join(" / "));
    assert.equal(capped.helperStarts.length, 2);
  });
  check("...and the chat shows it as failed with that reason", () => {
    const failedOnes = [...capped.snapshots.values()].filter((snapshot) => snapshot.status === "failed");
    assert.equal(failedOnes.length, TOPICS.length - 2);
    assert.ok(failedOnes.every((snapshot) => snapshot.error?.includes("Not started")), JSON.stringify(failedOnes));
  });
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
