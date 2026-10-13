// Test support: a pino destination that keeps every log line in memory, so tests can assert what was (and was not)
// logged. Pass it as `logDestination` to startApi / startWorker or as the destination of createApiLogger.
import { Writable } from "node:stream";

export type LogLine = Record<string, unknown>;

export class MemorySink extends Writable {
  /** The raw JSON lines, in the order they were written. */
  readonly lines: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.lines.push(
      ...chunk
        .toString("utf8")
        .split("\n")
        .filter((line) => line !== ""),
    );
    callback();
  }

  /** The parsed lines. */
  records(): LogLine[] {
    return this.lines.map((line) => JSON.parse(line) as LogLine);
  }

  /** Everything written so far as one string, for "never contains" assertions. */
  text(): string {
    return this.lines.join("\n");
  }
}
