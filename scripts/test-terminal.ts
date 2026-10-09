/**
 * Checks the processes people start from the browser: a command run by a click,
 * a command typed behind `!`, and the shell in the side panel.
 *
 * Run with Node 22: npm run test:terminal
 *
 * Real bash, real child processes, the real routes and the real middleware; only
 * the module that asks the agent SDK which shell to use and the project store
 * are stood in for. What has to hold, because each of these is a way for a shell
 * to be reachable by somebody who should not have one or to leave work behind:
 *
 *   - no route answers without a session of its own, whatever the middleware
 *     does with the path in front of it, and a page on a sibling workspace
 *     cannot start a command with the cookie the browser attaches;
 *   - a reader that was cut off and comes back gets exactly what it missed;
 *   - stopping a command stops everything the command started;
 *   - a shell nobody uses, or watches, does not stay open;
 *   - a file in the project called `pty.py` does not replace the standard module
 *     the helper imports.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-terminal-"));
process.chdir(workdir);
process.env.EGGENT_AUTH_SECRET = "terminal-test-secret-0123456789abcdef";
process.env.TMPDIR = workdir;
const projectsDir = path.join(workdir, "data", "projects");
fs.mkdirSync(path.join(projectsDir, "demo", "sub"), { recursive: true });

const format = await import("../src/lib/terminal/format.ts");
const { readEvents } = await import("../src/lib/terminal/sse.ts");
const { clampTerminalSize, TERMINAL_LIMITS } = await import("../src/lib/terminal/protocol.ts");
const { TerminalRegistry, TerminalLimitError, getTerminalRegistry } = await import("../src/lib/terminal/registry.ts");
const { resolvePtyAvailability } = await import("../src/lib/terminal/pty-helper.ts");
const { prepareInteractiveShell } = await import("../src/lib/terminal/interactive-shell.ts");
const { resolveTerminalCwd, TerminalCwdError } = await import("../src/lib/terminal/cwd.ts");
const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const jobsRoute = await import("../src/app/api/terminal/jobs/route.ts");
const streamRoute = await import("../src/app/api/terminal/jobs/[id]/stream/route.ts");
const inputRoute = await import("../src/app/api/terminal/jobs/[id]/input/route.ts");
const resizeRoute = await import("../src/app/api/terminal/jobs/[id]/resize/route.ts");
const stopRoute = await import("../src/app/api/terminal/jobs/[id]/stop/route.ts");
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
function skip(name: string, why: string): void {
  console.log(`  skip  ${name} (${why})`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const BASH = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
const shell = { path: BASH, args: ["-c"] };

type Exit = { code: number | null; signal: string | null; reason: string };
interface Collected {
  text: string;
  exit: Exit | null;
  starts: Array<{ from: number; truncated: boolean }>;
}

/** Follow a job the way a page does: attach, collect, stop at the exit. */
function collect(registry: InstanceType<typeof TerminalRegistry>, id: string, from = 0): Promise<Collected> {
  return new Promise((resolve, reject) => {
    const result: Collected = { text: "", exit: null, starts: [] };
    const attachment = registry.attach(id, from, {
      onOutput: (text) => {
        result.text += text;
      },
      onExit: (info) => {
        result.exit = info;
        resolve(result);
      },
    });
    if (!attachment) return reject(new Error("no such job"));
    result.starts.push({ from: attachment.start, truncated: attachment.truncated });
    result.text += attachment.replay;
    if (attachment.exit) {
      result.exit = attachment.exit;
      resolve(result);
    }
  });
}

