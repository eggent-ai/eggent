/**
 * What a test of two paired sides needs around them: a model that answers
 * without a network, a control plane that carries a request from one side to the
 * other, and a stand-in for the file sync that is slow on purpose.
 *
 * Nothing here is the thing under test. The routes, the head check, the
 * relaying and the stop/steer rules are the app's own, running in two real
 * processes (see remote-test-node.ts); this only supplies what is outside them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- the model

export interface ModelCall {
  /** Which side asked, from the key it presented. */
  side: string;
  userTexts: string[];
  system: string;
  at: number;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/**
 * An OpenAI-compatible endpoint that answers from a script of magic words in
 * the last thing the person said. The key tells it which side is asking, so an
 * answer can say where it was produced.
 */
export async function startModel() {
  const calls: ModelCall[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
      return;
    }
    let body = "";
    req.on("data", (part) => {
      body += String(part);
    });
    req.on("end", async () => {
      const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
      const messages = payload.messages ?? [];
      const side = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || "unknown";
      const userTexts = messages
        .filter((message) => message.role === "user")
        .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")));
      const system = messages.filter((message) => message.role === "system").map((message) => String(message.content ?? "")).join("\n");
      calls.push({ side, userTexts, system, at: Date.now() });

      const last = userTexts[userTexts.length - 1] ?? "";
      const toolAnswered = messages[messages.length - 1]?.role === "tool";

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(chunk({ role: "assistant" }));

      if (last.includes("ASK-ME") && !toolAnswered) {
        res.write(chunk({
          tool_calls: [{
            index: 0,
            id: "stub-ask-1",
            type: "function",
            function: { name: "eggent_ask_user", arguments: JSON.stringify({ question: "Which colour?", kind: "free_text" }) },
          }],
        }));
        res.write(chunk({}, "tool_calls"));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (toolAnswered) {
        const toolText = String(messages[messages.length - 1]?.content ?? "");
        res.write(chunk({ content: `${side} got the answer: ${toolText.slice(0, 80)}` }));
        res.write(chunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      const words = last.includes("SLOW")
        ? Array.from({ length: 16 }, (_, index) => `slow${index} `)
        : [`${side} answered. `, `ctx users=${userTexts.length} `, `last=${JSON.stringify(last.slice(0, 60))}`];
      for (const word of words) {
        if (res.destroyed || res.writableEnded) return;
        res.write(chunk({ content: word }));
        if (last.includes("SLOW")) await sleep(300);
      }
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    /** The calls one side made. */
    callsBy: (side: string) => calls.filter((call) => call.side === side),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------- a side

export interface Side {
  name: string;
  root: string;
  url: string;
  port: number;
  process: ChildProcess;
  log: string[];
  stop: () => Promise<void>;
}

export interface StartSideOptions {
  name: string;
  /** "cloud" or "device:<id>"; empty for a side where the feature is off. */
  node: string;
  relayUrl: string;
  modelUrl: string;
  repoRoot: string;
  env?: Record<string, string>;
}

export async function startSide(options: StartSideOptions): Promise<Side> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `eggent-remote-${options.name}-`));
  const log: string[] = [];
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      "--import",
      "./scripts/alias-loader-register.mjs",
      "scripts/lib/remote-test-node.ts",
    ],
    {
      cwd: options.repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: root,
        NODE_ROOT: root,
        NODE_PORT: "0",
        PROVIDER_URL: options.modelUrl,
        PROVIDER_KEY: options.name,
        EGGENT_AUTH_SECRET: "remote-test-secret-0123456789abcdef",
        ...(options.node ? { EGGENT_REMOTE_NODE: options.node, EGGENT_REMOTE_RELAY_URL: options.relayUrl, EGGENT_REMOTE_RELAY_TOKEN: `token-${options.name}` } : {}),
        EGGENT_REMOTE_COVER_WAIT_SECONDS: "6",
        EGGENT_REMOTE_SETTLE_WAIT_SECONDS: "10",
        EGGENT_TURN_WATCHDOG: "off",
        EXTERNAL_API_TOKEN: "test-external-token",
        EGGENT_TEST_STUBS: "i18n/server",
        ...(options.env ?? {}),
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stderr?.on("data", (part) => log.push(String(part)));

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${options.name} did not start:\n${log.join("")}`)), 60_000);
    child.stdout?.on("data", (part) => {
      const text = String(part);
      log.push(text);
      const match = /READY (\d+)/.exec(text);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${options.name} exited with ${code}:\n${log.join("")}`));
    });
  });

  return {
    name: options.name,
    root,
    url: `http://127.0.0.1:${port}`,
    port,
    process: child,
    log,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

// ----------------------------------------------------------- the control plane

export interface RelayState {
  deviceOnline: boolean;
  deviceAccept: "ask" | "always" | null;
  historyShared: boolean;
  /** Requests carried, newest last. */
  carried: Array<{ from: "cloud" | "device"; method: string; path: string; status: number }>;
  /** Make the next carried response of this path end early, to look like a lost connection. */
  cutStreamOf?: string;
}

/**
 * Carries a request from one side to the other and streams the answer back,
 * as the control plane does. It replies for itself only when it cannot deliver.
 */
export async function startRelay(sides: { cloud: () => Side; device: () => Side }, cookie: string) {
  const state: RelayState = { deviceOnline: true, deviceAccept: "always", historyShared: true, carried: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const [, from, , action] = url.pathname.split("/"); // /<cloud|device>-side/relay/<action>
    const caller = from === "cloud-side" ? "cloud" : "device";

    if (req.method === "GET" && action === "devices") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          devices: caller === "cloud"
            ? [{ node: "device:test-mac", name: "Test Mac", online: state.deviceOnline, accept: state.deviceAccept, historyShared: state.historyShared, lastSeenAt: new Date().toISOString() }]
            : [],
        })
      );
      return;
    }

    if (req.method === "POST" && action === "request") {
      let raw = "";
      for await (const part of req) raw += String(part);
      const spec = JSON.parse(raw) as { target: string; method: string; path: string; headers: Record<string, string>; body: string | null };
      const expected = caller === "cloud" ? "device:test-mac" : "cloud";
      if (spec.target !== expected) {
        res.writeHead(403, { "content-type": "application/json", "x-eggent-relay-error": "denied" });
        res.end(JSON.stringify({ error: `a ${caller} cannot reach ${spec.target}` }));
        return;
      }
      if (caller === "cloud" && (!state.deviceOnline || !state.deviceAccept)) {
        res.writeHead(503, { "content-type": "application/json", "x-eggent-relay-error": "offline" });
        res.end(JSON.stringify({ error: "the computer is not connected" }));
        return;
      }
      const target = caller === "cloud" ? sides.device() : sides.cloud();
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const upstream = await fetch(`${target.url}${spec.path}`, {
          method: spec.method,
          headers: { ...spec.headers, cookie: `eggent_auth=${cookie}` },
          body: spec.method === "GET" ? undefined : (spec.body ?? undefined),
          signal: controller.signal,
        });
        state.carried.push({ from: caller, method: spec.method, path: spec.path, status: upstream.status });
        const headers: Record<string, string> = {};
        upstream.headers.forEach((value, name) => {
          if (name !== "content-length" && name !== "transfer-encoding" && name !== "connection") headers[name] = value;
        });
        res.writeHead(upstream.status, headers);
        if (upstream.body) {
          const reader = upstream.body.getReader();
          let sent = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
            sent += value.length;
            if (state.cutStreamOf && spec.path === state.cutStreamOf && sent > 200) {
              // A connection that drops mid-answer: what was sent has arrived, then the stream just stops.
              state.cutStreamOf = undefined;
              await sleep(250);
              res.destroy();
              controller.abort();
              return;
            }
          }
        }
        res.end();
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json", "x-eggent-relay-error": "failed" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        } else {
          res.end();
        }
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    state,
    url: (caller: "cloud" | "device") => `http://127.0.0.1:${port}/${caller}-side/relay`,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

