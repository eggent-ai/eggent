/**
 * Checks the browser's half of the terminal: following a job's output, coming
 * back to it after a connection dropped or a page was reloaded, and the store
 * the command cards in the chat are drawn from.
 *
 * Run with Node 22: npm run test:terminal-client
 *
 * The page's `fetch` is answered by the real route handlers in the same
 * process (real bash behind them), so what is under test is the contract
 * between the two halves and not a copy of it: offsets, replay, the exit event,
 * a stream that ends without one. The connection is cut on purpose, in the
 * middle of a frame, because that is what a flaky network does.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-terminal-client-"));
process.chdir(workdir);
process.env.EGGENT_AUTH_SECRET = "terminal-client-test-secret-0123456789ab";
process.env.TMPDIR = workdir;
fs.mkdirSync(path.join(workdir, "data", "projects", "demo"), { recursive: true });

// What the page has and Node does not: a window and a per-tab store.
const memory = new Map<string, string>();
const sessionStorageShim = {
  getItem: (key: string) => (memory.has(key) ? (memory.get(key) as string) : null),
  setItem: (key: string, value: string) => void memory.set(key, String(value)),
  removeItem: (key: string) => void memory.delete(key),
};
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: sessionStorageShim, configurable: true });

const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const jobsRoute = await import("../src/app/api/terminal/jobs/route.ts");
const streamRoute = await import("../src/app/api/terminal/jobs/[id]/stream/route.ts");
const inputRoute = await import("../src/app/api/terminal/jobs/[id]/input/route.ts");
const resizeRoute = await import("../src/app/api/terminal/jobs/[id]/resize/route.ts");
const stopRoute = await import("../src/app/api/terminal/jobs/[id]/stop/route.ts");
const { getTerminalRegistry } = await import("../src/lib/terminal/registry.ts");
const client = await import("../src/lib/terminal/client.ts");
const { NextRequest } = await import("next/server.js");

const ORIGIN = "http://localhost:3000";
const session = await createSessionToken("owner@example.test", false);

/**
 * Cuts the next streams: the first two chunks go through whole, the third is
 * sent half and the connection ends - mid-frame, which is how a bad network
 * ends one.
 */
let dropNext = 0;
const requested: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, ORIGIN);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  headers.set("cookie", `${AUTH_COOKIE_NAME}=${session}`);
  headers.set("origin", ORIGIN);
  headers.set("host", "localhost:3000");
  const request = new NextRequest(url, {
    method,
    headers,
    body: (init?.body as BodyInit | null | undefined) ?? undefined,
    signal: init?.signal ?? undefined,
  });
  requested.push(`${method} ${url.pathname}${url.search}`);

  if (url.pathname === "/api/terminal/jobs") return jobsRoute.POST(request);
  const match = url.pathname.match(/^\/api\/terminal\/jobs\/([^/]+)\/(stream|input|resize|stop)$/);
  if (!match) return new Response("not found", { status: 404 });
  const params = { params: Promise.resolve({ id: decodeURIComponent(match[1]) }) };
  if (match[2] === "stream") {
    const response = await streamRoute.GET(request, params);
    if (dropNext > 0 && response.body) {
      dropNext -= 1;
      const reader = response.body.getReader();
      let chunks = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await reader.read();
            if (done) return controller.close();
            chunks += 1;
            if (chunks <= 2) return controller.enqueue(value);
            controller.enqueue(value.slice(0, Math.max(1, Math.floor(value.length / 2))));
            await reader.cancel();
            controller.close();
          },
          cancel: () => reader.cancel(),
        }),
        { headers: response.headers }
      );
    }
    return response;
  }
  if (match[2] === "input") return inputRoute.POST(request, params);
  if (match[2] === "resize") return resizeRoute.POST(request, params);
  return stopRoute.POST(request, params);
}) as typeof fetch;

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Followed {
  text: string;
  exit: { code: number | null; reason: string } | null;
  lost: boolean;
  starts: Array<{ from: number; truncated: boolean }>;
  connections: string[];
}
function follow(id: string, from = 0, options: import("../src/lib/terminal/client.ts").FollowOptions = {}) {
  const seen: Followed = { text: "", exit: null, lost: false, starts: [], connections: [] };
  const follower = client.followTerminalJob(
    id,
    from,
    {
      onStart: (info) => seen.starts.push({ from: info.from, truncated: info.truncated }),
      onOutput: (text) => {
        seen.text += text;
      },
      onExit: (info) => {
        seen.exit = { code: info.code, reason: info.reason };
      },
      onLost: () => {
        seen.lost = true;
      },
      onConnection: (state) => seen.connections.push(state),
    },
    options
  );
  return { seen, follower };
}
async function newRun(command: string, projectId: string | null = null): Promise<string> {
  const { id } = await client.createTerminalJob({ kind: "run", projectId, command });
  return id;
}

