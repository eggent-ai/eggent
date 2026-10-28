/**
 * Events and Google, from the workspace's side.
 *
 * The calendar file: times written the three ways an event can mean them, the
 * zone's clock changes for a repeating event, whole days, escaping, folding,
 * and a rule or a title that tries to smuggle in a line of its own. The
 * download route serves it as text/calendar so a phone adds it; the tool
 * writes it without overwriting what is there; the turn counts it among its
 * files.
 *
 * Google: a stand-in for the deployment's service answers the way it does and
 * records what it was sent. Without EGGENT_GOOGLE_API_URL nothing exists; with
 * it the tool asks only for listed actions with the workspace's token, turns a
 * CSV file into rows without passing through the model, writes event times the
 * way the service takes them, and answers "connect" with the button's address;
 * the routes behind the card need a session, and a write needs this site.
 *
 * No network, no credential. Run with Node 22:
 *   npm run test:google
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-google-"));
process.chdir(root);
const projectsDir = path.join(root, "data", "projects");
const shopDir = path.join(projectsDir, "shop");
fs.mkdirSync(shopDir, { recursive: true });
delete process.env.EGGENT_GOOGLE_API_URL;
delete process.env.EGGENT_GOOGLE_API_TOKEN;

const ics = await import("../src/lib/calendar/ics.ts");
const { createCalendarFileTool } = await import("../src/lib/calendar/tool.ts");
const openable = await import("../src/lib/files/openable.ts");
const downloadHeaders = await import("../src/lib/files/download-headers.ts");
const downloadRoute = await import("../src/app/api/files/download/route.ts");
const { collectProducedFiles } = await import("../src/lib/files/produced.ts");
const googleConfig = await import("../src/lib/google/config.ts");
const { createGoogleTool, eventFromParams } = await import("../src/lib/google/tool.ts");
const rowsModule = await import("../src/lib/google/rows.ts");
const link = await import("../src/lib/google/connect-link.ts");
const statusRoute = await import("../src/app/api/google/status/route.ts");
const disconnectRoute = await import("../src/app/api/google/disconnect/route.ts");
const { createSessionToken } = await import("../src/lib/auth/session.ts");

const fixedUid = () => {
  let n = 0;
  return () => `uid-${++n}`;
};
const NOW = new Date(Date.UTC(2026, 9, 28, 12, 0, 0));
const build = (events: Parameters<typeof ics.buildCalendarFile>[0]) => ics.buildCalendarFile(events, { now: NOW, uid: fixedUid() });
/** The file's lines with folding undone. */
const unfolded = (text: string) => text.replace(/\r\n /g, "").split("\r\n");
const line = (text: string, prefix: string) => unfolded(text).find((item) => item.startsWith(prefix));

console.log("The calendar file\n");

await check("a wall-clock time in a zone is written as the instant it names, summer and winter", () => {
  const winter = build([{ title: "Viewing", start: "2026-11-03T15:00", timeZone: "Europe/Berlin" }]);
  assert.equal(line(winter.text, "DTSTART"), "DTSTART:20261103T140000Z");
  assert.equal(line(winter.text, "DTEND"), "DTEND:20261103T150000Z", "an hour by default");
  const summer = build([{ title: "Viewing", start: "2027-07-01T15:00", end: "2027-07-01T16:30", timeZone: "Europe/Berlin" }]);
  assert.equal(line(summer.text, "DTSTART"), "DTSTART:20270701T130000Z");
  assert.equal(line(summer.text, "DTEND"), "DTEND:20270701T143000Z");
  const almaty = build([{ title: "Call", start: "2026-11-03T09:00", timeZone: "Asia/Almaty", durationMinutes: 30 }]);
  assert.equal(line(almaty.text, "DTSTART"), "DTSTART:20261103T040000Z");
  assert.equal(line(almaty.text, "DTEND"), "DTEND:20261103T043000Z");
});

await check("an exact moment keeps its moment; a time with no zone is local to whoever opens it", () => {
  const exact = build([{ title: "Flight", start: "2026-11-03T15:00:00+03:00", end: "2026-11-03T18:20:00+01:00" }]);
  assert.equal(line(exact.text, "DTSTART"), "DTSTART:20261103T120000Z");
  assert.equal(line(exact.text, "DTEND"), "DTEND:20261103T172000Z");
  const floating = build([{ title: "Gym", start: "2026-11-03T07:30" }]);
  assert.equal(line(floating.text, "DTSTART"), "DTSTART:20261103T073000");
  assert.equal(floating.events[0].timing, "floating");
});

