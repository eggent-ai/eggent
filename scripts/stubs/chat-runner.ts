/**
 * Stands in for the chat runner in tests.
 *
 * The real one runs a model. A test of where a message lands needs only the
 * other half of a turn: the person's message and an answer written into the
 * chat that was asked to run, plus - when a test says so - a tool result the
 * caller reads afterwards, such as the agent moving the conversation.
 * `globalThis.__eggentTestRuns` collects which chat each turn ran in.
 */
import { getChat, saveChat } from "../../src/lib/storage/chat-store.ts";

type TestRunner = {
  reply?: string;
  /** A tool message to leave behind, as JSON the caller will parse. */
  toolResult?: { toolName: string; payload: Record<string, unknown> };
};

export async function joinActiveRun(): Promise<null> {
  return null;
}

export async function runPiAgentText(options: { chatId: string; userMessage: string }): Promise<string> {
  const holder = globalThis as { __eggentTestRunner?: TestRunner; __eggentTestRuns?: string[] };
  const runner = holder.__eggentTestRunner || {};
  (holder.__eggentTestRuns ??= []).push(options.chatId);
  const reply = runner.reply ?? `answer in ${options.chatId}`;
  const chat = await getChat(options.chatId);
  if (chat) {
    const now = new Date().toISOString();
    chat.messages.push({ id: crypto.randomUUID(), role: "user", content: options.userMessage, createdAt: now });
    if (runner.toolResult) {
      chat.messages.push({
        id: crypto.randomUUID(),
        role: "tool",
        content: JSON.stringify(runner.toolResult.payload),
        createdAt: now,
        toolName: runner.toolResult.toolName,
        toolCallId: crypto.randomUUID(),
        toolResult: runner.toolResult.payload,
      });
    }
    chat.messages.push({ id: crypto.randomUUID(), role: "assistant", content: reply, createdAt: now });
    chat.updatedAt = now;
    await saveChat(chat);
  }
  return reply;
}
