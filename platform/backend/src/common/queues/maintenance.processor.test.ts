// The one consumer of `platform-maintenance` (PBE-021): it hands each job to the `@MaintenanceJob` handler of its
// schedule, completes a job without a handler with one warning per name, and refuses a decorator for an id that is
// not a schedule and two handlers of one schedule. DiscoveryService and the logger are stand-ins.
import { Injectable } from "@nestjs/common";
import { Reflector, type DiscoveryService } from "@nestjs/core";
import type { Job } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import {
  MaintenanceJob,
  maintenanceHandlers,
  MaintenanceProcessor,
  type MaintenanceJobHandler,
} from "./maintenance.processor";
import { PLATFORM_SCHEDULES } from "./scheduler.registry";

@Injectable()
@MaintenanceJob("api_keys.flush_usage")
class FlushHandler implements MaintenanceJobHandler {
  readonly runs: Job[] = [];

  run(job: Job): Promise<{ flushed: number }> {
    this.runs.push(job);
    return Promise.resolve({ flushed: 1 });
  }
}

@Injectable()
@MaintenanceJob("invitations.expire")
class ExpireHandler implements MaintenanceJobHandler {
  run(): Promise<never> {
    return Promise.reject(new Error("database down"));
  }
}

@Injectable()
class NotAHandler {}

const job = (name: string): Job => ({ name, data: {}, attemptsMade: 0 }) as unknown as Job;
const wrapper = (instance: object) => ({ instance, metatype: instance.constructor });

function processorOver(instances: readonly object[]) {
  const discovery = { getProviders: vi.fn(() => instances.map(wrapper)) };
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const processor = new MaintenanceProcessor(
    discovery as unknown as DiscoveryService,
    new Reflector(),
    logger as unknown as PinoLogger,
  );
  return { processor, discovery, logger };
}

describe("@MaintenanceJob", () => {
  it("accepts every schedule id of PLATFORM_SCHEDULES and refuses any other name", () => {
    for (const { id } of PLATFORM_SCHEDULES) {
      expect(() => MaintenanceJob(id)).not.toThrow();
    }
    expect(() => MaintenanceJob("api_keys.flush")).toThrow(TypeError);
    expect(() => MaintenanceJob("email.sweep")).toThrow(/not a schedule/);
  });
});

describe("maintenanceHandlers", () => {
  it("finds the marked providers by schedule id and leaves the others out", () => {
    const flush = new FlushHandler();
    const expire = new ExpireHandler();

    const handlers = maintenanceHandlers(
      [
        wrapper(flush),
        wrapper(new NotAHandler()),
        wrapper(expire),
        { instance: undefined, metatype: undefined },
      ],
      new Reflector(),
    );

    expect([...handlers.keys()]).toEqual(["api_keys.flush_usage", "invitations.expire"]);
    expect(handlers.get("api_keys.flush_usage")).toBe(flush);
  });

  it("refuses two handlers of one schedule and a marked class without run()", () => {
    @MaintenanceJob("purge.daily")
    class NoRun {}

    expect(() =>
      maintenanceHandlers([wrapper(new FlushHandler()), wrapper(new FlushHandler())], new Reflector()),
    ).toThrow(/two handlers/);
    expect(() => maintenanceHandlers([wrapper(new NoRun())], new Reflector())).toThrow(/no run\(job\)/);
  });
});

describe("MaintenanceProcessor", () => {
  it("runs each job with the handler of its name, found once on the first job", async () => {
    const flush = new FlushHandler();
    const { processor, discovery } = processorOver([flush, new ExpireHandler()]);

    await expect(processor.process(job("api_keys.flush_usage"))).resolves.toEqual({ flushed: 1 });
    await expect(processor.process(job("api_keys.flush_usage"))).resolves.toEqual({ flushed: 1 });

    expect(flush.runs.map(({ name }) => name)).toEqual(["api_keys.flush_usage", "api_keys.flush_usage"]);
    expect(discovery.getProviders).toHaveBeenCalledTimes(1);
  });

  it("fails the job when its handler throws, so BullMQ tries again", async () => {
    const { processor } = processorOver([new ExpireHandler()]);

    await expect(processor.process(job("invitations.expire"))).rejects.toThrow("database down");
  });

  it("completes a job without a handler, with one maintenance.no_handler warning per name", async () => {
    const { processor, logger } = processorOver([new FlushHandler()]);

    for (const name of ["provisioning.reconcile", "provisioning.reconcile", "purge.daily"]) {
      await expect(processor.process(job(name))).resolves.toEqual({ handled: false });
    }

    expect(logger.warn.mock.calls).toEqual([
      [{ queue: "platform-maintenance", job: "provisioning.reconcile" }, "maintenance.no_handler"],
      [{ queue: "platform-maintenance", job: "purge.daily" }, "maintenance.no_handler"],
    ]);
  });
});