// ------------------------------------------------------------------ the sync

/**
 * A stand-in for the file sync: after a quiet period, the newer copy of a
 * chat or of the agent's record of it replaces the older one on the other
 * side. Slow on purpose, and it can be held, because the whole point of what is
 * being tested is what happens while the files have not arrived.
 */
export function startSyncer(a: string, b: string, options: { delayMs: number }) {
  let paused = false;
  let delayMs = options.delayMs;
  const copied: string[] = [];
  const dirs = ["data/chats", "data/pi-sessions", "data/chat-files"];

  /** Every file under a directory, as paths relative to it (attachments sit one folder down). */
  const listFiles = (directory: string, prefix = ""): string[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) =>
      entry.isDirectory() ? listFiles(path.join(directory, entry.name), path.join(prefix, entry.name)) : [path.join(prefix, entry.name)]
    );
  };

  const pass = () => {
    if (paused) return;
    for (const [from, to] of [[a, b], [b, a]] as const) {
      for (const dir of dirs) {
        const source = path.join(from, dir);
        for (const name of listFiles(source)) {
          const file = path.join(source, name);
          const target = path.join(to, dir, name);
          let sourceStat: fs.Stats;
          try {
            sourceStat = fs.statSync(file);
          } catch {
            continue;
          }
          if (Date.now() - sourceStat.mtimeMs < delayMs) continue;
          let targetStat: fs.Stats | null = null;
          try {
            targetStat = fs.statSync(target);
          } catch {
            targetStat = null;
          }
          if (targetStat && targetStat.mtimeMs >= sourceStat.mtimeMs - 1) continue;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const temp = `${target}.sync-tmp`;
          fs.copyFileSync(file, temp);
          fs.utimesSync(temp, sourceStat.atime, sourceStat.mtime);
          fs.renameSync(temp, target);
          copied.push(`${path.relative(from, file)}`);
        }
      }
    }
  };
  const timer = setInterval(pass, 120);
  return {
    copied,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    setDelay: (ms: number) => {
      delayMs = ms;
    },
    stop: () => clearInterval(timer),
  };
}