async function runToEnd(
  registry: InstanceType<typeof TerminalRegistry>,
  command: string,
  cwd = workdir
): Promise<Collected & { id: string }> {
  const id = registry.startRun({ command, cwd, shell });
  const result = await collect(registry, id);
  return { ...result, id };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
console.log("what a process wrote, as a page shows it:");

await check("colour codes and window titles are removed, text is not", () => {
  assert.equal(format.stripEscapes("\u001b[31mred\u001b[0m and \u001b]0;title\u0007plain"), "red and plain");
  assert.equal(format.stripEscapes("a\u001b[2K\u001b[1Gb"), "ab");
});
await check("a progress bar that rewrites its line is one line, the last one", () => {
  assert.equal(format.settleLines("10%\r50%\r100%\ndone"), "100%\ndone");
  // A shorter rewrite leaves the rest of the longer text, as a terminal does.
  assert.equal(format.settleLines("abcdef\rxy"), "xycdef");
  assert.equal(format.settleLines("line one\r\nline two\r\n"), "line one\nline two\n");
});
await check("backspaces erase what they follow", () => {
  assert.equal(format.settleLines("abc\b\bX"), "aX");
  assert.equal(format.settleLines("-\b\\\b|\b/"), "/");
});
await check("only the end of long output is kept, and the count says so", () => {
  const raw = Array.from({ length: 1000 }, (_, index) => `line ${index}`).join("\n");
  const shown = format.formatOutput(raw, 50);
  assert.equal(shown.hiddenLines, 950);
  assert.equal(shown.text.split("\n").length, 50);
  assert.ok(shown.text.endsWith("line 999"));
  assert.deepEqual(format.formatOutput("ok\n"), { text: "ok", hiddenLines: 0 });
});
await check("stray control characters do not reach the page", () => {
  assert.equal(format.formatOutput("a\u0000b\u0007c\td").text, "abc\td");
});

console.log("\nwhich code blocks get a Run button:");
for (const [language, code, expected] of [
  ["bash", "npm install\nnpm test", "npm install\nnpm test"],
  ["sh", "ls -la", "ls -la"],
  ["zsh", "echo hi", "echo hi"],
  ["bash", "$ npm install", "npm install"],
  ["bash", "$ npm install\n$ npm test\n", "npm install\nnpm test"],
  ["console", "$ git status", "git status"],
  ["console", "$ ls\nREADME.md\npackage.json", null],
  ["bash", "# only a note", null],
  ["bash", "", null],
  ["python", "print(1)", null],
  ["json", "{}", null],
  [undefined, "ls", null],
] as Array<[string | undefined, string, string | null]>) {
  await check(`${language ?? "(no language)"}: ${JSON.stringify(code).slice(0, 40)} -> ${JSON.stringify(expected)}`, () =>
    assert.equal(format.runnableCommand(code, language), expected)
  );
}
await check("a command too long to run from a click has no button", () => {
  assert.equal(format.runnableCommand("x".repeat(TERMINAL_LIMITS.maxCommandChars + 1), "bash"), null);
});

console.log("\n!command in the composer:");
await check("a leading ! is a command", () => {
  assert.deepEqual(format.parseShellInput("!ls -la"), { kind: "command", command: "ls -la" });
  assert.deepEqual(format.parseShellInput("!  git status "), { kind: "command", command: "git status" });
  assert.deepEqual(format.parseShellInput("!"), { kind: "command", command: "" });
});
await check("!! is a message that really starts with !", () => {
  assert.deepEqual(format.parseShellInput("!!important, read this"), { kind: "literal", text: "!important, read this" });
});
await check("anything else is for the agent", () => {
  for (const text of ["hello", " !ls", "what is !important", "", "/skill:x"]) {
    assert.equal(format.parseShellInput(text), null);
  }
});

console.log("\nwhat is handed to the agent:");
await check("a fence the output cannot close", () => {
  assert.equal(format.fencedBlock("ls", "bash"), "```bash\nls\n```");
  const hostile = format.fencedBlock("before\n```\nafter", "");
  assert.ok(hostile.startsWith("````\n") && hostile.endsWith("\n````"), hostile);
  assert.ok(format.fencedBlock("`````x").startsWith("``````"));
});
await check("the end of long output is cut at a line", () => {
  const text = ["aaaa", "bbbb", "cccc", "dddd"].join("\n");
  assert.deepEqual(format.lastChars(text, 100), { text, cut: false });
  assert.deepEqual(format.lastChars(text, 12), { text: "cccc\ndddd", cut: true });
  assert.deepEqual(format.lastChars("x".repeat(50), 10), { text: "x".repeat(10), cut: true });
});
await check("one block of code gets one name, and two different blocks do not share it", () => {
  assert.equal(format.hashText("npm test"), format.hashText("npm test"));
  assert.notEqual(format.hashText("npm test"), format.hashText("npm run test"));
});

console.log("\nwindow sizes:");
await check("a size is kept inside what a terminal can be", () => {
  assert.deepEqual(clampTerminalSize(120, 40), { cols: 120, rows: 40 });
  assert.deepEqual(clampTerminalSize(1, 1), { cols: TERMINAL_LIMITS.minCols, rows: TERMINAL_LIMITS.minRows });
  assert.deepEqual(clampTerminalSize(99999, 99999), { cols: TERMINAL_LIMITS.maxCols, rows: TERMINAL_LIMITS.maxRows });
  assert.deepEqual(clampTerminalSize("abc", undefined), { cols: 80, rows: 24 });
  assert.deepEqual(clampTerminalSize(NaN, null), { cols: 80, rows: 24 });
});

console.log("\nreading server-sent events:");
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}
async function eventsOf(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of readEvents(streamOf(chunks))) out.push(event);
  return out;
}
await check("frames split across reads are put back together", async () => {
  assert.deepEqual(await eventsOf(['data: {"a":1}\n', '\ndata: {"b"', ':2}\n\n']), [{ a: 1 }, { b: 2 }]);
});
await check("comments, heartbeats and CRLF are tolerated", async () => {
  assert.deepEqual(await eventsOf([': ping\n\n', 'data: {"a":1}\r\n\r\n', ': ping\n\n']), [{ a: 1 }]);
});
await check("a frame that is not JSON does not stop the rest", async () => {
  assert.deepEqual(await eventsOf(["data: not json\n\n", 'data: {"ok":true}\n\n']), [{ ok: true }]);
});
await check("a character split between two reads is not broken", async () => {
  // A word in a script that is not Latin, written as escapes so the source
  // stays plain ASCII.
  const word = "\u043f\u0440\u0438\u0432\u0435\u0442";
  const bytes = new TextEncoder().encode(`data: {"t":"${word}"}\n\n`);
  const cut = bytes.indexOf(0xd0) + 1;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
  const out: unknown[] = [];
  for await (const event of readEvents(body)) out.push(event);
  assert.deepEqual(out, [{ t: word }]);
});

// ---------------------------------------------------------------------------
console.log("\ncommands:");
const registry = new TerminalRegistry({ killGraceMs: 400 });

