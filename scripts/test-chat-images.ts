/**
 * Checks that an image the agent embeds in an answer loads from the project.
 *
 * Run with Node 22: npm run test:chat-images
 *
 * `![jar](./uploads/jar.png)` names a file in the agent's working directory,
 * and the chat handed it to the browser as written. The browser resolved it
 * against the page - /dashboard/<chatId> - and drew a broken image where the
 * person had asked to see their photo, with the file sitting in the project the
 * whole time. Relative paths are the only form found in real conversations, and
 * one of them had a non-ASCII name, which the markdown pipeline percent-encodes
 * on the way through - so the last section runs the real pipeline rather than
 * trusting the resolver alone.
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import ReactDOMServer from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { embeddedImageUrl, fileMentionPath } from "../src/lib/files/openable.ts";

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

/** The file a download URL asks for, read back the way the route reads it. */
function requested(url: string | null | undefined): { project: string | null; path: string | null; inline: string | null } {
  assert.ok(url, "no url");
  const parsed = new URL(url, "http://workspace.invalid");
  assert.equal(parsed.pathname, "/api/files/download");
  return {
    project: parsed.searchParams.get("project"),
    path: parsed.searchParams.get("path"),
    inline: parsed.searchParams.get("inline"),
  };
}

console.log("a path in the project loads through the file API:");
check("the shape from the report", () =>
  assert.deepEqual(requested(embeddedImageUrl("./uploads/meridian-pasta.png", "none")), {
    project: "none",
    path: "uploads/meridian-pasta.png",
    inline: "1",
  })
);
check("without the ./", () =>
  assert.equal(requested(embeddedImageUrl("uploads/meridian-pasta.png", "none")).path, "uploads/meridian-pasta.png")
);
check("inside a project, against that project", () =>
  assert.equal(requested(embeddedImageUrl("site/hero.webp", "landing")).project, "landing")
);
check("a non-ASCII name, as the pipeline hands it over", () =>
  assert.equal(requested(embeddedImageUrl("fotos/caf%C3%A9.jpg", "none")).path, "fotos/café.jpg")
);
check("a space in the name", () =>
  assert.equal(requested(embeddedImageUrl("uploads/photo%20of%20jar.png", "none")).path, "uploads/photo of jar.png")
);
for (const name of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg", "A.PNG"]) {
  check(`${name} is an image`, () => assert.equal(requested(embeddedImageUrl(name, "none")).path, name));
}
check("a % that escapes nothing is judged as written", () =>
  assert.equal(requested(embeddedImageUrl("uploads/100%.png", "none")).path, "uploads/100%.png")
);

console.log("\nanything else is left exactly as written:");
for (const [src, why] of [
  ["https://example.invalid/pic.png", "a web address"],
  ["data:image/png;base64,iVBORw0KGgo=", "a data url"],
  ["/app/data/projects/uploads/pic.png", "an absolute path"],
  ["~/pic.png", "a home path"],
  ["../outside.png", "a path out of the project"],
  ["uploads/%2E%2E/%2E%2E/outside.png", "the same, encoded"],
  ["link", "a placeholder the agent never filled in"],
  ["site/index.html", "a page, which is not an image"],
  ["uploads/pic.png?v=2", "a query string"],
] as Array<[string, string]>) {
  check(why, () => assert.equal(embeddedImageUrl(src, "none"), null));
}

console.log("\nthrough the real markdown pipeline:");
const markdown = [
  "![jar](./uploads/meridian-pasta.png)",
  "![cafe](fotos/café.jpg)",
  "![jar again](<uploads/photo of jar.png>)",
  "![outside](https://example.invalid/pic.png)",
].join("\n\n");
const html = ReactDOMServer.renderToStaticMarkup(
  createElement(
    Markdown,
    {
      remarkPlugins: [remarkGfm],
      components: {
        // The same expression the chat's img renderer uses.
        img: ({ src, alt }) =>
          createElement("img", { src: typeof src === "string" ? embeddedImageUrl(src, "none") ?? src : src, alt }),
      },
    },
    markdown
  )
);
const sources = [...html.matchAll(/<img src="([^"]*)"/g)].map((match) => match[1].replaceAll("&amp;", "&"));
check("every image rendered", () => assert.equal(sources.length, 4));
check("the report's image", () => assert.equal(requested(sources[0]).path, "uploads/meridian-pasta.png"));
check("a non-ASCII name arrives decoded", () => assert.equal(requested(sources[1]).path, "fotos/café.jpg"));
check("a name with a space", () => assert.equal(requested(sources[2]).path, "uploads/photo of jar.png"));
check("an external image is untouched", () => assert.equal(sources[3], "https://example.invalid/pic.png"));

console.log("\na mention is judged exactly as before:");
check("a path in inline code still links", () =>
  assert.equal(fileMentionPath("./uploads/meridian-pasta.png"), "uploads/meridian-pasta.png")
);
check("a space still keeps it plain text", () => assert.equal(fileMentionPath("npm run build.js"), null));
check("an absolute path still does", () => assert.equal(fileMentionPath("/app/data/report.pdf"), null));
check("a way out still does", () => assert.equal(fileMentionPath("../report.pdf"), null));

console.log(failed === 0 ? `\nall ${ran} checks passed` : `\n${failed} of ${ran} checks failed`);
process.exit(failed === 0 ? 0 : 1);
