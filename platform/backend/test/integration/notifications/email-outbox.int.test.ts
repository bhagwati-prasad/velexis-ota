// The platform e-mail outbox end to end (PBE-011; PADR-0013, ADR-0017): the API queues e-mails in its transactions
// (createTestApp with NotificationsModule and a test-only route, on this file's own database clone), and the worker's
// module graph (WorkerModule, as dist/worker.js builds it, with the same FakeClock) sends them through SMTP to Mailpit.
// The worker reaches Mailpit through a small TCP proxy of this file, so a test can make SMTP unreachable (the proxy
// resets every connection) and reachable again. A retry is not waited for: the test promotes the delayed BullMQ job,
// which is what the 30-second backoff would do. Every test writes to recipients of its own (`uniqueEmail`).
import { randomBytes } from "node:crypto";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { getQueueToken } from "@nestjs/bullmq";
import { Body, Controller, Inject, Post } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { DecryptionError } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { extractLinks, mailpit, uniqueEmail, waitForMessage } from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Clock } from "../../../src/common/clock";
import { EnvelopeService } from "../../../src/common/crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../../../src/common/database";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { runInTransaction } from "../../../src/common/redis/invalidation.publisher";
import { createProcessLogger, PLATFORM_PROCESSES, type PlatformBackendConfig } from "../../../src/config";
import {
  EMAIL_SWEEP_EVERY_MS,
  EMAIL_SWEEP_JOB,
  EmailProcessor,
  SWEEP_PENDING_AGE_MS,
} from "../../../src/notifications/email.processor";
import { NotificationsModule } from "../../../src/notifications/notifications.module";
import { OutboxRepository, type EmailOutboxRow } from "../../../src/notifications/outbox.repository";
import {
  idempotentEmailId,
  InvalidEmailError,
  OutboxService,
  secretPayloadPlace,
  type QueueEmailInput,
  type QueuedEmail,
} from "../../../src/notifications/outbox.service";
import { EmailVariablesError } from "../../../src/notifications/templates";
import { WorkerModule } from "../../../src/worker.module";
import { createTestApp, LogSink, type TestApp } from "../../support/app";

/**
 * Starting the API on a database clone and the worker's module graph takes about two seconds alone; the bound allows
 * for the parallel load of `pnpm test:int` on a 4-CPU CI runner.
 */
const SETUP_TIMEOUT_MS = 60_000;
/** A test that sends through SMTP and waits for Mailpit, up to five attempts; seconds alone, bounded for CI load. */
const SEND_TEST_TIMEOUT_MS = 60_000;
/** How long `waitFor` and `waitForMessage` wait for the worker. */
const WAIT_MS = 20_000;

/** The development SMTP_URL (Mailpit) of the environment, where the proxy forwards. */
function mailpitSmtp(): { readonly host: string; readonly port: number } {
  loadDevEnvFiles({ appDir: resolve(__dirname, "..", "..", "..") });
  const { SMTP_URL } = defineConfig({ SMTP_URL: env.url({ protocols: ["smtp:"] }) });
  const url = new URL(SMTP_URL);
  return { host: url.hostname, port: Number(url.port === "" ? 25 : url.port) };
}

/**
 * A TCP proxy on 127.0.0.1 in front of Mailpit's SMTP port. `down()` makes SMTP unreachable for new connections (each
 * is reset at once, as a refused connection fails the send); `up()` forwards them again.
 */
class SmtpProxy {
  private reachable = true;
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;

  private constructor(private readonly target: { readonly host: string; readonly port: number }) {
    this.server = createServer((client) => this.accept(client));
  }

  static async start(target: { readonly host: string; readonly port: number }): Promise<SmtpProxy> {
    const proxy = new SmtpProxy(target);
    await new Promise<void>((done) => proxy.server.listen(0, "127.0.0.1", done));
    return proxy;
  }

