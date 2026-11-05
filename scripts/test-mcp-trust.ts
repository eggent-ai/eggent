/**
 * A project's MCP server, on the real pi-mcp-adapter, through the real runner.
 *
 * The failure this exists for: a person connects a server in a project and asks
 * for it from Telegram. Nobody can be asked there, the adapter skips the server,
 * and the agent reports a tool that does not exist. Where the deployment trusts
 * the workspace's own files, the server has to work on every surface; where it
 * does not, the question has to stay a question, and no process may start.
 *
 * Each case runs in a process of its own: the adapter and the runner hold state
 * per process, and a real workspace meets these one at a time.
 *
 * Needs an installed pi-mcp-adapter: EGGENT_MCP_ADAPTER=<package dir>, else the
 * image's seed; skipped when there is none. No network, no credential.
 *   npm run test:mcp-trust
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER = "stub";
const MODEL = "stub-model";
const CHAT = "11111111-1111-4111-8111-111111111111";
const PROJECT = "shop";

const adapterDir = [
  process.env.EGGENT_MCP_ADAPTER,
  "/opt/eggent-pi-seed/npm/node_modules/pi-mcp-adapter",
].find((dir) => dir && fs.existsSync(path.join(dir, "package.json")));

const SERVER_SOURCE = `
const fs = require("node:fs");
fs.appendFileSync(process.env.MARK_FILE, "spawned\\n");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (part) => {
  buffer += part;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const { id, method, params } = JSON.parse(line);
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stubsrv", version: "1" } } });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [{ name: "ping", description: "Answers", inputSchema: { type: "object", properties: {} } }] } });
    else if (method === "tools/call") { fs.appendFileSync(process.env.MARK_FILE, "called\\n"); send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "STUB-PONG" }] } }); }
    else if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
  }
});
`;

type Report = {
  mcpResults: string[];
  reply: string;
  spawned: number;
  called: number;
  approvals: Array<{ serverName: string; projectRoot: string }>;
  cards: string[];
  tools: string[];
  policy?: unknown;
};

/** One workspace, one turn or several, then a report on stdout. */
async function runCase(name: string): Promise<void> {
  const mcpResults: string[] = [];
  let tools: string[] = [];
  const delayedTurns = new Set<number>();
  // The model asks for the tool until it has been answered, then says what it got.
  const provider = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: MODEL }] }));
      return;
    }
    let body = "";
    req.on("data", (part) => { body += String(part); });
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as {
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      tools = (payload.tools ?? []).map((tool) => tool.function?.name ?? "");
      const messages = payload.messages ?? [];
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const text = JSON.stringify(lastUser?.content ?? "");
      const lastUserAt = messages.lastIndexOf(lastUser as never);
      const answers = messages.slice(lastUserAt + 1).filter((message) => message.role === "tool");
      for (const answer of answers) mcpResults.push(JSON.stringify(answer.content));
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      // A real model takes longer than the reload's timer: a reload that does not wait for the
      // turn has to land inside it here, or this test could not fail.
      if (text.includes("ADD-THEN-CALL") && answers.length >= 1 && !delayedTurns.has(answers.length)) {
        delayedTurns.add(answers.length);
        setTimeout(respond, 1500);
        return;
      }
      respond();
      return;
      function respond() {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant" }));
      const call = (toolName: string, args: unknown) => {
        res.write(chunk({ tool_calls: [{ index: 0, id: `call-${answers.length}`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] }));
        res.write(chunk({}, "tool_calls"));
      };
      const ping = { tool: "stubsrv_ping", args: "{}" };
      if (text.includes("ADD-THEN-CALL") && answers.length === 0) {
        call("upsert_mcp_server", { project_id: PROJECT, id: "stubsrv", transport: "stdio", command: process.execPath, args: [serverFile], env: { MARK_FILE: markFile } });
      } else if (text.includes("ADD-THEN-CALL") && answers.length === 1) {
        call("mcp", { connect: "stubsrv" });
      } else if (text.includes("ADD-THEN-CALL") && answers.length === 2) {
        call("mcp", ping);
      } else if (text.includes("ADD-THEN-CALL") && answers.length === 3) {
        call("mcp", {});
      } else if (text.includes("CALL-MCP") && answers.length === 0) {
        call("mcp", ping);
      } else {
        res.write(chunk({ content: "done" }));
        res.write(chunk({}, "stop"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
      }
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-mcp-trust-"));
  process.chdir(root);
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  const serverFile = path.join(root, "stub-server.cjs");
  const markFile = path.join(root, "marks.txt");
  fs.writeFileSync(serverFile, SERVER_SOURCE);
  fs.writeFileSync(markFile, "");
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [PROVIDER]: {
        name: "Stub",
        baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
        api: "openai-completions",
        models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }],
      },
    },
  }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: PROVIDER,
    defaultModel: MODEL,
    packages: [adapterDir],
  }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.EGGENT_LEARNING = "off";
  process.env.EGGENT_TURN_WATCHDOG = "off";
  const trusted = !name.startsWith("untrusted");
  if (trusted) process.env.EGGENT_MCP_TRUST_WORKSPACE = "1";
  else delete process.env.EGGENT_MCP_TRUST_WORKSPACE;

  const { runPiAgentText, createPiChatUIMessageStream } = await import("../src/lib/pi/chat-runner.ts");
  const { createChat } = await import("../src/lib/storage/chat-store.ts");
  const { createProject, upsertProjectMcpServer } = await import("../src/lib/storage/project-store.ts");
  const { listPendingInteractions, respondToPendingInteraction } = await import("../src/lib/pi/pending-interactions.ts");
  const { createEggentPiSession } = await import("../src/lib/pi/session.ts");
  void createPiChatUIMessageStream;

  await createProject({ id: PROJECT, name: "Shop" } as never).catch(() => undefined);
  const projects = path.join(root, "data", "projects");
  const projectId = fs.readdirSync(projects).find((entry) => fs.existsSync(path.join(projects, entry, "project.json"))) ?? PROJECT;
  const stubServer = { transport: "stdio", command: process.execPath, args: [serverFile], env: { MARK_FILE: markFile } };
  const addServer = (extra: Record<string, string> = {}) =>
    upsertProjectMcpServer(projectId, { id: "stubsrv", ...stubServer, env: { ...stubServer.env, ...extra } } as never);
  await createChat(CHAT, "t", projectId);

  const cards: string[] = [];
  const turn = (message: string, extra: Record<string, unknown> = {}) =>
    runPiAgentText({ chatId: CHAT, projectId, userMessage: message, ...extra } as never);
  let reply = "";

  if (name === "trusted-no-listener" || name === "untrusted-no-listener") {
    await addServer();
    reply = await turn("CALL-MCP please");
  } else if (name === "trusted-changed") {
    await addServer();
    await turn("CALL-MCP please");
    await addServer({ CHANGED: "1" });
    reply = await turn("CALL-MCP again");
  } else if (name === "trusted-added-in-turn" || name === "untrusted-added-in-turn") {
    reply = await turn("ADD-THEN-CALL");
  } else if (name === "trusted-kept-session") {
    const session = await createEggentPiSession({ chatId: CHAT, projectId } as never);
    await session.prompt("ADD-THEN-CALL");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await session.prompt("CALL-MCP again");
    session.dispose();
  } else if (name === "trusted-no-ui") {
    await addServer();
    const session = await createEggentPiSession({ chatId: CHAT, projectId } as never);
    await session.prompt("CALL-MCP please");
    session.dispose();
  } else if (name === "untrusted-no-ui") {
    await addServer();
    const session = await createEggentPiSession({ chatId: CHAT, projectId } as never);
    await session.prompt("CALL-MCP please");
    session.dispose();
  } else if (name === "untrusted-web-yes") {
    await addServer();
    const session = await createEggentPiSession({
      chatId: CHAT,
      projectId,
      runId: "run-web",
      onPiInteraction: (interaction: { runId: string; title: string }) => {
        cards.push(interaction.title);
        if (!interaction.title?.startsWith("Allow project MCP server")) return;
        setTimeout(() => {
          for (const open of listPendingInteractions(interaction.runId)) {
            respondToPendingInteraction(interaction.runId, open.id, { value: true });
          }
        }, 10);
      },
    } as never);
    await session.prompt("CALL-MCP please");
    session.dispose();
  } else if (name === "trusted-public") {
    await addServer();
    reply = await turn("CALL-MCP please", { publicShare: true, enableEggentTools: false });
  } else {
    throw new Error(`no such case: ${name}`);
  }

  const approvalsFile = path.join(agentDir, "mcp-project-approvals.json");
  const marks = fs.readFileSync(markFile, "utf-8").split("\n");
  const policyFile = path.join(agentDir, "mcp-adapter.json");
  const report: Report = {
    mcpResults,
    reply,
    spawned: marks.filter((line) => line === "spawned").length,
    called: marks.filter((line) => line === "called").length,
    approvals: fs.existsSync(approvalsFile) ? JSON.parse(fs.readFileSync(approvalsFile, "utf-8")).approvals : [],
    cards,
    tools,
    policy: fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, "utf-8")) : undefined,
  };
  process.stdout.write(`\nREPORT${JSON.stringify(report)}\n`);
  process.exit(0);
}

