// Runs after every install (package.json "postinstall"; the Dockerfile copies
// this file in before each `npm ci`).
//
// Next 15.5 runs a Node middleware - ours is one, it reads the settings file -
// on a copy of the request body, then hands the route the original back
// through `requestData.body.finalize()`. That call is not awaited, unlike the
// edge path's, so a body that is still arriving (a long chat's history is 1-2
// MB) reaches the route already read, and `new Request` throws "Response body
// object should not be disturbed or locked": the message is lost with a 500.
// Measured on production: 7 of 60 such requests. Awaiting it is the fix.
//
// A Next that no longer carries the line stops the install instead of passing
// silently: look whether it still needs the fix, then change or drop this.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const UNPATCHED = "                    requestData.body.finalize();";
const PATCHED = "                    await requestData.body.finalize();";

export function patchNextServer(source) {
  if (source.includes(PATCHED)) return { source, changed: false };
  const count = source.split(UNPATCHED).length - 1;
  if (count !== 1) {
    throw new Error(
      `patch-next: expected one unawaited requestData.body.finalize() in next-server.js, found ${count}. ` +
        "Check whether this Next still needs scripts/patch-next.mjs.",
    );
  }
  return { source: source.replace(UNPATCHED, PATCHED), changed: true };
}

function main() {
  let file;
  try {
    file = path.join(path.dirname(require.resolve("next/package.json")), "dist/server/next-server.js");
  } catch {
    return; // next is not installed here (a partial install); nothing to patch
  }
  const { source, changed } = patchNextServer(fs.readFileSync(file, "utf8"));
  if (changed) {
    fs.writeFileSync(file, source);
    console.log("patch-next: next-server.js now awaits the middleware body hand-back");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
