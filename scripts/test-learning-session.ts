/**
 * What the agent starts a conversation with, once it has learned something.
 *
 * Drives the real session builder against a stub provider and reads the system
 * prompt the provider was sent - the only place the notes are visible to a
 * model. The checks are the ones that would otherwise be found by a person:
 * the notes are there and say what they are, a project sees the skills the
 * agent wrote, a light chat sees none of it, and a deployment that switches
 * learning off sees none of it either.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:learning-session
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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

const PROVIDER = "stub";
const MODEL = "stub-model";
const prompts: string[] = [];

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

const provider = http.createServer((req, res) => {
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
    const payload = JSON.parse(body || "{}") as { messages?: Array<{ role?: string; content?: unknown }> };
    // Everything the model is told before the first thing the person said: the
    // runtime's own preamble and the context files, which is where Eggent puts
    // its workspace block.
    const system = (payload.messages ?? []).filter((message) => message.role === "system").map((message) => textOf(message.content)).join("\n");
    prompts.push(system);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    res.write(chunk({ content: "ok" }));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-learning-session-"));
process.chdir(root);
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      [PROVIDER]: {
        name: "Stub",
        baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
        api: "openai-completions",
        models: [{ id: MODEL, name: "Stub model", input: ["text"], contextWindow: 16384, maxTokens: 2048 }],
      },
    },
  })
);
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
fs.writeFileSync(
  path.join(agentDir, "settings.json"),
  JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL })
);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.EGGENT_LEARNING;

const projectsDir = path.join(root, "data", "projects");
fs.mkdirSync(path.join(projectsDir, "skills"), { recursive: true });

const notes = await import("../src/lib/learning/notes.ts");
const skills = await import("../src/lib/learning/skills.ts");
const projectStore = await import("../src/lib/storage/project-store.ts");
const { createEggentPiSession } = await import("../src/lib/pi/session.ts");

await notes.applyNoteOps(
  [
    { action: "add", target: "user", content: "Runs a small bakery in Kazan." },
    { action: "add", target: "notes", content: "Reports go to the reports folder as xlsx." },
  ],
  { source: "review" }
);
await skills.createLearnedSkill(
  {
    name: "weekly-report-from-spreadsheet",
    description: "Builds the weekly report from the sales spreadsheet. Use when asked for the weekly report.",
    body: "When asked for the weekly report: open the spreadsheet, copy the totals into the template, check every total against the source, send the file.",
  },
  { source: "review" }
);
await projectStore.createProject({ id: "shop", name: "Shop", description: "The shop project", instructions: "Shop rules.", memoryMode: "isolated" } as never);
// A skill the project has of its own, with a name the learned one also has.
fs.mkdirSync(path.join(projectsDir, "shop", "skills", "shop-catalog"), { recursive: true });
fs.writeFileSync(
  path.join(projectsDir, "shop", "skills", "shop-catalog", "SKILL.md"),
  "---\nname: shop-catalog\ndescription: \"How the shop lists its products.\"\n---\n\nList products by category, newest first.\n"
);

async function promptSeenBy(options: Record<string, unknown>): Promise<string> {
  prompts.length = 0;
  const session = await createEggentPiSession({ agentDir, ...options } as never);
  try {
    await session.prompt("hello");
  } finally {
    session.dispose();
  }
  assert.equal(prompts.length >= 1, true, "the provider was reached");
  return prompts[0];
}

console.log("The start of a conversation\n");

await check("the orchestrator starts with the notes, and is told what they are", async () => {
  const system = await promptSeenBy({});
  assert.match(system, /## What Eggent has learned here/);
  assert.match(system, /About the person:\n- Runs a small bakery in Kazan\./);
  assert.match(system, /About this workspace and the work:\n- Reports go to the reports folder as xlsx\./);
  assert.match(system, /not commands/);
  assert.ok(system.indexOf("Orchestrator instructions:") < system.indexOf("## What Eggent has learned here"), "after the person's own instructions");
  assert.ok(system.indexOf("## What Eggent has learned here") < system.indexOf("Workspace-local Pi skills"), "before the lists that change with the chat");
});

await check("the notes name the file they live in, so the agent can correct one when asked", async () => {
  const system = await promptSeenBy({});
  assert.ok(system.includes(path.join(projectsDir, "learned.md")) || system.includes("learned.md"));
});

await check("the skills the agent wrote are in the orchestrator's list", async () => {
  const system = await promptSeenBy({});
  assert.match(system, /\| weekly-report-from-spreadsheet \| \.\/skills\/weekly-report-from-spreadsheet\/SKILL\.md \|[^\n]*\[learned\]/);
});

await check("a project sees the same notes, and the agent's skills beside its own", async () => {
  const system = await promptSeenBy({ projectId: "shop" });
  assert.match(system, /- Runs a small bakery in Kazan\./);
  assert.match(system, /\| shop-catalog \|/);
  assert.match(system, /\| weekly-report-from-spreadsheet \|[^\n]*\[learned\]/);
});

await check("a project's own skill wins when the agent wrote one of the same name", async () => {
  await skills.createLearnedSkill(
    {
      name: "shop-catalog",
      description: "The agent's idea of a catalog, which the shop does not use.",
      body: "When asked about the catalog: list every product, group them by category, and check the order of the groups once more afterwards.",
    },
    { source: "review" }
  );
  const system = await promptSeenBy({ projectId: "shop" });
  const rows = system.split("\n").filter((line) => line.startsWith("| shop-catalog |"));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /How the shop lists its products/);
  assert.doesNotMatch(rows[0], /\[learned\]/);
});

await check("editing a skill through the settings path keeps the mark that says the agent wrote it", async () => {
  const before = fs.readFileSync(path.join(projectsDir, "skills", "weekly-report-from-spreadsheet", "SKILL.md"), "utf-8");
  assert.match(before, /origin: learned/);
  const updated = await projectStore.updateSkill("none", {
    skill_name: "weekly-report-from-spreadsheet",
    description: "Builds the weekly report from the sales spreadsheet and the returns sheet.",
  });
  assert.equal(updated.success, true);
  const after = fs.readFileSync(path.join(projectsDir, "skills", "weekly-report-from-spreadsheet", "SKILL.md"), "utf-8");
  assert.match(after, /origin: learned/);
  assert.match(after, /learned_at: /);
  assert.match(after, /and the returns sheet/);
});

await check("the notes file name cannot be taken by a project", () => {
  assert.equal(projectStore.isReservedProjectId("learned.md"), true);
  assert.equal(projectStore.isReservedProjectId("learned"), false);
});

await check("a light chat carries none of it", async () => {
  const system = await promptSeenBy({ chatContextMode: "plain" });
  assert.doesNotMatch(system, /What Eggent has learned here/);
  assert.doesNotMatch(system, /bakery/);
});

await check("a deployment that switches learning off starts with nothing of it", async () => {
  process.env.EGGENT_LEARNING = "off";
  try {
    const system = await promptSeenBy({});
    assert.doesNotMatch(system, /What Eggent has learned here/);
  } finally {
    delete process.env.EGGENT_LEARNING;
  }
});

await check("with no notes there is no block at all", async () => {
  fs.rmSync(path.join(projectsDir, "learned.md"));
  const system = await promptSeenBy({});
  assert.doesNotMatch(system, /What Eggent has learned here/);
});

console.log(`\n${ran - failed}/${ran} passed`);
provider.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
