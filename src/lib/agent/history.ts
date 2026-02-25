import type { ModelMessage } from "ai";

/**
 * Manage conversation history with size limits
 */
export class History {
  private messages: ModelMessage[] = [];
  private maxMessages: number;

  constructor(maxMessages: number = 100) {
    this.maxMessages = maxMessages;
  }

  add(message: ModelMessage): void {
    this.messages.push(message);
    this.trim();
  }

  addMany(messages: ModelMessage[]): void {
    this.messages.push(...messages);
    this.trim();
  }

  getAll(): ModelMessage[] {
    return [...this.messages];
  }

  getLast(n: number): ModelMessage[] {
    return this.messages.slice(-n);
  }

  clear(): void {
    this.messages = [];
  }

  get length(): number {
    return this.messages.length;
  }

  private trim(): void {
    if (this.messages.length > this.maxMessages) {
      // Keep system messages and trim from the beginning
      const systemMessages = this.messages.filter(
        (m) => m.role === "system"
      );
      const nonSystemMessages = this.messages.filter(
        (m) => m.role !== "system"
      );
      const trimmed = nonSystemMessages.slice(
        nonSystemMessages.length - this.maxMessages + systemMessages.length
      );
      this.messages = [...systemMessages, ...trimmed];
    }
  }

  toJSON(): ModelMessage[] {
    return this.getAll();
  }

  static fromJSON(messages: ModelMessage[], maxMessages?: number): History {
    const history = new History(maxMessages);
    history.messages = messages;
    return history;
  }
}
