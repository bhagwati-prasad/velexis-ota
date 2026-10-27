// Test support (OBE-052): every log line the API and the worker write during a test, in one place, for "never contains"
// checks (pan-scanner.ts; ota/docs/flows/checkout-airline-card.md §7).
//
// The two processes log through pino into MemorySinks (test/helpers/log-sink.ts): the worker's logger gets a sink from
// `destination()`, and the API's logger, which createTestApp builds with a sink of its own, is adopted with `attach()`.
// On top of the pino lines, `start()` records what anything in this process writes to the console or straight to
// stdout and stderr until `stop()`: application code never does (it logs through the injected logger, AGENTS.md §8), so
// such a write is a log line nobody redacted, and it is scanned like the others. The writes still reach their usual
// destination. A write to file descriptor 1 or 2 itself (`fs.writeSync(1, …)`, as pino's default destination writes)
// passes `process.stdout` by and is not seen: that is why both loggers under test write to MemorySinks, and why the
// PAN-absence test checks that each of them wrote lines (`counts()`).
//
//   const logs = new LogCapture();
//   const api = await createTestApp({ ... });
//   logs.attach("api", api.sink);
//   const logger = createWorkerLogger(config, logs.destination("worker"));
//   logs.start();
//   ...
//   scanner.scanLogs(logs.lines());
//   logs.stop();
import { format, inspect } from "node:util";
import { MemorySink } from "../helpers/log-sink";

/** One captured line: which process or stream wrote it, its position there, and its text. */
export interface CapturedLine {
  /** `api`, `worker` (pino), `console` or `stdout`/`stderr` (direct writes). */
  readonly source: string;
  /** 1-based line number within its source. */
  readonly line: number;
  readonly text: string;
}

/** The console methods that print, which `start()` records. */
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace", "dir"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

type Write = typeof process.stdout.write;

export class LogCapture {
  readonly #sinks = new Map<string, MemorySink>();
  readonly #direct: Array<{ readonly source: string; readonly text: string }> = [];
  #restore: (() => void) | undefined;

  /** A new pino destination for `source`, captured from now on: pass it to createWorkerLogger or createApiLogger. */
  destination(source: string): MemorySink {
    const sink = new MemorySink();
    this.attach(source, sink);
    return sink;
  }

  /** Adopts the sink of a logger built elsewhere (createTestApp's `api.sink`): its lines so far and from now on. */
  attach(source: string, sink: MemorySink): void {
    if (this.#sinks.has(source)) {
      throw new Error(`LogCapture: a sink for "${source}" is already attached`);
    }
    this.#sinks.set(source, sink);
  }

  /**
   * Starts recording console calls and direct writes to stdout and stderr in this process, until `stop()`. Idempotent.
   * The original methods still run, so nothing the test runner shows is lost.
   */
  start(): void {
    if (this.#restore !== undefined) {
      return;
    }
    const restorers: Array<() => void> = [];
    // The process's console object, whose methods are wrapped here, not called to print anything: `no-console` keeps
    // the code under test from printing, and this records whether it did.
    const target = globalThis.console;
    for (const method of CONSOLE_METHODS) {
      const original = target[method] as (...args: unknown[]) => void;
      const recorded = (...args: unknown[]): void => {
        this.#direct.push({ source: "console", text: printed(method, args) });
        original.apply(target, args);
      };
      target[method] = recorded;
      restorers.push(() => {
        target[method] = original;
      });
    }
    for (const [source, stream] of [
      ["stdout", process.stdout],
      ["stderr", process.stderr],
    ] as const) {
      const original: Write = stream.write;
      const recorded = (chunk: unknown, ...rest: unknown[]): boolean => {
        this.#direct.push({ source, text: chunkText(chunk) });
        return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
      };
      stream.write = recorded as Write;
      restorers.push(() => {
        stream.write = original;
      });
    }
    this.#restore = () => {
      for (const restore of restorers.reverse()) {
        restore();
      }
    };
  }

  /** Stops recording console calls and direct writes (what was recorded stays). Idempotent. */
  stop(): void {
    this.#restore?.();
    this.#restore = undefined;
  }

  /** Every captured line so far: each sink's lines in order, then the console and direct writes in order. */
  lines(): CapturedLine[] {
    const lines: CapturedLine[] = [];
    for (const [source, sink] of this.#sinks) {
      sink.lines.forEach((text, index) => lines.push({ source, line: index + 1, text }));
    }
    const counts = new Map<string, number>();
    for (const { source, text } of this.#direct) {
      const line = (counts.get(source) ?? 0) + 1;
      counts.set(source, line);
      lines.push({ source, line, text });
    }
    return lines;
  }

  /** How many lines each source has captured so far (pino sinks, the console and direct writes). */
  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { source } of this.lines()) {
      counts[source] = (counts[source] ?? 0) + 1;
    }
    return counts;
  }
}

/** What a console method prints for `args`, as Node's console formats it. */
function printed(method: ConsoleMethod, args: readonly unknown[]): string {
  if (method === "dir") {
    return inspect(args[0], { depth: null });
  }
  return format(...args);
}

/** The text of a chunk written to a stream. */
function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
  }
  return String(chunk);
}
