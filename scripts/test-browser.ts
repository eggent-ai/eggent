// The agent's browser: the eggent-browser program and the panel's viewer,
// against a real Chromium on this machine behind a stand-in for the
// deployment's gateway. Skipped when no Chromium is found
// (EGGENT_TEST_CHROME names one).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "scripts", "bin", "eggent-browser");
const chromePath = [
  process.env.EGGENT_TEST_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((candidate) => candidate && fs.existsSync(candidate));

if (!chromePath) {
  console.log("browser: skipped, no Chromium found (set EGGENT_TEST_CHROME)");
  process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-browser-test-"));
const profile = path.join(work, "profile");
const stateDir = path.join(work, "state");
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });

async function devtoolsPort(): Promise<number> {
  const file = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i += 1) {
    if (fs.existsSync(file)) {
      const port = Number(fs.readFileSync(file, "utf8").split("\n")[0]);
      if (port) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chromium did not start");
}
const chromePort = await devtoolsPort();

// --- the stand-in gateway, which also serves the test pages -----------------
const TOKEN = "test-token";
let open = false;
const calls: string[] = [];
const PAGE = `<!doctype html><html><head><title>Test shop</title></head><body>
<h1>Test shop</h1>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Found: ' + document.querySelector('[name=q]').value;">
<input name="q" placeholder="Search"> <input type="password" name="pw" value="s3cret-value" aria-label="Password"> <button>Find</button></form>
<p id="out"></p><p><a href="/page2">Next page</a></p><div id="late"></div>
<script>setTimeout(() => { document.getElementById('late').textContent = 'Loaded by script'; }, 200);</script>
</body></html>`;
const PAGE2 = "<!doctype html><title>Second</title><h1>Second page</h1>";
const gateway = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://gateway");
  if (url.pathname === "/page") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }
  if (url.pathname === "/page2") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE2); return; }
  calls.push(`${req.method} ${url.pathname}`);
  const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" });
  const minutes = { monthly: 120, used: 1, left: 119 };
  if (url.pathname === "/v1/tools/browser/session") {
    if (req.method === "GET") return json(200, { open, minutes });
    if (req.method === "POST") { open = true; return json(201, { session: { id: "x" }, cdp: "/v1/tools/browser/session/cdp", minutes }); }
    if (req.method === "DELETE") { open = false; return json(200, { ok: true }); }
  }
  if (url.pathname === "/v1/tools/browser/profile" && req.method === "DELETE") { open = false; return json(200, { ok: true }); }
  json(404, {});
});
gateway.on("upgrade", async (req, socket, head) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}` || !open) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  const info = await (await fetch(`http://127.0.0.1:${chromePort}/json/version`)).json() as { webSocketDebuggerUrl: string };
  const upstream = net.connect(chromePort, "127.0.0.1", () => {
    upstream.write([`GET ${new URL(info.webSocketDebuggerUrl).pathname} HTTP/1.1`, `Host: 127.0.0.1:${chromePort}`, "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}`, `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"]}`, "", ""].join("\r\n"));
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gw = `http://127.0.0.1:${(gateway.address() as net.AddressInfo).port}`;

process.env.EGGENT_BROWSER_API_URL = `${gw}/v1/tools/browser`;
process.env.EGGENT_USAGE_API_TOKEN = TOKEN;
process.env.EGGENT_BROWSER_STATE_DIR = stateDir;
process.env.EGGENT_APP_ROOT = repo;

async function browser(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { cwd: work, env: process.env, timeout: 60_000 });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, out: failed.stdout ?? "", err: failed.stderr ?? "" };
  }
}

function refFor(listing: string, name: string): string {
  const line = listing.split("\n").find((entry) => entry.includes(`"${name}"`));
  assert.ok(line, `no item named ${name} in:\n${listing}`);
  return line!.match(/^\[(\d+)\]/)![1];
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (error) { failures += 1; console.log(`  FAIL  ${name}\n        ${(error as Error).message.split("\n").join("\n        ")}`); }
}

