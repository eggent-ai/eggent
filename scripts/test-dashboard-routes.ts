/**
 * Checks that a chat's address is a chat's address and nothing else, and that
 * a settings tab's address says whose settings it shows.
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
 *
 * The settings tabs that exist once for the orchestrator and once per project
 * carry the choice in `?project=`, and a project's old pages send their links
 * there. Getting either wrong shows one project's files under another's name.
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
import {
  ORCHESTRATOR_SCOPE_ID,
  SCOPE_PARAM,
  projectIdFromPath,
  resolveSettingsScope,
  settingsScopeHref,
} from "../src/lib/orchestrator-scope.ts";

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
  for (const id of ["a b", "a/b", "a?b", "a#b", "café"]) {
    const encoded = chatPath(id).slice("/dashboard/".length);
    assert.ok(!encoded.includes("/"), `must stay one segment: ${id}`);
    assert.equal(decodeURIComponent(encoded), id, `must decode back: ${id}`);
  }
});

const loaded = { projectIds: ["alpha", "bravo"], projectsLoaded: true };

check("a settings tab follows the address, then the open project, then the orchestrator", () => {
  assert.deepEqual(
    resolveSettingsScope({ ...loaded, requested: "alpha", activeProjectId: "bravo" }),
    { scopeId: "alpha", stale: false }
  );
  assert.deepEqual(
    resolveSettingsScope({ ...loaded, requested: null, activeProjectId: "bravo" }),
    { scopeId: "bravo", stale: false }
  );
  assert.deepEqual(
    resolveSettingsScope({ ...loaded, requested: null, activeProjectId: null }),
    { scopeId: ORCHESTRATOR_SCOPE_ID, stale: false }
  );
  // Choosing the orchestrator on purpose has to survive being inside a project.
  assert.deepEqual(
    resolveSettingsScope({ ...loaded, requested: ORCHESTRATOR_SCOPE_ID, activeProjectId: "bravo" }),
    { scopeId: ORCHESTRATOR_SCOPE_ID, stale: false }
  );
  assert.deepEqual(
    resolveSettingsScope({ ...loaded, requested: "  ", activeProjectId: "bravo" }),
    { scopeId: "bravo", stale: false }
  );
});

check("a deleted project falls back to the orchestrator, but only once the list is known", () => {
  // Before the list arrives nothing is known to be gone; bouncing here is the
  // race that once sent people from a project's link to the orchestrator.
  assert.deepEqual(
    resolveSettingsScope({ projectIds: [], projectsLoaded: false, requested: "charlie", activeProjectId: null }),
    { scopeId: "charlie", stale: false }
  );
  assert.deepEqual(
    resolveSettingsScope({ ...loaded, requested: "charlie", activeProjectId: null }),
    { scopeId: ORCHESTRATOR_SCOPE_ID, stale: true }
  );
  assert.deepEqual(
    resolveSettingsScope({ ...loaded, requested: null, activeProjectId: "charlie" }),
    { scopeId: ORCHESTRATOR_SCOPE_ID, stale: true }
  );
  assert.deepEqual(
    resolveSettingsScope({ projectIds: [], projectsLoaded: true, requested: ORCHESTRATOR_SCOPE_ID, activeProjectId: null }),
    { scopeId: ORCHESTRATOR_SCOPE_ID, stale: false }
  );
});

check("the scope travels in the address and comes back out intact", () => {
  assert.equal(settingsScopeHref("/dashboard/context", "alpha"), `/dashboard/context?${SCOPE_PARAM}=alpha`);
  assert.equal(settingsScopeHref("/dashboard/context", ORCHESTRATOR_SCOPE_ID), `/dashboard/context?${SCOPE_PARAM}=none`);
  assert.equal(settingsScopeHref("/dashboard/context", null), "/dashboard/context");
  assert.equal(settingsScopeHref("/dashboard/context", ""), "/dashboard/context");
  for (const id of ["a b", "a&b=c", "a#b", "café"]) {
    const url = new URL(settingsScopeHref("/dashboard/memory", id), "https://dashboard.example.test");
    assert.equal(url.pathname, "/dashboard/memory", `path must survive: ${id}`);
    assert.equal(url.searchParams.get(SCOPE_PARAM), id, `must decode back: ${id}`);
  }
});

check("a project's own page counts as looking at that project", () => {
  assert.equal(projectIdFromPath("/dashboard/projects/alpha"), "alpha");
  assert.equal(projectIdFromPath("/dashboard/projects/alpha/context"), "alpha");
  assert.equal(projectIdFromPath("/dashboard/projects/caf%C3%A9"), "café");
  assert.equal(projectIdFromPath("/dashboard/projects"), null);
  assert.equal(projectIdFromPath("/dashboard/context"), null);
  assert.equal(projectIdFromPath("/dashboard/alpha"), null);
});

check("a project's old pages still answer, and send their links to the tabs", () => {
  for (const [page, tab] of [
    ["context", "/dashboard/context"],
    ["memory", "/dashboard/memory"],
    ["mcp", "/dashboard/mcp"],
    ["skills", "/dashboard/skills"],
    ["settings", "/dashboard/settings"],
  ]) {
    const file = path.join(dashboardDir, "projects", "[id]", page, "page.tsx");
    assert.ok(fs.existsSync(file), `a link to /dashboard/projects/<id>/${page} must still resolve`);
    const source = fs.readFileSync(file, "utf-8");
    assert.ok(source.includes("redirect("), `${page} should hand over to its tab`);
    assert.ok(source.includes(`"${tab}"`), `${page} should hand over to ${tab}`);
  }
});

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