// ---------------------------------------------------------------------------
console.log("following a job:");

await check("output arrives in order and the exit ends the reading", async () => {
  const id = await newRun("printf one; sleep 0.15; printf two; exit 5");
  const { seen } = follow(id);
  await until(() => seen.exit !== null, "the exit");
  assert.equal(seen.text, "onetwo");
  assert.deepEqual(seen.exit, { code: 5, reason: "exit" });
  assert.equal(seen.lost, false);
});
await check("a connection cut in the middle of a frame is picked up again, with nothing missed or repeated", async () => {
  const id = await newRun("printf aaa; sleep 0.2; printf bbb; sleep 0.2; printf ccc");
  dropNext = 2;
  const before = requested.length;
  const { seen } = follow(id);
  await until(() => seen.exit !== null, "the exit");
  assert.equal(seen.text, "aaabbbccc");
  const streams = requested.slice(before).filter((line) => line.includes("/stream"));
  assert.ok(streams.length >= 3, `only ${streams.length} stream requests`);
  assert.ok(seen.connections.includes("reconnecting"));
  // Each new request asked for where the last one had got to, not for the start.
  const froms = streams.map((line) => Number(line.match(/from=(\d+)/)?.[1]));
  assert.equal(froms[0], 0);
  assert.ok(froms[1] > 0 || froms[2] > 0, `offsets ${froms.join(",")}`);
});
await check("a job the server does not know is reported as gone, once, without retrying", async () => {
  const before = requested.length;
  const { seen } = follow("run_00000000000000000000000000000000");
  await until(() => seen.lost, "the loss");
  await sleep(300);
  assert.equal(requested.slice(before).filter((line) => line.includes("/stream")).length, 1);
});
await check("stopping the reading leaves the job running, and a new reader continues from the offset", async () => {
  const id = await newRun("printf first; sleep 0.4; printf second");
  const { seen, follower } = follow(id);
  await until(() => seen.text === "first", "the first part");
  follower.stop();
  const offset = follower.offset();
  assert.equal(offset, 5);
  assert.equal(getTerminalRegistry().summary(id)?.state, "running");
  const next = follow(id, offset);
  await until(() => next.seen.exit !== null, "the exit");
  assert.equal(next.seen.text, "second");
});
await check("a stream that never opens gives up after a while instead of retrying for ever", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError("network down");
  }) as typeof fetch;
  try {
    const { seen } = follow("run_11111111111111111111111111111111", 0, { retryDelaysMs: [10], maxRetries: 5 });
    await until(() => seen.lost, "giving up");
    assert.equal(calls, 6);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
console.log("\nthe store behind the cards:");
type Store = typeof import("../src/store/shell-runs.ts");
const shellRuns = (await import("../src/store/shell-runs.ts")) as Store;
const state = () => shellRuns.useShellRuns.getState();
/** A page load: a second copy of the module, reading what the tab kept. */
const reloadPage = (n: number): Promise<Store> => import(`../src/store/shell-runs.ts?reload=${n}`) as Promise<Store>;
const run = (key: string) => state().runs[key];

await check("a command goes from starting to done, and the output is kept", async () => {
  await state().start({ key: "t1", command: "echo hello; echo there", projectId: "demo" });
  await until(() => run("t1")?.status === "done", "done");
  assert.equal(run("t1").output, "hello\nthere\n");
  assert.equal(run("t1").exitCode, 0);
  assert.ok(run("t1").endedAt && run("t1").endedAt! >= run("t1").startedAt);
});
await check("a failing command is failed, with its code", async () => {
  await state().start({ key: "t2", command: "echo nope >&2; exit 9", projectId: null });
  await until(() => run("t2")?.status === "failed", "failed");
  assert.equal(run("t2").exitCode, 9);
  assert.match(run("t2").output, /nope/);
});
await check("it runs in the project's folder", async () => {
  fs.writeFileSync(path.join(workdir, "data", "projects", "demo", "marker.txt"), "x");
  await state().start({ key: "t3", command: "ls", projectId: "demo" });
  await until(() => run("t3")?.status === "done", "done");
  assert.match(run("t3").output, /marker\.txt/);
});
await check("stop ends a command that would not have ended", async () => {
  await state().start({ key: "t4", command: "sleep 60", projectId: null });
  await until(() => run("t4")?.status === "running", "running");
  await state().stop("t4");
  await until(() => run("t4")?.status === "stopped", "stopped");
});
await check("what is typed reaches a command that asked", async () => {
  await state().start({ key: "t5", command: "read -r x; echo got-$x", projectId: null });
  await until(() => run("t5")?.status === "running", "running");
  await sleep(150);
  await state().sendInput("t5", "yes");
  await until(() => run("t5")?.status === "done", "done");
  assert.equal(run("t5").output, "got-yes\n");
});
await check("a refused start is shown as an error with the reason, not left starting", async () => {
  await state().start({ key: "t6", command: "true", projectId: "no-such-project" });
  await until(() => run("t6")?.status === "error", "error");
  assert.match(run("t6").error ?? "", /not found/i);
});
await check("output that is very long is bounded in memory, and says it was cut", async () => {
  await state().start({ key: "t7", command: "head -c 600000 /dev/zero | tr '\\0' 'x'; echo END", projectId: null });
  await until(() => run("t7")?.status === "done", "done", 15000);
  assert.ok(run("t7").output.length <= 300_000, `kept ${run("t7").output.length}`);
  assert.ok(run("t7").droppedChars > 0);
  assert.ok(run("t7").output.endsWith("END\n"));
});

console.log("\ncommands typed behind !:");
await check("a card is added after the message it was typed under, and removed with its run", async () => {
  const key = state().addCard({ chatId: "chat-a", anchorId: "m1", command: "echo from-a", projectId: null });
  state().addCard({ chatId: "chat-a", anchorId: null, command: "echo first", projectId: null });
  state().addCard({ chatId: "chat-b", anchorId: "m9", command: "echo from-b", projectId: null });
  assert.deepEqual(state().cards["chat-a"].map((card) => card.anchorId), ["m1", null]);
  assert.equal(state().cards["chat-b"].length, 1);
  await until(() => run(key)?.status === "done", "done");
  assert.equal(run(key).output, "from-a\n");
  state().dismissCard("chat-a", key);
  assert.equal(run(key), undefined);
  assert.deepEqual(state().cards["chat-a"].map((card) => card.anchorId), [null]);
});

console.log("\nafter the page is reloaded:");
await check("finished runs come back with their output; a running one is followed again from its start", async () => {
  await state().start({ key: "keep-done", command: "echo finished-before-reload", projectId: null });
  await until(() => run("keep-done")?.status === "done", "done");
  await state().start({ key: "keep-going", command: "echo part-one; sleep 1; echo part-two", projectId: null });
  await until(() => run("keep-going")?.status === "running" && run("keep-going").output.includes("part-one"), "part one");
  state().addCard({ chatId: "chat-reload", anchorId: "m3", command: "echo card-survives", projectId: null });
  await sleep(500); // the store writes to the tab's storage a moment after a change
  assert.ok(memory.get("eggent.shellRuns.v1"), "nothing was stored");

  const reloaded = await reloadPage(1);
  const after = reloaded.useShellRuns.getState();
  assert.equal(after.runs["keep-done"].output, "finished-before-reload\n");
  assert.equal(after.runs["keep-done"].status, "done");
  assert.equal(after.runs["keep-going"].output, "", "a running one is replayed, not stitched");
  assert.equal(after.cards["chat-reload"].length, 1);
  after.resume("keep-going");
  await until(() => reloaded.useShellRuns.getState().runs["keep-going"].status === "done", "the run to finish");
  assert.equal(reloaded.useShellRuns.getState().runs["keep-going"].output, "part-one\npart-two\n");
});
await check("a run the server has forgotten is marked as cut off rather than left running", async () => {
  memory.set(
    "eggent.shellRuns.v1",
    JSON.stringify({
      runs: [
        {
          key: "ghost",
          jobId: "run_22222222222222222222222222222222",
          command: "sleep 99",
          projectId: null,
          cwd: "",
          status: "running",
          exitCode: null,
          reason: null,
          output: "",
          droppedChars: 0,
          startedAt: Date.now() - 1000,
          endedAt: null,
          error: null,
          connection: "connected",
        },
      ],
      cards: {},
    })
  );
  const reloaded = await reloadPage(2);
  reloaded.useShellRuns.getState().resume("ghost");
  await until(() => reloaded.useShellRuns.getState().runs.ghost.status === "lost", "the loss");
});
await check("only so many finished runs are kept, newest first", async () => {
  for (let i = 0; i < 45; i += 1) {
    await state().start({ key: `bulk-${i}`, command: "true", projectId: null });
    // Room for each to end before the next asks: there is a limit on how many run at once.
    await sleep(15);
  }
  await until(() => Object.values(state().runs).every((entry) => entry.status !== "starting" && entry.status !== "running"), "all to finish", 30000);
  await sleep(500);
  const stored = JSON.parse(memory.get("eggent.shellRuns.v1") as string) as { runs: Array<{ key: string }> };
  assert.ok(stored.runs.length <= 40, `${stored.runs.length} stored`);
  assert.ok(stored.runs.some((entry) => entry.key === "bulk-44"));
});

getTerminalRegistry().killAll();
console.log(`\n${ran - failed}/${ran} passed${failed ? `, ${failed} FAILED` : ""}`);
fs.rmSync(workdir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
