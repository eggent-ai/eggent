/**
 * Checks that an installed skill can be brought up to date, and only when it is
 * safe to do so.
 *
 * Run with Node 22:
 *   EGGENT_TEST_STUBS=lib/storage/project-store node --experimental-strip-types \
 *     --import ./scripts/alias-loader-register.mjs scripts/test-skill-refresh.ts
 *
 * An installed copy used to be frozen for the life of the workspace, so every
 * improvement reached new users only. Refreshing it is safe exactly when the
 * copy is provably one we shipped; a copy the user has edited is theirs, and
 * silently overwriting it would be worse than the staleness it fixes.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-skill-refresh-"));
const dataDir = path.join(workDir, "data");
const bundledDir = path.join(workDir, "bundled-skills");
await fs.mkdir(path.join(dataDir, "projects"), { recursive: true });
await fs.mkdir(bundledDir, { recursive: true });
process.chdir(workDir);

const md5 = (text: string) => crypto.createHash("md5").update(text).digest("hex");

const OLD_BODY = "---\nname: demo\ndescription: Demo skill, an earlier version.\n---\n\n# Demo\n\nOld instructions.\n";
const NEW_BODY = "---\nname: demo\ndescription: Demo skill, the shipped version.\n---\n\n# Demo\n\nNew instructions.\n";

async function writeSource(name: string, body: string, vintages: string[]): Promise<void> {
  const dir = path.join(bundledDir, name);
  await fs.mkdir(path.join(dir, "references"), { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body);
  await fs.writeFile(path.join(dir, "references", "guide.md"), "shipped guide\n");
  if (vintages.length) await fs.writeFile(path.join(dir, ".vintages"), vintages.join("\n") + "\n");
}

await writeSource("demo", NEW_BODY, [md5(OLD_BODY), md5(NEW_BODY)]);
await writeSource("unmanaged", NEW_BODY, []);

const store = await import("../src/lib/storage/bundled-skills-store.ts");
const { getProjectSkillsDir } = await import("./stubs/project-store.ts");

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const installedDir = (skill: string) => path.join(getProjectSkillsDir("none"), skill);

/** Put a copy on disk as if it had been installed at some earlier date. */
async function seedInstalled(skill: string, body: string, extra?: Record<string, string>): Promise<void> {
  const dir = installedDir(skill);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, "references"), { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body);
  await fs.writeFile(path.join(dir, "references", "guide.md"), "old guide\n");
  for (const [rel, contents] of Object.entries(extra ?? {})) {
    await fs.writeFile(path.join(dir, rel), contents);
  }
}

const readInstalled = (skill: string, rel: string) => fs.readFile(path.join(installedDir(skill), rel), "utf-8");

console.log("Installed skill refresh\n");

await check("a fresh install copies the skill and leaves the manifest behind", async () => {
  await fs.rm(installedDir("demo"), { recursive: true, force: true });
  const result = await store.installBundledSkill("none", "demo");
  assert.equal(result.success, true);
  assert.equal(await readInstalled("demo", "SKILL.md"), NEW_BODY);
  await assert.rejects(() => readInstalled("demo", ".vintages"), "the manifest describes the bundle, not the skill");
});

await check("an untouched older copy is brought up to the shipped version", async () => {
  await seedInstalled("demo", OLD_BODY);
  const result = await store.installBundledSkill("none", "demo");
  assert.equal(result.success, false, "still a reuse rather than an install");
  assert.equal((result as { code: number }).code, 409);
  assert.equal((result as { refreshed?: boolean }).refreshed, true);
  assert.equal(await readInstalled("demo", "SKILL.md"), NEW_BODY);
  assert.equal(await readInstalled("demo", "references/guide.md"), "shipped guide\n", "supporting files follow");
});

await check("a copy the user edited is left exactly as it is", async () => {
  const edited = OLD_BODY + "\nMy own rule: always answer in Portuguese.\n";
  await seedInstalled("demo", edited);
  const result = await store.installBundledSkill("none", "demo");
  assert.equal((result as { refreshed?: boolean }).refreshed, false);
  assert.equal(await readInstalled("demo", "SKILL.md"), edited);
  assert.equal(await readInstalled("demo", "references/guide.md"), "old guide\n", "nothing else is touched either");
});

await check("files the user added to the directory survive a refresh", async () => {
  await seedInstalled("demo", OLD_BODY, { "notes.md": "my notes\n" });
  await store.installBundledSkill("none", "demo");
  assert.equal(await readInstalled("demo", "SKILL.md"), NEW_BODY);
  assert.equal(await readInstalled("demo", "notes.md"), "my notes\n");
});

await check("an already-current copy is reported as reuse, not as a refresh", async () => {
  await seedInstalled("demo", NEW_BODY);
  const result = await store.installBundledSkill("none", "demo");
  assert.equal((result as { refreshed?: boolean }).refreshed, false);
});

await check("a skill that ships no manifest is never overwritten", async () => {
  await seedInstalled("unmanaged", OLD_BODY);
  const result = await store.installBundledSkill("none", "unmanaged");
  assert.equal((result as { refreshed?: boolean }).refreshed, false);
  assert.equal(await readInstalled("unmanaged", "SKILL.md"), OLD_BODY);
});

await check("launching a card refreshes the copy it reuses", async () => {
  // An explicit scope, because a card with no target of its own opens a new
  // project and installs there - a different directory from the one seeded here.
  await seedInstalled("demo", OLD_BODY);
  const result = await store.launchBundledSkill("demo", "none", "en");
  assert.equal(result.success, true, "a reused skill still launches");
  assert.equal(await readInstalled("demo", "SKILL.md"), NEW_BODY);
});

console.log(`\n${ran} checks, ${failed} failed`);
await fs.rm(workDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