  /** `smtp://127.0.0.1:<port>`, the worker's SMTP_URL. */
  get url(): string {
    return `smtp://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  down(): void {
    this.reachable = false;
  }

  up(): void {
    this.reachable = true;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  private accept(client: Socket): void {
    if (!this.reachable) {
      client.resetAndDestroy();
      return;
    }
    const upstream = connect(this.target.port, this.target.host);
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  }
}

/** Calls `check` every 50 ms until it returns a value other than `undefined`, at most WAIT_MS. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor: ${what} did not happen within ${WAIT_MS} ms`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

/** A secret token, as the auth flows make them (256 bits, base64url). */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

interface QueueRequest {
  readonly email: QueueEmailInput;
  /** Throw after queuing, so the transaction rolls back. */
  readonly fail?: boolean;
}

/** Test-only route: queues one e-mail in a transaction of velexis_platform_app, as the API's modules will. */
@Controller("test/outbox")
class OutboxTestController {
  constructor(
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    private readonly outbox: OutboxService,
  ) {}

  @Post("queue")
  async queue(@Body() body: QueueRequest): Promise<QueuedEmail> {
    return runInTransaction(this.db, async (trx) => {
      const queued = await this.outbox.queue(trx, body.email);
      if (body.fail === true) {
        throw new AppError("CONFLICT", { message: "The test route rolls its transaction back." });
      }
      return queued;
    });
  }
}

let t: TestApp;
let db: PlatformDb;
let outbox: OutboxService;
let emails: Queue;
let proxy: SmtpProxy;
let worker: TestingModule;
let processor: EmailProcessor;
const workerLogs = new LogSink();

/**
 * Every line both applications logged. nestjs-pino keeps one logger per process for lines written outside a request
 * (the first application's), so most of the worker's lines are in the API's sink.
 */
function logLines(msg?: string): Array<Record<string, unknown>> {
  const lines = [...t.logs.lines, ...workerLogs.lines];
  return msg === undefined ? lines : lines.filter((line) => line["msg"] === msg);
}

beforeAll(async () => {
  t = await createTestApp({
    imports: [NotificationsModule],
    controllers: [OutboxTestController],
    // Every line at every level is captured, so "no log line holds the token" (AC3) covers the debug and trace lines
    // too; the worker below runs with the same configuration.
    env: { LOG_LEVEL: "trace" },
  });
  db = t.app.get<PlatformDb>(PLATFORM_DB);
  outbox = t.app.get(OutboxService, { strict: false });
  emails = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.emails), { strict: false });
  proxy = await SmtpProxy.start(mailpitSmtp());
  // The worker of dist/worker.js on the same database, Redis, key folder and clock, sending through the proxy.
  const config: PlatformBackendConfig = { ...t.config, SMTP_URL: proxy.url };
  const logger = createProcessLogger(PLATFORM_PROCESSES.worker, config, workerLogs);
  worker = await Test.createTestingModule({ imports: [WorkerModule.forRoot(config, logger)] })
    .overrideProvider(Clock)
    .useValue(t.clock)
    .compile();
  await worker.init();
  processor = worker.get(EmailProcessor, { strict: false });
  // The sweep's job scheduler is registered in the background when the worker starts; wait for it, so every test
  // starts from the same state.
  await waitFor("the sweep scheduler to be registered", () =>
    Promise.resolve(logLines("email.sweep_registered").length > 0 ? true : undefined),
  );
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await proxy?.close();
  await t?.close();
}, SETUP_TIMEOUT_MS);

async function queueByRoute(email: QueueEmailInput, fail = false): Promise<QueuedEmail> {
  const res = await t.http
    .post("/test/outbox/queue")
    .send({ email, fail })
    .expect(fail ? 409 : 201);
  return res.body as QueuedEmail;
}

async function row(emailId: string): Promise<EmailOutboxRow | undefined> {
  return db.selectFrom("platform.email_outbox").selectAll().where("id", "=", emailId).executeTakeFirst();
}

/** Waits until the row of `emailId` satisfies `done`, and returns it. */
function waitForRow(
  emailId: string,
  what: string,
  done: (row: EmailOutboxRow) => boolean,
): Promise<EmailOutboxRow> {
  return waitFor(what, async () => {
    const current = await row(emailId);
    return current !== undefined && done(current) ? current : undefined;
  });
}

