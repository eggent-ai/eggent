/**
 * A helper started with the Agent tool can message a colleague.
 *
 * The failure this exists for: "write to Pyotr at ten" was scheduled, fired on
 * time, and the helper that runs every scheduled task answered that it had no
 * tool for messages - pi-subagents builds a helper's session from the
 * extensions it finds on disk, and the messages tool lived only in the chat's
 * own session. Eggent now writes a small extension into the agent's folder that
 * hands helpers the tool, and keeps it out of the chat's own session, which has
 * the tool already.
 *
 * The real runtime, the real pi-subagents extension, a stub model and a
 * stand-in for the messages service. Needs an installed copy of
 * @tintinweb/pi-subagents (EGGENT_SUBAGENTS_EXTENSIONS, else the usual install
 * locations; skipped when none is there). No network, no credential.
 *
 * Run with Node 22: npm run test:helper-tools
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
import { ensureHelperToolsExtension, HELPER_TOOLS_FILE, withoutHelperTools } from "../src/lib/pi/helper-tools.ts";
import { createMessagesTool } from "../src/lib/mail/tool.ts";

const PROVIDER = "stub";
const MODEL = "stub-model";
const HELPER_MARK = "HELPER-TASK";
const MESSAGE = "Meeting tomorrow at 10";

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

function extensionDir(): string | null {
  const fromEnv = (process.env.EGGENT_SUBAGENTS_EXTENSIONS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)[0];
  const candidates = fromEnv
    ? [fromEnv]
    : [
        "/opt/eggent-pi-seed/npm/node_modules/@tintinweb/pi-subagents",
        path.join(process.cwd(), "data", "pi-agent", "npm", "node_modules", "@tintinweb", "pi-subagents"),
      ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json"))) ?? null;
}

const extension = extensionDir();
if (!extension) {
  console.log("skipped: no @tintinweb/pi-subagents installed (set EGGENT_SUBAGENTS_EXTENSIONS)");
  process.exit(0);
}

// ---- the messages service ------------------------------------------------------

const TOKEN = "eggw_test_token";
const sent: Array<Record<string, unknown>> = [];
const mail = http.createServer((req, res) => {
  let body = "";
  req.on("data", (part) => { body += String(part); });
  req.on("end", () => {
    const route = new URL(req.url || "/", "http://localhost").pathname;
    const json = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json({ error: "no", code: "unauthorized" }, 401);
    if (route === "/contacts") {
      return json({
        me: { instanceId: "acme", orgName: "ACME", role: "owner", name: "Ilia" },
        company: { id: "acme", name: "ACME" },
        contacts: [{ id: "acme-pyotr", name: "Pyotr", role: "member", about: null, unread: 0, lastMessageAt: null, lastMessage: null }],
        unreadTotal: 0,
      });
    }
    if (route === "/send" && req.method === "POST") {
      const payload = JSON.parse(body) as Record<string, unknown>;
      sent.push(payload);
      return json({
        message: {
          id: 100 + sent.length,
          fromMe: true,
          author: { id: "acme", name: "Ilia", kind: "agent" },
          via: "agent",
          text: payload.text,
          replyTo: null,
          createdAt: new Date().toISOString(),
          attachments: [],
        },
      });
    }
    return json({ error: "not found" }, 404);
  });
});
await new Promise<void>((resolve) => mail.listen(0, "127.0.0.1", resolve));
process.env.EGGENT_MAIL_API_URL = `http://127.0.0.1:${(mail.address() as { port: number }).port}`;
process.env.EGGENT_MAIL_API_TOKEN = TOKEN;

// ---- the model -------------------------------------------------------------------

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
type StubMessage = { role?: string; content?: unknown };
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part as { text?: string })?.text ?? "").join("");
  return "";
}

/** The tools each request offered: the helper's and the chat session's apart. */
const offered = { helper: [] as string[][], parent: [] as string[][] };
const helperToolResults: string[] = [];
const provider = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    return;
  }
  let body = "";
  req.on("data", (part) => { body += String(part); });
  req.on("end", () => {
    const payload = JSON.parse(body || "{}") as { messages?: StubMessage[]; tools?: Array<{ function?: { name?: string } }> };
    const messages = payload.messages ?? [];
    const names = (payload.tools ?? []).map((tool) => tool.function?.name ?? "");
    const firstUser = textOf(messages.find((message) => message.role === "user")?.content);
    const toolAnswered = messages[messages.length - 1]?.role === "tool";
    const isHelper = firstUser.includes(HELPER_MARK);
    (isHelper ? offered.helper : offered.parent).push(names);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    const call = (name: string, args: Record<string, unknown>) => {
      res.write(chunk({ tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
      res.write(chunk({}, "tool_calls"));
    };
    if (isHelper && !toolAnswered && names.includes("eggent_messages")) {
      call("eggent_messages", { action: "send", to: "Pyotr", text: MESSAGE });
    } else if (isHelper) {
      if (toolAnswered) helperToolResults.push(textOf(messages[messages.length - 1]?.content));
      res.write(chunk({ content: toolAnswered ? "Sent to Pyotr." : "No tool for messages here." }));
      res.write(chunk({}, "stop"));
    } else if (!toolAnswered) {
      call("Agent", { description: "Tell Pyotr", subagent_type: "general-purpose", run_in_background: false, prompt: `${HELPER_MARK} Send Pyotr the message: ${MESSAGE}` });
    } else {
      res.write(chunk({ content: "Done." }));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

// ---- a chat turn that starts one helper -------------------------------------------

async function runTurn(options: { filterBridge: boolean }): Promise<{ agentDir: string; helperReply: string; chatToolIsOwn: boolean }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-helper-tools-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "work");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { [PROVIDER]: { name: "Stub", baseUrl: providerUrl, api: "openai-completions", models: [{ id: MODEL, name: "Stub", input: ["text"], contextWindow: 32768, maxTokens: 2048 }] } },
  }));
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
  // The extension is found where a workspace has it: in the agent's settings.
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [extension] }));
  process.env.PI_CODING_AGENT_DIR = agentDir;

  // What session.ts does before building the chat's session.
  ensureHelperToolsExtension(agentDir);

  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
  const registry = new ModelRegistry(runtime);
  await registry.refresh();
  const model = registry.getAll().find((entry) => entry.provider === PROVIDER && entry.id === MODEL);
  const ownTool = createMessagesTool({ chatId: "chat-1", cwd, marksRead: () => true });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noSkills: true,
    ...(options.filterBridge ? { extensionsOverride: withoutHelperTools } : {}),
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    // The chat's own session has the tool from Eggent, as in eggent-tools.ts.
    customTools: [ownTool as never],
  });
  const chatToolIsOwn = session.getToolDefinition("eggent_messages") === (ownTool as unknown);
  await session.bindExtensions({ mode: "rpc" });
  let helperReply = "";
  const unsubscribe = session.subscribe((event: unknown) => {
    const record = event as Record<string, unknown>;
    if (record.type === "tool_execution_end" && record.toolName === "Agent") {
      helperReply = ((record.result as { content?: Array<{ text?: string }> })?.content ?? []).map((part) => part.text ?? "").join("");
    }
  });
  await session.prompt("Tell Pyotr about the meeting.");
  unsubscribe();
  session.dispose();
  return { agentDir, helperReply, chatToolIsOwn };
}

