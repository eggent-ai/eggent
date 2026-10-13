// npm run test:web-search-defaults
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureWebSearchDefaults,
  isEggentRoute,
  planWebSearchConfig,
  routeForVersion,
} from "./web-search-defaults.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const FULL = ["transient", "quota", "network", "invalid-response", "unsupported"];
const SHORT = ["transient", "quota", "network", "invalid-response"];
const ROUTE = ["parallel-mcp", "duckduckgo", "exa"];

check("no route below 0.24.0, where parallel-mcp does not exist", () => {
  for (const v of ["0.13.0", "0.22.0", "0.23.9", "garbage", undefined]) assert.equal(routeForVersion(v), null, v);
});

check("0.24.x gets the route without the kind it rejects", () => {
  for (const v of ["0.24.0", "0.24.2"]) assert.deepEqual(routeForVersion(v), { providers: ROUTE, fallbackOn: SHORT });
});

check("0.25.0 and later get every kind", () => {
  for (const v of ["0.25.0", "0.35.0", "1.0.0"]) assert.deepEqual(routeForVersion(v), { providers: ROUTE, fallbackOn: FULL });
});

check("a fresh workspace gets the route and keeps what was there", () => {
  assert.deepEqual(planWebSearchConfig({ current: undefined, version: "0.35.0" }), {
    searchRouting: { providers: ROUTE, fallbackOn: FULL },
  });
  assert.deepEqual(planWebSearchConfig({ current: { workflow: "none" }, version: "0.35.0" }), {
    workflow: "none",
    searchRouting: { providers: ROUTE, fallbackOn: FULL },
  });
});

check("nothing to do when the route is already right", () => {
  const current = { workflow: "none", searchRouting: { providers: ROUTE, fallbackOn: FULL } };
  assert.equal(planWebSearchConfig({ current, version: "0.35.0" }), null);
});

check("an upgrade rewrites Eggent's route, a downgrade removes it", () => {
  const short = { searchRouting: { providers: ROUTE, fallbackOn: SHORT } };
  assert.deepEqual(planWebSearchConfig({ current: short, version: "0.30.0" }).searchRouting.fallbackOn, FULL);
  const full = { workflow: "none", searchRouting: { providers: ROUTE, fallbackOn: FULL } };
  assert.deepEqual(planWebSearchConfig({ current: full, version: "0.24.1" }).searchRouting.fallbackOn, SHORT);
  assert.deepEqual(planWebSearchConfig({ current: full, version: "0.22.0" }), { workflow: "none" });
  assert.equal(planWebSearchConfig({ current: { workflow: "none" }, version: "0.22.0" }), null);
});

check("a search somebody configured is left alone", () => {
  const theirs = [
    { braveApiKey: "x" },
    { exaApiKey: "$EXA" },
    { searxngBaseUrl: "https://search.example.test" },
    { provider: "brave" },
    { searchProvider: "exa" },
    { webSearch: { allowedProviders: ["exa"] } },
    { geminiAuth: "adc" },
    { searchRouting: { providers: ["brave", "exa"], fallbackOn: ["quota"] } },
    { searchRouting: { providers: ROUTE, fallbackOn: FULL, useCurrentModel: true } },
  ];
  for (const current of theirs) assert.equal(planWebSearchConfig({ current, version: "0.35.0" }), null, JSON.stringify(current));
  assert.equal(planWebSearchConfig({ current: undefined, version: "0.35.0", env: { TAVILY_API_KEY: "t" } }), null);
  assert.notEqual(planWebSearchConfig({ current: undefined, version: "0.35.0", env: { TAVILY_API_KEY: " " } }), null);
});

check("a file that is not an object is not touched", () => {
  for (const current of [null, [], "x", 3]) assert.equal(planWebSearchConfig({ current, version: "0.35.0" }), null);
});

check("only Eggent's exact routes count as Eggent's", () => {
  assert.equal(isEggentRoute({ providers: ROUTE, fallbackOn: FULL }), true);
  assert.equal(isEggentRoute({ providers: ROUTE, fallbackOn: SHORT }), true);
  assert.equal(isEggentRoute({ providers: ["exa", "duckduckgo"], fallbackOn: FULL }), false);
  assert.equal(isEggentRoute({ providers: ["exa", "parallel-mcp", "duckduckgo"], fallbackOn: FULL }), false);
  assert.equal(isEggentRoute({ providers: ROUTE, fallbackOn: ["quota"] }), false);
});

function workspace(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-wsd-"));
  if (version) {
    const pkg = path.join(dir, "npm", "node_modules", "pi-web-access");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "pi-web-access", version }));
  }
  return dir;
}
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "web-search.json"), "utf-8"));
const quiet = (fn) => { const log = console.log; console.log = () => {}; try { fn(); } finally { console.log = log; } };

check("the file is written for an installed extension and kept on a second run", () => {
  const dir = workspace("0.35.0");
  fs.writeFileSync(path.join(dir, "web-search.json"), JSON.stringify({ workflow: "none" }));
  quiet(() => ensureWebSearchDefaults(dir, {}));
  assert.deepEqual(read(dir), { workflow: "none", searchRouting: { providers: ROUTE, fallbackOn: FULL } });
  const before = fs.statSync(path.join(dir, "web-search.json")).mtimeMs;
  quiet(() => ensureWebSearchDefaults(dir, {}));
  assert.equal(fs.statSync(path.join(dir, "web-search.json")).mtimeMs, before);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
});

check("no extension installed, or an unreadable file: nothing written", () => {
  const none = workspace(undefined);
  quiet(() => ensureWebSearchDefaults(none, {}));
  assert.equal(fs.existsSync(path.join(none, "web-search.json")), false);
  const broken = workspace("0.35.0");
  fs.writeFileSync(path.join(broken, "web-search.json"), "{not json");
  quiet(() => ensureWebSearchDefaults(broken, {}));
  assert.equal(fs.readFileSync(path.join(broken, "web-search.json"), "utf-8"), "{not json");
});

console.log(`\n${passed} checks passed`);
