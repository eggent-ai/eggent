import fs from "node:fs";
import path from "node:path";

// pi-web-access searches with Exa's keyless endpoint and, when that refuses,
// with nothing else: every other keyless engine it carries is "explicit-only"
// and is never tried on its own. Every workspace on one host reaches Exa from
// one address, and a morning job is set for the same hour by everyone, so the
// refusal arrives exactly when a scheduled brief needs the search - and the
// run reports "No search provider available". Writing an ordered route into
// the extension's own config lets it fall through to the other two keyless
// engines it already ships, which is what other agents do out of the box.
//
// Exa goes last, not first: its keyless endpoint answers a refusal with an
// empty result, which the extension classifies as "unknown", and a route
// stops at a kind it was not told to fall through - measured, half of the
// calls in a quick series. Parallel's and DuckDuckGo's refusals arrive as rate
// limits or unreadable answers, which the route passes over.
//
// The extension validates this config strictly and a value it does not know
// fails every search, not only the route, so the route is written per
// installed version: 0.24.0 is the first with all three engines, and 0.24.x
// rejects the "unsupported" kind. Below 0.24.0 nothing is written.
export const KEYLESS_ROUTE = ["parallel-mcp", "duckduckgo", "exa"];
const BASE_KINDS = ["transient", "quota", "network", "invalid-response"];

// The extension's own environment variables for search credentials. Any of
// them set means somebody chose a search engine, and a route would bypass it.
const SEARCH_ENV_KEYS = [
  "OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY", "SEARCH1API_KEY",
  "SEARCHINFINITY_API_KEY", "QUERIT_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_BASE_URL", "JINA_API_KEY",
  "SERPDIVE_API_KEY", "KAGI_API_KEY", "BOCHA_API_KEY", "OLLAMA_API_KEY", "SEARXNG_BASE_URL",
  "PERPLEXITY_API_KEY", "EXA_API_KEY", "GEMINI_API_KEY",
];

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""));
  return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(version, [major, minor, patch]) {
  for (const [have, want] of [[version[0], major], [version[1], minor], [version[2], patch]]) {
    if (have !== want) return have > want;
  }
  return true;
}

/** The route this version accepts, or null when it should carry none. */
export function routeForVersion(rawVersion) {
  const version = parseVersion(rawVersion);
  if (!version || !atLeast(version, [0, 24, 0])) return null;
  const fallbackOn = atLeast(version, [0, 25, 0]) ? [...BASE_KINDS, "unsupported"] : [...BASE_KINDS];
  return { providers: [...KEYLESS_ROUTE], fallbackOn };
}

function sameList(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((item, index) => item === b[index]);
}

/** True when this route is one Eggent wrote, so Eggent may rewrite or remove it. */
export function isEggentRoute(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) return false;
  const keys = Object.keys(route).sort();
  if (keys.length !== 2 || keys[0] !== "fallbackOn" || keys[1] !== "providers") return false;
  if (!sameList(route.providers, KEYLESS_ROUTE)) return false;
  return sameList(route.fallbackOn, BASE_KINDS) || sameList(route.fallbackOn, [...BASE_KINDS, "unsupported"]);
}

// Anything here means the search was configured by somebody: a chosen engine,
// a key, an endpoint, an allowlist. Their config is left exactly as it is.
function chosenBySomebody(config, env) {
  if (Object.hasOwn(config, "provider") || Object.hasOwn(config, "searchProvider")) return true;
  if (Object.hasOwn(config, "webSearch")) return true;
  if (Object.hasOwn(config, "searchRouting") && !isEggentRoute(config.searchRouting)) return true;
  if (Object.keys(config).some((key) => /(ApiKey|ApiToken|BaseUrl|Headers|Auth|Project)$/.test(key))) return true;
  return SEARCH_ENV_KEYS.some((name) => String(env[name] || "").trim());
}

/**
 * Decide the extension's config for this workspace. Returns the config to
 * write, or null to leave the file alone. Pure, for the test.
 */
export function planWebSearchConfig({ current, version, env = {} }) {
  if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) return null;
  const config = current ? { ...current } : {};
  if (chosenBySomebody(config, env)) return null;

  const route = routeForVersion(version);
  const ours = Object.hasOwn(config, "searchRouting");
  if (!route) {
    // An older extension came back (a restored copy, a pinned install): the
    // route it cannot read would fail every search, so ours goes.
    if (!ours) return null;
    delete config.searchRouting;
    return config;
  }
  if (ours && JSON.stringify(config.searchRouting) === JSON.stringify(route)) return null;
  config.searchRouting = route;
  return config;
}

function installedVersion(agentDir) {
  try {
    const file = path.join(agentDir, "npm", "node_modules", "pi-web-access", "package.json");
    return JSON.parse(fs.readFileSync(file, "utf-8")).version;
  } catch {
    return undefined;
  }
}

/** Apply the plan to `<agent dir>/web-search.json`. Never throws: search config must not stop a start. */
export function ensureWebSearchDefaults(agentDir, env = process.env) {
  try {
    const version = installedVersion(agentDir);
    if (!version) return;
    const file = path.join(agentDir, "web-search.json");
    let current;
    if (fs.existsSync(file)) {
      try {
        current = JSON.parse(fs.readFileSync(file, "utf-8"));
      } catch {
        // Not ours to repair: an unreadable file is left exactly as it is.
        return;
      }
    }
    const next = planWebSearchConfig({ current, version, env });
    if (!next) return;
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o644 });
    fs.renameSync(temp, file);
    console.log(next.searchRouting
      ? `Web search falls through ${next.searchRouting.providers.join(" -> ")} (pi-web-access ${version})`
      : `Removed the web search route pi-web-access ${version} cannot read`);
  } catch (error) {
    console.warn(`Could not write web search defaults: ${error instanceof Error ? error.message : String(error)}`);
  }
}