await check("whole days: one day by default, the end is the day after the last", () => {
  const one = build([{ title: "Birthday", start: "2026-12-31" }]);
  assert.equal(line(one.text, "DTSTART"), "DTSTART;VALUE=DATE:20261231");
  assert.equal(line(one.text, "DTEND"), "DTEND;VALUE=DATE:20270101");
  const trip = build([{ title: "Trip", start: "2026-11-03", end: "2026-11-05" }]);
  assert.equal(line(trip.text, "DTEND"), "DTEND;VALUE=DATE:20261106");
  assert.equal(trip.events[0].end, "2026-11-05");
});

await check("a repeating event in a zone with clock changes keeps its hour: TZID and the zone's changes written out", () => {
  const file = build([{ title: "Standup", start: "2026-11-02T10:00", timeZone: "Europe/Berlin", repeat: "weekly" }]);
  assert.equal(line(file.text, "DTSTART;TZID"), "DTSTART;TZID=Europe/Berlin:20261102T100000");
  assert.equal(line(file.text, "DTEND;TZID"), "DTEND;TZID=Europe/Berlin:20261102T110000");
  assert.equal(line(file.text, "RRULE"), "RRULE:FREQ=WEEKLY");
  const lines = unfolded(file.text);
  assert.ok(lines.includes("BEGIN:VTIMEZONE") && lines.includes("TZID:Europe/Berlin"));
  // The spring change of 2027: 02:00 local becomes 03:00, +0100 to +0200.
  const spring = lines.indexOf("DTSTART:20270328T020000");
  assert.ok(spring > 0, "no onset for 2027-03-28");
  assert.equal(lines[spring + 1], "TZOFFSETFROM:+0100");
  assert.equal(lines[spring + 2], "TZOFFSETTO:+0200");
  assert.equal(lines[spring - 1], "BEGIN:DAYLIGHT");
  const autumn = lines.indexOf("DTSTART:20271031T030000");
  assert.ok(autumn > 0, "no onset for 2027-10-31");
  assert.equal(lines[autumn + 2], "TZOFFSETTO:+0100");
  assert.equal(lines[autumn - 1], "BEGIN:STANDARD");
  // A zone that never changes has one standard block.
  const steady = build([{ title: "Standup", start: "2026-11-02T10:00", timeZone: "Asia/Almaty", repeat: "daily" }]);
  const blocks = unfolded(steady.text).filter((item) => item === "BEGIN:STANDARD" || item === "BEGIN:DAYLIGHT");
  assert.deepEqual(blocks, ["BEGIN:STANDARD"]);
});

await check("UNTIL is written the way the start is: a date, UTC, or local", () => {
  assert.equal(line(build([{ title: "x", start: "2026-11-02", repeat: "FREQ=DAILY;UNTIL=20261110T120000Z" }]).text, "RRULE"), "RRULE:FREQ=DAILY;UNTIL=20261110");
  assert.equal(line(build([{ title: "x", start: "2026-11-02T10:00", timeZone: "Europe/Berlin", repeat: "FREQ=DAILY;UNTIL=20261110" }]).text, "RRULE"), "RRULE:FREQ=DAILY;UNTIL=20261110T235959Z");
  assert.equal(line(build([{ title: "x", start: "2026-11-02T10:00", repeat: "FREQ=DAILY;UNTIL=20261110T090000Z" }]).text, "RRULE"), "RRULE:FREQ=DAILY;UNTIL=20261110T090000");
});

await check("text is escaped, so a title or a rule cannot add a line of its own", () => {
  const file = build([{ title: "Meet; bring, docs\\notes\r\nATTENDEE:mailto:x@example.test", description: "Line one\nLine two", location: "Office, 3rd floor" }].map((event) => ({ ...event, start: "2026-11-03" })));
  const lines = unfolded(file.text);
  assert.ok(lines.includes("SUMMARY:Meet\\; bring\\, docs\\\\notes\\nATTENDEE:mailto:x@example.test"));
  assert.ok(lines.includes("DESCRIPTION:Line one\\nLine two"));
  assert.ok(lines.includes("LOCATION:Office\\, 3rd floor"));
  assert.ok(!lines.some((item) => item.startsWith("ATTENDEE")));
  assert.throws(() => build([{ title: "x", start: "2026-11-03", repeat: "FREQ=DAILY\r\nATTENDEE:mailto:x@example.test" }]), ics.CalendarInputError);
  assert.throws(() => build([{ title: "x", start: "2026-11-03", repeat: "FREQ=SECONDLY" }]), ics.CalendarInputError);
  assert.throws(() => build([{ title: "x", start: "2026-11-03", repeat: "FREQ=DAILY;COUNT=3;UNTIL=20261110" }]), ics.CalendarInputError);
});