/** Waits until the e-mail's BullMQ job waits for its next attempt, then lets it run now (what the backoff does). */
async function promoteRetry(emailId: string): Promise<void> {
  const job = await waitFor(`the job of ${emailId} to be delayed`, async () => {
    const found = await emails.getJob(emailId);
    return found !== undefined && (await found.getState()) === "delayed" ? found : undefined;
  });
  await job.promote();
}

function verifyEmail(to: string, token: string): QueueEmailInput {
  return {
    templateKey: "auth.verify_email",
    to,
    data: { fullName: "Ana <Lima> & Co" },
    secretData: { verifyUrl: `http://localhost:3000/verify-email?token=${token}` },
  };
}

function invitation(to: string, token: string, idempotencyKey?: string): QueueEmailInput {
  return {
    templateKey: "team.invitation",
    to,
    data: { tenantName: "Acme Travel", inviterName: "Lena Holm", role: "admin" },
    secretData: { acceptUrl: `http://localhost:3000/invitations/accept?token=${token}` },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

/** Every value of every key of this file's Redis database, as text. */
async function redisContents(): Promise<string> {
  const client = t.redis.client;
  const parts: string[] = [];
  for (const key of await client.keys("*")) {
    const type = await client.type(key);
    if (type === "string") {
      parts.push(key, (await client.get(key)) ?? "");
    } else if (type === "hash") {
      parts.push(key, JSON.stringify(await client.hgetall(key)));
    } else if (type === "list") {
      parts.push(key, JSON.stringify(await client.lrange(key, 0, -1)));
    } else if (type === "set") {
      parts.push(key, JSON.stringify(await client.smembers(key)));
    } else if (type === "zset") {
      parts.push(key, JSON.stringify(await client.zrange(key, 0, -1)));
    } else if (type === "stream") {
      parts.push(key, JSON.stringify(await client.xrange(key, "-", "+")));
    } else {
      parts.push(key, type);
    }
  }
  return parts.join("\n");
}

describe("e-mail outbox", () => {
  it(
    "[PBE-011 AC1] a queued e-mail arrives in Mailpit with its link; the row is then sent with a null ciphertext",
    async () => {
      const to = uniqueEmail("verify");
      const token = newToken();
      const email = verifyEmail(to, token);

      const queued = await queueByRoute(email);

      expect(queued).toEqual({
        emailId: expect.stringMatching(/^eml_[0-9A-HJKMNP-TV-Z]{26}$/),
        queued: true,
      });
      const message = await waitForMessage({
        to,
        subject: "Confirm your e-mail address for Velexis",
        timeoutMs: WAIT_MS,
      });
      expect(extractLinks(message)).toContain(email.secretData?.["verifyUrl"]);
      expect(message.Text).toContain(`http://localhost:3000/verify-email?token=${token}`);
      expect(message.HTML).toContain("Hello Ana &lt;Lima&gt; &amp; Co,");
      expect(message.From).toEqual({ Name: "Velexis", Address: "no-reply@mail.platform.example.com" });
      expect(message.MessageID).toBe(`${queued.emailId}@mail.platform.example.com`);

      const sent = await waitForRow(
        queued.emailId,
        "the row to be sent",
        (current) => current.status === "sent",
      );
      expect(sent).toMatchObject({
        template: "auth.verify_email",
        to_email: to,
        data: { fullName: "Ana <Lima> & Co" },
        secret_payload_ciphertext: null,
        attempts: 1,
        last_error: null,
        provider_message_id: `<${queued.emailId}@mail.platform.example.com>`,
        sent_at: t.clock.now(),
        secrets_purged_at: t.clock.now(),
      });
    },
    SEND_TEST_TIMEOUT_MS,
  );

  it(
    "[PBE-011 AC2] with SMTP unreachable the row stays pending, and it is sent once SMTP answers again",
    async () => {
      const to = uniqueEmail("invite");
      const token = newToken();
      let queued: QueuedEmail;
      proxy.down();
      try {
        queued = await queueByRoute(invitation(to, token));

        const pending = await waitForRow(
          queued.emailId,
          "the first attempt to fail",
          (current) => current.attempts === 1 && current.status === "pending",
        );
        expect(pending.last_error).toMatch(/^E[A-Z]+( |$)/);
        // The secret link is stored only encrypted, bound to this row (ADR-0010).
        const ciphertext = pending.secret_payload_ciphertext;
        expect(ciphertext).not.toBeNull();
        expect(ciphertext?.includes(Buffer.from(token))).toBe(false);
        const envelope = t.app.get(EnvelopeService);
        await expect(
          envelope.decryptJson(ciphertext ?? Buffer.alloc(0), secretPayloadPlace(queued.emailId)),
        ).resolves.toEqual({
          acceptUrl: `http://localhost:3000/invitations/accept?token=${token}`,
        });
        await expect(
          envelope.decryptJson(
            ciphertext ?? Buffer.alloc(0),
            secretPayloadPlace(idempotentEmailId("x.y", to, "z")),
          ),
        ).rejects.toBeInstanceOf(DecryptionError);
        await promoteRetry(queued.emailId);
        await waitForRow(
          queued.emailId,
          "the second attempt to fail",
          (current) => current.attempts === 2 && current.status === "pending",
        );
        expect(await mailpit.search({ to })).toEqual([]);
      } finally {
        proxy.up();
      }

      const queuedId = queued.emailId;
      await promoteRetry(queuedId);
      const message = await waitForMessage({
        to,
        subject: "Lena Holm invited you to Acme Travel on Velexis",
        timeoutMs: WAIT_MS,
      });
      expect(extractLinks(message)).toContain(`http://localhost:3000/invitations/accept?token=${token}`);
      const sent = await waitForRow(queuedId, "the row to be sent", (current) => current.status === "sent");
      expect(sent).toMatchObject({
        attempts: 3,
        secret_payload_ciphertext: null,
        last_error: expect.stringMatching(/^E/),
      });
      expect(sent.secrets_purged_at).not.toBeNull();
    },
    SEND_TEST_TIMEOUT_MS,
  );

  it(
    "[PBE-011 AC3] no captured log line and no BullMQ job payload contains the token",
    async () => {
      const delivered = { to: uniqueEmail("secret-ok"), token: newToken() };
      const retried = { to: uniqueEmail("secret-retry"), token: newToken() };

      const first = await queueByRoute(verifyEmail(delivered.to, delivered.token));
      await waitForMessage({ to: delivered.to, timeoutMs: WAIT_MS });
      proxy.down();
      let second: QueuedEmail;
      try {
        second = await queueByRoute(invitation(retried.to, retried.token));
        await waitForRow(
          second.emailId,
          "the attempt to fail",
          (current) => current.attempts === 1 && current.status === "pending",
        );
      } finally {
        proxy.up();
      }
      await promoteRetry(second.emailId);
      await waitForMessage({ to: retried.to, timeoutMs: WAIT_MS });
      for (const emailId of [first.emailId, second.emailId]) {
        // Completed: the processor has marked the row sent and written its last line.
        const job = await waitFor(`the job of ${emailId} to complete`, async () => {
          const found = await emails.getJob(emailId);
          return found !== undefined && (await found.getState()) === "completed" ? found : undefined;
        });
        // The job carries the e-mail id and nothing else (ADR-0009).
        expect(job.data).toEqual({ emailId });
        expect((await row(emailId))?.status).toBe("sent");
      }

      const captured = JSON.stringify(logLines());
      const stored = await redisContents();
      for (const token of [delivered.token, retried.token]) {
        expect(captured).not.toContain(token);
        expect(stored).not.toContain(token);
      }
      // The log lines name the e-mail, never the recipient.
      expect(logLines("email.sent").map((line) => line["emailId"])).toEqual(
        expect.arrayContaining([first.emailId, second.emailId]),
      );
      expect(captured).not.toContain(delivered.to);
      expect(captured).not.toContain(retried.to);
    },
    SEND_TEST_TIMEOUT_MS,
  );

  it(
    "after the last attempt the row is failed and its secrets are erased in the same update",
    async () => {
      const to = uniqueEmail("give-up");
      proxy.down();
      try {
        const queued = await queueByRoute(invitation(to, newToken()));
        for (let attempt = 1; attempt < 5; attempt += 1) {
          await waitForRow(
            queued.emailId,
            `attempt ${attempt} to fail`,
            (current) => current.attempts === attempt,
          );
          await promoteRetry(queued.emailId);
        }

        const failed = await waitForRow(
          queued.emailId,
          "the row to fail",
          (current) => current.status === "failed",
        );
        expect(failed).toMatchObject({
          attempts: 5,
          secret_payload_ciphertext: null,
          secrets_purged_at: t.clock.now(),
          last_error: expect.stringMatching(/^E[A-Z]+/),
        });
        await waitFor("the job to fail", async () =>
          (await (await emails.getJob(queued.emailId))?.getState()) === "failed" ? true : undefined,
        );
        expect(
          logLines("email.send_failed").filter((line) => line["emailId"] === queued.emailId),
        ).toHaveLength(5);
      } finally {
        proxy.up();
      }
    },
    SEND_TEST_TIMEOUT_MS,
  );

  it(
    "queues an e-mail with an idempotency key once, also from two concurrent transactions",
    async () => {
      const to = uniqueEmail("welcome");
      const email: QueueEmailInput = {
        templateKey: "tenant.welcome",
        to,
        data: { fullName: "Ana Lima", tenantName: "Acme Travel", tenantKey: "acme" },
        idempotencyKey: "job_01JTESTWELCOME000000000000",
      };

      const [a, b] = await Promise.all([queueByRoute(email), queueByRoute(email)]);
      const again = await queueByRoute(email);

      const id = idempotentEmailId("tenant.welcome", to, "job_01JTESTWELCOME000000000000");
      expect([a, b].map((queued) => queued.queued).sort()).toEqual([false, true]);
      expect([a.emailId, b.emailId, again.emailId]).toEqual([id, id, id]);
      expect(again.queued).toBe(false);
      await waitForRow(id, "the row to be sent", (current) => current.status === "sent");
      expect(await mailpit.search({ to })).toHaveLength(1);
      // Another template with the same key is another e-mail.
      const other = await queueByRoute({ ...email, templateKey: "tenant.resumed" });
      expect(other).toEqual({
        emailId: idempotentEmailId("tenant.resumed", to, email.idempotencyKey ?? ""),
        queued: true,
      });
    },
    SEND_TEST_TIMEOUT_MS,
  );

  it("stores and enqueues nothing when the caller's transaction rolls back", async () => {
    const to = uniqueEmail("rollback");
    const email = invitation(to, newToken(), "ivt_rollback");

    await queueByRoute(email, true);

    const id = idempotentEmailId("team.invitation", to, "ivt_rollback");
    expect(await row(id)).toBeUndefined();
    expect(await emails.getJob(id)).toBeUndefined();
  });

  it("refuses e-mails that break the template's allow-list, links on other hosts and unsafe recipients", async () => {
    const to = uniqueEmail("refused");
    const attempts: Array<[QueueEmailInput, new (...args: never[]) => Error]> = [
      [{ ...verifyEmail(to, "t"), data: { fullName: "Ana", extra: "x" } }, EmailVariablesError],
      [{ ...verifyEmail(to, "t"), data: {} }, EmailVariablesError],
      [{ ...verifyEmail(to, "t"), secretData: {} }, EmailVariablesError],
      [
        { ...verifyEmail(to, "t"), secretData: { verifyUrl: "https://evil.example.net/verify?token=t" } },
        InvalidEmailError,
      ],
      [
        { ...verifyEmail(to, "t"), secretData: { verifyUrl: "http://localhost:3000.evil.example.net/x" } },
        InvalidEmailError,
      ],
      [{ ...verifyEmail(to, "t"), to: `"x@evil.example.net" <${to}>` }, InvalidEmailError],
      [{ ...verifyEmail(to, "t"), to: `${to}, x@evil.example.net` }, InvalidEmailError],
      [
        { ...verifyEmail(to, "t"), templateKey: "auth.unknown" as QueueEmailInput["templateKey"] },
        InvalidEmailError,
      ],
    ];
    for (const [email, errorType] of attempts) {
      await expect(runInTransaction(db, (trx) => outbox.queue(trx, email))).rejects.toBeInstanceOf(errorType);
    }
    const stored = await db
      .selectFrom("platform.email_outbox")
      .select("id")
      .where("to_email", "=", to)
      .execute();
    expect(stored).toEqual([]);
  });

  it("the worker registers the email.sweep job scheduler on platform-emails, every minute", async () => {
    const schedulers = await emails.getJobSchedulers(0, -1);

    expect(schedulers).toEqual([
      expect.objectContaining({ key: EMAIL_SWEEP_JOB, name: EMAIL_SWEEP_JOB, every: EMAIL_SWEEP_EVERY_MS }),
    ]);
  });

  it(
    "the sweep enqueues a pending row older than 2 minutes whose job is missing",
    async () => {
      // The scheduled sweep would race this test's own calls (and their counts): stop it first.
      await emails.removeJobScheduler(EMAIL_SWEEP_JOB);
      const to = uniqueEmail("sweep");
      const young = uniqueEmail("sweep-young");
      const envelope = t.app.get(EnvelopeService);
      const repository = t.app.get(OutboxRepository, { strict: false });
      const lost = idempotentEmailId("auth.password_reset", to, "lost-enqueue");
      const fresh = idempotentEmailId("auth.password_reset", young, "lost-enqueue");
      const token = newToken();
      for (const [id, recipient, createdAt] of [
        [lost, to, new Date(t.clock.now().getTime() - SWEEP_PENDING_AGE_MS - 1000)],
        [fresh, young, t.clock.now()],
      ] as const) {
        const encrypted = await envelope.encryptJson(
          { resetUrl: `http://localhost:3000/reset-password?token=${token}` },
          secretPayloadPlace(id),
        );
        // A row whose enqueue was lost (Redis down at the commit): no BullMQ job exists for it.
        await repository.insertIfAbsent(db, {
          id,
          template: "auth.password_reset",
          toEmail: recipient,
          accountId: null,
          tenantId: null,
          dataJson: JSON.stringify({ fullName: "Ana Lima" }),
          secretPayloadCiphertext: encrypted.ciphertext,
          encryptionKeyId: encrypted.kekId,
          now: createdAt,
        });
      }

      await expect(processor.sweep()).resolves.toEqual({ enqueued: 1 });

      const message = await waitForMessage({
        to,
        subject: "Reset your Velexis password",
        timeoutMs: WAIT_MS,
      });
      expect(extractLinks(message)).toContain(`http://localhost:3000/reset-password?token=${token}`);
      await waitForRow(lost, "the swept row to be sent", (current) => current.status === "sent");
      expect((await row(fresh))?.status).toBe("pending");
      expect(await emails.getJob(fresh)).toBeUndefined();
      await expect(processor.sweep()).resolves.toEqual({ enqueued: 0 });
    },
    SEND_TEST_TIMEOUT_MS,
  );

  it(
    "fails at once, and erases the ciphertext, when the secret payload does not decrypt for its row",
    async () => {
      const to = uniqueEmail("tampered");
      const id = idempotentEmailId("auth.password_reset", to, "tampered");
      const envelope = t.app.get(EnvelopeService);
      // Encrypted for another row: the associated data does not match (a ciphertext copied between rows).
      const encrypted = await envelope.encryptJson(
        { resetUrl: "http://localhost:3000/reset-password?token=t" },
        secretPayloadPlace(idempotentEmailId("auth.password_reset", to, "another row")),
      );
      await t.app.get(OutboxRepository, { strict: false }).insertIfAbsent(db, {
        id,
        template: "auth.password_reset",
        toEmail: to,
        accountId: null,
        tenantId: null,
        dataJson: JSON.stringify({ fullName: "Ana Lima" }),
        secretPayloadCiphertext: encrypted.ciphertext,
        encryptionKeyId: encrypted.kekId,
        now: t.clock.now(),
      });

      await outbox.enqueue(id, "auth.password_reset");

      const failed = await waitForRow(id, "the row to fail", (current) => current.status === "failed");
      expect(failed).toMatchObject({
        attempts: 1,
        last_error: "DecryptionError",
        secret_payload_ciphertext: null,
      });
      const job = await waitFor("the job to fail", async () => {
        const found = await emails.getJob(id);
        return found !== undefined && (await found.getState()) === "failed" ? found : undefined;
      });
      expect(job.attemptsMade).toBe(1);
      expect(await mailpit.search({ to })).toEqual([]);
    },
    SEND_TEST_TIMEOUT_MS,
  );
});
