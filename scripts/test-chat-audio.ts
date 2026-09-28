/**
 * Checks that a recording the agent made can be played where it is named.
 *
 * Run with Node 22: npm run test:chat-audio
 *
 * Someone asked for four takes of one line in four moods and got a table of
 * paths - `tts-demo/1-radostno.mp3` and three more - that nothing could play.
 * The chat left an .mp3 path as plain text, the file screen refused it as a
 * binary, and the download route would have served it as text/plain under
 * nosniff. Two more failures sat underneath and would have met the first
 * recording with a Russian name or the first listener on an iPhone: a
 * Content-Disposition carrying Cyrillic made the Response constructor throw, so
 * such a file answered 404 - every download of it, not only audio - and a
 * server that ignores Range is one Safari will not play from at all. This runs
 * the real routes against a real directory.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import ReactDOMServer from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-chat-audio-"));
process.chdir(workdir);

const {
  audioContentType,
  embeddedAudioPath,
  embeddedImageUrl,
  fileMentionPath,
  isAudioFile,
  isOpenableFile,
} = await import("../src/lib/files/openable.ts");
const { contentDisposition, parseByteRange } = await import("../src/lib/files/download-headers.ts");

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${(error as Error).message}`);
  }
}

console.log("what counts as a recording:");
for (const [name, type] of [
  ["take.mp3", "audio/mpeg"],
  ["take.wav", "audio/wav"],
  ["take.ogg", "audio/ogg"],
  ["voice.oga", "audio/ogg"],
  ["voice.opus", "audio/ogg"],
  ["take.m4a", "audio/mp4"],
  ["take.aac", "audio/aac"],
  ["take.flac", "audio/flac"],
  ["TAKE.MP3", "audio/mpeg"],
] as Array<[string, string]>) {
  await check(`${name} is ${type}`, () => assert.equal(audioContentType(name), type));
}
for (const name of ["raw.pcm", "take.mp3.txt", "notes.md", "mp3", "take.mp3?v=2"]) {
  await check(`${name} is not audio`, () => assert.equal(isAudioFile(name), false));
}
await check("a recording is played in the page, not opened in a tab of its own", () =>
  assert.equal(isOpenableFile("tts-demo/1-radostno.mp3"), false)
);

console.log("\nthe answer from the report:");
const answer = [
  "| File | Style | Length |",
  "|---|---|---|",
  "| `tts-demo/1-radostno.mp3` | cheerful and bright | 12.1 s |",
  "| `tts-demo/2-grustno.mp3` | sad and melancholic | 11.8 s |",
  "| `tts-demo/3-zadumchivo.mp3` | thoughtful and reflective | 11.2 s |",
  "| `tts-demo/4-shepotom.mp3` | whispering softly | 12.2 s |",
  "",
  "All four are in `tts-demo/`; [listen](tts-demo/1-radostno.mp3), or ![whisper](<tts-demo/4-ψίθυρος.mp3>).",
].join("\n");
const mentions: string[] = [];
const html = ReactDOMServer.renderToStaticMarkup(
  createElement(
    Markdown,
    {
      remarkPlugins: [remarkGfm],
      components: {
        // The same expressions the chat's renderers use.
        code: ({ children }) => {
          const mention = typeof children === "string" ? fileMentionPath(children) : null;
          if (mention && isAudioFile(mention)) mentions.push(mention);
          return createElement("code", null, children);
        },
        a: ({ href, children }) => {
          const audio = typeof href === "string" ? embeddedAudioPath(href) : null;
          if (audio) mentions.push(audio);
          return createElement("a", { href }, children);
        },
        img: ({ src, alt }) => {
          const audio = typeof src === "string" ? embeddedAudioPath(src) : null;
          if (audio) mentions.push(audio);
          return createElement("img", { src, alt });
        },
      },
    },
    answer
  )
);
await check("the table rendered", () => assert.match(html, /<table>/));
await check("every take in the table is a recording to play", () =>
  assert.deepEqual(mentions.slice(0, 4), [
    "tts-demo/1-radostno.mp3",
    "tts-demo/2-grustno.mp3",
    "tts-demo/3-zadumchivo.mp3",
    "tts-demo/4-shepotom.mp3",
  ])
);
await check("a link to a take plays it too", () => assert.equal(mentions[4], "tts-demo/1-radostno.mp3"));
await check("so does an embedded one, its non-ASCII name decoded", () =>
  assert.equal(mentions[5], "tts-demo/4-ψίθυρος.mp3")
);
await check("and nothing else was taken for one - not the folder, not the text", () =>
  assert.equal(mentions.length, 6)
);
for (const [src, why] of [
  ["https://example.invalid/take.mp3", "a web address"],
  ["/app/data/projects/tts-demo/take.mp3", "an absolute path"],
  ["../take.mp3", "a way out of the project"],
  ["tts-demo/%2E%2E/%2E%2E/take.mp3", "the same, encoded"],
  ["tts-demo/cover.png", "a picture"],
] as Array<[string, string]>) {
  await check(`${why} is not played`, () => assert.equal(embeddedAudioPath(src), null));
}
await check("and a recording is not drawn as a picture", () =>
  assert.equal(embeddedImageUrl("tts-demo/1-radostno.mp3", "none"), null)
);

console.log("\nbyte ranges:");
const size = 1000;
for (const [header, expected, why] of [
  [null, null, "no header is the whole file"],
  ["bytes=0-1", { start: 0, end: 1 }, "Safari's first question"],
  ["bytes=0-", { start: 0, end: 999 }, "Chrome's first question"],
  ["bytes=500-", { start: 500, end: 999 }, "a seek"],
  ["bytes=990-5000", { start: 990, end: 999 }, "an end past the file is clipped"],
  ["bytes=-100", { start: 900, end: 999 }, "the last hundred bytes"],
  ["bytes=-5000", { start: 0, end: 999 }, "a suffix longer than the file"],
  ["bytes=1000-", "unsatisfiable", "a start past the end"],
  ["bytes=-0", "unsatisfiable", "an empty suffix"],
  ["bytes=10-5", null, "a range that is not one is ignored"],
  ["bytes=0-1,5-9", null, "several ranges get the whole file"],
  ["items=0-5", null, "another unit gets the whole file"],
] as Array<[string | null, unknown, string]>) {
  await check(why, () => assert.deepEqual(parseByteRange(header, size), expected));
}
await check("nothing in an empty file can be asked for", () =>
  assert.equal(parseByteRange("bytes=0-", 0), "unsatisfiable")
);

// Any character above U+00FF broke the header, which is every Cyrillic name
// the Russian deployment writes. Greek stands in for it here.
console.log("\nfile names in a header:");
await check("a name outside Latin-1 no longer makes a header throw", () => {
  const value = contentDisposition("attachment", "Σύμβαση μίσθωσης (Μάρτιος).docx");
  assert.doesNotThrow(() => new Response("x", { headers: { "Content-Disposition": value } }));
});
await check("the name comes back exactly from filename*", () => {
  const value = contentDisposition("inline", "φωνή «ψίθυρος».mp3");
  const encoded = /filename\*=UTF-8''(.+)$/.exec(value)?.[1];
  assert.ok(encoded);
  assert.equal(decodeURIComponent(encoded), "φωνή «ψίθυρος».mp3");
});
await check("an ASCII name reads the same in both", () =>
  assert.equal(
    contentDisposition("inline", "take-1.mp3"),
    `inline; filename="take-1.mp3"; filename*=UTF-8''take-1.mp3`
  )
);
await check("a quote cannot close the plain filename early", () =>
  assert.match(contentDisposition("attachment", 'a"b.txt'), /^attachment; filename="a_b\.txt"; /)
);

console.log("\nthe download route:");
const projects = path.join(workdir, "data", "projects");
fs.mkdirSync(path.join(projects, "tts-demo"), { recursive: true });
const take = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
fs.writeFileSync(path.join(projects, "tts-demo", "1-radostno.mp3"), take);
fs.writeFileSync(path.join(projects, "tts-demo", "φωνή.mp3"), take);
fs.writeFileSync(path.join(projects, "Σύμβαση.docx"), "contract");
fs.writeFileSync(path.join(projects, "tts-demo", "cover.png"), "png");
// A sibling of the orchestrator's directory whose name starts with its own.
fs.writeFileSync(path.join(workdir, "data", "projects-private.txt"), "not yours");

const { GET } = await import("../src/app/api/files/download/route.ts");
// Next ships no exports map, so plain Node wants the file name.
const { NextRequest } = await import("next/server.js");
const download = (file: string, options: { inline?: boolean; range?: string } = {}) => {
  const params = new URLSearchParams({ project: "none", path: file });
  if (options.inline) params.set("inline", "1");
  const headers: Record<string, string> = options.range ? { range: options.range } : {};
  return GET(new NextRequest(`http://workspace.example.test/api/files/download?${params}`, { headers }));
};

const played = await download("tts-demo/1-radostno.mp3", { inline: true });
await check("a take is served as audio, whole, saying it can be read in pieces", async () => {
  assert.equal(played.status, 200);
  assert.equal(played.headers.get("content-type"), "audio/mpeg");
  assert.equal(played.headers.get("accept-ranges"), "bytes");
  assert.equal(played.headers.get("content-length"), "1000");
  assert.deepEqual(Buffer.from(await played.arrayBuffer()), take);
});
const first = await download("tts-demo/1-radostno.mp3", { inline: true, range: "bytes=0-1" });
await check("Safari's first question gets two bytes, not the file", async () => {
  assert.equal(first.status, 206);
  assert.equal(first.headers.get("content-range"), "bytes 0-1/1000");
  assert.equal(first.headers.get("content-length"), "2");
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), take.subarray(0, 2));
});
const seek = await download("tts-demo/1-radostno.mp3", { inline: true, range: "bytes=900-" });
await check("a seek gets the rest from there", async () => {
  assert.equal(seek.status, 206);
  assert.equal(seek.headers.get("content-range"), "bytes 900-999/1000");
  assert.deepEqual(Buffer.from(await seek.arrayBuffer()), take.subarray(900));
});
const past = await download("tts-demo/1-radostno.mp3", { inline: true, range: "bytes=5000-" });
await check("a piece the file does not have is a 416 that says how long it is", async () => {
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), "bytes */1000");
});
const named = await download("tts-demo/φωνή.mp3", { inline: true });
await check("a take with a non-Latin name plays instead of being 'not found'", async () => {
  assert.equal(named.status, 200);
  assert.equal(named.headers.get("content-type"), "audio/mpeg");
  assert.match(named.headers.get("content-disposition") || "", /filename\*=UTF-8''%CF%86/);
});
const contract = await download("Σύμβαση.docx");
await check("and any file with one downloads again, not only audio", async () => {
  assert.equal(contract.status, 200);
  assert.equal(contract.headers.get("content-type"), "application/octet-stream");
  assert.match(contract.headers.get("content-disposition") || "", /^attachment; /);
  assert.equal(await contract.text(), "contract");
});
await check("a picture opened inline is served exactly as before", async () => {
  const response = await download("tts-demo/cover.png", { inline: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("content-security-policy") || "", /^sandbox /);
});
await check("a missing file is still a 404", async () => {
  assert.equal((await download("tts-demo/5-net.mp3", { inline: true })).status, 404);
});
await check("a folder is not a file", async () => {
  assert.equal((await download("tts-demo")).status, 404);
});
await check("a way out is still refused", async () => {
  assert.equal((await download("../../etc/hostname")).status, 403);
});
await check("so is a sibling whose name only starts like the project's", async () => {
  assert.equal((await download("../projects-private.txt")).status, 403);
});

console.log("\nthe file's own screen:");
const content = await import("../src/app/api/files/content/route.ts");
const describe = async (file: string) => {
  const params = new URLSearchParams({ project: "none", path: file });
  const response = await content.GET(
    new NextRequest(`http://workspace.example.test/api/files/content?${params}`)
  );
  return { status: response.status, body: await response.json() };
};
await check("a take gets a player there instead of 'binary files cannot be previewed'", async () => {
  const { status, body } = await describe("tts-demo/1-radostno.mp3");
  assert.equal(status, 200);
  assert.equal(body.contentType, "audio/mpeg");
  assert.equal(body.binary, true);
  const url = new URL(body.previewUrl, "http://workspace.example.test");
  assert.equal(url.pathname, "/api/files/download");
  assert.equal(url.searchParams.get("path"), "tts-demo/1-radostno.mp3");
  assert.equal(url.searchParams.get("inline"), "1");
});
await check("a picture's preview is the same address as before", async () => {
  const { body } = await describe("tts-demo/cover.png");
  assert.equal(body.contentType, "image/png");
  assert.equal(body.previewUrl, "/api/files/download?project=none&path=tts-demo%2Fcover.png");
});

fs.rmSync(workdir, { recursive: true, force: true });
console.log(failed === 0 ? `\nall ${ran} checks passed` : `\n${failed} of ${ran} checks failed`);
process.exit(failed === 0 ? 0 : 1);
