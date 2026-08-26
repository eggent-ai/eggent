/**
 * Checks the rules that decide what an upload is allowed to do.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-file-upload.ts
 *
 * The upload route itself needs a request, a project, and a disk to write to.
 * Everything it decides before touching any of them - how large a request may
 * be, where a name is allowed to land, and what happens when the name is
 * already taken - is decided here, where it can be tested without any of them.
 */
import assert from "node:assert/strict";
import path from "node:path";
import {
  DEFAULT_MAX_UPLOAD_MB,
  buildRenameCandidate,
  parseContentLength,
  resolveConflictPolicy,
  resolveMaxUploadBytes,
  resolveSafeChildPath,
  resolveUploadTarget,
  safeRelativePath,
} from "../src/lib/files/upload.ts";

function takenNames(...names: string[]) {
  const taken = new Set(names);
  return async (candidate: string) => taken.has(candidate);
}

// The limit falls back to a bounded default, so an install that sets nothing
// is still protected from a request large enough to exhaust its memory.
assert.equal(resolveMaxUploadBytes(undefined), DEFAULT_MAX_UPLOAD_MB * 1024 * 1024);
assert.equal(resolveMaxUploadBytes(""), DEFAULT_MAX_UPLOAD_MB * 1024 * 1024);
assert.equal(resolveMaxUploadBytes("25"), 25 * 1024 * 1024);
assert.equal(resolveMaxUploadBytes(" 12.5 "), 12.5 * 1024 * 1024);

// Nonsense must not silently disable the limit; only an explicit zero does.
assert.equal(resolveMaxUploadBytes("abc"), DEFAULT_MAX_UPLOAD_MB * 1024 * 1024);
assert.equal(resolveMaxUploadBytes("-5"), DEFAULT_MAX_UPLOAD_MB * 1024 * 1024);
assert.equal(resolveMaxUploadBytes("0"), Number.POSITIVE_INFINITY);

assert.equal(parseContentLength("1024"), 1024);
assert.equal(parseContentLength(null), null);
assert.equal(parseContentLength("not-a-number"), null);
assert.equal(parseContentLength("-1"), null);

// An unknown policy behaves like the old route did: it refuses to overwrite.
assert.equal(resolveConflictPolicy(undefined), "skip");
assert.equal(resolveConflictPolicy(""), "skip");
assert.equal(resolveConflictPolicy("nonsense"), "skip");
assert.equal(resolveConflictPolicy("skip"), "skip");
assert.equal(resolveConflictPolicy("overwrite"), "overwrite");
assert.equal(resolveConflictPolicy("OVERWRITE"), "overwrite");
assert.equal(resolveConflictPolicy("rename"), "rename");

assert.equal(safeRelativePath("notes.md"), "notes.md");
assert.equal(safeRelativePath("docs/notes.md"), "docs/notes.md");
assert.equal(safeRelativePath("docs\\notes.md"), "docs/notes.md");
assert.equal(safeRelativePath(" docs / notes.md "), "docs/notes.md");
assert.equal(safeRelativePath(""), null);
assert.equal(safeRelativePath("   "), null);
assert.equal(safeRelativePath("../secrets.env"), null);
assert.equal(safeRelativePath("docs/../../secrets.env"), null);
assert.equal(safeRelativePath("/etc/passwd"), null);
assert.equal(safeRelativePath("docs/./notes.md"), null);

const root = path.resolve("/tmp/eggent-upload-root");
assert.equal(resolveSafeChildPath(root, "docs/notes.md"), path.join(root, "docs", "notes.md"));
assert.throws(() => resolveSafeChildPath(root, "../escape.md"), /Invalid child path/);

// A rename keeps the extension, so a copy of a spreadsheet is still openable.
assert.equal(buildRenameCandidate("notes.md", 1), "notes (1).md");
assert.equal(buildRenameCandidate("notes.md", 2), "notes (2).md");
assert.equal(buildRenameCandidate("archive.tar.gz", 1), "archive.tar (1).gz");
assert.equal(buildRenameCandidate("README", 1), "README (1)");
// A dotfile is all name and no extension, however much it looks like one.
assert.equal(buildRenameCandidate(".env", 1), ".env (1)");
assert.equal(buildRenameCandidate("docs/notes.md", 1), "docs/notes (1).md");

// A free name is written under any policy, without a detour through renaming.
for (const policy of ["skip", "overwrite", "rename"] as const) {
  assert.deepEqual(await resolveUploadTarget("notes.md", policy, takenNames()), {
    relativePath: "notes.md",
    overwrite: false,
  });
}

// Skipping is the old behaviour: the file on disk wins and nothing is written.
assert.equal(await resolveUploadTarget("notes.md", "skip", takenNames("notes.md")), null);

assert.deepEqual(await resolveUploadTarget("notes.md", "overwrite", takenNames("notes.md")), {
  relativePath: "notes.md",
  overwrite: true,
});

// Renaming keeps looking until it finds a name nobody is using.
assert.deepEqual(await resolveUploadTarget("notes.md", "rename", takenNames("notes.md")), {
  relativePath: "notes (1).md",
  overwrite: false,
});
assert.deepEqual(
  await resolveUploadTarget("notes.md", "rename", takenNames("notes.md", "notes (1).md", "notes (2).md")),
  { relativePath: "notes (3).md", overwrite: false }
);
assert.deepEqual(await resolveUploadTarget("docs/notes.md", "rename", takenNames("docs/notes.md")), {
  relativePath: "docs/notes (1).md",
  overwrite: false,
});

// A directory full of collisions gives up rather than looping forever.
const everythingTaken = async () => true;
assert.equal(await resolveUploadTarget("notes.md", "rename", everythingTaken), null);

console.log("file upload rules: all assertions passed");
