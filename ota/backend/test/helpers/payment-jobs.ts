// Test support: runs a delayed job of `ota-payments` now and answers how the worker finished it (FIX-W29-OTA).
//
//   const ended = await runDelayedPaymentJob(worker, paymentsQueue, `capture-retry-${paymentId}`);
//   expect(ended).toEqual({ state: "completed", returnvalue: expect.objectContaining({ outcome: "applied" }) });
//
// A capture retry is queued 10 minutes later, and so is the safety net a record step adds before its commit
// (payments.processor.ts `safetyNetJob`); the helper waits for the job to exist, promotes it and waits for the worker's
// `completed` event of its id (or its last `failed` one). A safety net is removed once it completed
// (`removeOnComplete`), so its end is read from the worker's events, never from the queue.
import type { INestApplicationContext } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { PaymentsProcessor } from "../../src/payments/payments.processor";

/** A job of `ota-payments` as the worker finished it: its result, or the error of its last attempt. */
export interface FinishedPaymentJob {
  readonly state: "completed" | "failed";
  readonly returnvalue: unknown;
}

/** How long the helper waits at most, and how often it looks. */
const WAIT_MS = 20_000;
const POLL_MS = 25;

async function until<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`runDelayedPaymentJob: ${what} did not happen within ${WAIT_MS} ms`);
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

/**
 * Runs the job `id` of `queue` (`ota-payments`, consumed by `worker`'s PaymentsProcessor) now, promoting it while it is
 * delayed, and answers how the worker finished it.
 */
export async function runDelayedPaymentJob(
  worker: INestApplicationContext,
  queue: Queue,
  id: string,
): Promise<FinishedPaymentJob> {
  const bullWorker = worker.get(PaymentsProcessor, { strict: false }).worker;
  let ended: FinishedPaymentJob | undefined;
  const onCompleted = (job: Job, result: unknown): void => {
    if (job.id === id) {
      ended = { state: "completed", returnvalue: result };
    }
  };
  const onFailed = (job: Job | undefined, error: Error): void => {
    if (job?.id === id && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      ended = { state: "failed", returnvalue: error.message };
    }
  };
  bullWorker.on("completed", onCompleted);
  bullWorker.on("failed", onFailed);
  try {
    const job = await until(`the job ${id}`, async () => (await queue.getJob(id)) ?? undefined);
    if ((await job.getState()) === "delayed") {
      await job.promote();
    }
    return await until(`the end of the job ${id}`, () => Promise.resolve(ended));
  } finally {
    bullWorker.off("completed", onCompleted);
    bullWorker.off("failed", onFailed);
  }
}
