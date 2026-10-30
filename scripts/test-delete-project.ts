/**
 * The agent can delete a project, and only when deleting it is safe.
 *
 * Run with Node 22:
 *   npm run test:delete-project
 *
 * There was no such tool: asked to delete a project, an agent opened the
 * browser and asked the person to sign in, then removed the folder with a
 * script, past the chats and file history that go with it. The tool deletes
 * through the same function as the Settings button, refuses the project its own
 * chat lives in, a project with a turn running, a scheduled run and a visit, and
 * drops the project's row from the orchestrator's routing table.
 *
 * Drives the real `delete_project` tool against real project and chat stores.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-delete-project-"));
process.chdir(root);
const projectsDir = path.join(root, "data", "projects");
fs.mkdirSync(projectsDir, { recursive: true });
process.env.EGGENT_LEARNING = "off";

const { createEggentPiTools } = await import("../src/lib/pi/eggent-tools.ts");
const { createProject, getProject } = await import("../src/lib/storage/project-store.ts");
const { createChat, getChat } = await import("../src/lib/storage/chat-store.ts");
const { registerActiveRun, clearActiveRun } = await import("../src/lib/pi/active-runs.ts");
const { markScheduledRunSession, unmarkScheduledRunSession } = await import("../src/lib/pi/scheduled-run-state.ts");

type ToolLike = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> };

async function deleteVia(options: Record<string, unknown>, projectId: string): Promise<Record<string, unknown>> {
  const { tools } = await createEggentPiTools({ scopeId: "none", cwd: projectsDir, ...options } as never);
  const tool = (tools as unknown as ToolLike[]).find((item) => item.name === "delete_project");
  if (!tool) throw new Error("no delete_project tool");
  const result = await tool.execute("call-1", { project_id: projectId }, undefined, undefined, undefined);
  return JSON.parse(result.content.map((part) => part.text ?? "").join("")) as Record<string, unknown>;
}

async function makeProject(id: string, name: string) {
  await createProject({ id, name, description: "", instructions: "", memoryMode: "isolated" });
  fs.writeFileSync(path.join(projectsDir, id, "notes.md"), "kept until deleted");
}

const contextPath = path.join(projectsDir, "context.md");
fs.writeFileSync(contextPath, [
  "# Orchestrator",
  "",
  "## Projects",
  "",
  "| Project | Id | What |",
  "|---|---|---|",
  "| Leads | `leads` | leads from the public chat |",
  "| Accounts | `accounts` | the books |",
  "",
  "Mention `leads` in prose stays.",
].join("\n"));

console.log("Deleting a project from the agent\n");

await check("deletes the folder, its chats, and its routing row only", async () => {
  await makeProject("leads", "Leads");
  await makeProject("accounts", "Accounts");
  await createChat("leads-chat", "a chat", "leads");
  const result = await deleteVia({ chatId: "outside-chat" }, "leads");
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.deletedChats, 1);
  assert.equal(fs.existsSync(path.join(projectsDir, "leads")), false);
  assert.equal(await getChat("leads-chat"), null);
  const context = fs.readFileSync(contextPath, "utf-8");
  assert.ok(!context.includes("| Leads |"), "the row is gone");
  assert.ok(context.includes("| Accounts | `accounts` |"), "the other row stays");
  assert.ok(context.includes("Mention `leads` in prose stays."), "prose is not touched");
  assert.ok(await getProject("accounts"), "the other project stays");
});

await check("finds the project by its name too", async () => {
  await makeProject("by-name", "Πελάτες");
  const result = await deleteVia({ chatId: "outside-chat" }, "Πελάτες");
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(projectsDir, "by-name")), false);
});

await check("refuses the project this chat belongs to", async () => {
  await makeProject("own", "Own");
  const result = await deleteVia({ chatId: "own-chat", projectId: "own" }, "own");
  assert.equal(result.success, false);
  assert.ok(fs.existsSync(path.join(projectsDir, "own", "notes.md")));
});

await check("refuses a project with a turn running in one of its chats", async () => {
  await makeProject("busy", "Busy");
  await createChat("busy-chat", "working", "busy");
  registerActiveRun("busy-chat", { session: { isStreaming: true, steer: async () => {}, abort: async () => {} }, runId: "run-busy", surface: "web" } as never);
  try {
    const result = await deleteVia({ chatId: "outside-chat" }, "busy");
    assert.equal(result.success, false);
    assert.ok(fs.existsSync(path.join(projectsDir, "busy", "notes.md")));
  } finally {
    clearActiveRun("busy-chat", "run-busy");
  }
});

await check("refuses from a visit", async () => {
  await makeProject("visited", "Visited");
  const result = await deleteVia({ chatId: "visit-chat", visit: { parentChatId: "p" } }, "visited");
  assert.equal(result.success, false);
  assert.ok(fs.existsSync(path.join(projectsDir, "visited", "notes.md")));
});

await check("refuses from a scheduled run", async () => {
  await makeProject("scheduled", "Scheduled");
  markScheduledRunSession("cron-chat");
  try {
    const result = await deleteVia({ chatId: "cron-chat" }, "scheduled");
    assert.equal(result.success, false);
    assert.ok(fs.existsSync(path.join(projectsDir, "scheduled", "notes.md")));
  } finally {
    unmarkScheduledRunSession("cron-chat");
  }
});

await check("refuses the orchestrator and an unknown id", async () => {
  assert.equal((await deleteVia({ chatId: "outside-chat" }, "none")).success, false);
  assert.equal((await deleteVia({ chatId: "outside-chat" }, "../data")).success, false);
  assert.ok(fs.existsSync(contextPath));
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