// ------------------------------------------------------------------- helpers

export interface ChunkRead {
  status: number;
  headers: Headers;
  chunks: Array<Record<string, unknown>>;
  text: string;
  finishedAt: number;
  done: boolean;
}

/** Everything a chat stream said, as the screen would read it. */
export async function readChatStream(response: Response, onChunk?: (chunk: Record<string, unknown>) => void): Promise<ChunkRead> {
  const chunks: Array<Record<string, unknown>> = [];
  let done = false;
  if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
    const { readSseData } = await import("../../src/lib/remote/sse.ts");
    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") {
        done = true;
        break;
      }
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        chunks.push(parsed);
        onChunk?.(parsed);
      } catch {
        // not ours to judge
      }
    }
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
  const text = chunks
    .filter((part) => part.type === "text-delta")
    .map((part) => String(part.delta ?? ""))
    .join("");
  return { status: response.status, headers: response.headers, chunks, text, finishedAt: Date.now(), done };
}

export function readChatFile(root: string, chatId: string): { messages: Array<{ id: string; role: string; content: string }>; home?: string; updatedAt: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "data", "chats", `${chatId}.json`), "utf-8"));
  } catch {
    return null;
  }
}

export function sessionFilesOf(root: string, chatId: string): string[] {
  try {
    return fs.readdirSync(path.join(root, "data", "pi-sessions")).filter((name) => name.endsWith(`_${chatId}.jsonl`));
  } catch {
    return [];
  }
}
