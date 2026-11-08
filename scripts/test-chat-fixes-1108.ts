/**
 * The 2026-11-08 fixes from reading a week of real chats.
 *
 * Run with Node 22: npm run test:chat-fixes
 *
 * - a link to a project file in an answer is a file, not a 404 (akanovsergei98);
 * - files attached to the message being sent are named to the agent (cd2type);
 * - text before and after a question card is not glued into one sentence;
 * - a question put on a board card ends the run instead of being nudged again (pavlenko, panin-e7).
 */
import assert from "node:assert/strict";
import { linkedFile } from "../src/lib/files/openable.ts";
import { freshAttachments, freshAttachmentsNote } from "../src/lib/files/fresh-attachments.ts";
import { paragraphBreak, questionPutOnCard } from "../src/lib/pi/chat-runner.ts";

let failed = 0;
let ran = 0;
function check(name: string, fn: () => void): void {
  ran += 1;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${(error as Error).message}`);
  }
}

check("a relative file link is a file in the open project", () => {
  assert.deepEqual(linkedFile("work/start_samp.ps1", "e5200c1f"), { projectId: "e5200c1f", path: "work/start_samp.ps1" });
  assert.deepEqual(linkedFile("./report.xlsx", "none"), { projectId: "none", path: "report.xlsx" });
});
check("an absolute path in the projects folder resolves to its project", () => {
  assert.deepEqual(linkedFile("/app/data/projects/shop/work/a.docx", "shop"), { projectId: "shop", path: "work/a.docx" });
  assert.deepEqual(linkedFile("/app/data/projects/other/a.docx", "shop"), { projectId: "none", path: "other/a.docx" });
});
check("URLs, anchors, routes and ways out stay links", () => {
  for (const href of ["https://example.test/a.pdf", "mailto:x@example.test", "#top", "/dashboard/files", "../secret.txt", "work/", "settings", "?x=1"]) {
    assert.equal(linkedFile(href, "p"), null, href);
  }
});
check("a percent-encoded name is decoded", () => {
  assert.deepEqual(linkedFile("work/caf%C3%A9.md", "p"), { projectId: "p", path: "work/café.md" });
});

const file = (name: string, at: string) => ({ name, path: `/app/data/chat-files/c/${name}`, size: 1, type: "image", uploadedAt: at });
check("only files that arrived after the last message are named", () => {
  const chat = { messages: [{ id: "1", role: "assistant" as const, content: "", createdAt: "2026-11-04T14:40:00.000Z" }] };
  const fresh = freshAttachments([file("old.png", "2026-11-04T14:30:00.000Z"), file("shot.jpeg", "2026-11-04T14:46:30.000Z")], chat);
  assert.deepEqual(fresh.map((f) => f.name), ["shot.jpeg"]);
  const note = freshAttachmentsNote(fresh) ?? "";
  assert.match(note, /\/app\/data\/chat-files\/c\/shot\.jpeg/);
});
check("a new chat names every file it was started with; none means no note", () => {
  assert.equal(freshAttachments([file("a.png", "2026-11-04T14:30:00.000Z")], null).length, 1);
  assert.equal(freshAttachmentsNote([]), null);
});

check("a new message after a card starts its own paragraph", () => {
  assert.equal(paragraphBreak("pick the goal."), "pick the goal.\n\n");
  assert.equal(paragraphBreak(""), "");
  assert.equal(paragraphBreak("done\n"), "done\n");
});

const ask = (output: string, input: Record<string, unknown>) => ({ toolCallId: "t", toolName: "eggent_ask_user", input, output, status: "completed" as const });
check("a question placed on the card is found with its choices", () => {
  const q = questionPutOnCard([ask('{"success": true, "onCard": true}', { question: "Which topic?", options: ["SEO", "Prices"] })]);
  assert.equal(q, "Which topic?\n\n- SEO\n- Prices");
});
check("a question asked on screen is not a card question", () => {
  assert.equal(questionPutOnCard([ask('{"success": true, "answer": "SEO"}', { question: "?" })]), null);
  assert.equal(questionPutOnCard([]), null);
});

console.log(`\n${ran - failed}/${ran} passed`);
if (failed) process.exit(1);