await check("long lines fold at 75 bytes without cutting a letter in two, with CRLF everywhere", () => {
  const description = "Besichtigung am Ölweg: Pass, Vertrag und Schlüssel mitnehmen; Ärztin vorher anrufen ✓ 日本語のメモ. ".repeat(4);
  const file = build([{ title: "Besichtigung", start: "2026-11-03", description }]);
  for (const raw of file.text.split("\r\n")) assert.ok(Buffer.byteLength(raw, "utf-8") <= 75, `a line of ${Buffer.byteLength(raw, "utf-8")} bytes`);
  assert.ok(!file.text.includes("�"));
  assert.ok(!/[^\r]\n/.test(file.text), "a bare LF");
  assert.equal(line(file.text, "DESCRIPTION"), `DESCRIPTION:${ics.escapeText(description.trim())}`);
  assert.ok(file.text.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") && file.text.endsWith("END:VCALENDAR\r\n"));
  assert.ok(unfolded(file.text).includes("METHOD:PUBLISH"));
});

await check("a line of exactly 76 bytes is folded, one of 75 is not", () => {
  const exact = (bytes: number) => "x".repeat(bytes - "SUMMARY:".length);
  const at75 = build([{ title: exact(75), start: "2026-11-03" }]);
  assert.ok(at75.text.split("\r\n").includes(`SUMMARY:${exact(75)}`));
  const at76 = build([{ title: exact(76), start: "2026-11-03" }]);
  const lines = at76.text.split("\r\n");
  const start = lines.findIndex((item) => item.startsWith("SUMMARY:"));
  assert.equal(Buffer.byteLength(lines[start], "utf-8"), 75);
  assert.equal(lines[start + 1], " x");
});

await check("reminders become alarms before the start", () => {
  const file = build([{ title: "Dentist", start: "2026-11-03T15:00", timeZone: "Europe/Berlin", reminderMinutes: [15, 120, 1440] }]);
  const triggers = unfolded(file.text).filter((item) => item.startsWith("TRIGGER"));
  assert.deepEqual(triggers, ["TRIGGER:-PT15M", "TRIGGER:-PT2H", "TRIGGER:-P1D"]);
});

await check("what cannot be written truthfully is refused with a sentence to act on", () => {
  const refuse = (event: Parameters<typeof build>[0][number], pattern: RegExp) => assert.throws(() => build([event]), (error: unknown) => error instanceof ics.CalendarInputError && pattern.test(error.message));
  refuse({ title: "x", start: "2026-02-30" }, /not a real date/);
  refuse({ title: "x", start: "tomorrow at 5" }, /must look like/);
  refuse({ title: "x", start: "2026-11-03T15:00", timeZone: "Mars/Olympus" }, /not a known zone/);
  refuse({ title: "x", start: "2026-11-03T15:00", end: "2026-11-03T14:00", timeZone: "Europe/Berlin" }, /after start/);
  refuse({ title: "x", start: "2026-11-05", end: "2026-11-03" }, /before start/);
  refuse({ title: "", start: "2026-11-03" }, /title/);
  refuse({ title: "x", start: "2026-11-03", url: "javascript:alert(1)" }, /http/);
  assert.throws(() => ics.buildCalendarFile([]), ics.CalendarInputError);
});

await check("a file name is the title, minus what a file system refuses", () => {
  assert.equal(ics.calendarFileName("Café / Zürich: 1"), "Café Zürich 1.ics");
  assert.equal(ics.calendarFileName("../../etc/passwd"), "etc passwd.ics");
  assert.equal(ics.calendarFileName("   "), "event.ics");
});

console.log("\nServing it\n");

fs.writeFileSync(path.join(shopDir, "viewing.ics"), build([{ title: "Viewing", start: "2026-11-03" }]).text);
fs.writeFileSync(path.join(shopDir, "notes.txt"), "hello");
const download = (query: string) => downloadRoute.GET(new NextRequest(`http://localhost/api/files/download?${query}`));

await check("a calendar file is served as text/calendar, opened or saved; other files as before", async () => {
  const opened = await download("project=shop&path=viewing.ics&inline=1");
  assert.equal(opened.status, 200);
  assert.equal(opened.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.match(opened.headers.get("content-disposition") || "", /^inline;/);
  const saved = await download("project=shop&path=viewing.ics");
  assert.equal(saved.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.match(saved.headers.get("content-disposition") || "", /^attachment;/);
  assert.match(await saved.text(), /^BEGIN:VCALENDAR/);
  const other = await download("project=shop&path=notes.txt");
  assert.equal(other.headers.get("content-type"), "application/octet-stream");
  assert.equal(downloadHeaders.attachmentContentType("photo.png"), "application/octet-stream");
});

await check("a calendar file opens (on a phone: its calendar) and a mention of one is a link", () => {
  assert.equal(openable.isOpenableFile("plans/viewing.ics"), true);
  assert.equal(openable.fileMentionPath("viewing.ics"), "viewing.ics");
  assert.equal(openable.isOpenableFile("notes.txt"), false);
});

console.log("\nThe calendar file tool\n");

type ToolResult = { content: Array<{ text?: string }>; details?: Record<string, unknown> };
type Executable = { execute: (...args: unknown[]) => Promise<ToolResult> };
const answerOf = (result: ToolResult) => JSON.parse(result.content.map((part) => part.text ?? "").join("")) as Record<string, unknown>;
const calendarTool = createCalendarFileTool({ cwd: shopDir }) as unknown as Executable;

let written: ToolResult;
await check("the tool writes the file in the working folder and says what it put in", async () => {
  written = await calendarTool.execute("c1", { events: [{ title: "Besichtigung Ölweg", start: "2026-11-03T15:00", reminderMinutes: [60] }], timeZone: "Asia/Almaty" });
  const answer = answerOf(written);
  assert.equal(answer.success, true);
  assert.equal(answer.file, "Besichtigung Ölweg.ics");
  assert.deepEqual(answer.events, [{ title: "Besichtigung Ölweg", start: "2026-11-03T10:00:00.000Z", end: "2026-11-03T11:00:00.000Z" }]);
  assert.match(fs.readFileSync(path.join(shopDir, "Besichtigung Ölweg.ics"), "utf-8"), /DTSTART:20261103T100000Z/);
});

await check("it never writes over a file unless asked to by name, and stays inside the folder", async () => {
  const again = answerOf(await calendarTool.execute("c2", { events: [{ title: "Besichtigung Ölweg", start: "2026-11-04" }] }));
  assert.equal(again.file, "Besichtigung Ölweg-2.ics");
  assert.match(fs.readFileSync(path.join(shopDir, "Besichtigung Ölweg.ics"), "utf-8"), /20261103T100000Z/, "the first file is untouched");
  const replaced = answerOf(await calendarTool.execute("c3", { events: [{ title: "Besichtigung Ölweg", start: "2026-11-05" }], fileName: "Besichtigung Ölweg.ics" }));
  assert.equal(replaced.success, true);
  assert.match(fs.readFileSync(path.join(shopDir, "Besichtigung Ölweg.ics"), "utf-8"), /20261105/);
  for (const fileName of ["../outside.ics", "/tmp/x.ics", "notes.txt", "sub/../../x.ics"]) {
    const refused = answerOf(await calendarTool.execute("c4", { events: [{ title: "x", start: "2026-11-05" }], fileName }));
    assert.equal(refused.success, false, fileName);
  }
  assert.ok(!fs.existsSync(path.join(projectsDir, "outside.ics")));
});

await check("a bad time comes back as a sentence, not an exception", async () => {
  const answer = answerOf(await calendarTool.execute("c5", { events: [{ title: "x", start: "2026-11-03T15:00" }], timeZone: "Nowhere/Here" }));
  assert.equal(answer.success, false);
  assert.match(String(answer.error), /not a known zone/);
});

await check("the turn counts the file it wrote among its files, for the card under the answer", async () => {
  const group = await collectProducedFiles({
    tools: [{ toolName: "eggent_calendar_file", input: {}, output: written, status: "completed" }],
    startedAt: Date.now() - 60_000,
    cwd: shopDir,
    projectId: "shop",
    assistantText: "",
  });
  assert.deepEqual(group?.items.map((item) => item.path), ["Besichtigung Ölweg.ics"]);
});

console.log("\nGoogle, without the service\n");

const session = await createSessionToken("tester", false);
const request = (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; cookie?: boolean } = {}) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method ?? "GET",
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    headers: {
      ...(init.cookie === false ? {} : { cookie: `eggent_auth=${session}` }),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      host: "localhost",
      ...(init.headers ?? {}),
    },
  });

