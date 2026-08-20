/**
 * Resolves the "@/" path alias for scripts run straight from source.
 *
 * The test scripts import from src/ with the same alias the app uses, and Node
 * has no notion of tsconfig paths. A test may also replace a module with a stub
 * from scripts/stubs by naming it in EGGENT_TEST_STUBS, so a test of one module
 * does not have to load the half of the app that module happens to import.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scriptsDir = import.meta.dirname;
const srcDir = path.resolve(scriptsDir, "..", "src");
const stubs = new Set((process.env.EGGENT_TEST_STUBS || "").split(",").map((item) => item.trim()).filter(Boolean));

function firstExisting(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const relative = specifier.slice(2);
    if (stubs.has(relative)) {
      const stub = firstExisting(path.join(scriptsDir, "stubs", path.basename(relative)));
      if (stub) return { url: pathToFileURL(stub).href, shortCircuit: true };
    }
    const resolved = firstExisting(path.join(srcDir, relative));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
