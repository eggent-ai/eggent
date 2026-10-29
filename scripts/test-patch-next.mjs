// The Next patch: applied once, left alone when applied, loud when Next changed,
// and present in the installed copy this checkout runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { patchNextServer } from "./patch-next.mjs";

const require = createRequire(import.meta.url);
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}\n  ${error.message}`);
  }
}

const unpatched = "a\n            } finally{\n                if (hasRequestBody) {\n                    requestData.body.finalize();\n                }\n";

check("awaits the hand-back", () => {
  const { source, changed } = patchNextServer(unpatched);
  assert.equal(changed, true);
  assert.match(source, /await requestData\.body\.finalize\(\);/);
});

check("a patched file is left as it is", () => {
  const once = patchNextServer(unpatched).source;
  const twice = patchNextServer(once);
  assert.equal(twice.changed, false);
  assert.equal(twice.source, once);
});

check("a Next without the line stops the install", () => {
  assert.throws(() => patchNextServer("nothing here"), /expected one unawaited/);
});

check("the installed next-server.js is patched", () => {
  const file = path.join(path.dirname(require.resolve("next/package.json")), "dist/server/next-server.js");
  const source = fs.readFileSync(file, "utf8");
  assert.ok(source.includes("await requestData.body.finalize();"), "run npm install (postinstall applies it)");
  assert.ok(!/[^t] requestData\.body\.finalize\(\);/.test(source.replace(/await requestData\.body\.finalize\(\);/g, "")));
});

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall passed");