await check("no EGGENT_GOOGLE_API_URL: not enabled, and the card's route says so", async () => {
  assert.equal(googleConfig.googleEnabled(), false);
  const answer = (await (await statusRoute.GET(request("/api/google/status"))).json()) as { enabled: boolean };
  assert.equal(answer.enabled, false);
});

// ---- a stand-in for the deployment's Google service -----------------------------------

const TOKEN = "eggs_test_services_token";
const CONNECT = "https://acme.cloud.example.test/__eggent/google";
const PICK = "https://acme.cloud.example.test/__eggent/google/pick";
const service = {
  calls: [] as Array<{ method: string; path: string; auth: string; body: Record<string, unknown> | null }>,
  connected: false,
  calendar: "on" as "on" | "consent" | "off",
  next: null as null | { status: number; body: Record<string, unknown> },
};
const gateway = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    const route = (req.url || "").replace(/^\/api\/instances\/acme\/google/, "");
    service.calls.push({ method: req.method || "", path: route, auth: String(req.headers.authorization || ""), body });
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "Unauthorized", code: "unauthorized" });
    if (service.next) {
      const next = service.next;
      service.next = null;
      return reply(next.status, next.body);
    }
    if (route === "/status") {
      return reply(200, service.connected
        ? { connected: true, email: "alice@example.test", sheets: true, files: true, calendar: service.calendar, connectUrl: CONNECT, pickUrl: PICK }
        : { connected: false, sheets: false, calendar: service.calendar, connectUrl: CONNECT });
    }
    if (route === "/disconnect") {
      service.connected = false;
      return reply(200, { disconnected: true });
    }
    if (!service.connected) return reply(409, { error: "Google is not connected.", code: "notConnected", connectUrl: CONNECT });
    if (route === "/sheet_create") return reply(200, { spreadsheetId: "1abcdefghijklmnop", title: body?.title, url: "https://sheets.example.test/1abc", tabs: body?.tabs ?? ["Sheet1"] });
    if (route === "/doc_create") return reply(200, { documentId: "1docdocdocdocdoc", fileId: "1docdocdocdocdoc", title: body?.title, kind: "document", url: "https://docs.example.test/1doc" });
    if (route === "/drive_upload") return reply(200, { fileId: "1upupupupupupup", title: body?.name, kind: "file", url: "https://drive.example.test/1up", converted: Boolean(body?.convert) });
    if (route === "/drive_export") {
      return reply(200, {
        file: { fileId: body?.fileId, title: "Q3 plan", kind: "document", url: "https://docs.example.test/q3", origin: "picked" },
        export: { name: "Q3 plan.pdf", mimeType: "application/pdf", size: 9, data: Buffer.from("%PDF-1.4\n").toString("base64") },
      });
    }
    if (route === "/share_link") {
      return reply(202, {
        pending: { id: "8a7e0c52-1111-4222-8333-944455556666", action: "share_link", file: "Q3 plan", status: "pending", waitsIn: "telegram" },
        note: "This needs the owner's yes. They were asked in Telegram.",
      });
    }
    if (route === "/sheet_read") return reply(200, { spreadsheetId: body?.spreadsheetId, range: "Sheet1", rows: 700, values: Array.from({ length: 700 }, (_, index) => [`row ${index}`]) });
    return reply(200, { ok: true });
  });
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
process.env.EGGENT_GOOGLE_API_URL = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/api/instances/acme/google`;
process.env.EGGENT_SERVICES_TOKEN = TOKEN;

const googleTool = createGoogleTool({ cwd: shopDir }) as unknown as Executable;
const runGoogle = async (input: Record<string, unknown>) => answerOf(await googleTool.execute("g", input));

console.log("\nGoogle, with the service\n");

await check("the tool asks with the workspace's services token; not connected: it hands the person the button", async () => {
  assert.equal(googleConfig.googleEnabled(), true);
  const answer = await runGoogle({ action: "status" });
  assert.equal(answer.success, false);
  assert.deepEqual(answer.connect, { url: CONNECT });
  assert.equal(service.calls.at(-1)?.auth, `Bearer ${TOKEN}`);
  assert.equal(link.connectUrlFromToolOutput(JSON.stringify(answer)), CONNECT, "the chat finds the button's address in the answer");
});

await check("the button goes only to this workspace's own address, and comes back to the page it was on", () => {
  const here = { origin: "https://acme.cloud.example.test", pathname: "/dashboard/chat-1", search: "?google=cancelled&x=1" };
  assert.equal(link.connectHref(CONNECT, here), `/__eggent/google?return=${encodeURIComponent("/dashboard/chat-1?x=1")}`);
  assert.equal(link.connectHref("https://evil.example.test/__eggent/google", here), null);
  assert.equal(link.connectHref("javascript:alert(1)", here), null);
  assert.equal(link.connectUrlFromToolOutput("not json"), null);
  assert.equal(link.connectUrlFromToolOutput({ connect: { url: 5 } }), null);
});

await check("a sheet from a CSV file: the file's rows go to the service, quotes and semicolons understood", async () => {
  service.connected = true;
  fs.writeFileSync(path.join(shopDir, "listings.csv"), "\uFEFFAdresse;Zimmer;Notiz\r\nÖlweg 1;3;\"Ecke; mit Balkon\"\r\n\"Haus \"\"5\"\"\";2;\r\n");
  const answer = await runGoogle({ action: "sheet_create", title: "Wohnungen", csvPath: "listings.csv" });
  assert.equal(answer.success, true, JSON.stringify(answer));
  const sent = service.calls.at(-1)!;
  assert.equal(sent.path, "/sheet_create");
  assert.deepEqual(sent.body, { title: "Wohnungen", rows: [["Adresse", "Zimmer", "Notiz"], ["Ölweg 1", "3", "Ecke; mit Balkon"], ["Haus \"5\"", "2", ""]] });
});

await check("a CSV outside the projects folder, or one with credentials, is not read", async () => {
  const outside = path.join(root, "secret.csv");
  fs.writeFileSync(outside, "a,b\n1,2\n");
  const before = service.calls.length;
  for (const csvPath of [outside, "../../secret.csv"]) {
    const answer = await runGoogle({ action: "sheet_append", spreadsheetId: "1abcdefghijklmnop", csvPath });
    assert.equal(answer.success, false, csvPath);
  }
  fs.mkdirSync(path.join(shopDir, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(shopDir, ".ssh", "keys.csv"), "a,b\n");
  const sensitive = await runGoogle({ action: "sheet_append", spreadsheetId: "1abcdefghijklmnop", csvPath: ".ssh/keys.csv" });
  assert.equal(sensitive.success, false);
  assert.equal(service.calls.length, before, "nothing was sent");
});

await check("rows too large for one request are refused before sending; a call without its spreadsheet too", async () => {
  const before = service.calls.length;
  const big = await runGoogle({ action: "sheet_append", spreadsheetId: "1abcdefghijklmnop", rows: [["x".repeat(rowsModule.MAX_ROWS_BYTES)]] });
  assert.equal(big.success, false);
  const noId = await runGoogle({ action: "sheet_read" });
  assert.equal(noId.success, false);
  assert.match(String(noId.error), /spreadsheetId/);
  assert.equal(service.calls.length, before);
});

await check("a long read is cut for the agent, with the rest counted", async () => {
  const answer = await runGoogle({ action: "sheet_read", spreadsheetId: "1abcdefghijklmnop" });
  assert.equal((answer.values as unknown[]).length, 500);
  assert.match(String(answer.note), /200 more rows/);
});

await check("an event goes as the service takes it: wall clock with its zone, whole days ending the day after, a rule", async () => {
  await runGoogle({ action: "event_create", title: "Besichtigung", start: "2026-11-03T15:00", timeZone: "Asia/Almaty", reminderMinutes: [30], repeat: "weekly" });
  assert.deepEqual(service.calls.at(-1)?.body, {
    event: {
      title: "Besichtigung",
      start: { dateTime: "2026-11-03T15:00:00", timeZone: "Asia/Almaty" },
      end: { dateTime: "2026-11-03T16:00:00", timeZone: "Asia/Almaty" },
      reminderMinutes: [30],
      recurrence: ["RRULE:FREQ=WEEKLY"],
    },
  });
  assert.deepEqual(eventFromParams({ title: "Trip", start: "2026-11-03", end: "2026-11-05" }).end, { date: "2026-11-06" });
  assert.deepEqual(eventFromParams({ title: "Late", start: "2026-11-03T23:30", durationMinutes: 90, timeZone: "Europe/Berlin" }).end, { dateTime: "2026-11-04T01:00:00", timeZone: "Europe/Berlin" });
  assert.deepEqual(eventFromParams({ title: "Call", start: "2026-11-03T15:00:00+03:00" }).start, { dateTime: "2026-11-03T12:00:00.000Z" });
  const before = service.calls.length;
  for (const params of [{ title: "x", start: "2026-11-03T15:00" }, { title: "x", start: "2026-11-03T15:00:00Z", repeat: "daily" }, { title: "x", start: "2026-11-03", end: "2026-11-01" }]) {
    const answer = await runGoogle({ action: "event_create", ...params });
    assert.equal(answer.success, false, JSON.stringify(params));
  }
  assert.equal(service.calls.length, before);
});

await check("the service's refusals reach the agent with what to do next", async () => {
  service.next = { status: 409, body: { error: "Calendar needs consent.", code: "calendarConsent", connectUrl: CONNECT } };
  const consent = await runGoogle({ action: "event_list" });
  assert.deepEqual(consent.connect, { url: CONNECT });
  service.next = { status: 403, body: { error: "Calendar is not available.", code: "calendarOff" } };
  const off = await runGoogle({ action: "event_create", title: "x", start: "2026-11-03" });
  assert.match(String(off.note), /eggent_calendar_file/);
  service.next = { status: 403, body: { error: "That spreadsheet was not made here.", code: "notOwnFile" } };
  const notOwn = await runGoogle({ action: "sheet_info", spreadsheetId: "1abcdefghijklmnop" });
  assert.equal(notOwn.code, "notOwnFile");
});

await check("connect, already connected, says so; the calendar's missing permission brings the button back", async () => {
  service.calendar = "on";
  const done = await runGoogle({ action: "connect" });
  assert.equal(done.connected, true);
  assert.equal(done.connect, undefined);
  service.calendar = "consent";
  const again = await runGoogle({ action: "connect" });
  assert.deepEqual(again.connect, { url: CONNECT });
  service.calendar = "on";
});


console.log("\nDocs, Drive and the picker\n");

await check("pick hands the person the Choose from Drive button; the chat finds it, on this workspace's address only", async () => {
  const answer = await runGoogle({ action: "pick" });
  assert.equal(answer.success, true);
  assert.deepEqual(answer.pick, { url: PICK });
  assert.equal(link.pickUrlFromToolOutput(JSON.stringify(answer)), PICK);
  assert.equal(link.connectUrlFromToolOutput(JSON.stringify(answer)), null, "a pick answer is no connect answer");
  const here = { origin: "https://acme.cloud.example.test", pathname: "/dashboard/chat-1", search: "?google=picked&n=2&tab=x" };
  assert.equal(link.connectHref(PICK, here), "/__eggent/google/pick?return=%2Fdashboard%2Fchat-1%3Ftab%3Dx");
  assert.equal(link.connectHref("https://evil.example.test/__eggent/google/pick", here), null);
});

await check("doc_create takes Markdown, or the text of a file of this workspace", async () => {
  fs.writeFileSync(path.join(shopDir, "plan.md"), "# Plan\n- one\n");
  const answer = await runGoogle({ action: "doc_create", title: "Plan", contentPath: "plan.md" });
  assert.equal(answer.success, true, JSON.stringify(answer));
  assert.equal(answer.url, "https://docs.example.test/1doc");
  assert.deepEqual(service.calls.at(-1)?.body, { title: "Plan", content: "# Plan\n- one\n" });
  const both = await runGoogle({ action: "doc_append", documentId: "1docdocdocdocdoc", content: "x", contentPath: "plan.md" });
  assert.equal(both.success, false);
  const none = await runGoogle({ action: "doc_append", documentId: "1docdocdocdocdoc" });
  assert.equal(none.success, false);
});

await check("drive_upload sends the workspace file's bytes, with its own name and extension", async () => {
  fs.writeFileSync(path.join(shopDir, "price list.xlsx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]));
  const answer = await runGoogle({ action: "drive_upload", path: "price list.xlsx", convert: true, name: "Prices" });
  assert.equal(answer.success, true, JSON.stringify(answer));
  const body = service.calls.at(-1)?.body as Record<string, unknown>;
  assert.equal(body.name, "Prices.xlsx", "a name without an extension keeps the file's own");
  assert.equal(body.convert, true);
  assert.deepEqual(Buffer.from(String(body.data), "base64"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]));
});

await check("drive_upload reads no file outside the projects, none with credentials, none too large - before sending", async () => {
  const before = service.calls.length;
  fs.writeFileSync(path.join(root, "outside.txt"), "x");
  fs.writeFileSync(path.join(shopDir, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(shopDir, "huge.bin"), Buffer.alloc(1024 * 1024 + 1));
  for (const target of [path.join(root, "outside.txt"), "../../outside.txt", ".env", "huge.bin", "missing.pdf"]) {
    const answer = await runGoogle({ action: "drive_upload", path: target });
    assert.equal(answer.success, false, target);
  }
  assert.equal(service.calls.length, before);
});

await check("drive_export lands in the project folder under a name the chat can link, never over a file, and in the files card", async () => {
  const startedAt = Date.now();
  const first = await runGoogle({ action: "drive_export", fileId: "1q3q3q3q3q3q3q3", format: "pdf" });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.saved, "Q3-plan.pdf");
  assert.equal(fs.readFileSync(path.join(shopDir, "Q3-plan.pdf"), "utf-8"), "%PDF-1.4\n");
  const second = (await googleTool.execute("g", { action: "drive_export", fileId: "1q3q3q3q3q3q3q3", format: "pdf" })) as ToolResult & { details: Record<string, unknown> };
  assert.equal(answerOf(second).saved, "Q3-plan-2.pdf");
  assert.equal(fs.readFileSync(path.join(shopDir, "Q3-plan.pdf"), "utf-8"), "%PDF-1.4\n");
  const group = await collectProducedFiles({
    tools: [{ toolName: "eggent_google", input: {}, output: second, status: "completed" }],
    startedAt: startedAt - 2000,
    cwd: shopDir,
    projectId: "shop",
    assistantText: "",
  });
  assert.deepEqual(group?.items.map((item) => item.path), ["Q3-plan-2.pdf"]);
});

await check("a change waiting for the owner comes back as pending, with what to tell the person", async () => {
  const answer = await runGoogle({ action: "share_link", fileId: "1q3q3q3q3q3q3q3", role: "writer" });
  assert.equal(answer.success, false);
  assert.equal((answer.pending as Record<string, unknown>).status, "pending");
  assert.match(String(answer.note), /owner/);
  assert.deepEqual(service.calls.at(-1)?.body, { fileId: "1q3q3q3q3q3q3q3", role: "writer" });
});

await check("exportTarget keeps a name inside the folder whatever Drive called the file", async () => {
  const { exportTarget } = await import("../src/lib/google/tool.ts");
  for (const name of ["../../etc/passwd", "..\\evil.pdf", ".hidden.pdf", "a/b/c.pdf"]) {
    const target = await exportTarget(shopDir, name);
    assert.ok(target.absolute.startsWith(shopDir + path.sep), `${name} -> ${target.absolute}`);
    assert.ok(!target.relative.includes("/") && !target.relative.startsWith("."), target.relative);
  }
});

console.log("\nCards that need the deployment\n");

await check("a bundled skill that names requires_env is offered and installed only where that variable is set", async () => {
  const skillsRoot = path.join(root, "app");
  const skillDir = path.join(skillsRoot, "bundled-skills", "your-files");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: your-files\ndescription: Needs the files service.\ncard_order: -2\nrequires_env: EGGENT_TEST_FILES_URL\n---\n# x\n");
  fs.mkdirSync(path.join(skillsRoot, "bundled-skills", "plain"), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "bundled-skills", "plain", "SKILL.md"), "---\nname: plain\ndescription: Always.\ncard_order: 1\n---\n# y\n");
  const cwd = process.cwd();
  process.chdir(skillsRoot);
  try {
    // A fresh copy of the module, so it reads its skills folder from here.
    const fresh = "../src/lib/storage/bundled-skills-store.ts?requires-env";
    const store = (await import(fresh)) as typeof import("../src/lib/storage/bundled-skills-store.ts");
    delete process.env.EGGENT_TEST_FILES_URL;
    assert.deepEqual((await store.listBundledSkills("en")).map((skill) => skill.name), ["plain"]);
    const refused = await store.installBundledSkill("none", "your-files");
    assert.equal(refused.success, false);
    process.env.EGGENT_TEST_FILES_URL = "http://service";
    assert.deepEqual((await store.listBundledSkills("en")).map((skill) => skill.name), ["your-files", "plain"], "a negative card_order leads the row");
  } finally {
    process.chdir(cwd);
    delete process.env.EGGENT_TEST_FILES_URL;
  }
});

console.log("\nThe card's routes\n");

await check("the status route needs a session and says who is connected", async () => {
  const anonymous = await statusRoute.GET(request("/api/google/status", { cookie: false }));
  assert.equal(anonymous.status, 401);
  const answer = (await (await statusRoute.GET(request("/api/google/status"))).json()) as Record<string, unknown>;
  assert.deepEqual(answer, { enabled: true, connected: true, email: "alice@example.test", sheets: true, files: true, calendar: "on", connectUrl: CONNECT, pickUrl: PICK });
});

await check("disconnecting needs a session, JSON and this site; then it asks the service", async () => {
  const before = service.calls.length;
  const foreign = await disconnectRoute.POST(request("/api/google/disconnect", { method: "POST", body: {}, headers: { origin: "https://other.cloud.example.test", "sec-fetch-site": "same-site" } }));
  assert.equal(foreign.status, 403);
  const form = await disconnectRoute.POST(request("/api/google/disconnect", { method: "POST", body: "x=1", headers: { "content-type": "application/x-www-form-urlencoded" } }));
  assert.notEqual(form.status, 200);
  const anonymous = await disconnectRoute.POST(request("/api/google/disconnect", { method: "POST", body: {}, cookie: false }));
  assert.equal(anonymous.status, 401);
  assert.equal(service.calls.length, before, "nothing reached the service");
  const done = await disconnectRoute.POST(request("/api/google/disconnect", { method: "POST", body: {} }));
  assert.equal(done.status, 200);
  const answer = (await done.json()) as Record<string, unknown>;
  assert.equal(answer.connected, false);
  assert.equal(service.calls.at(-2)?.path, "/disconnect");
});

gateway.close();
console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