console.log("browser:");
let listing = "";
await check("open starts the browser, loads the page and reads it, the script's text included", async () => {
  const result = await browser("open", `${gw}/page`);
  assert.equal(result.code, 0, result.err);
  listing = result.out;
  assert.match(listing, /Test shop/);
  assert.match(listing, /textbox "Search"/);
  assert.match(listing, /link "Next page" -> \/page2/);
  assert.match(listing, /Loaded by script/);
  assert.ok(calls.includes("POST /v1/tools/browser/session"));
});
await check("a password field's value is never read back", async () => {
  assert.match(listing, /password "Password"/);
  assert.ok(!listing.includes("s3cret-value"));
});
await check("type into an item, press Enter, and the page answers", async () => {
  const result = await browser("type", refFor(listing, "Search"), "lamps", "--enter");
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Found: lamps/);
});
await check("click by text follows the link", async () => {
  const result = await browser("click", "Next page");
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Second page/);
});
await check("back returns", async () => {
  const result = await browser("back");
  assert.match(result.out, /Test shop/);
});
await check("a screenshot is a PNG file where it was asked for", async () => {
  const result = await browser("screenshot", "shot.png");
  assert.equal(result.code, 0, result.err);
  const bytes = fs.readFileSync(path.join(work, "shot.png"));
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
});
await check("the page worked on is remembered for the panel", async () => {
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.ok(state.targetId);
  const tabs = await browser("tabs");
  assert.match(tabs.out, /\*/);
});

const config = await import("../src/lib/browser/config.ts");
const viewer = await import("../src/lib/browser/viewer.ts");
const guidance = await import("../src/lib/browser/guidance.ts");
const address = await import("../src/lib/browser/address.ts");
const promo = await import("../src/lib/cloud-promo.ts");

