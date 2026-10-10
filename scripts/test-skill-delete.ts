/**
 * Checks that a skill can be deleted from the Skills page, and that deleting
 * touches nothing but that skill.
 *
 * Run with Node 22:
 *   EGGENT_TEST_STUBS=i18n/server node --experimental-strip-types \
 *     --import ./scripts/alias-loader-register.mjs scripts/test-skill-delete.ts
 *
 * What has to hold, because each is a way for a delete to do harm:
 *
 *   - the route answers nobody without a session of this site, and a page on a
 *     sibling workspace cannot delete with the cookie the browser attaches;
 *   - a name is a path, so one that is not a skill's name - `../notes`, a slash,
 *     a dot - removes nothing, from the page or from the agent's own tool, which
 *     used to accept it;
 *   - what goes is the skill: its folder with everything in it, every copy an
 *     older layout left, and the earlier versions a replacement put aside - and
 *     not the neighbours, nor another skill's earlier versions that merely
 *     share the start of its name;
 *   - after a delete the name is free again, which is what the Replace button's
 *     missing sibling was for.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "eggent-skill-delete-"));
process.chdir(workDir);
process.env.EGGENT_AUTH_SECRET = "skill-delete-test-secret-0123456789abcdef";
const projectsDir = path.join(workDir, "data", "projects");
await fs.mkdir(projectsDir, { recursive: true });

const { installUploadedSkill, REPLACED_DIRNAME } = await import("../src/lib/skills/upload-install.ts");
const store = await import("../src/lib/storage/project-store.ts");
const { AUTH_COOKIE_NAME, createSessionToken } = await import("../src/lib/auth/session.ts");
const skillsRoute = await import("../src/app/api/projects/[id]/skills/route.ts");
const uploadRoute = await import("../src/app/api/projects/[id]/skills/upload/route.ts");
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

const header = (name: string, description = "Does a thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSteps.\n`;
const skillsOf = (scope: string) => store.getProjectSkillsDir(scope);
const exists = (target: string) => fs.stat(target).then(() => true, () => false);
const list = async (dir: string) => (await fs.readdir(dir).catch(() => [])).sort();

async function install(scope: string, name: string, extraFiles: Record<string, string> = {}, replace = false) {
  const files = [{ path: "SKILL.md", data: Buffer.from(header(name)), executable: false }];
  for (const [file, text] of Object.entries(extraFiles)) files.push({ path: file, data: Buffer.from(text), executable: false });
  const result = await installUploadedSkill(scope, { name, description: "Does a thing.", files, directories: [], notes: [] }, { replace });
  assert.ok(result.ok, `could not set up ${name}: ${JSON.stringify(result)}`);
}

await store.createProject({ id: "demo", name: "Demo", description: "", instructions: "# Demo\n", memoryMode: "global" });
// Things a hostile name would have to reach, and must not.
await fs.mkdir(path.join(projectsDir, "precious"), { recursive: true });
await fs.writeFile(path.join(projectsDir, "precious", "keep.txt"), "keep\n");
await fs.writeFile(path.join(projectsDir, "demo", "precious.txt"), "keep\n");

// --- The route's requests ------------------------------------------------------

const ORIGIN = "https://workspace.example.test";
const session = await createSessionToken("owner@example.test", false);
const defaultLoginSession = await createSessionToken("admin", true);

interface Options {
  cookie?: string | null;
  origin?: string | null;
  site?: string;
  contentType?: string | null;
  raw?: string;
}
function deleteRequest(projectId: string, body: unknown, options: Options = {}) {
  const headers = new Headers();
  const cookie = options.cookie === undefined ? session : options.cookie;
  if (cookie) headers.set("cookie", `${AUTH_COOKIE_NAME}=${cookie}`);
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.set("origin", origin);
  headers.set("host", new URL(ORIGIN).host);
  if (options.site) headers.set("sec-fetch-site", options.site);
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  if (contentType) headers.set("content-type", contentType);
  return new NextRequest(`${ORIGIN}/api/projects/${projectId}/skills`, {
    method: "DELETE",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
async function del(projectId: string, name: unknown, options: Options = {}) {
  const response = await skillsRoute.DELETE(deleteRequest(projectId, { name }, options), params(projectId));
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, payload };
}
async function upload(projectId: string, fileName: string, data: string, replace = false) {
  const headers = new Headers();
  headers.set("cookie", `${AUTH_COOKIE_NAME}=${session}`);
  headers.set("origin", ORIGIN);
  headers.set("host", new URL(ORIGIN).host);
  const form = new FormData();
  form.set("file", new File([data], fileName));
  if (replace) form.set("replace", "1");
  const response = await uploadRoute.POST(
    new NextRequest(`${ORIGIN}/api/projects/${projectId}/skills/upload`, { method: "POST", headers, body: form }),
    params(projectId)
  );
  return { response, payload: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}
async function listed(projectId: string): Promise<string[]> {
  const response = await skillsRoute.GET(new NextRequest(`${ORIGIN}/api/projects/${projectId}/skills`), params(projectId));
  return ((await response.json()) as Array<{ name: string }>).map((skill) => skill.name).sort();
}

// --- Who may delete -------------------------------------------------------------
console.log("\nwho may delete:");

await install("demo", "guarded", { "scripts/run.sh": "echo hi\n" });

await check("no session, a forged one, or the default login: refused, and the skill is still there", async () => {
  assert.equal((await del("demo", "guarded", { cookie: null })).response.status, 401);
  assert.equal((await del("demo", "guarded", { cookie: "forged.value" })).response.status, 401);
  assert.equal((await del("demo", "guarded", { cookie: defaultLoginSession })).response.status, 401);
  assert.ok(await exists(path.join(skillsOf("demo"), "guarded", "scripts", "run.sh")));
});

await check("a page on another site cannot delete with the cookie the browser attaches", async () => {
  for (const origin of ["https://evil.example.test", "https://other-workspace.example.test", "null"]) {
    assert.equal((await del("demo", "guarded", { origin })).response.status, 403, origin);
  }
  assert.equal((await del("demo", "guarded", { site: "same-site" })).response.status, 403);
  assert.equal((await del("demo", "guarded", { site: "cross-site" })).response.status, 403);
  assert.ok(await exists(path.join(skillsOf("demo"), "guarded")));
});

await check("a body that is not JSON is refused", async () => {
  const { response } = await del("demo", "guarded", { contentType: "text/plain" });
  assert.equal(response.status, 415);
  assert.ok(await exists(path.join(skillsOf("demo"), "guarded")));
});

// --- What a name may be ------------------------------------------------------------
console.log("\nwhat a name may be:");

await check("a request with no name, or a body that is not an object, is a 400", async () => {
  assert.equal((await del("demo", undefined)).response.status, 400);
  assert.equal((await del("demo", "   ")).response.status, 400);
  assert.equal((await del("demo", 42)).response.status, 400);
  const garbled = await skillsRoute.DELETE(deleteRequest("demo", null, { raw: "{not json" }), params("demo"));
  assert.equal(garbled.status, 400);
  assert.ok(await exists(path.join(skillsOf("demo"), "guarded")));
});

await check("a name that is a path removes nothing, whatever it points at", async () => {
  for (const name of ["../precious", "../../precious", "..", ".", "a/b", "../skills", ".replaced", "guarded/scripts", "has space", "-lead", "trail-", "a--b", "x\u0000y"]) {
    const { response, payload } = await del("demo", name);
    assert.equal(response.status, 400, `${JSON.stringify(name)} -> ${response.status}`);
    assert.equal(payload?.code, "invalidName");
  }
  assert.ok(await exists(path.join(projectsDir, "precious", "keep.txt")));
  assert.ok(await exists(path.join(projectsDir, "demo", "precious.txt")));
  assert.ok(await exists(path.join(skillsOf("demo"), "guarded", "SKILL.md")));
});

await check("the agent's own delete tool had the same hole and has been closed", async () => {
  for (const name of ["../../precious", "../precious", "/etc"]) {
    const result = await store.deleteSkill("demo", name);
    assert.ok(!result.success && result.code === "invalid-name", name);
  }
  assert.ok(await exists(path.join(projectsDir, "precious", "keep.txt")));
  assert.ok(await exists(path.join(projectsDir, "demo", "precious.txt")));
});

await check("a skill that is not there, or a project that is not, is a 404", async () => {
  const gone = await del("demo", "never-installed");
  assert.equal(gone.response.status, 404);
  assert.equal(gone.payload?.code, "notFound");
  assert.match(String(gone.payload?.error), /never-installed/);
  const noProject = await del("no-such-project", "guarded");
  assert.equal(noProject.response.status, 404);
  for (const id of ["../precious", "..", "skills"]) assert.equal((await del(id, "guarded")).response.status, 404, id);
  assert.ok(await exists(path.join(projectsDir, "precious", "keep.txt")));
});

// --- What goes ------------------------------------------------------------------------
console.log("\nwhat goes:");

await check("the skill goes with everything in it; the one beside it stays", async () => {
  await install("demo", "doomed", {
    "scripts/run.sh": "echo hi\n",
    "references/deep/guide.md": "guide\n",
    "assets/data.json": "{}\n",
  });
  await install("demo", "survivor", { "references/a.md": "a\n" });
  assert.deepEqual(await listed("demo"), ["doomed", "guarded", "survivor"]);

  const { response, payload } = await del("demo", "doomed");
  assert.equal(response.status, 200);
  assert.equal(payload?.ok, true);
  assert.equal(payload?.skill, "doomed");
  assert.equal(payload?.versionsRemoved, 0);
  assert.equal(await exists(path.join(skillsOf("demo"), "doomed")), false);
  assert.deepEqual(await listed("demo"), ["guarded", "survivor"]);
  assert.equal(await fs.readFile(path.join(skillsOf("demo"), "survivor", "references", "a.md"), "utf-8"), "a\n");
});

await check("deleting the same skill again is a 404, not a second success", async () => {
  assert.equal((await del("demo", "doomed")).response.status, 404);
});

await check("a read-only file inside does not stop it", async () => {
  await install("demo", "locked-file", { "references/ro.md": "x\n" });
  await fs.chmod(path.join(skillsOf("demo"), "locked-file", "references", "ro.md"), 0o444);
  assert.equal((await del("demo", "locked-file")).response.status, 200);
  assert.equal(await exists(path.join(skillsOf("demo"), "locked-file")), false);
});

if (typeof process.getuid === "function" && process.getuid() === 0) {
  skip("a folder that cannot be emptied is a failure, and is said to be", "running as root, where permissions do not apply");
} else {
  await check("a folder that cannot be emptied is a failure, and is said to be", async () => {
    await install("demo", "stuck-one", { "references/a.md": "a\n" });
    const inner = path.join(skillsOf("demo"), "stuck-one", "references");
    await fs.chmod(inner, 0o555);
    const originalError = console.error;
    console.error = () => {};
    const { response, payload } = await del("demo", "stuck-one").finally(() => {
      console.error = originalError;
    });
    await fs.chmod(inner, 0o755);
    assert.equal(response.status, 500);
    assert.equal(payload?.code, "failed");
    assert.equal(payload?.ok, false);
    await fs.rm(path.join(skillsOf("demo"), "stuck-one"), { recursive: true, force: true });
  });
}

await check("the orchestrator's skills are addressed as none", async () => {
  await install("none", "orch-one", { "scripts/x.sh": "x\n" });
  assert.deepEqual(await list(path.join(projectsDir, "skills")), ["orch-one"]);
  assert.equal((await del("none", "orch-one")).response.status, 200);
  assert.deepEqual(await list(path.join(projectsDir, "skills")), []);
});

await check("every copy goes, including one an older layout left in .meta", async () => {
  await store.createProject({ id: "twice", name: "Twice", description: "", instructions: "# T\n", memoryMode: "global" });
  await install("twice", "dup-skill");
  const legacy = path.join(projectsDir, "twice", ".meta", "skills", "dup-skill");
  await fs.mkdir(legacy, { recursive: true });
  await fs.writeFile(path.join(legacy, "SKILL.md"), header("dup-skill", "The old copy."));
  assert.equal((await del("twice", "dup-skill")).response.status, 200);
  assert.equal(await exists(path.join(skillsOf("twice"), "dup-skill")), false);
  assert.equal(await exists(legacy), false);
  assert.deepEqual(await listed("twice"), [], "no second copy shows up where the first was");
});

await check("a folder written by hand with capitals is deleted as the list names it", async () => {
  const dir = path.join(skillsOf("demo"), "Hand-Made");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), header("hand-made"));
  assert.ok((await listed("demo")).includes("Hand-Made"));
  assert.equal((await del("demo", "Hand-Made")).response.status, 200);
  assert.equal(await exists(dir), false);
  assert.ok(!(await listed("demo")).includes("Hand-Made"));
});

// --- The earlier versions --------------------------------------------------------------
console.log("\nthe earlier versions a replacement kept:");

await check("deleting a skill clears the versions that were put aside for it, and only those", async () => {
  // `notes` and `notes-20261010` are two skills, and the second's tail looks like a date.
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  await install("demo", "notes");
  await install("demo", "notes", { "references/new.md": "new\n" }, true);
  await install("demo", "notes", { "references/newer.md": "newer\n" }, true);
  await install("demo", "notes-20261010");
  await install("demo", "notes-20261010", { "references/new.md": "new\n" }, true);
  await install("demo", "other");
  await install("demo", "other", { "references/new.md": "new\n" }, true);

  const kept = path.join(skillsOf("demo"), REPLACED_DIRNAME);
  assert.deepEqual(
    await list(kept),
    [`notes-${day}`, `notes-${day}-1`, `notes-20261010-${day}`, `other-${day}`].sort(),
    "what the replacements put aside"
  );

  const { response, payload } = await del("demo", "notes");
  assert.equal(response.status, 200);
  assert.equal(payload?.versionsRemoved, 2);
  assert.deepEqual(await list(kept), [`notes-20261010-${day}`, `other-${day}`].sort(), "the other skills' versions are not this skill's");

  assert.equal((await del("demo", "notes-20261010")).payload?.versionsRemoved, 1);
  assert.deepEqual(await list(kept), [`other-${day}`]);
});

await check("what was set aside is never taken for a skill", async () => {
  const names = await listed("demo");
  assert.ok(!names.includes(REPLACED_DIRNAME) && !names.some((name) => name.startsWith(".")), names.join(", "));
});

// --- Round trip ---------------------------------------------------------------------------
console.log("\nthe round trip:");

await check("upload, upload again (a conflict), delete, upload again: the name is free after a delete", async () => {
  const first = await upload("demo", "x.md", header("round-trip"));
  assert.equal(first.response.status, 201);
  const again = await upload("demo", "x.md", header("round-trip", "Second."));
  assert.equal(again.response.status, 409);
  assert.equal((await del("demo", "round-trip")).response.status, 200);
  const third = await upload("demo", "x.md", header("round-trip", "Third."));
  assert.equal(third.response.status, 201);
  assert.equal(third.payload?.replaced, false);
  assert.match(await fs.readFile(path.join(skillsOf("demo"), "round-trip", "SKILL.md"), "utf-8"), /Third\./);
});

await check("the folder the versions were kept in goes when the last of them does", async () => {
  await store.createProject({ id: "tidy", name: "Tidy", description: "", instructions: "# T\n", memoryMode: "global" });
  await install("tidy", "solo");
  await install("tidy", "solo", { "references/new.md": "new\n" }, true);
  assert.equal(await exists(path.join(skillsOf("tidy"), REPLACED_DIRNAME)), true);
  assert.equal((await del("tidy", "solo")).payload?.versionsRemoved, 1);
  assert.equal(await exists(path.join(skillsOf("tidy"), REPLACED_DIRNAME)), false);
  assert.deepEqual(await list(skillsOf("tidy")), []);
});

await check("replacing and then deleting leaves nothing of the skill anywhere", async () => {
  await upload("demo", "x.md", header("tidy-one"));
  const replaced = await upload("demo", "x.md", header("tidy-one", "New."), true);
  assert.equal(replaced.response.status, 201);
  assert.equal((await del("demo", "tidy-one")).payload?.versionsRemoved, 1);
  const leftovers = (await list(path.join(skillsOf("demo"), REPLACED_DIRNAME))).filter((name) => name.startsWith("tidy-one"));
  assert.deepEqual(leftovers, []);
  assert.equal(await exists(path.join(skillsOf("demo"), "tidy-one")), false);
});

console.log(`\n${ran} checks, ${failed} failed`);
await fs.rm(workDir, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