const onlyCase = process.argv[2];
if (onlyCase) {
  await runCase(onlyCase);
} else if (!adapterDir) {
  console.log("skipped: no pi-mcp-adapter (set EGGENT_MCP_ADAPTER)");
} else {
  let failed = 0;
  let ran = 0;
  const self = fileURLToPath(import.meta.url);
  const inCase = (name: string): Report => {
    const out = spawnSync(process.execPath, [
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
      "--import", path.resolve("scripts/alias-loader-register.mjs"),
      self, name,
    ], { encoding: "utf-8", timeout: 120_000, cwd: process.cwd() });
    const line = out.stdout.split("\n").find((entry) => entry.startsWith("REPORT"));
    if (!line) throw new Error(`no report (status ${out.status}): ${(out.stderr || out.stdout).slice(-600)}`);
    return JSON.parse(line.slice("REPORT".length)) as Report;
  };
  const check = (title: string, name: string, fn: (report: Report) => void) => {
    ran += 1;
    try {
      fn(inCase(name));
      console.log(`  ok    ${title}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const answered = (report: Report) => report.mcpResults.some((result) => result.includes("STUB-PONG"));

  console.log("A project's MCP server, where the deployment trusts the workspace\n");
  check("a messenger's turn reaches the server, and the adapter keeps its own record", "trusted-no-listener", (report) => {
    assert.ok(answered(report), `no answer: ${report.mcpResults.join(" | ").slice(0, 300)}`);
    assert.equal(report.called, 1);
    assert.ok(report.approvals.some((entry) => entry.serverName === "stubsrv"), "no approval recorded");
  });
  check("nobody is asked for it on a surface that has cards", "trusted-no-listener", (report) => {
    assert.equal(report.cards.length, 0);
  });
  check("a changed server still runs", "trusted-changed", (report) => {
    assert.equal(report.called, 2);
  });
  check("a session with no UI at all - a helper, a scheduled run - reaches it too", "trusted-no-ui", (report) => {
    assert.ok(answered(report), `no answer: ${report.mcpResults.join(" | ").slice(0, 300)}`);
    assert.equal((report.policy as { settings?: { projectServers?: string } })?.settings?.projectServers, "allow");
  });
  check("a server added in a turn answers in that same turn, and nothing goes stale", "trusted-added-in-turn", (report) => {
    assert.ok(answered(report), `no answer: ${report.mcpResults.join(" | ").slice(0, 400)}`);
    assert.ok(!report.mcpResults.some((result) => result.includes("stale")), "a tool went stale");
  });
  check("a session kept for its schedules still reaches it after the turn", "trusted-kept-session", (report) => {
    assert.equal(report.called, 2, `results: ${report.mcpResults.join(" | ").slice(0, 400)}`);
    assert.ok(!report.mcpResults.some((result) => result.includes("stale")), "a tool went stale");
  });
  check("a public link starts no server and has no mcp tool", "trusted-public", (report) => {
    assert.equal(report.spawned, 0);
    assert.ok(!report.tools.includes("mcp"), "the mcp tool is offered");
  });

  console.log("\nWhere it does not\n");
  check("a messenger's turn does not start the server, and does not hang", "untrusted-no-listener", (report) => {
    assert.equal(report.spawned, 0);
    assert.equal(report.called, 0);
    assert.ok(!report.mcpResults.some((result) => result.includes("STUB-PONG")));
  });
  check("a session with no UI does not start it either, and nothing grants it", "untrusted-no-ui", (report) => {
    assert.equal(report.spawned, 0);
    assert.equal(report.policy, undefined);
  });
  check("a server added in a turn waits for the next message, says so, and breaks nothing", "untrusted-added-in-turn", (report) => {
    assert.equal(report.spawned, 0);
    assert.ok(report.mcpResults.some((result) => result.includes("next message")), "the agent is not told");
    assert.ok(!report.mcpResults.some((result) => result.includes("stale")), "a tool went stale");
  });
  check("in the web the person is asked, and a yes works", "untrusted-web-yes", (report) => {
    assert.ok(report.cards.some((title) => title.startsWith("Allow project MCP server")), `cards: ${report.cards.join(",")}`);
    assert.equal(report.called, 1);
  });

  console.log(`\n${ran - failed} of ${ran} passed`);
  process.exit(failed ? 1 : 0);
}
