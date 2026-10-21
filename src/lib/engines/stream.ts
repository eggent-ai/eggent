/**
 * The small async stream the runtime reads a model's answer from.
 *
 * The runtime's own class is not reachable from here (it sits inside the SDK's
 * dependencies), and a stream is only a queue with an end: events pushed in
 * order, read with `for await`, and one final value read with `result()`. This
 * follows the runtime's behaviour exactly - a push after the end is dropped, a
 * terminal event settles the result - so the runtime cannot tell the two apart.
 */
export class EngineEventStream<T, R> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;
  private final: Promise<R>;
  private settle!: (value: R) => void;
  private readonly isComplete: (event: T) => boolean;
  private readonly extractResult: (event: T) => R;

  // No parameter properties: the tests run this file with types stripped, not compiled.
  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.final = new Promise<R>((resolve) => {
      this.settle = resolve;
    });
  }

  push(event: T): void {
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.settle(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: R): void {
    this.done = true;
    if (result !== undefined) this.settle(result);
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined as unknown as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as T;
      } else if (this.done) {
        return;
      } else {
        const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }

  result(): Promise<R> {
    return this.final;
  }
}