await check("output and a clean exit", async () => {
  const run = await runToEnd(registry, "echo hello; echo there");
  assert.equal(run.text, "hello\nthere\n");
  assert.deepEqual(run.exit, { code: 0, signal: null, reason: "exit" });
});
await check("a failing command reports its own exit code", async () => {
  const run = await runToEnd(registry, "echo before; exit 7");
  assert.equal(run.text, "before\n");
  assert.equal(run.exit?.code, 7);
});
await check("what goes to stderr is shown, in the order it was written", async () => {
  const run = await runToEnd(registry, "echo one; echo two >&2; sleep 0.1; echo three");
  assert.deepEqual(run.text.split("\n").filter(Boolean), ["one", "two", "three"]);
});
await check("a command that is not found says so and exits 127", async () => {
  const run = await runToEnd(registry, "definitely-not-a-command-xyz");
  assert.equal(run.exit?.code, 127);
  assert.match(run.text, /not found/);
});
await check("it runs where it was told to, and the environment carries no pager", async () => {
  const run = await runToEnd(registry, "pwd; echo $PAGER", path.join(projectsDir, "demo", "sub"));
  const lines = run.text.split("\n");
  assert.equal(fs.realpathSync(lines[0]), fs.realpathSync(path.join(projectsDir, "demo", "sub")));
  assert.equal(lines[1], "cat");
});
await check("a character split between two writes arrives whole", async () => {
  const run = await runToEnd(registry, "printf '\\xd0'; sleep 0.2; printf '\\xbf\\n'");
  assert.equal(run.text, "\u043f\n");
  assert.ok(!run.text.includes("�"));
});
await check("what it reads from stdin comes from the person", async () => {
  const id = registry.startRun({ command: "read -r name; echo got:$name", cwd: workdir, shell });
  const done = collect(registry, id);
  await sleep(150);
  assert.equal(registry.write(id, "alice\n"), true);
  const run = await done;
  assert.equal(run.text, "got:alice\n");
});
await check("a shell that cannot start ends the job with the reason, not a hang", async () => {
  const id = registry.startRun({ command: "true", cwd: workdir, shell: { path: "/nonexistent/shell", args: ["-c"] } });
  const run = await collect(registry, id);
  assert.equal(run.exit?.reason, "error");
  assert.equal(run.exit?.code, 127);
  assert.match(run.text, /ENOENT/);
});
await check("a command that leaves a process holding its pipes still ends", async () => {
  const started = Date.now();
  const run = await runToEnd(registry, "sleep 3 & echo launched");
  assert.equal(run.text, "launched\n");
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

console.log("\nreaders that come and go:");
await check("a reader that attaches late is given everything before it", async () => {
  const id = registry.startRun({ command: "for i in 1 2 3; do echo line$i; sleep 0.1; done", cwd: workdir, shell });
  await sleep(180);
  const late = await collect(registry, id, 0);
  assert.equal(late.text, "line1\nline2\nline3\n");
});
await check("replay and live output meet without a gap or a repeat", async () => {
  const id = registry.startRun({ command: "for i in 1 2 3 4 5 6; do echo n$i; sleep 0.05; done", cwd: workdir, shell });
  await sleep(120);
  const joined = await collect(registry, id, 0);
  assert.equal(joined.text, "n1\nn2\nn3\nn4\nn5\nn6\n");
});
await check("asking to continue from an offset gives only the rest", async () => {
  const run = await runToEnd(registry, "printf 'abcdef'");
  const rest = await collect(registry, run.id, 4);
  assert.equal(rest.text, "ef");
  assert.deepEqual(rest.starts[0], { from: 4, truncated: false });
});
await check("a reader that detaches stops receiving, and the job carries on", async () => {
  const id = registry.startRun({ command: "echo a; sleep 0.3; echo b", cwd: workdir, shell });
  let seen = "";
  await sleep(100);
  const attachment = registry.attach(id, 0, { onOutput: (text) => (seen += text), onExit: () => undefined });
  assert.ok(attachment);
  seen += attachment.replay;
  attachment.detach();
  await sleep(500);
  assert.equal(seen, "a\n");
  assert.equal((await collect(registry, id)).text, "a\nb\n");
});
await check("output past the cap is dropped from the start, and the reader is told", async () => {
  const small = new TerminalRegistry({ bufferChars: 200 });
  const id = small.startRun({ command: "for i in $(seq 1 100); do echo line-number-$i; done", cwd: workdir, shell });
  const everything = await collect(small, id, 0);
  assert.ok(everything.exit);
  const again = await collect(small, id, 0);
  assert.equal(again.starts[0].truncated, true);
  assert.ok(again.starts[0].from > 0);
  assert.ok(again.text.length <= 250, `kept ${again.text.length}`);
  assert.ok(again.text.endsWith("line-number-100\n"));
  // Asking from the first offset that is still kept is not a loss.
  const resumed = await collect(small, id, again.starts[0].from);
  assert.equal(resumed.starts[0].truncated, false);
  assert.equal(resumed.text, again.text);
});

console.log("\nstopping:");
await check("stopping a command stops what it started, not only the shell", async () => {
  const pidFile = path.join(workdir, "child.pid");
  fs.rmSync(pidFile, { force: true });
  const id = registry.startRun({ command: `sleep 60 & echo $! > ${pidFile}; wait`, cwd: workdir, shell });
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", "the child to start");
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  assert.ok(alive(pid));
  assert.equal(registry.kill(id), true);
  const run = await collect(registry, id);
  assert.equal(run.exit?.reason, "stopped");
  await until(() => !alive(pid), "the background process to die");
});
await check("a command that ignores the polite request is ended anyway", async () => {
  const id = registry.startRun({ command: "trap '' TERM; while true; do sleep 0.1; done", cwd: workdir, shell });
  await sleep(200);
  const started = Date.now();
  registry.kill(id);
  const run = await collect(registry, id);
  assert.equal(run.exit?.reason, "stopped");
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
await check("stopping something already over is not an error", async () => {
  const run = await runToEnd(registry, "true");
  assert.equal(registry.kill(run.id), false);
  assert.equal(registry.write(run.id, "x"), false);
});

console.log("\nlimits and housekeeping:");
await check("only so many commands run at once", async () => {
  const limited = new TerminalRegistry({ maxRuns: 2, killGraceMs: 200 });
  const first = limited.startRun({ command: "sleep 5", cwd: workdir, shell });
  const second = limited.startRun({ command: "sleep 5", cwd: workdir, shell });
  assert.throws(() => limited.startRun({ command: "true", cwd: workdir, shell }), TerminalLimitError);
  limited.kill(first);
  await collect(limited, first);
  // Room again once one has ended.
  const third = limited.startRun({ command: "true", cwd: workdir, shell });
  await collect(limited, third);
  limited.kill(second);
  await collect(limited, second);
});
await check("a command that runs too long is stopped, with that as the reason", async () => {
  const short = new TerminalRegistry({ runMaxMs: 80, killGraceMs: 200 });
  const id = short.startRun({ command: "sleep 30", cwd: workdir, shell });
  await sleep(150);
  short.sweep();
  const run = await collect(short, id);
  assert.equal(run.exit?.reason, "timeout");
});
await check("finished jobs are forgotten after a while", async () => {
  const brief = new TerminalRegistry({ keepFinishedMs: 50 });
  const id = brief.startRun({ command: "true", cwd: workdir, shell });
  await collect(brief, id);
  brief.sweep();
  assert.equal(brief.has(id), true);
  brief.sweep(Date.now() + 1000);
  assert.equal(brief.has(id), false);
});
await check("only so many finished jobs are kept, the oldest forgotten first", async () => {
  const tidy = new TerminalRegistry({ maxFinished: 3 });
  const ids: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const id = tidy.startRun({ command: `echo n${i}`, cwd: workdir, shell });
    await collect(tidy, id);
    ids.push(id);
  }
  const kept = tidy.list().filter((job) => job.state === "exited").map((job) => job.id);
  assert.ok(kept.length <= 3, `${kept.length} kept`);
  assert.ok(kept.includes(ids[ids.length - 1]));
  assert.ok(!kept.includes(ids[0]));
});
await check("the registry is one per process, whichever route asks", () => {
  assert.equal(getTerminalRegistry(), getTerminalRegistry());
});

// ---------------------------------------------------------------------------
console.log("\nthe shell in the panel:");
const pty = resolvePtyAvailability();
if (!pty.python) {
  skip("every check of the interactive shell", `no usable Python: ${pty.reason}`);
} else {
  const python = pty.python;
  // What the route passes: the real path, which is what the shell will report.
  const root = fs.realpathSync(path.join(projectsDir, "demo"));
  const interactive = prepareInteractiveShell(BASH, root, path.join(workdir, "data"));
  const shellOptions = (extra: Record<string, unknown> = {}) => ({
    cwd: root,
    python,
    shellPath: interactive.path,
    shellArgs: interactive.args,
    cols: 100,
    rows: 30,
    env: interactive.env,
    ...extra,
  });

  /** Keep what a terminal prints, and wait for something in it. */
  function watch(reg: InstanceType<typeof TerminalRegistry>, id: string) {
    const seen = { text: "", exit: null as Exit | null };
    const attachment = reg.attach(id, 0, {
      onOutput: (text) => {
        seen.text += text;
      },
      onExit: (info) => {
        seen.exit = info;
      },
    });
    seen.text += attachment?.replay ?? "";
    // The prompt is dim text between colour codes; what is looked for is what
    // a person would read.
    const readable = () => format.stripEscapes(seen.text).replace(/\r/g, "");
    return {
      seen,
      waitFor: (needle: string | RegExp, what = String(needle)) =>
        until(() => (typeof needle === "string" ? readable().includes(needle) : needle.test(readable())), what),
    };
  }

  const terminals = new TerminalRegistry({ killGraceMs: 500 });
  // Whatever a check leaves running, a failure included, must not be counted
  // against the next one.
  const pcheck = async (name: string, fn: () => void | Promise<void>) => {
    await check(name, fn);
    terminals.killAll();
    // Killing is asked for here and happens a moment later; the next check must
    // not be counted against what is still on its way out.
    await until(() => terminals.list().every((job) => job.state === "exited"), "the terminals to be gone");
  };

  await pcheck("a real shell: a prompt, an echo, the exit code", async () => {
    const { id } = terminals.startPty(shellOptions());
    const view = watch(terminals, id);
    await view.waitFor("demo $", "the prompt");
    terminals.write(id, "echo sum-$((20+22))\n");
    await view.waitFor("sum-42", "the answer");
    terminals.write(id, "exit 5\n");
    await until(() => view.seen.exit !== null, "the shell to end");
    assert.equal(view.seen.exit?.code, 5);
  });
  await pcheck("the prompt names the project and the way down from it, not the machine", async () => {
    const { id } = terminals.startPty(shellOptions());
    const view = watch(terminals, id);
    await view.waitFor("demo $", "the prompt");
    terminals.write(id, "cd sub\n");
    await view.waitFor("demo/sub $", "the prompt in the subfolder");
    terminals.write(id, "cd /\n");
    await view.waitFor(/\n\/ \$ /, "a real path outside the project");
    terminals.kill(id);
  });
  await pcheck("the window size reaches the shell, at the start and after a resize", async () => {
    const { id } = terminals.startPty(shellOptions({ cols: 100, rows: 30 }));
    const view = watch(terminals, id);
    await view.waitFor("demo $", "the prompt");
    terminals.write(id, "stty size\n");
    await view.waitFor("30 100", "the first size");
    assert.equal(terminals.resize(id, 132, 41), true);
    await sleep(100);
    terminals.write(id, "stty size\n");
    await view.waitFor("41 132", "the new size");
    terminals.kill(id);
  });
  await pcheck("Ctrl+C interrupts what is running and leaves the shell", async () => {
    const { id } = terminals.startPty(shellOptions());
    const view = watch(terminals, id);
    await view.waitFor("demo $", "the prompt");
    terminals.write(id, "sleep 60\n");
    await sleep(300);
    terminals.write(id, "\u0003");
    await sleep(300);
    terminals.write(id, "echo still-here\n");
    await view.waitFor("still-here", "the shell to answer after the interrupt");
    assert.equal(view.seen.exit, null);
    terminals.kill(id);
  });
  await pcheck("typing into a program that wants a terminal works (it sees a TTY)", async () => {
    const { id } = terminals.startPty(shellOptions());
    const view = watch(terminals, id);
    await view.waitFor("demo $", "the prompt");
    terminals.write(id, "test -t 0 && test -t 1 && echo is-a-tty\n");
    await view.waitFor(/\nis-a-tty/, "the program to see a terminal");
    terminals.kill(id);
  });
  await pcheck("asking for the project's terminal again returns the one that is running", async () => {
    const first = terminals.startPty(shellOptions({ key: "project:demo" }));
    const second = terminals.startPty(shellOptions({ key: "project:demo", cols: 90, rows: 20 }));
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.id, first.id);
    const other = terminals.startPty(shellOptions({ key: "project:other" }));
    assert.notEqual(other.id, first.id);
    terminals.kill(first.id);
    terminals.kill(other.id);
  });
  await pcheck("a terminal that is being stopped is not handed out again, and does not count against the limit", async () => {
    const few = new TerminalRegistry({ maxPty: 1, killGraceMs: 500 });
    const first = few.startPty(shellOptions({ key: "project:demo" }));
    const view = watch(few, first.id);
    await view.waitFor("demo $", "the prompt");
    few.kill(first.id);
    // Restart: the old one has been asked to stop and has not gone yet.
    const second = few.startPty(shellOptions({ key: "project:demo" }));
    assert.equal(second.reused, false);
    assert.notEqual(second.id, first.id);
    few.killAll();
    await until(() => few.list().every((job) => job.state === "exited"), "both to be gone");
  });
  await pcheck("history is kept in the workspace's data folder, not in a home that goes with the image", async () => {
    assert.equal(interactive.env.HISTFILE, path.join(workdir, "data", "terminal", "bash_history"));
    assert.ok(fs.existsSync(path.join(workdir, "data", "terminal")));
  });
  await pcheck("a file in the project named like a standard module does not replace it", async () => {
    const trap = path.join(root, "pty.py");
    const marker = path.join(root, "shadowed.txt");
    fs.writeFileSync(trap, `open(${JSON.stringify(marker)}, "w").write("ran")\nraise SystemExit(99)\n`);
    fs.writeFileSync(path.join(root, "select.py"), `open(${JSON.stringify(marker)}, "w").write("ran")\n`);
    try {
      const { id } = terminals.startPty(shellOptions());
      const view = watch(terminals, id);
      await view.waitFor("demo $", "a prompt, which a shadowed module would have prevented");
      assert.ok(!fs.existsSync(marker), "the project's own pty.py ran in place of the standard one");
      terminals.kill(id);
    } finally {
      fs.rmSync(trap, { force: true });
      fs.rmSync(path.join(root, "select.py"), { force: true });
      fs.rmSync(marker, { force: true });
    }
  });
  await pcheck("stopping the terminal ends the shell and what it started", async () => {
    const pidFile = path.join(workdir, "pty-child.pid");
    fs.rmSync(pidFile, { force: true });
    const { id } = terminals.startPty(shellOptions());
    const view = watch(terminals, id);
    await view.waitFor("demo $", "the prompt");
    terminals.write(id, `sleep 60 & echo $! > ${pidFile}\n`);
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", "the background job");
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    terminals.kill(id);
    await until(() => view.seen.exit !== null, "the terminal to end");
    assert.equal(view.seen.exit?.reason, "stopped");
    // A background job of a hung-up shell gets the hangup too.
    await until(() => !alive(pid), "the background job to go with it", 4000);
  });
  await pcheck("a shell nobody has typed into or heard from is closed, so it does not sit open for ever", async () => {
    const idle = new TerminalRegistry({ idleMs: 150, detachMs: 60_000, killGraceMs: 500 });
    const { id } = idle.startPty(shellOptions());
    const view = watch(idle, id);
    await view.waitFor("demo $", "the prompt");
    await sleep(400);
    idle.sweep();
    await until(() => view.seen.exit !== null, "the idle shell to close");
    assert.equal(view.seen.exit?.reason, "idle");
  });
  await pcheck("typing counts as use", async () => {
    const idle = new TerminalRegistry({ idleMs: 400, detachMs: 60_000, killGraceMs: 500 });
    const { id } = idle.startPty(shellOptions());
    const view = watch(idle, id);
    await view.waitFor("demo $", "the prompt");
    for (let i = 0; i < 4; i += 1) {
      await sleep(200);
      idle.write(id, "\n");
      idle.sweep();
    }
    assert.equal(view.seen.exit, null);
    idle.kill(id);
  });
  await pcheck("a shell nobody is watching is closed after a while", async () => {
    const lonely = new TerminalRegistry({ idleMs: 60_000, detachMs: 150, killGraceMs: 500 });
    const { id } = lonely.startPty(shellOptions());
    await sleep(400);
    lonely.sweep();
    const run = await collect(lonely, id);
    assert.equal(run.exit?.reason, "detached");
  });
  await pcheck("only so many terminals at once", async () => {
    const few = new TerminalRegistry({ maxPty: 1, killGraceMs: 300 });
    const { id } = few.startPty(shellOptions());
    assert.throws(() => few.startPty(shellOptions({ key: "another" })), TerminalLimitError);
    few.kill(id);
    await collect(few, id);
  });
  await pcheck("a shell that is not there reports it in the terminal instead of showing nothing", async () => {
    const { id } = terminals.startPty(shellOptions({ shellPath: "/nonexistent/shell", shellArgs: ["-i"] }));
    const run = await collect(terminals, id);
    assert.match(run.text, /cannot start/);
    assert.equal(run.exit?.code, 127);
  });
  terminals.killAll();
}

// ---------------------------------------------------------------------------
console.log("\nwhere it starts:");
const real = (value: string) => fs.realpathSync(value);
await check("the project's folder, or the workspace's own for the orchestrator", () => {
  assert.equal(real(resolveTerminalCwd("demo").cwd), real(path.join(projectsDir, "demo")));
  assert.equal(real(resolveTerminalCwd(null).cwd), real(projectsDir));
  assert.equal(real(resolveTerminalCwd("none").cwd), real(projectsDir));
});
await check("a folder of the project can be asked for; one outside it cannot", () => {
  assert.equal(real(resolveTerminalCwd("demo", "sub").cwd), real(path.join(projectsDir, "demo", "sub")));
  assert.equal(real(resolveTerminalCwd("demo", "../../..").cwd), real(path.join(projectsDir, "demo")));
  assert.equal(real(resolveTerminalCwd("demo", "/etc").cwd), real(path.join(projectsDir, "demo")));
  assert.equal(real(resolveTerminalCwd("demo", "does-not-exist").cwd), real(path.join(projectsDir, "demo")));
});
await check("a link inside the project that points out of it is not followed", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-outside-"));
  const link = path.join(projectsDir, "demo", "way-out");
  fs.symlinkSync(outside, link);
  try {
    assert.equal(real(resolveTerminalCwd("demo", "way-out").cwd), real(path.join(projectsDir, "demo")));
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
await check("a project that does not exist, or a name that tries to leave, is refused", () => {
  assert.throws(() => resolveTerminalCwd("nope"), (error: unknown) => error instanceof TerminalCwdError && error.code === "project-not-found");
  for (const name of ["../..", "..", "demo/sub", "../demo"]) {
    assert.throws(() => resolveTerminalCwd(name), (error: unknown) => error instanceof TerminalCwdError, name);
  }
});

// ---------------------------------------------------------------------------
console.log("\nthe routes:");
const ORIGIN = "https://workspace.example.test";
const ownerSession = await createSessionToken("owner@example.test", false);
const defaultLoginSession = await createSessionToken("admin", true);

interface RequestOptions {
  cookie?: string | null;
  origin?: string | null;
  site?: string;
  contentType?: string | null;
  body?: unknown;
  method?: string;
}
function request(pathname: string, options: RequestOptions = {}) {
  const headers = new Headers();
  const cookie = options.cookie === undefined ? ownerSession : options.cookie;
  if (cookie) headers.set("cookie", `${AUTH_COOKIE_NAME}=${cookie}`);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.set("origin", origin);
  headers.set("host", new URL(ORIGIN).host);
  if (options.site) headers.set("sec-fetch-site", options.site);
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  if (contentType && method !== "GET") headers.set("content-type", contentType);
  return new NextRequest(`${ORIGIN}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body),
  });
}
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function createJob(body: unknown, options: RequestOptions = {}) {
  const response = await jobsRoute.POST(request("/api/terminal/jobs", { body, ...options }));
  const payload = (await response.json().catch(() => null)) as { id?: string; reused?: boolean; error?: string; code?: string } | null;
  return { response, payload };
}
async function readStream(id: string, from = 0, options: RequestOptions = {}) {
  const response = await streamRoute.GET(request(`/api/terminal/jobs/${id}/stream?from=${from}`, options), idParams(id));
  const events: Array<Record<string, unknown>> = [];
  if (response.ok && response.body) {
    for await (const event of readEvents<Record<string, unknown>>(response.body)) events.push(event);
  }
  const text = events.filter((event) => event.t === "o").map((event) => String(event.d)).join("");
  return { response, events, text, exit: events.find((event) => event.t === "x") };
}

console.log("  - who may ask:");
await check("no session, no command", async () => {
  const { response } = await createJob({ kind: "run", command: "touch should-not-exist" }, { cookie: null });
  assert.equal(response.status, 401);
  assert.ok(!fs.existsSync(path.join(projectsDir, "should-not-exist")));
});
await check("a forged session is no session", async () => {
  const { response } = await createJob({ kind: "run", command: "true" }, { cookie: "eyJ1Ijoib3duZXIifQ.not-a-signature" });
  assert.equal(response.status, 401);
});
await check("the stock login has no shell until it has been replaced", async () => {
  const { response } = await createJob({ kind: "run", command: "true" }, { cookie: defaultLoginSession });
  assert.equal(response.status, 401);
});
await check("a page on another site cannot use the cookie the browser attaches", async () => {
  for (const origin of ["https://evil.example.test", "https://other-workspace.example.test", "null"]) {
    const { response } = await createJob({ kind: "run", command: "true" }, { origin });
    assert.equal(response.status, 403, `origin ${origin}`);
  }
  const sibling = await createJob({ kind: "run", command: "true" }, { site: "same-site" });
  assert.equal(sibling.response.status, 403);
  const crossSite = await createJob({ kind: "run", command: "true" }, { site: "cross-site" });
  assert.equal(crossSite.response.status, 403);
});
await check("a body a foreign page could send without a preflight is not parsed as a command", async () => {
  const { response } = await createJob('{"kind":"run","command":"touch should-not-exist"}', { contentType: "text/plain" });
  assert.equal(response.status, 415);
  const form = await createJob("kind=run&command=true", { contentType: "application/x-www-form-urlencoded" });
  assert.equal(form.response.status, 415);
  assert.ok(!fs.existsSync(path.join(projectsDir, "should-not-exist")));
});
await check("the same-origin request the page itself sends is accepted", async () => {
  const { response, payload } = await createJob({ kind: "run", projectId: "demo", command: "true" }, { site: "same-origin" });
  assert.equal(response.status, 201);
  assert.match(payload?.id ?? "", /^run_[0-9a-f]{32}$/);
});
await check("every other route asks for the session as well, whatever the path looks like", async () => {
  const { payload } = await createJob({ kind: "run", command: "sleep 5" });
  const id = payload!.id!;
  const withoutSession = { cookie: null };
  assert.equal((await streamRoute.GET(request(`/api/terminal/jobs/${id}/stream`, withoutSession), idParams(id))).status, 401);
  assert.equal((await inputRoute.POST(request(`/api/terminal/jobs/${id}/input`, { ...withoutSession, body: { data: "x" } }), idParams(id))).status, 401);
  assert.equal((await resizeRoute.POST(request(`/api/terminal/jobs/${id}/resize`, { ...withoutSession, body: { cols: 80, rows: 24 } }), idParams(id))).status, 401);
  assert.equal((await stopRoute.POST(request(`/api/terminal/jobs/${id}/stop`, { ...withoutSession, body: {} }), idParams(id))).status, 401);
  // The middleware lets a path whose last segment has a dot through (open issue
  // 2); the handler must still refuse. Nothing is leaked by the answer either:
  // an id that is not one is "not found" for somebody signed in.
  assert.equal((await streamRoute.GET(request("/api/terminal/jobs/x.y/stream", withoutSession), idParams("x.y"))).status, 401);
  assert.equal((await streamRoute.GET(request("/api/terminal/jobs/x.y/stream"), idParams("x.y"))).status, 404);
  assert.equal((await stopRoute.POST(request(`/api/terminal/jobs/${id}/stop`, { body: {}, origin: "https://evil.example.test" }), idParams(id))).status, 403);
  getTerminalRegistry().kill(id);
});
await check("the middleware itself turns an anonymous caller away from the collection", async () => {
  const response = await middleware(new NextRequest(`${ORIGIN}/api/terminal/jobs`, { method: "POST" }));
  assert.equal(response.status, 401);
});

console.log("  - commands over HTTP:");
await check("a command's output arrives as events, ending with its exit", async () => {
  const { payload } = await createJob({ kind: "run", projectId: "demo", command: "echo from-the-route; exit 3" });
  const stream = await readStream(payload!.id!);
  assert.equal(stream.response.status, 200);
  assert.match(stream.response.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.match(stream.response.headers.get("cache-control") ?? "", /no-transform/);
  assert.equal(stream.events[0].t, "s");
  assert.equal(stream.text, "from-the-route\n");
  assert.deepEqual({ ...stream.exit, t: undefined }, { t: undefined, code: 3, signal: null, reason: "exit" });
});
await check("a reader that comes back with its last offset is given the rest", async () => {
  const { payload } = await createJob({ kind: "run", command: "printf 'abcdef'" });
  const whole = await readStream(payload!.id!);
  assert.equal(whole.text, "abcdef");
  const rest = await readStream(payload!.id!, 4);
  assert.equal(rest.text, "ef");
  assert.equal(rest.events[0].from, 4);
});
await check("the offset in each event is where the next request should start", async () => {
  const { payload } = await createJob({ kind: "run", command: "printf 'one'; sleep 0.1; printf 'two'" });
  const stream = await readStream(payload!.id!);
  const outputs = stream.events.filter((event) => event.t === "o");
  assert.equal(outputs[outputs.length - 1].n, 6);
});
await check("typing into a running command reaches it", async () => {
  const { payload } = await createJob({ kind: "run", command: "read -r word; echo you-said-$word" });
  const id = payload!.id!;
  const reading = readStream(id);
  await sleep(200);
  const typed = await inputRoute.POST(request(`/api/terminal/jobs/${id}/input`, { body: { data: "yes\n" } }), idParams(id));
  assert.equal(typed.status, 200);
  assert.equal((await reading).text, "you-said-yes\n");
  const late = await inputRoute.POST(request(`/api/terminal/jobs/${id}/input`, { body: { data: "again\n" } }), idParams(id));
  assert.equal(late.status, 409);
});
await check("a reader that has stopped reading is let go, and gets the rest when it comes back", async () => {
  const live = getTerminalRegistry();
  const normal = live.limits.bufferChars;
  // Enough room to keep all of it, so what the second reader is owed is still there.
  live.limits.bufferChars = 40_000_000;
  try {
    const { payload } = await createJob({ kind: "run", command: "head -c 9000000 /dev/zero | tr '\\0' x; echo done" });
    const id = payload!.id!;
    // Opened and never read, as a tab that went to sleep holds a socket.
    const stalled = await streamRoute.GET(request(`/api/terminal/jobs/${id}/stream?from=0`), idParams(id));
    await until(() => live.summary(id)?.state === "exited", "the command to finish");
    const first: Array<Record<string, unknown>> = [];
    for await (const event of readEvents<Record<string, unknown>>(stalled.body!)) first.push(event);
    const delivered = first.filter((event) => event.t === "o");
    const reached = delivered.length ? Number(delivered[delivered.length - 1].n) : 0;
    assert.ok(!first.some((event) => event.t === "x"), "the server kept a dead reader's queue to the end");
    assert.ok(reached > 0 && reached < 9_000_005, `reader reached ${reached}`);
    // Back with the offset it reached: everything after, nothing twice.
    const rest = await readStream(id, reached);
    assert.equal(rest.response.status, 200, `status ${rest.response.status}; ${JSON.stringify(rest.events.slice(0, 2))}`);
    assert.equal(rest.exit?.code, 0, `events: ${rest.events.length}, last ${JSON.stringify(rest.events[rest.events.length - 1])?.slice(0, 120)}`);
    assert.equal(reached + rest.text.length, 9_000_005);
    assert.ok(rest.text.endsWith("done\n"));
  } finally {
    live.limits.bufferChars = normal;
  }
});
await check("nothing to send, or far too much, is refused", async () => {
  const { payload } = await createJob({ kind: "run", command: "sleep 2" });
  const id = payload!.id!;
  for (const data of ["", undefined, 42, "x".repeat(TERMINAL_LIMITS.maxInputChars + 1)]) {
    const response = await inputRoute.POST(request(`/api/terminal/jobs/${id}/input`, { body: { data } }), idParams(id));
    assert.equal(response.status, 400, `data ${String(data).slice(0, 10)}`);
  }
  getTerminalRegistry().kill(id);
});
await check("stop ends a command, and the stream says it was stopped", async () => {
  const { payload } = await createJob({ kind: "run", command: "sleep 60" });
  const id = payload!.id!;
  const reading = readStream(id);
  await sleep(150);
  const stopped = await stopRoute.POST(request(`/api/terminal/jobs/${id}/stop`, { body: {} }), idParams(id));
  assert.equal(stopped.status, 200);
  const stream = await reading;
  assert.equal(stream.exit?.reason, "stopped");
});
await check("a job that does not exist is not found, and an id that is not one is too", async () => {
  const response = await streamRoute.GET(request("/api/terminal/jobs/run_00000000000000000000000000000000/stream"), idParams("run_00000000000000000000000000000000"));
  assert.equal(response.status, 404);
  for (const id of ["../../etc/passwd", "pty_short", "RUN_" + "a".repeat(32), "run_" + "g".repeat(32)]) {
    assert.equal((await streamRoute.GET(request("/api/terminal/jobs/x/stream"), idParams(id))).status, 404, id);
  }
});
await check("the folder is the project's; a way out of it is quietly the project's root", async () => {
  const where = async (cwd?: string) => {
    const { payload } = await createJob({ kind: "run", projectId: "demo", cwd, command: "pwd" });
    return fs.realpathSync((await readStream(payload!.id!)).text.trim());
  };
  assert.equal(await where(), fs.realpathSync(path.join(projectsDir, "demo")));
  assert.equal(await where("sub"), fs.realpathSync(path.join(projectsDir, "demo", "sub")));
  assert.equal(await where("../../.."), fs.realpathSync(path.join(projectsDir, "demo")));
});
await check("a project that is not there, or whose name tries to leave, is refused", async () => {
  assert.equal((await createJob({ kind: "run", projectId: "nope", command: "true" })).response.status, 404);
  assert.equal((await createJob({ kind: "run", projectId: "../..", command: "true" })).response.status, 400);
  assert.ok(!fs.existsSync(path.join(workdir, "should-not-exist")));
});
await check("a request that is not a command is refused with a reason", async () => {
  assert.equal((await createJob({ kind: "run", command: "   " })).response.status, 400);
  assert.equal((await createJob({ kind: "run" })).response.status, 400);
  assert.equal((await createJob({ kind: "bogus", command: "true" })).response.status, 400);
  assert.equal((await createJob({ kind: "run", command: "x".repeat(TERMINAL_LIMITS.maxCommandChars + 1) })).response.status, 413);
  const message = (await createJob({ kind: "run" })).payload?.error ?? "";
  assert.ok(message.length > 5);
});
await check("too many at once is a clear refusal, not a hang", async () => {
  const live: string[] = [];
  let refusal = 0;
  for (let i = 0; i < 12 && !refusal; i += 1) {
    const { response, payload } = await createJob({ kind: "run", command: "sleep 20" });
    if (response.status === 429) refusal = response.status;
    else if (payload?.id) live.push(payload.id);
  }
  assert.equal(refusal, 429);
  for (const id of live) getTerminalRegistry().kill(id);
});

console.log("  - the panel's shell over HTTP:");
if (!pty.python) {
  skip("the panel's shell over HTTP", `no usable Python: ${pty.reason}`);
} else {
  await check("a terminal is started once per project and found again", async () => {
    const first = await createJob({ kind: "pty", projectId: "demo", cols: 100, rows: 30 });
    assert.equal(first.response.status, 201);
    assert.match(first.payload?.id ?? "", /^pty_[0-9a-f]{32}$/);
    const again = await createJob({ kind: "pty", projectId: "demo", cols: 90, rows: 20 });
    assert.equal(again.response.status, 200);
    assert.equal(again.payload?.reused, true);
    assert.equal(again.payload?.id, first.payload?.id);
  });
  await check("typing, a resize and the output all go through the routes", async () => {
    const { payload } = await createJob({ kind: "pty", projectId: "demo", cols: 100, rows: 30 });
    const id = payload!.id!;
    const registryNow = getTerminalRegistry();
    const response = await streamRoute.GET(request(`/api/terminal/jobs/${id}/stream`), idParams(id));
    let seen = "";
    const reader = (async () => {
      for await (const event of readEvents<{ t: string; d?: string }>(response.body!)) {
        if (event.t === "o") seen += event.d;
      }
    })();
    await until(() => format.stripEscapes(seen).includes("demo $"), "the prompt");
    const resized = await resizeRoute.POST(request(`/api/terminal/jobs/${id}/resize`, { body: { cols: 77, rows: 19 } }), idParams(id));
    assert.equal(resized.status, 200);
    await sleep(100);
    await inputRoute.POST(request(`/api/terminal/jobs/${id}/input`, { body: { data: "stty size\n" } }), idParams(id));
    await until(() => format.stripEscapes(seen).includes("19 77"), "the size the page asked for");
    registryNow.kill(id);
    await reader;
  });
  await check("closing the stream leaves the shell running, and a new one picks up what was printed", async () => {
    const { payload } = await createJob({ kind: "pty", projectId: "demo", cols: 100, rows: 30 });
    const id = payload!.id!;
    const first = new AbortController();
    const cancelled = new NextRequest(`${ORIGIN}/api/terminal/jobs/${id}/stream`, {
      headers: { cookie: `${AUTH_COOKIE_NAME}=${ownerSession}`, origin: ORIGIN, host: new URL(ORIGIN).host },
      signal: first.signal,
    });
    const response = await streamRoute.GET(cancelled, idParams(id));
    const reader = response.body!.getReader();
    await reader.read();
    first.abort();
    await sleep(100);
    await inputRoute.POST(request(`/api/terminal/jobs/${id}/input`, { body: { data: "echo while-away-$((1+1))\n" } }), idParams(id));
    await sleep(500);
    const summary = getTerminalRegistry().summary(id);
    assert.equal(summary?.state, "running");
    const back = new AbortController();
    const second = await streamRoute.GET(
      new NextRequest(`${ORIGIN}/api/terminal/jobs/${id}/stream?from=0`, {
        headers: { cookie: `${AUTH_COOKIE_NAME}=${ownerSession}`, origin: ORIGIN, host: new URL(ORIGIN).host },
        signal: back.signal,
      }),
      idParams(id)
    );
    let seen = "";
    const secondReader = (async () => {
      for await (const event of readEvents<{ t: string; d?: string }>(second.body!)) {
        if (event.t === "o") seen += event.d;
      }
    })();
    await until(() => seen.includes("while-away-2"), "what was printed while nobody was reading");
    getTerminalRegistry().kill(id);
    await secondReader;
  });
  await check("a terminal that cannot be had says so, with a code the page can act on", async () => {
    const before = process.env.EGGENT_TERMINAL_PYTHON;
    // Availability is decided once per process, which is the point of caching
    // it; here it is asked again with an interpreter that is not there.
    const { resetPtyAvailabilityCache } = await import("../src/lib/terminal/pty-helper.ts");
    process.env.EGGENT_TERMINAL_PYTHON = "/nonexistent/python3";
    resetPtyAvailabilityCache();
    try {
      const { response, payload } = await createJob({ kind: "pty", projectId: "demo", cols: 80, rows: 24 });
      assert.equal(response.status, 501);
      assert.equal(payload?.code, "pty-unavailable");
      // A command still runs: the panel is not the only way to run one.
      const run = await createJob({ kind: "run", projectId: "demo", command: "true" });
      assert.equal(run.response.status, 201);
    } finally {
      if (before === undefined) delete process.env.EGGENT_TERMINAL_PYTHON;
      else process.env.EGGENT_TERMINAL_PYTHON = before;
      resetPtyAvailabilityCache();
    }
  });
}

// Anything still running must not outlive the test.
getTerminalRegistry().killAll();
registry.killAll();

console.log(`\n${ran - failed}/${ran} passed${failed ? `, ${failed} FAILED` : ""}`);
fs.rmSync(workdir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