console.log(`Helpers get the messages tool (${path.basename(path.dirname(extension))}/${path.basename(extension)} ${JSON.parse(fs.readFileSync(path.join(extension, "package.json"), "utf8")).version})\n`);

const first = await runTurn({ filterBridge: true });

check("the bridge is written into the agent's extensions folder", () => {
  assert.ok(fs.existsSync(path.join(first.agentDir, "extensions", HELPER_TOOLS_FILE)));
});
check("the helper is offered eggent_messages", () => {
  assert.ok(offered.helper.length > 0, "no helper request reached the model");
  assert.ok(offered.helper[0].includes("eggent_messages"), `helper tools: ${offered.helper[0].join(", ")}`);
});
check("the helper's send reaches the messages service, signed by the agent", () => {
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.equal(sent[0].to, "acme-pyotr");
  assert.equal(sent[0].text, MESSAGE);
  assert.equal(sent[0].author, "agent");
  assert.match(helperToolResults[0] ?? "", /"success": true/);
});
check("the helper's result comes back to the turn that started it", () => {
  assert.match(first.helperReply, /Sent to Pyotr/);
});
check("the chat's own session offers the tool once, and it is the chat's own copy", () => {
  // The chat's copy marks what it reads as read and knows its chat; the
  // helper's does neither. The session leaves the bridge out, and the SDK would
  // let its own tools win a clash of names anyway.
  assert.ok(first.chatToolIsOwn);
  for (const names of offered.parent) {
    assert.equal(names.filter((name) => name === "eggent_messages").length, 1, names.join(", "));
  }
});

// Without messages in this deployment nothing of ours is left in the folder.
delete process.env.EGGENT_MAIL_API_URL;
ensureHelperToolsExtension(first.agentDir);
check("without messages the bridge file is removed", () => {
  assert.ok(!fs.existsSync(path.join(first.agentDir, "extensions", HELPER_TOOLS_FILE)));
});
const foreign = path.join(first.agentDir, "extensions", HELPER_TOOLS_FILE);
fs.mkdirSync(path.dirname(foreign), { recursive: true });
fs.writeFileSync(foreign, "export default function () {}\n");
ensureHelperToolsExtension(first.agentDir);
check("a file of the same name that is not ours is left alone", () => {
  assert.ok(fs.existsSync(foreign));
});

mail.close();
provider.close();
console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
