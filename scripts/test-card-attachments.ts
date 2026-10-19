/**
 * A question card can be answered with a file.
 *
 * Run with Node 22:
 *   npm run test:card-attachments
 *
 * The composer's paperclip was switched off while a card was open, so a card
 * asking for a sample ("attach the contract and tick below") could not be
 * answered at all. The paperclip now works under a card, and the card's tool
 * reports what arrived in the chat while it waited - the file is the answer, and
 * often the only one, since nothing needs typing once it is attached.
 *
 * Drives the real `eggent_ask_user` tool and the real chat-files store.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "eggent-card-files-"));
process.chdir(root);
fs.mkdirSync(path.join(root, "data", "projects"), { recursive: true });
process.env.EGGENT_LEARNING = "off";

const { createEggentPiTools } = await import("../src/lib/pi/eggent-tools.ts");
const { respondToPendingInteraction } = await import("../src/lib/pi/pending-interactions.ts");
const { saveChatFile, getChatFilesDir } = await import("../src/lib/storage/chat-files-store.ts");

type ToolLike = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> };
type Card = { id: string; runId: string; status: string };

/**
 * Opens a card in chat `chatId`, lets `whileOpen` act as the person, then
 * answers with `value` and returns the tool's result.
 */
async function askAndAnswer(
  chatId: string,
  whileOpen: () => Promise<void>,
  value: string,
  params: Record<string, unknown> = { question: "Send me the sample", options: ["I will attach a file", "I will paste the text"] }
): Promise<Record<string, unknown>> {
  let card: Card | undefined;
  const { tools } = await createEggentPiTools({
    chatId,
    scopeId: "none",
    cwd: path.join(root, "data", "projects"),
    interactive: true,
    runId: `run-${chatId}`,
    onPiInteraction: (interaction: Card) => {
      if (interaction.status === "pending") card ??= interaction;
    },
  } as never);
  const ask = (tools as unknown as ToolLike[]).find((tool) => tool.name === "eggent_ask_user");
  if (!ask) throw new Error("no eggent_ask_user");
  const pending = ask.execute("call-1", params, undefined, undefined, undefined);
  for (let i = 0; i < 50 && !card; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!card) throw new Error("the card was never raised");
  await whileOpen();
  respondToPendingInteraction(card.runId, card.id, { value });
  const result = await pending;
  return JSON.parse(result.content.map((part) => part.text ?? "").join("")) as Record<string, unknown>;
}

console.log("A question card answered with a file\n");

await check("a file attached while the card is open comes back with the answer, by path", async () => {
  const result = await askAndAnswer("chat-a", async () => {
    await saveChatFile("chat-a", Buffer.from("PK sample"), "Contrato de alquiler (señal).docx");
  }, "");
  assert.equal(result.success, true);
  const files = result.files as Array<{ name: string; path: string; size: number }>;
  assert.ok(Array.isArray(files), "files must be listed");
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "Contrato de alquiler (señal).docx");
  assert.equal(files[0].path, path.join(getChatFilesDir("chat-a"), "Contrato de alquiler (señal).docx"));
  assert.ok(fs.existsSync(files[0].path), "the path must open");
  assert.match(String(result.note), /attached/);
});

await check("a typed answer and a file arrive together", async () => {
  const result = await askAndAnswer("chat-b", async () => {
    await saveChatFile("chat-b", Buffer.from("a,b"), "prices.csv");
  }, "here is the list");
  assert.equal(result.answer, "here is the list");
  assert.deepEqual((result.files as Array<{ name: string }>).map((file) => file.name), ["prices.csv"]);
});

await check("a tap on an option with a file attached carries the file too", async () => {
  const result = await askAndAnswer("chat-c", async () => {
    await saveChatFile("chat-c", Buffer.from("x"), "scan.pdf");
  }, "I will attach a file");
  assert.equal(result.answer, "I will attach a file");
  assert.deepEqual((result.files as Array<{ name: string }>).map((file) => file.name), ["scan.pdf"]);
});

await check("files that were in the chat before the card are not reported as the answer", async () => {
  const old = await saveChatFile("chat-d", Buffer.from("old"), "earlier.txt");
  const past = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(old.path, past, past);
  const result = await askAndAnswer("chat-d", async () => {}, "no file");
  assert.equal(result.answer, "no file");
  assert.equal(result.files, undefined);
});

await check("an answer with no file is the same as before", async () => {
  const result = await askAndAnswer("chat-e", async () => {}, "I will paste the text");
  assert.deepEqual(Object.keys(result).sort(), ["answer", "kind", "success"]);
});

await check("the tool tells the model a card can receive a file", async () => {
  const { tools } = await createEggentPiTools({ chatId: "chat-f", scopeId: "none", cwd: path.join(root, "data", "projects") } as never);
  const ask = (tools as unknown as Array<{ name: string; description: string }>).find((tool) => tool.name === "eggent_ask_user");
  assert.match(String(ask?.description), /attach files while the card is open/);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
