/**
 * Checks where a quick-start card puts the skill it launches.
 *
 * Run with Node 22:
 *   EGGENT_TEST_STUBS=lib/storage/project-store node --experimental-strip-types \
 *     --import ./scripts/alias-loader-register.mjs scripts/test-skill-launch-scope.ts
 *
 * The project store is stubbed - the real one pulls in the chat store and the
 * app's type module - but the stub writes and reads real projects on disk, so
 * these assertions are about files appearing, not about calls being made.
 *
 * Tapping a card is an offer to begin a piece of work, so the work gets its own
 * project and no question is asked - the person has nothing to base the answer
 * on one screen before they have seen the skill run. The exception is the
 * skills that describe the workspace rather than a line of work: about-you
 * writes into the orchestrator's own context.md, which every chat reads, so a
 * project would hide its answers from everywhere else.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-skill-launch-"));
const dataDir = path.join(workDir, "data");
const bundledDir = path.join(workDir, "bundled-skills");
await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });
await fs.mkdir(bundledDir, { recursive: true });

// Both stores resolve their roots from cwd at import time, so move first.
process.chdir(workDir);

async function writeBundledSkill(name: string, title: string): Promise<void> {
  const dir = path.join(bundledDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}, written for the model.\ntitle_en: ${title}\nsummary_en: Short card copy.\n---\n\n# ${title}\n`
  );
}

await writeBundledSkill("about-you", "Tell me about yourself");
await writeBundledSkill("iishenka-rag", "RAG over your files");

const { launchBundledSkill, isOrchestratorScopedSkill } = await import("../src/lib/storage/bundled-skills-store.ts");
const { listProjects, getProject } = await import("./stubs/project-store.ts");

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

console.log("bundled skill launch scope");

await check("about-you is workspace-scoped, every other skill is not", () => {
  assert.equal(isOrchestratorScopedSkill("about-you"), true);
  assert.equal(isOrchestratorScopedSkill("About-You"), true);
  assert.equal(isOrchestratorScopedSkill("iishenka-rag"), false);
});

const aboutYou = await launchBundledSkill("about-you");
await check("about-you lands in the orchestrator and creates no project", async () => {
  assert.equal(aboutYou.success, true);
  assert.equal(aboutYou.success && aboutYou.projectId, null);
  assert.equal((await listProjects()).length, 0);
});

const rag = await launchBundledSkill("iishenka-rag");
await check("another skill gets a project of its own, without being asked", async () => {
  assert.equal(rag.success, true);
  assert.ok(rag.success && rag.projectId, "expected a project id");
});
await check("the project is named after the card, and its id after the skill", async () => {
  assert.ok(rag.success);
  const project = await getProject(rag.success ? rag.projectId as string : "");
  assert.ok(project, "project should exist on disk");
  assert.equal(project?.id, "iishenka-rag");
  assert.equal(project?.name, "RAG over your files");
});

// Launching the same card twice must not collide on the project id.
const ragAgain = await launchBundledSkill("iishenka-rag");
await check("launching the same card again makes a second project rather than failing", async () => {
  assert.equal(ragAgain.success, true);
  assert.equal(ragAgain.success && ragAgain.projectId, "iishenka-rag-2");
  assert.equal((await listProjects()).length, 2);
});

// The skills screen inside a project still targets that project explicitly.
const explicit = await launchBundledSkill("iishenka-rag", "iishenka-rag");
await check("an explicit target still wins over the automatic one", async () => {
  assert.equal(explicit.success, true);
  assert.equal(explicit.success && explicit.projectId, "iishenka-rag");
  assert.equal((await listProjects()).length, 2, "no extra project should appear");
});

const missing = await launchBundledSkill("iishenka-rag", "no-such-project");
await check("an explicit target that does not exist is refused, not invented", () => {
  assert.equal(missing.success, false);
  assert.equal(!missing.success && missing.code, 404);
});

process.chdir(os.tmpdir());
await fs.rm(workDir, { recursive: true, force: true });

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed > 0 ? 1 : 0);
