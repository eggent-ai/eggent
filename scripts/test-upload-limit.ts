/**
 * Checks that the upload limit is one number and not two.
 *
 * Run with Node 22: node --experimental-strip-types scripts/test-upload-limit.ts
 *
 * Every request passes through middleware, and a request that passes through
 * middleware is buffered whole before the route sees it. Past the framework's
 * ceiling for that buffer it keeps the first part, drops the rest and lets the
 * connection abort - so a 16 MB video dropped into the file tree produced no
 * file, no error and no explanation, and the only trace was one line in the
 * container log. The ceiling therefore has to agree with the limit the client
 * and the routes enforce; if it is ever the smaller of the two, the failure
 * comes back exactly as silent as it was.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  oversizedRequestBytes,
  formatUploadSize,
} from "../src/lib/files/upload-limits.ts";

let failed = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextConfig = fs.readFileSync(path.join(repoRoot, "next.config.mjs"), "utf-8");

function configuredBufferBytes(): number {
  const match = /middlewareClientMaxBodySize:\s*"(\d+)(kb|mb|gb)"/i.exec(nextConfig);
  assert.ok(match, "next.config.mjs does not set experimental.middlewareClientMaxBodySize");
  const units: Record<string, number> = { kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

console.log("the buffer and the limit are the same number:");
check("next.config.mjs declares a buffer", () => assert.ok(configuredBufferBytes() > 0));
check("and it is exactly MAX_UPLOAD_BYTES", () => assert.equal(configuredBufferBytes(), MAX_UPLOAD_BYTES));
check("which is larger than the framework default that caused this", () =>
  assert.ok(MAX_UPLOAD_BYTES > 10 * 1024 * 1024)
);

console.log("\na request is judged by what it declares, before it is read:");
check("under the limit passes", () => assert.equal(oversizedRequestBytes(String(MAX_UPLOAD_BYTES - 1)), null));
check("exactly the limit passes", () => assert.equal(oversizedRequestBytes(String(MAX_UPLOAD_BYTES)), null));
check("over the limit is refused, and by how much is quotable", () =>
  assert.equal(oversizedRequestBytes(String(MAX_UPLOAD_BYTES + 1)), MAX_UPLOAD_BYTES + 1)
);
check("a missing header is not a refusal", () => assert.equal(oversizedRequestBytes(null), null));
check("nor is a header that is not a number", () => assert.equal(oversizedRequestBytes("chunked"), null));

console.log("\nsizes are readable at the size people actually drop:");
for (const [bytes, expected] of [
  [512, "512 B"],
  [1536, "1.5 KB"],
  [16 * 1024 * 1024, "16 MB"],
  [MAX_UPLOAD_BYTES, "100 MB"],
  [3 * 1024 * 1024 * 1024, "3.0 GB"],
] as Array<[number, string]>) {
  check(`${bytes} -> ${expected}`, () => assert.equal(formatUploadSize(bytes), expected));
}
check("the label quoted to the user is the limit itself", () =>
  assert.equal(MAX_UPLOAD_LABEL, formatUploadSize(MAX_UPLOAD_BYTES))
);

console.log(failed === 0 ? `\nall ${ran} checks passed` : `\n${failed} of ${ran} checks failed`);
process.exit(failed === 0 ? 0 : 1);
