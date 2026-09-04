/**
 * Checks the rules that decide what an upload is allowed to do.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-file-upload.ts
 *
 * The upload route itself needs a request, a project, and a disk to write to.
 * Everything it decides before touching any of them - how large a request may
 * be, where a name is allowed to land, and what happens when the name is
 * already taken - is decided here, where it can be tested without any of them.
 *
 * The browser's half of the same upload - which folders a picked tree implies,
 * and how many requests it has to become - is decided in upload-plan.ts, and is
 * checked here too.
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
import {
  MAX_FILES_PER_BATCH,
  collectParentDirectories,
  planUploadBatches,
} from "../src/lib/files/upload-plan.ts";

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

// A picked folder arrives as paths and nothing else, so the folders it needs
// have to be read back out of them - every level, not just the last one.
assert.deepEqual(collectParentDirectories(["report.md"]), []);
assert.deepEqual(
  collectParentDirectories(["docs/a/notes.md", "docs/b.md", "docs/a/deep/c.md"]),
  ["docs", "docs/a", "docs/a/deep"]
);

// A folder that fits stays one request; the batches exist to bound a request,
// not to split what needs no splitting.
const sized = (...sizes: number[]) => sizes.map((size, index) => ({ name: `f${index}`, size }));
const sizeOf = (item: { size: number }) => item.size;

assert.equal(planUploadBatches(sized(1, 2, 3), sizeOf, 10 * 1024 * 1024).length, 1);
assert.deepEqual(planUploadBatches([], sizeOf, 1024), []);

// A folder larger than one request becomes several, each of them under budget.
const budget = 1000;
const batches = planUploadBatches(sized(400, 400, 400, 400), (item) => item.size, budget + 4 * 512);
assert.ok(batches.length > 1);
for (const batch of batches) {
  const weight = batch.reduce((sum, item) => sum + item.size + 512, 0);
  assert.ok(weight <= budget + 4 * 512, `batch of ${weight} bytes exceeds the budget`);
}
assert.equal(batches.flat().length, 4);

// Small files cost nothing to send and still cost a part each to parse, so the
// count is capped as well as the weight.
const many = planUploadBatches(sized(...new Array(MAX_FILES_PER_BATCH * 2 + 1).fill(1)), sizeOf, Infinity);
assert.equal(many.length, 3);
assert.equal(many[0].length, MAX_FILES_PER_BATCH);
assert.equal(many[2].length, 1);

// A file too large for any batch is still sent, and refused by the route that
// can say why - rather than dropped here without a word.
assert.deepEqual(planUploadBatches(sized(5000), sizeOf, 100), [sized(5000)]);

console.log("file upload rules: all assertions passed");
