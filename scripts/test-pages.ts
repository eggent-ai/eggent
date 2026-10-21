/**
 * Pages shown on screen: how a page's source is numbered and marked for
 * pointing at blocks, how words changed on the page are written back - only
 * those characters, the rest of the file byte for byte - and what the routes
 * that serve, describe, edit and print a page allow and refuse.
 *
 * No network. Run with Node 22:
 *   npm run test:pages
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let failed = 0;
let ran = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  ran += 1;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-pages-"));
process.chdir(root);
const projectsDir = path.join(root, "data", "projects");
fs.mkdirSync(path.join(projectsDir, "skills"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR);

const html = await import("../src/lib/files/html-source.ts");
const token = await import("../src/lib/files/page-token.ts");
const projectStore = await import("../src/lib/storage/project-store.ts");
const storeModule = await import("../src/lib/files/versions/store.ts");
const { createSessionToken } = await import("../src/lib/auth/session.ts");
const pageRoute = await import("../src/app/api/files/page/[token]/[...path]/route.ts");
const linkRoute = await import("../src/app/api/files/page-link/route.ts");
const elementRoute = await import("../src/app/api/files/page-element/route.ts");
const editRoute = await import("../src/app/api/files/page-edit/route.ts");
const printRoute = await import("../src/app/api/files/page-print/route.ts");
const { middleware } = await import("../src/middleware.ts");

const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const unmark = (text: string) => text.replace(/ data-eggent-el="\d+"/g, "");

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Spring offer</title>
  <link rel="stylesheet" href="css/site.css">
  <style>h1 { color: red }</style>
</head>
<body>
  <!-- the hero -->
  <section class="hero" id="top">
    <h1>
      Fresh bread every morning
    </h1>
    <p>Order before <b>9 am</b> and get it by noon &amp; warm.</p>
    <img src="img/loaf.png" alt="A loaf"><br/>
    <a href="#buy" class="btn primary">Buy now</a>
  </section>
  <svg viewBox="0 0 10 10"><path d="M0 0L10 10"/><text x="1" y="5">svg text</text></svg>
  <pre>  keep   this  </pre>
  <textarea>notes</textarea>
  <template><p>never shown</p></template>
  <script>document.title = "x"</script>
</body>
</html>
`;

console.log("Reading a page's source\n");

await check("elements are numbered in document order, HTML only, nothing inside svg or a template", () => {
  const page = html.readPage(PAGE);
  const tags = page.elements.map((element) => element.tag);
  assert.deepEqual(tags, ["html", "head", "meta", "title", "link", "style", "body", "section", "h1", "p", "b", "img", "br", "a", "pre", "textarea", "template", "script"]);
  assert.ok(page.bodyEnd !== null && PAGE.slice(page.bodyEnd).startsWith("</body>"));
  const h1 = page.elements[8];
  assert.equal(PAGE.slice(h1.start, h1.end), "<h1>\n      Fresh bread every morning\n    </h1>");
  assert.equal(h1.startLine, 12);
  assert.equal(h1.endLine, 14);
  assert.equal(html.labelOf(page.elements[7]), "section#top");
  assert.equal(html.labelOf(page.elements[13]), "a.btn");
});
await check("the copy marked for editing differs from the file by the marks and the script, and nothing else", () => {
  const page = html.readPage(PAGE);
  const marked = html.markForEditing(PAGE, page, "<script>bridge()</script>");
  assert.equal(unmark(marked).replace("<script>bridge()</script>", ""), PAGE);
  assert.ok(marked.includes('<section class="hero" id="top" data-eggent-el="7">'));
  assert.ok(marked.includes('<br/ data-eggent-el="12">'), "a void element's mark sits before its final >");
  assert.ok(marked.includes('<path d="M0 0L10 10"/>'), "a self-closing tag in svg is left as it is");
  assert.ok(marked.indexOf("<script>bridge()</script>") === marked.indexOf("</body>") - "<script>bridge()</script>".length);
  const noBody = "<p>just a fragment</p>";
  assert.equal(html.markForEditing(noBody, html.readPage(noBody), "<i>t</i>").endsWith("<i>t</i>"), true);
});

console.log("\nWords changed on the page\n");

const n = (tag: string, nth = 0) => html.readPage(PAGE).elements.filter((element) => element.tag === tag)[nth].n;

await check("a heading's words change in place; its indentation and the rest of the file stay", () => {
  const result = html.applyTextEdits(PAGE, [{ el: n("h1"), slot: 0, was: "\n      Fresh bread every morning\n    ", text: "Warm bread every morning" }]);
  assert.ok(result.ok);
  assert.equal(result.source, PAGE.replace("Fresh bread every morning", "Warm bread every morning"));
});
await check("text around a bold word is its own piece; entities are read and written back as entities", () => {
  const p = n("p");
  const pieces = html.readPage(PAGE).elements[p].node.childNodes.filter((node) => node.nodeName === "#text").map((node) => (node as { value: string }).value);
  assert.deepEqual(pieces, ["Order before ", " and get it by noon & warm."]);
  const result = html.applyTextEdits(PAGE, [
    { el: p, slot: 1, was: " and get it by noon & warm.", text: " and get it by 11 <hot> & warm." },
    { el: n("b"), slot: 0, was: "9 am", text: "10 am" },
  ]);
  assert.ok(result.ok);
  assert.ok(result.source.includes("<p>Order before <b>10 am</b> and get it by 11 &lt;hot&gt; &amp; warm.</p>"), result.source);
  assert.equal(result.changed, 2);
});
await check("what the page showed must still be what the file says, or nothing is written", () => {
  const stale = html.applyTextEdits(PAGE, [{ el: n("a"), slot: 0, was: "Buy later", text: "Buy" }]);
  assert.deepEqual(stale, { ok: false, reason: "mismatch", edit: { el: n("a"), slot: 0, was: "Buy later", text: "Buy" } });
  assert.equal(html.applyTextEdits(PAGE, [{ el: 999, slot: 0, was: "", text: "x" }]).ok, false);
  assert.equal(html.applyTextEdits(PAGE, [{ el: n("a"), slot: 3, was: "", text: "x" }]).ok, false);
});
await check("code, form fields and templates are not changed from the page; <pre> keeps its spaces", () => {
  for (const tag of ["script", "textarea", "style", "title"]) {
    const element = html.readPage(PAGE).elements[n(tag)];
    const was = (element.node.childNodes[0] as { value: string }).value;
    const result = html.applyTextEdits(PAGE, [{ el: element.n, slot: 0, was, text: "changed" }]);
    if (tag === "title") assert.ok(result.ok, "a title is plain text");
    else assert.equal(result.ok ? "written" : result.reason, "uneditable", tag);
  }
  const pre = html.applyTextEdits(PAGE, [{ el: n("pre"), slot: 0, was: "  keep   this  ", text: " kept  " }]);
  assert.ok(pre.ok);
  assert.ok(pre.source.includes("<pre> kept  </pre>"));
});

await check("typing over all of a piece, deleting all of it, typing where there was none, around a comment", () => {
  const all = html.applyTextEdits(PAGE, [{ el: n("a"), slot: 0, was: "Buy now", text: "" }]);
  assert.ok(all.ok && all.source.includes('class="btn primary"></a>'), "deleting a link's words");
  const between = "<p><b>bread</b><i>butter</i></p><h2></h2><p>A <!-- note --> B</p>";
  const read = html.readPage(between);
  assert.deepEqual(read.elements.map((element) => element.tag), ["p", "b", "i", "h2", "p"], "implied html, head and body carry no number");
  const [p1, , , h2, p2] = read.elements.map((element) => element.n);
  const gap = html.applyTextEdits(between, [{ el: p1, slot: 1, was: "", text: " and " }]);
  assert.ok(gap.ok && gap.source.startsWith("<p><b>bread</b> and <i>butter</i></p>"), gap.ok ? gap.source : gap.reason);
  const empty = html.applyTextEdits(between, [{ el: h2, slot: 0, was: "", text: "Hours" }]);
  assert.ok(empty.ok && empty.source.includes("<h2>Hours</h2>"));
  const comment = html.applyTextEdits(between, [{ el: p2, slot: 1, was: " B", text: " C" }]);
  assert.ok(comment.ok && comment.source.endsWith("<p>A <!-- note --> C</p>"), comment.ok ? comment.source : comment.reason);
  assert.equal(html.applyTextEdits(between, [{ el: p1, slot: 9, was: "", text: "x" }]).ok, false, "a gap that is not there");
  assert.equal(html.applyTextEdits(between, [{ el: p1, slot: 1, was: "x", text: "y" }]).ok, false, "an empty gap said to hold words");
});

console.log("\nThe routes\n");

await projectStore.createProject({ id: "shop", name: "Shop", description: "", instructions: "", memoryMode: "isolated" } as never);
const shopDir = path.join(projectsDir, "shop");
fs.mkdirSync(path.join(shopDir, "site", "css"), { recursive: true });
fs.writeFileSync(path.join(shopDir, "site", "index.html"), PAGE);
fs.writeFileSync(path.join(shopDir, "site", "css", "site.css"), "body { margin: 0 }");
fs.writeFileSync(path.join(shopDir, "notes.md"), "# Notes\n\nPlain words.\n");
fs.writeFileSync(path.join(shopDir, ".env"), "KEY=secret\n");
fs.writeFileSync(path.join(root, "data", "outside.html"), "<p>outside</p>");
fs.symlinkSync(path.join(root, "data", "outside.html"), path.join(shopDir, "site", "link.html"));

const session = await createSessionToken("tester", false);
const request = (url: string, init: { method?: string; body?: unknown; cookie?: boolean; headers?: Record<string, string> } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      ...(init.cookie === false ? {} : { cookie: `eggent_auth=${session}` }),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
const serve = async (url: string) => {
  const parsed = new URL(url, "http://localhost");
  const [, , , , tok, ...rest] = parsed.pathname.split("/");
  return pageRoute.GET(new NextRequest(parsed.toString()), { params: Promise.resolve({ token: tok, path: rest }) });
};
const linkFor = async (filePath: string, mode?: string) => {
  const response = await linkRoute.GET(request(`/api/files/page-link?project=shop&path=${encodeURIComponent(filePath)}${mode ? `&mode=${mode}` : ""}`));
  return { status: response.status, url: ((await response.json()) as { url?: string }).url };
};

await check("a link is given only to a signed-in person, only for a file of the workspace", async () => {
  assert.equal((await linkRoute.GET(request("/api/files/page-link?project=shop&path=site/index.html", { cookie: false }))).status, 401);
  assert.equal((await linkFor("../../outside.html")).status, 403);
  assert.equal((await linkFor(".env")).status, 403);
  assert.equal((await linkFor("notes.md", "edit")).status, 400, "only a page is marked for editing");
  const { status, url } = await linkFor("site/index.html");
  assert.equal(status, 200);
  assert.match(url!, /^\/api\/files\/page\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/site\/index\.html$/);
});
await check("the page is served as it is, sandboxed, unable to fetch, sending no referrer; its css beside it too", async () => {
  const { url } = await linkFor("site/index.html");
  const response = await serve(url!);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), PAGE);
  const policy = response.headers.get("content-security-policy") || "";
  assert.match(policy, /^sandbox allow-scripts /);
  assert.ok(!policy.includes("allow-same-origin"));
  assert.match(policy, /connect-src 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  const css = await serve(url!.replace("site/index.html", "site/css/site.css"));
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(await css.text(), "body { margin: 0 }");
});
await check("the token is the credential: forged, expired, or used for a link, a secret or a step outside - nothing", async () => {
  const { url } = await linkFor("site/index.html");
  const tok = url!.split("/")[4];
  const forged = `${tok.split(".")[0]}.AAAA`;
  assert.equal((await serve(url!.replace(tok, forged))).status, 403);
  const expired = token.mintPageToken("shop", Date.now() - 60 * 60_000);
  assert.equal((await serve(url!.replace(tok, expired))).status, 403);
  assert.equal(token.readPageToken(token.mintPageToken("shop"))?.project, "shop");
  assert.equal((await serve(url!.replace("site/index.html", "site/link.html"))).status, 404, "a link was followed");
  assert.equal((await serve(url!.replace("site/index.html", ".env"))).status, 404, "a credential was served");
  assert.equal((await serve(url!.replace("site/index.html", "..%2F..%2Foutside.html"))).status, 404);
  assert.equal((await serve(url!.replace("site/index.html", "site/missing.html"))).status, 404);
  const other = token.mintPageToken("../..");
  assert.equal((await serve(`/api/files/page/${other}/outside.html`)).status, 404, "a token naming no project served something");
});
await check("the frame is let past the sign-in, with no cookie; everything else under /api still is not", async () => {
  const passed = await middleware(new NextRequest("http://localhost/api/files/page/x.y/site/README"));
  assert.equal(passed.status, 200);
  assert.equal(passed.headers.get("x-middleware-next"), "1");
  const stopped = await middleware(new NextRequest("http://localhost/api/files/page-link"));
  assert.equal(stopped.status, 401);
});
await check("the copy for editing carries the marks, the hash of what it was made from, and runs only its own script", async () => {
  const { url } = await linkFor("site/index.html", "edit");
  const response = await serve(url!);
  const body = await response.text();
  const policy = response.headers.get("content-security-policy") || "";
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
  assert.ok(nonce, policy);
  assert.ok(!policy.includes("allow-popups") && !policy.includes("allow-modals"));
  assert.ok(body.includes(`<script nonce="${nonce}">`));
  assert.ok(body.includes(JSON.stringify(sha(PAGE))));
  assert.ok(body.includes('<h1 data-eggent-el="8">'));
  assert.equal(unmark(body).replace(/<script nonce="[^"]+">[\s\S]*?<\/script>(?=<\/body>)/, ""), PAGE);
});
await check("the copy for printing gets ready and opens the dialog; colours are kept", async () => {
  const { url } = await linkFor("site/index.html", "print");
  const response = await serve(url!);
  const body = await response.text();
  assert.match(response.headers.get("content-security-policy") || "", /allow-modals/);
  assert.ok(body.includes("print-color-adjust:exact"));
  assert.ok(body.includes("print();"));
  assert.ok(!body.includes("data-eggent-el"));
});
await check("printing goes to the page's own copy for a page, to the print screen for anything else", async () => {
  const page = await printRoute.GET(request("/api/files/page-print?project=shop&path=site/index.html"));
  assert.equal(page.status, 302);
  assert.match(page.headers.get("location") || "", /^\/api\/files\/page\/[^/]+\/site\/index\.html\?eggent=print$/);
  const notes = await printRoute.GET(request("/api/files/page-print?project=shop&path=notes.md"));
  assert.equal(notes.headers.get("location"), "/print?project=shop&path=notes.md");
  assert.equal((await printRoute.GET(request("/api/files/page-print?project=shop&path=.env"))).status, 403);
  assert.equal((await printRoute.GET(request("/api/files/page-print?project=shop&path=notes.md", { cookie: false }))).status, 401);
});
await check("a picked block is described by its lines and source, for the page the screen showed", async () => {
  const h1 = n("h1");
  const ok = await elementRoute.GET(request(`/api/files/page-element?project=shop&path=site/index.html&sha=${sha(PAGE)}&el=${h1}`));
  const block = (await ok.json()) as { label: string; startLine: number; endLine: number; source: string };
  assert.deepEqual([block.label, block.startLine, block.endLine], ["h1", 12, 14]);
  assert.equal(block.source, "<h1>\n      Fresh bread every morning\n    </h1>");
  const stale = await elementRoute.GET(request(`/api/files/page-element?project=shop&path=site/index.html&sha=${"0".repeat(64)}&el=${h1}`));
  assert.equal(stale.status, 409);
});
await check("words changed on the page are saved into the file as the person's version, and only for the page shown", async () => {
  const body = { project: "shop", path: "site/index.html", sha: sha(PAGE), edits: [{ el: n("a"), slot: 0, was: "Buy now", text: "Order now" }] };
  assert.equal((await editRoute.POST(request("/api/files/page-edit", { method: "POST", body, cookie: false }))).status, 401);
  assert.equal((await editRoute.POST(request("/api/files/page-edit", { method: "POST", body, headers: { origin: "https://other.example.test", "sec-fetch-site": "same-site" } }))).status, 403);
  const response = await editRoute.POST(request("/api/files/page-edit", { method: "POST", body }));
  assert.equal(response.status, 200, await response.clone().text());
  const written = fs.readFileSync(path.join(shopDir, "site", "index.html"), "utf8");
  assert.equal(written, PAGE.replace(">Buy now<", ">Order now<"));
  assert.equal(((await response.json()) as { sha: string }).sha, sha(written));
  const journal = await storeModule.getVersionStore().journal("shop/site/index.html");
  assert.deepEqual(journal?.versions.map((entry) => entry.by.kind), ["earlier", "person"]);
  const again = await editRoute.POST(request("/api/files/page-edit", { method: "POST", body }));
  assert.equal(again.status, 409, "an edit made on the page as it was before was written");
  assert.equal(((await again.json()) as { code: string }).code, "changed");
  const mismatch = await editRoute.POST(request("/api/files/page-edit", { method: "POST", body: { ...body, sha: sha(written), edits: [{ el: n("a"), slot: 0, was: "Buy now", text: "x" }] } }));
  assert.equal(((await mismatch.json()) as { code: string }).code, "mismatch");
  assert.equal(fs.readFileSync(path.join(shopDir, "site", "index.html"), "utf8"), written);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
