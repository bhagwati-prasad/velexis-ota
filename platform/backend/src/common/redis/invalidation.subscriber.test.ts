// The API's `vx:invalidate` subscriber without Redis (PBE-027): which providers are listeners (`@InvalidationListener()`,
// each instance once, a marked class without `onInvalidation` refused), and what one message does
// (`applyInvalidation`): a valid event reaches every listener in order, a listener that throws is logged and the next
// one still runs, and anything that is not a valid event reaches no listener and is logged without its content.
// test/integration/domains/tls-ask.int.test.ts runs the subscription itself through Redis pub/sub.
import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { InvalidationEvent } from "@velexis/api-types/jobs";
import { describe, expect, it } from "vitest";
import {
  applyInvalidation,
  InvalidationListener,
  invalidationListeners,
  type InvalidationHandler,
} from "./invalidation.subscriber";

/** A listener that records the events it gets in `seen`, under its name. */
@Injectable()
@InvalidationListener()
class RecordingListener implements InvalidationHandler {
  constructor(
    private readonly name: string,
    private readonly seen: string[],
  ) {}

  onInvalidation(event: InvalidationEvent): Promise<void> {
    this.seen.push(`${this.name}:${event.type}`);
    return Promise.resolve();
  }
}

@Injectable()
@InvalidationListener()
class FailingListener implements InvalidationHandler {
  onInvalidation(): Promise<void> {
    return Promise.reject(new Error("Connection is closed."));
  }
}

@Injectable()
@InvalidationListener()
class MarkedWithoutHandler {}

@Injectable()
class NotAListener {
  onInvalidation(): Promise<void> {
    return Promise.resolve();
  }
}

const wrapper = (instance: object) => ({ instance, metatype: instance.constructor });

/** A logger stand-in that keeps the warnings. */
function recordingLogger(): {
  warnings: Array<{ message: string; object: Record<string, unknown> }>;
  warn(object: Record<string, unknown>, message: string): void;
} {
  const warnings: Array<{ message: string; object: Record<string, unknown> }> = [];
  return {
    warnings,
    warn(object, message) {
      warnings.push({ message, object });
    },
  };
}

describe("invalidationListeners", () => {
  it("finds the instances of marked classes, each once, and nothing else", () => {
    const seen: string[] = [];
    const listener = new RecordingListener("tls", seen);

    const listeners = invalidationListeners(
      [
        wrapper(listener),
        // The same instance, exported by a second module.
        wrapper(listener),
        wrapper(new NotAListener()),
        // A value provider and a factory provider.
        { instance: { onInvalidation: () => Promise.resolve() }, metatype: null },
        { instance: listener, metatype: () => listener },
      ],
      new Reflector(),
    );

    expect(listeners).toEqual([listener]);
  });

  it("refuses a marked class without onInvalidation", () => {
    expect(() => invalidationListeners([wrapper(new MarkedWithoutHandler())], new Reflector())).toThrow(
      "@InvalidationListener(): MarkedWithoutHandler has no onInvalidation(event) method",
    );
  });
});

describe("applyInvalidation", () => {
  it("hands a valid event to every listener in order, and goes on after one that throws", async () => {
    const seen: string[] = [];
    const logger = recordingLogger();

    await applyInvalidation(
      JSON.stringify({ v: 1, type: "domain", hostname: "travel.example.net" }),
      [new RecordingListener("first", seen), new FailingListener(), new RecordingListener("last", seen)],
      logger,
    );

    expect(seen).toEqual(["first:domain", "last:domain"]);
    expect(logger.warnings).toEqual([
      {
        message: "invalidation.listener_failed",
        object: { type: "domain", listener: "FailingListener", err: expect.any(Error) },
      },
    ]);
  });

  it("refuses a message that is not JSON or not a valid event, without its content, and calls no listener", async () => {
    const seen: string[] = [];
    const logger = recordingLogger();
    const listeners = [new RecordingListener("tls", seen)];

    await applyInvalidation("{not json", listeners, logger);
    await applyInvalidation(
      JSON.stringify({ v: 1, type: "domain", hostname: "Bad Host" }),
      listeners,
      logger,
    );

    expect(seen).toEqual([]);
    expect(logger.warnings.map(({ message, object }) => [message, object["reason"]])).toEqual([
      ["invalidation.refused", "malformed_json"],
      ["invalidation.refused", "invalid_event"],
    ]);
    expect(logger.warnings[1]?.object["issues"]).toEqual([
      expect.objectContaining({ path: "/hostname", keyword: "pattern" }),
    ]);
    expect(JSON.stringify(logger.warnings)).not.toContain("Bad Host");
    expect(JSON.stringify(logger.warnings)).not.toContain("not json");
  });
});
