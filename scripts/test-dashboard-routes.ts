/**
 * Checks that a chat's address is a chat's address and nothing else.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-dashboard-routes.ts
 *

 * A conversation lives at `/dashboard/<chatId>`, beside the dashboard's own
 * pages rather than under a prefix of its own. Next keeps a page from being
 * read as a chat - a static segment always beats a dynamic one - but only for
 * directories that have a page. `pipeline-runs` has none of its own, only
 * `[id]` underneath, so it has nothing to win with and would fall through to
 * the chat route and quietly become a conversation named after it. The route
 * refuses the names on the list; the list is checked against the folder here,
 * because forgetting to add one breaks nothing loudly.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESERVED_DASHBOARD_SEGMENTS,
  chatPath,
  isReservedDashboardSegment,
} from "../src/lib/dashboard-routes.ts";

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

const dashboardDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "app",
  "dashboard"
);

/**
 * The URL segments that actually exist directly under /dashboard.
 *
 * A `(group)` adds no segment of its own, so its children are siblings of
 * everything else here and have to be looked at too; a `[param]` is the chat
 * route and is what the list exists to be distinguished from.
 */
function urlSegmentsUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("(") && entry.name.endsWith(")")) {
      found.push(...urlSegmentsUnder(path.join(dir, entry.name)));
      continue;
    }
    if (entry.name.startsWith("[")) continue;
    found.push(entry.name);
  }
  return found;
}

console.log("Addresses on the dashboard\n");

check("the reserved list is exactly the pages that exist", () => {
  const onDisk = [...new Set(urlSegmentsUnder(dashboardDir))].sort();
  const declared = [...RESERVED_DASHBOARD_SEGMENTS].sort();
  assert.deepEqual(
    declared,
    onDisk,
    `add the new page to RESERVED_DASHBOARD_SEGMENTS in src/lib/dashboard-routes.ts:\n` +
      `  on disk : ${onDisk.join(", ")}\n  declared: ${declared.join(", ")}`
  );
});

check("a chat has an address, and no chat is the bare dashboard", () => {
  assert.equal(chatPath(null), "/dashboard");
  assert.equal(chatPath(undefined), "/dashboard");
  assert.equal(chatPath(""), "/dashboard");
  assert.equal(
    chatPath("3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
    "/dashboard/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"
  );
});

check("every dashboard name is refused as a chat id", () => {
  for (const segment of RESERVED_DASHBOARD_SEGMENTS) {
    assert.equal(isReservedDashboardSegment(segment), true, `should be reserved: ${segment}`);
  }
});

check("a chat id is not mistaken for a dashboard name", () => {
  for (const id of [
    "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    "settings-2",
    "my-projects",
    "",
  ]) {
    assert.equal(isReservedDashboardSegment(id), false, `should not be reserved: ${id}`);
  }
});

check("an id that needs escaping stays one segment", () => {
  for (const id of ["a b", "a/b", "a?b", "a#b", "чат"]) {
    const encoded = chatPath(id).slice("/dashboard/".length);
    assert.ok(!encoded.includes("/"), `must stay one segment: ${id}`);
    assert.equal(decodeURIComponent(encoded), id, `must decode back: ${id}`);
  }
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