await check("the viewer gets frames of the page", async () => {
  const frames: Array<{ width: number; data: string }> = [];
  const stop = await viewer.watchBrowser((event) => { if (event.type === "frame") frames.push(event); });
  for (let i = 0; i < 50 && frames.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  stop();
  assert.ok(frames.length > 0, "no frame arrived");
  assert.ok(frames[0].width > 0 && frames[0].data.length > 1000);
});
await check("the panel's input is refused until the person takes control", async () => {
  assert.equal(await viewer.sendBrowserInput({ type: "text", text: "x" }), "not-yours");
});
await check("with the person in control the agent's program waits, and the panel's click acts", async () => {
  config.setBrowserControl("person");
  const refused = await browser("read");
  assert.equal(refused.code, 2);
  assert.match(refused.err, /taken control/);
  const frames: Array<{ width: number }> = [];
  const stop = await viewer.watchBrowser((event) => { if (event.type === "frame") frames.push(event); });
  for (let i = 0; i < 50 && frames.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  // Where the link is, asked of the page itself through the program's own reading.
  config.setBrowserControl("agent");
  const point = await browser("read");
  config.setBrowserControl("person");
  assert.equal(point.code, 0, point.err);
  const cdp = await import("node:child_process");
  void cdp;
  const box = JSON.parse((await run(process.execPath, ["-e", `
    const ws = new WebSocket(${JSON.stringify(`${gw.replace("http", "ws")}/v1/tools/browser/session/cdp`)}, { headers: { authorization: "Bearer ${TOKEN}" } });
    let id = 0; const wait = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (wait.has(d.id)) wait.get(d.id)(d.result); };
    const send = (method, params, sessionId) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
    ws.onopen = async () => {
      const { targetInfos } = await send("Target.getTargets", {});
      const page = targetInfos.find((t) => t.type === "page" && t.url.endsWith("/page"));
      const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const r = await send("Runtime.evaluate", { expression: "JSON.stringify((() => { const b = [...document.links].find((a) => a.textContent === 'Next page').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })())", returnByValue: true }, sessionId);
      console.log(r.result.value); ws.close();
    };`], { timeout: 30_000 })).stdout.trim());
  assert.equal(await viewer.sendBrowserInput({ type: "click", x: box.x, y: box.y }), "ok");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  stop();
  config.setBrowserControl("agent");
  const after = await browser("read");
  assert.match(after.out, /Second page/);
});
await check("the address bar takes web pages only, and an address without a scheme as https", async () => {
  assert.equal(address.pageAddress("shop.example.test"), "https://shop.example.test/");
  assert.equal(address.pageAddress("  http://shop.example.test/a b?q=1 "), "http://shop.example.test/a%20b?q=1");
  assert.equal(address.pageAddress("localhost:3000/x"), "https://localhost:3000/x");
  for (const refused of ["", "   ", "javascript:alert(1)", "javascript://%0Aalert(1)", "file:///etc/passwd", "chrome://version", "data:text/html,<b>x</b>", "about:blank", "view-source:https://shop.example.test", "weather in paris", `https://${"a".repeat(2001)}.example.test`]) {
    assert.equal(address.pageAddress(refused), null, refused);
  }
});
await check("with the person in control the address bar opens a page, and Back, Forward and Reload move through it", async () => {
  config.setBrowserControl("person");
  const pages: Array<{ url: string; back: boolean; forward: boolean }> = [];
  const stop = await viewer.watchBrowser((event) => { if (event.type === "page") pages.push(event); });
  const settled = async (test: (page: { url: string; back: boolean; forward: boolean }) => boolean, what: string) => {
    for (let i = 0; i < 100; i += 1) {
      const last = pages[pages.length - 1];
      if (last && test(last)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`the panel was never told ${what}; last: ${JSON.stringify(pages[pages.length - 1])}`);
  };
  try {
    assert.equal(await viewer.sendBrowserInput({ type: "navigate", url: `${gw}/page` }), "ok");
    await settled((page) => page.url.endsWith("/page") && page.back && !page.forward, "about the page it opened");
    assert.equal(await viewer.sendBrowserInput({ type: "back" }), "ok");
    await settled((page) => page.url.endsWith("/page2") && page.forward, "that it went back");
    assert.equal(await viewer.sendBrowserInput({ type: "forward" }), "ok");
    await settled((page) => page.url.endsWith("/page") && !page.forward, "that it went forward");
    assert.equal(await viewer.sendBrowserInput({ type: "reload" }), "ok");
    const failed = await viewer.sendBrowserInput({ type: "navigate", url: "http://127.0.0.1:1/" });
    assert.equal(typeof failed, "object", "a page that cannot open says why");
    assert.match((failed as { failed: string }).failed, /ERR_/);
  } finally {
    stop();
    config.setBrowserControl("agent");
  }
  assert.equal(await viewer.sendBrowserInput({ type: "navigate", url: `${gw}/page2` }), "not-yours");
});
await check("a page the agent's program named that this browser no longer has does not take the panel's page away", async () => {
  // A browser started afresh - by the person in the panel, or for a new
  // session - has new pages, while state.json still names the old one.
  const stateFile = path.join(stateDir, "state.json");
  const saved = fs.readFileSync(stateFile, "utf8");
  fs.writeFileSync(stateFile, JSON.stringify({ targetId: "A-PAGE-THAT-IS-GONE" }));
  viewer.stopWatchingBrowser("a fresh look");
  const frames: number[] = [];
  const stop = await viewer.watchBrowser((event) => { if (event.type === "frame") frames.push(Date.now()); });
  try {
    for (let i = 0; i < 50 && frames.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(frames.length > 0, "no frame arrived");
    // Long enough for the panel to have looked for the named page twice.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    config.setBrowserControl("person");
    const asked = Date.now();
    assert.equal(await viewer.sendBrowserInput({ type: "navigate", url: `${gw}/page2` }), "ok");
    for (let i = 0; i < 50 && !frames.some((at) => at > asked); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(frames.some((at) => at > asked), "the picture stopped after the panel looked for the page that is gone");
  } finally {
    stop();
    config.setBrowserControl("agent");
    fs.writeFileSync(stateFile, saved);
  }
});
await check("the card about the hosted Eggent is shown only on an Eggent run by its owner", async () => {
  assert.equal(promo.cloudPromoShown({}), true);
  assert.equal(promo.cloudPromoShown({ EGGENT_USAGE_API_URL: "https://usage.example.test" }), false);
  assert.equal(promo.cloudPromoShown({ EGGENT_DEPLOYMENT_CONTEXT: "a deployment" }), false);
  assert.equal(promo.cloudPromoShown({ EGGENT_CLOUD_PROMO: "0" }), false);
  assert.equal(promo.cloudPromoShown({ EGGENT_CLOUD_PROMO: "off", EGGENT_USAGE_API_URL: "" }), false);
  assert.equal(promo.cloudPromoShown({ EGGENT_CLOUD_PROMO: "1", EGGENT_USAGE_API_URL: "https://usage.example.test" }), true);
});
await check("the agent is told about the browser only where there is one", async () => {
  assert.match(guidance.browserGuidance(), /eggent-browser/);
  const saved = process.env.EGGENT_BROWSER_API_URL;
  delete process.env.EGGENT_BROWSER_API_URL;
  assert.equal(guidance.browserGuidance(), "");
  process.env.EGGENT_BROWSER_API_URL = saved;
});
await check("close closes it at the gateway", async () => {
  const result = await browser("close");
  assert.equal(result.code, 0);
  assert.ok(calls.includes("DELETE /v1/tools/browser/session"));
});
await check("no address, no browser", async () => {
  const saved = process.env.EGGENT_BROWSER_API_URL;
  delete process.env.EGGENT_BROWSER_API_URL;
  const result = await browser("open", "example.com");
  process.env.EGGENT_BROWSER_API_URL = saved;
  assert.notEqual(result.code, 0);
  assert.match(result.err, /no browser/);
});

viewer.stopWatchingBrowser("test over");
const exited = new Promise((resolve) => chrome.once("exit", resolve));
chrome.kill();
await exited;
gateway.close();
// Chromium may still be writing its profile as it goes; the folder is a test's.
fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures ? `\n${failures} check(s) failed` : "\nall passed");
process.exit(failures ? 1 : 0);
