// The OTA's e-mail outbox end to end (OBE-030; OADR-0013 items 1–3 and 5, OADR-0014 points 4–6, ADR-0017, db README §6
// and §8), against PostgreSQL 16, Redis 7 and Mailpit. The file clones the @velexis/testing template (`tenant_alpha`
// and `tenant_beta` provisioned), plays the platform (two platform.tenants rows as velexis_migrator: `alpha` active,
// `beta` suspended) and the provisioning seed (alpha's storefront settings), and runs both processes in-process:
//
//   - the API's module graph (createTestApp, NotificationsModule.forApi): use cases queue e-mails with OutboxService in
//     a TenantTx transaction of a tenant context, and the `notify {tenantId}` job follows the commit;
//   - the worker's module graph (WorkerModule.forRoot, as dist/worker.js builds it): the ota-notifications consumer
//     renders and sends through SMTP, and the ota-maintenance consumer runs the notifications.sweep jobs.
//
// The worker reaches Mailpit through a small TCP proxy of this file, so a scenario can make SMTP unreachable (the proxy
// resets every connection) and reachable again. The schedulers the worker registers at start-up are removed, so no
// sweep fires on its own; the file adds the sweep's per-tenant jobs itself. A retry is not waited for: the scenario
// moves the worker's Clock past the backoff and notifies the tenant, which is what the next sweep would do. Each
// scenario runs in its `beforeAll` hook (it sends e-mails and waits for the worker) and its tests read what it left;
// every e-mail goes to a recipient of its own (`uniqueEmail`). The `afterCommit` hook of TenantTx, which queues the
// `notify` after the commit, is tested on its own too, with rows nothing sends (`cancelled`).
import { randomBytes } from "node:crypto";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type TenantSchema,
} from "@velexis/db";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import {
  extractLinks,
  mailpit,
  uniqueEmail,
  waitForMessage,
  type MailpitMessage,
} from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { APP_DIR, loadWorkerConfig } from "../../../src/config";
import { minuteBucket, tenantJob } from "../../../src/jobs/fan-out";
import {
  NOTIFICATIONS_SWEEP_JOB,
  RETRY_BACKOFF_MS,
} from "../../../src/notifications/notifications.processor";
import type { NotificationRow } from "../../../src/notifications/outbox.repository";
import {
  InvalidNotificationError,
  OutboxService,
  type EnqueuedNotification,
  type EnqueueNotificationInput,
} from "../../../src/notifications/outbox.service";
import { TemplateInvalidError, TemplateService } from "../../../src/notifications/template.service";
import { TEMPLATE_REGISTRY } from "../../../src/notifications/templates/registry";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds";
import { TenantContext, type RequestTenant } from "../../../src/tenancy/tenant-context";
import {
  afterCommit,
  NotInTenantTransactionError,
  TenantTx,
  type TenantTransaction,
} from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { createTestApp, type TestApp } from "../../support/create-test-app";

/**
 * Cloning the template, starting the API's graph (it parses the OTA document and compiles its validators, about 1.5 s)
 * and the worker's (BullMQ connections, the scheduler registration): a few seconds alone, more while every package's
 * integration tests run on a 4-CPU CI runner. The bound only stops a start-up that hangs.
 */
const SETUP_TIMEOUT_MS = 90_000;
/**
 * A scenario sends a few e-mails through SMTP and waits for the worker and Mailpit each time: well under a second each
 * locally; the bound allows for CI load and only stops a scenario that hangs.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for the worker or Mailpit. */
const WAIT_MS = 20_000;

const MAIL_DOMAIN = "mail.ota.example.com";
const BRAND = "Alpha Travel";
const SUPPORT_EMAIL = "help@alpha-travel.example";

const quietPoolLogger = { error: (): void => undefined };

/** The development SMTP_URL (Mailpit) of the environment, where the proxy forwards. */
function mailpitSmtp(): { readonly host: string; readonly port: number } {
  loadDevEnvFiles({ appDir: APP_DIR });
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

/** Calls `check` every 25 ms until it returns a value other than `undefined`, at most WAIT_MS. */
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
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** A secret token as the auth flows make them: 256 random bits in base64url, new for every e-mail. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

let db: TestDatabase;
let redis: TestRedis;
let proxy: SmtpProxy;
let api: TestApp;
let worker: INestApplicationContext;
const workerSink = new MemorySink();
let migratorPool: ReturnType<typeof createPool>;
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
/** `tenantTx` as velexis_ota_app on this file's own pool: reads the rows back. */
let tenantDb: TenantDb;
let apiOutbox: OutboxService;
let workerOutbox: OutboxService;
let maintenance: Queue;
let notifications: Queue;
let alpha: RequestTenant;
let beta: RequestTenant;
/** Every token this file put in an e-mail: none of them may reach a log line or a clear column. */
const tokens: string[] = [];

async function insertTenant(key: "alpha" | "beta", status: string): Promise<RequestTenant> {
  const tenantId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id: tenantId, key, name: `${key} (platform name)`, status, plan_code: "early_access" })
    .execute();
  return {
    tenantId,
    key,
    schemaName: `tenant_${key}` as TenantSchema,
    environment: "test",
    caller: { type: "anonymous", id: "anonymous" },
    actor: { type: "system", id: null },
    requestId: newId("req"),
  };
}

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  alpha = await insertTenant("alpha", "active");
  beta = await insertTenant("beta", "suspended");
  // Alpha's settings as the provisioning seed writes them, with the support details an OTA adds in its admin.
  await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
    await seedStorefrontSettings(trx, { name: BRAND, defaultCurrency: "EUR", defaultLocale: "en" });
    await trx.updateTable("storefront_settings").set({ support_email: SUPPORT_EMAIL }).execute();
  });
  proxy = await SmtpProxy.start(mailpitSmtp());

  // Every level is logged, so "no log line holds a token" covers the debug lines too.
  api = await createTestApp({ database: db, redis, env: { LOG_LEVEL: "debug" } });
  apiOutbox = api.app.get(OutboxService, { strict: false });

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    LOG_LEVEL: "debug",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
    SMTP_URL: proxy.url,
  });
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(
    WorkerModule.forRoot(config, { logger: createWorkerLogger(config, workerSink) }),
  );
  await worker.init();
  workerOutbox = worker.get(OutboxService, { strict: false });
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  notifications = worker.get<Queue>(getQueueToken(OTA_QUEUE.notifications), { strict: false });
  // No scheduler iteration may fire while the file runs: it adds the sweep's jobs itself.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await proxy?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
}, SETUP_TIMEOUT_MS);

/** An auth.verify_email e-mail to `to` with a fresh token (kept in `tokens`). */
function verifyEmail(
  to: string,
  overrides: Partial<EnqueueNotificationInput> = {},
): EnqueueNotificationInput {
  const token = newToken();
  tokens.push(token);
  return {
    templateKey: "auth.verify_email",
    to,
    locale: "en-GB",
    data: { customer: { firstName: "Alex" }, expiresAt: "2026-11-02T10:00:00Z" },
    secretData: { token },
    dedupeKey: null,
    ...overrides,
  };
}

/** The token of an e-mail built by `verifyEmail` or `resetEmail`. */
function tokenOf(input: EnqueueNotificationInput): string {
  return input.secretData?.["token"] ?? "";
}

/** An auth.password_reset e-mail to `to` with a fresh token. */
function resetEmail(to: string): EnqueueNotificationInput {
  const token = newToken();
  tokens.push(token);
  return {
    templateKey: "auth.password_reset",
    to,
    locale: "en",
    data: { customer: { firstName: "Alex" }, expiresAt: "2026-11-01T11:00:00Z" },
    secretData: { token },
    dedupeKey: null,
  };
}

class RolledBack extends Error {}

/**
 * Queues `input` as a use case of the API does: in a TenantTx transaction of the tenant's context. `inside` reads
 * the row in the same transaction, before the commit. With `rollBack` the transaction throws after queuing.
 */
async function enqueue(
  input: EnqueueNotificationInput,
  options: { tenant?: RequestTenant; rollBack?: boolean } = {},
): Promise<{ queued: EnqueuedNotification; inside: NotificationRow | undefined }> {
  const tenants = api.app.get(TenantContext, { strict: false });
  const tx = api.app.get(TenantTx, { strict: false });
  return tenants.run(options.tenant ?? alpha, () =>
    tx.run(async (trx) => {
      const queued = await apiOutbox.enqueue(trx, input);
      const inside = await trx
        .selectFrom("notifications")
        .selectAll()
        .where("id", "=", queued.notificationId)
        .executeTakeFirst();
      if (options.rollBack === true) {
        throw new RolledBack("the use case failed after queuing its e-mail");
      }
      return { queued, inside };
    }),
  );
}

async function row(
  id: string,
  schema: "tenant_alpha" | "tenant_beta" = "tenant_alpha",
): Promise<NotificationRow | undefined> {
  return tenantTx(tenantDb, schema, (trx) =>
    trx.selectFrom("notifications").selectAll().where("id", "=", id).executeTakeFirst(),
  );
}

async function rowsTo(recipient: string): Promise<NotificationRow[]> {
  return tenantTx(tenantDb, "tenant_alpha", (trx) =>
    trx.selectFrom("notifications").selectAll().where("recipient", "=", recipient).execute(),
  );
}

/** Waits until the row of `id` satisfies `done`, and returns it. */
function waitForRow(
  id: string,
  what: string,
  done: (current: NotificationRow) => boolean,
): Promise<NotificationRow> {
  return waitFor(what, async () => {
    const current = await row(id);
    return current !== undefined && done(current) ? current : undefined;
  });
}

/** Points the worker's Clock `ms` ahead of real time until the returned function is called. */
function workerClockAhead(ms: number): () => void {
  const spy = vi.spyOn(worker.get(Clock), "now").mockImplementation(() => new Date(Date.now() + ms));
  return () => spy.mockRestore();
}

/** Every log line both applications wrote. */
function allLogText(): string {
  return `${api.sink.text()}\n${workerSink.text()}`;
}

describe("[OBE-030 AC1] an e-mail queued in a use case's transaction", () => {
  const rolledBackTo = uniqueEmail("obe030-rollback");
  const committedTo = uniqueEmail("obe030-commit");
  let rolledBackError: unknown;
  let rolledBackRows: NotificationRow[];
  let committed: { queued: EnqueuedNotification; inside: NotificationRow | undefined };
  let committedInput: EnqueueNotificationInput;
  let message: MailpitMessage;
  let sent: NotificationRow;
  let notifyCalls: string[];
  /** How many rows to `committedTo` another connection saw when `notify` was called: the commit came first. */
  let visibleAtNotify: number | undefined;

  beforeAll(async () => {
    const original = apiOutbox.notify.bind(apiOutbox);
    const notify = vi.spyOn(apiOutbox, "notify").mockImplementation(async (tenantId) => {
      visibleAtNotify ??= (await rowsTo(committedTo)).length;
      return original(tenantId);
    });
    rolledBackError = await enqueue(verifyEmail(rolledBackTo), { rollBack: true }).catch(
      (error: unknown) => error,
    );
    rolledBackRows = await rowsTo(rolledBackTo);
    const callsAfterRollback = notify.mock.calls.length;

    committedInput = verifyEmail(committedTo);
    committed = await enqueue(committedInput);
    message = await waitForMessage({ to: committedTo, timeoutMs: WAIT_MS });
    sent = await waitForRow(
      committed.queued.notificationId,
      "the row to be sent",
      (current) => current.status === "sent",
    );
    notifyCalls = notify.mock.calls.slice(callsAfterRollback).map(([tenantId]) => tenantId);
    // Mailpit had every chance to receive the rolled-back e-mail: the committed one, queued after it, has arrived.
    notify.mockRestore();
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-030 AC1] is never sent when the transaction rolls back: no row, no notify job, nothing in Mailpit", async () => {
    expect(rolledBackError).toBeInstanceOf(RolledBack);
    expect(rolledBackRows).toEqual([]);
    expect(notifyCalls).toEqual([alpha.tenantId]);
    expect(await mailpit.search({ to: rolledBackTo })).toEqual([]);
  });

  it("[OBE-030 AC1] queues notify only after the commit: another connection already sees the row", () => {
    expect(visibleAtNotify).toBe(1);
  });

  it("[OBE-030 AC1] arrives in Mailpit once committed, from the OTA's brand on the Velexis domain, Reply-To its support", () => {
    expect(committed.queued.queued).toBe(true);
    expect(message.Subject).toBe(`Confirm your e-mail address for ${BRAND}`);
    expect(message.From).toEqual({ Name: BRAND, Address: `no-reply@${MAIL_DOMAIN}` });
    expect(message.To).toEqual([{ Name: "", Address: committedTo }]);
    expect(message.ReplyTo).toEqual([{ Name: "", Address: SUPPORT_EMAIL }]);
    expect(message.MessageID).toBe(`${committed.queued.notificationId}@${MAIL_DOMAIN}`);
    // OBE-030 step 5: the link goes to /account/verify.html on the tenant's storefront host, with the token.
    const link = `https://alpha.ota.example.com/account/verify.html?token=${tokenOf(committedInput)}`;
    expect(extractLinks(message)).toContain(link);
    expect(message.Text).toContain(link);
    expect(message.Text).toContain("Hello Alex,");
  });

  it("[OBE-030 AC2] holds the token only encrypted until it is sent, and erases it in the update that marks it sent", () => {
    const token = tokenOf(committedInput);
    expect(committed.inside).toMatchObject({
      status: "pending",
      template_key: "auth.verify_email",
      channel: "email",
      recipient_type: "customer",
      locale: "en-GB",
      attempts: 0,
      secrets_purged_at: null,
    });
    expect(committed.inside?.secret_payload_ciphertext).toBeInstanceOf(Buffer);
    expect(committed.inside?.encryption_key_id).toBe("local:v1");
    expect(committed.inside?.secret_payload_ciphertext?.includes(Buffer.from(token))).toBe(false);
    expect(committed.inside?.payload).toEqual({
      customer: { firstName: "Alex" },
      expiresAt: "2026-11-02T10:00:00Z",
    });

    expect(sent).toMatchObject({
      status: "sent",
      attempts: 1,
      secret_payload_ciphertext: null,
      subject: `Confirm your e-mail address for ${BRAND}`,
      template_id: null,
      provider: "smtp",
      provider_message_id: `<${committed.queued.notificationId}@${MAIL_DOMAIN}>`,
      last_error: null,
    });
    expect(sent.sent_at).toBeInstanceOf(Date);
    expect(sent.secrets_purged_at).toBeInstanceOf(Date);
    expect(JSON.stringify({ ...sent, secret_payload_ciphertext: null })).not.toContain(token);
  });
});

describe("[OBE-030 AC2] with SMTP down", () => {
  const to = uniqueEmail("obe030-smtp-down");
  let id: string;
  let failedAttempt: NotificationRow;
  let afterRetry: NotificationRow;
  let mailpitWhileDown: unknown[];
  let message: MailpitMessage;

  beforeAll(async () => {
    proxy.down();
    try {
      ({
        queued: { notificationId: id },
      } = await enqueue(verifyEmail(to)));
      failedAttempt = await waitForRow(id, "the first attempt to fail", (current) => current.attempts === 1);
      mailpitWhileDown = await mailpit.search({ to });
    } finally {
      proxy.up();
    }
    // The backoff is over for the worker: the next notify sends the row again, as the next sweep would.
    const restore = workerClockAhead(RETRY_BACKOFF_MS + 1000);
    try {
      await workerOutbox.notify(alpha.tenantId);
      message = await waitForMessage({ to, timeoutMs: WAIT_MS });
      afterRetry = await waitForRow(id, "the retry to be sent", (current) => current.status === "sent");
    } finally {
      restore();
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-030 AC2] the row stays pending, with its secret, the attempt and the error, due again after the backoff", () => {
    expect(failedAttempt).toMatchObject({
      status: "pending",
      attempts: 1,
      sent_at: null,
      secrets_purged_at: null,
    });
    expect(failedAttempt.secret_payload_ciphertext).toBeInstanceOf(Buffer);
    expect(failedAttempt.last_error).toMatch(/^E[A-Z]+/);
    const backoff = failedAttempt.next_attempt_at.getTime() - failedAttempt.updated_at.getTime();
    expect(backoff).toBe(RETRY_BACKOFF_MS);
    expect(mailpitWhileDown).toEqual([]);
  });

  it("[OBE-030 AC2] is retried and sent once SMTP answers again, and the secret is then erased", () => {
    expect(afterRetry).toMatchObject({
      status: "sent",
      attempts: 2,
      secret_payload_ciphertext: null,
      last_error: null,
    });
    expect(afterRetry.secrets_purged_at).toBeInstanceOf(Date);
    expect(message.MessageID).toBe(`${id}@${MAIL_DOMAIN}`);
  });
});

describe("[OBE-030 AC3] the template of an e-mail", () => {
  const tenantTo = uniqueEmail("obe030-tenant-template");
  const inactiveTo = uniqueEmail("obe030-inactive-template");
  const brokenTo = uniqueEmail("obe030-broken-template");
  const templateId = newId("ntt");
  let tenantMessage: MailpitMessage;
  let tenantRow: NotificationRow | undefined;
  let inactiveMessage: MailpitMessage;
  let inactiveRow: NotificationRow | undefined;
  let renderError: unknown;
  let brokenMessage: MailpitMessage;

  const setTemplate = (values: { is_active?: boolean; body_text?: string }) =>
    tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.updateTable("notification_templates").set(values).where("id", "=", templateId).execute(),
    );

  /** Sends `input` and waits for it in Mailpit; returns the message and the row. */
  async function sendAndWait(
    input: EnqueueNotificationInput,
  ): Promise<[MailpitMessage, NotificationRow | undefined]> {
    const { queued } = await enqueue(input);
    const message = await waitForMessage({ to: input.to, timeoutMs: WAIT_MS });
    return [
      message,
      await waitForRow(queued.notificationId, "the row to be sent", (current) => current.status === "sent"),
    ];
  }

  beforeAll(async () => {
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx
        .insertInto("notification_templates")
        .values({
          id: templateId,
          key: "auth.password_reset",
          channel: "email",
          locale: "en",
          subject: "{{brand.name}}: choose a new password",
          body_html: '<p>Hi {{customer.firstName}}, <a href="{{resetUrl}}">choose a new password</a>.</p>',
          body_text: "Hi {{customer.firstName}}, choose a new password: {{resetUrl}}",
        })
        .execute(),
    );
    [tenantMessage, tenantRow] = await sendAndWait(resetEmail(tenantTo));

    await setTemplate({ is_active: false });
    [inactiveMessage, inactiveRow] = await sendAndWait(resetEmail(inactiveTo));

    // A row edited outside the console's checks: active again, with a variable outside the allow-list.
    await setTemplate({
      is_active: true,
      body_text: "Hi {{customer.firstName}} {{customer.lastName}}: {{resetUrl}}",
    });
    const templates = worker.get(TemplateService, { strict: false });
    const tenants = worker.get(TenantContext, { strict: false });
    const tx = worker.get(TenantTx, { strict: false });
    renderError = await tenants
      .run(alpha, () => tx.run((trx) => templates.effective(trx, "auth.password_reset", "en")))
      .then((template) => templates.render(template, { customer: { firstName: "Alex" } }))
      .catch((error: unknown) => error);
    [brokenMessage] = await sendAndWait(resetEmail(brokenTo));
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.deleteFrom("notification_templates").where("id", "=", templateId).execute(),
    );
  });

  it("is the tenant's active row: its subject and body, and the row is recorded", () => {
    expect(tenantMessage.Subject).toBe(`${BRAND}: choose a new password`);
    expect(tenantMessage.Text).toContain("https://alpha.ota.example.com/account/reset-password.html?token=");
    expect(tenantRow?.template_id).toBe(templateId);
  });

  it("[OBE-030 AC3] is the code default when the tenant's row is inactive", () => {
    expect(inactiveMessage.Subject).toBe(`Reset your ${BRAND} password`);
    expect(inactiveMessage.Text).toContain("We received a request to reset the password");
    expect(inactiveRow?.template_id).toBeNull();
  });

  it("[OBE-030 AC3] fails to render with a clear error when the tenant's row uses a variable outside the allow-list", () => {
    expect(renderError).toBeInstanceOf(TemplateInvalidError);
    expect((renderError as TemplateInvalidError).message).toContain(
      'The tenant template auth.password_reset (en) is invalid: txt line 1: "customer.lastName" is not a variable of auth.password_reset',
    );
  });

  it("does not stop the OTA's e-mails: the worker sends the code default instead and logs why", () => {
    expect(brokenMessage.Subject).toBe(`Reset your ${BRAND} password`);
    expect(workerSink.records()).toContainEqual(
      expect.objectContaining({
        msg: "notifications.template_fallback",
        template: "auth.password_reset",
        templateId,
        reason: expect.stringContaining(
          '"customer.lastName" is not a variable of auth.password_reset',
        ) as unknown,
      }),
    );
  });
});

describe("the notifications.sweep schedule", () => {
  const to = uniqueEmail("obe030-sweep");
  let id: string;
  let pendingBeforeSweep: NotificationRow | undefined;
  let message: MailpitMessage;
  const bucket = minuteBucket(new Date()) + 7;

  beforeAll(async () => {
    // The enqueue after the commit is lost (Redis did not answer): only the sweep finds the row.
    const notify = vi.spyOn(apiOutbox, "notify").mockResolvedValue(false);
    try {
      ({
        queued: { notificationId: id },
      } = await enqueue(verifyEmail(to)));
    } finally {
      notify.mockRestore();
    }
    pendingBeforeSweep = await row(id);
    for (const tenant of [alpha, beta]) {
      const job = tenantJob(NOTIFICATIONS_SWEEP_JOB, tenant.tenantId, bucket);
      await maintenance.add(job.name, job.data, job.opts);
    }
    message = await waitForMessage({ to, timeoutMs: WAIT_MS });
    await waitForRow(id, "the swept row to be sent", (current) => current.status === "sent");
    await waitFor("beta's sweep job to finish", async () =>
      (await maintenance.getJob(`${NOTIFICATIONS_SWEEP_JOB}:${beta.tenantId}:${bucket}`))?.finishedOn ===
      undefined
        ? undefined
        : true,
    );
  }, SCENARIO_TIMEOUT_MS);

  it("enqueues notify for a tenant with a due row, under the id of its minute, which sends the e-mail", async () => {
    expect(pendingBeforeSweep).toMatchObject({ status: "pending", attempts: 0 });
    expect(message.Subject).toBe(`Confirm your e-mail address for ${BRAND}`);
    const swept = await notifications.getJob(`notify:${alpha.tenantId}:${bucket}`);
    expect(swept?.data).toEqual({ tenantId: alpha.tenantId });
  });

  it("runs for suspended tenants too, and enqueues nothing for a tenant without due rows", async () => {
    const betaSweep = await maintenance.getJob(`${NOTIFICATIONS_SWEEP_JOB}:${beta.tenantId}:${bucket}`);
    expect(betaSweep?.returnvalue).toMatchObject({ outcome: "done", counts: { due: 0 } });
    expect(await notifications.getJob(`notify:${beta.tenantId}:${bucket}`)).toBeUndefined();
  });
});

describe("enqueue", () => {
  const dedupeTo = uniqueEmail("obe030-dedupe");
  const invalidTo = uniqueEmail("obe030-invalid");
  const dedupeKey = `auth.verify_email:${newId("cvt")}`;
  let first: EnqueuedNotification;
  let second: EnqueuedNotification;
  let invalid: unknown;

  beforeAll(async () => {
    ({ queued: first } = await enqueue(verifyEmail(dedupeTo, { dedupeKey })));
    ({ queued: second } = await enqueue(verifyEmail(dedupeTo, { dedupeKey })));
    await waitForMessage({ to: dedupeTo, timeoutMs: WAIT_MS });
    invalid = await enqueue(
      verifyEmail(invalidTo, {
        data: { customer: { firstName: "Alex", lastName: "Martin" }, expiresAt: "x" },
      }),
    ).catch((error: unknown) => error);
  }, SCENARIO_TIMEOUT_MS);

  it("queues one e-mail per dedupe key", async () => {
    expect(first.queued).toBe(true);
    expect(second).toEqual({ notificationId: first.notificationId, queued: false });
    expect(await rowsTo(dedupeTo)).toHaveLength(1);
  });

  it("refuses data outside the key's allow-list inside the transaction, which rolls back", async () => {
    expect(invalid).toBeInstanceOf(InvalidNotificationError);
    expect((invalid as Error).message).toContain("customer.lastName is not a variable of the template");
    expect(await rowsTo(invalidTo)).toEqual([]);
  });
});

describe("a final status", () => {
  const exhaustedTo = uniqueEmail("obe030-exhausted");
  const releasedTo = uniqueEmail("obe030-released");
  const donorTo = uniqueEmail("obe030-donor");
  const unreadableTo = uniqueEmail("obe030-unreadable");
  const missingTo = uniqueEmail("obe030-no-template");
  let afterFirstBatch: { exhausted: NotificationRow; released: NotificationRow };
  let exhausted: NotificationRow;
  let released: NotificationRow | undefined;
  let unreadable: NotificationRow;
  let missing: NotificationRow;
  let donor: NotificationRow;

  /** Queues e-mails whose enqueue after the commit is lost: the next notify drains them in one batch. */
  async function queueSilently(inputs: readonly EnqueueNotificationInput[]): Promise<string[]> {
    const notify = vi.spyOn(apiOutbox, "notify").mockResolvedValue(false);
    try {
      const ids: string[] = [];
      for (const input of inputs) {
        ids.push((await enqueue(input)).queued.notificationId);
      }
      return ids;
    } finally {
      notify.mockRestore();
    }
  }

  beforeAll(async () => {
    // SMTP down for every attempt of the first e-mail; the second, after it in the batch, is never tried.
    const [exhaustedId = "", releasedId = ""] = await queueSilently([
      verifyEmail(exhaustedTo),
      verifyEmail(releasedTo),
    ]);
    proxy.down();
    try {
      await workerOutbox.notify(alpha.tenantId);
      const first = await waitForRow(exhaustedId, "the first attempt", (current) => current.attempts === 1);
      afterFirstBatch = {
        exhausted: first,
        // Released: due again a minute after the release (a claim's lease would be five minutes).
        released: await waitForRow(
          releasedId,
          "the release",
          (current) => current.next_attempt_at.getTime() - current.updated_at.getTime() === RETRY_BACKOFF_MS,
        ),
      };
      // Each round moves the worker's clock past the longest backoff (8 minutes) and notifies again.
      for (let attempt = 2; attempt <= 5; attempt += 1) {
        const restore = workerClockAhead(attempt * 20 * 60_000);
        try {
          await workerOutbox.notify(alpha.tenantId);
          await waitForRow(exhaustedId, `attempt ${attempt}`, (current) => current.attempts === attempt);
        } finally {
          restore();
        }
      }
      exhausted = await waitForRow(exhaustedId, "the last attempt", (current) => current.status === "failed");
      released = await row(releasedId);
    } finally {
      proxy.up();
    }

    // With SMTP up: a ciphertext sealed for another row does not decrypt, and a key without a template cannot render.
    const booking = TEMPLATE_REGISTRY["booking.confirmed"].sampleData["booking"] ?? {};
    const [donorId = "", unreadableId = "", missingId = ""] = await queueSilently([
      verifyEmail(donorTo),
      verifyEmail(unreadableTo),
      { templateKey: "booking.confirmed", to: missingTo, locale: "en", data: { booking }, dedupeKey: null },
    ]);
    await tenantTx(tenantDb, "tenant_alpha", async (trx) => {
      const sealed = await trx
        .selectFrom("notifications")
        .select("secret_payload_ciphertext")
        .where("id", "=", donorId)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("notifications")
        .set({ secret_payload_ciphertext: sealed.secret_payload_ciphertext })
        .where("id", "=", unreadableId)
        .execute();
    });
    await workerOutbox.notify(alpha.tenantId);
    unreadable = await waitForRow(
      unreadableId,
      "the unreadable row to fail",
      (current) => current.status === "failed",
    );
    missing = await waitForRow(
      missingId,
      "the row without a template to fail",
      (current) => current.status === "failed",
    );
    donor = await waitForRow(donorId, "the donor row to be sent", (current) => current.status === "sent");
  }, SCENARIO_TIMEOUT_MS);

  it("ends a batch at an SMTP failure: the rows not tried are released without an attempt, for a minute", () => {
    expect(afterFirstBatch.exhausted).toMatchObject({ status: "pending", attempts: 1 });
    expect(afterFirstBatch.released).toMatchObject({ status: "pending", attempts: 0, last_error: null });
    expect(afterFirstBatch.released.secret_payload_ciphertext).toBeInstanceOf(Buffer);
  });

  it("[OBE-030 AC2] is failed after the 5th failed attempt, and the secret is erased in the same update", () => {
    expect(exhausted).toMatchObject({
      status: "failed",
      attempts: 5,
      secret_payload_ciphertext: null,
      sent_at: null,
    });
    expect(exhausted.last_error).toBe("ESOCKET CONN");
    expect(exhausted.secrets_purged_at).toBeInstanceOf(Date);
    expect(released).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("is failed at once, secret erased, for an e-mail that can never be sent; the batch goes on", async () => {
    expect(unreadable).toMatchObject({
      status: "failed",
      attempts: 0,
      last_error: "SECRET_UNREADABLE",
      secret_payload_ciphertext: null,
    });
    expect(unreadable.secrets_purged_at).toBeInstanceOf(Date);
    expect(missing).toMatchObject({ status: "failed", attempts: 0, secret_payload_ciphertext: null });
    expect(missing.last_error).toMatch(/^TEMPLATE_MISSING: No template applies to booking\.confirmed/);
    expect(donor).toMatchObject({ status: "sent", attempts: 1 });
    expect(await mailpit.search({ to: unreadableTo })).toEqual([]);
    expect(await mailpit.search({ to: missingTo })).toEqual([]);
  });
});

describe("afterCommit of TenantTx, which queues notify (OBE-030 step 2)", () => {
  /** Runs `fn` as a use case of alpha does: in a TenantTx transaction of the API, in alpha's context. */
  function inAlphaTx<T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> {
    const tenants = api.app.get(TenantContext, { strict: false });
    const tx = api.app.get(TenantTx, { strict: false });
    return tenants.run(alpha, () => tx.run(fn));
  }

  /** Inserts an outbox row that nothing sends (`cancelled`) in `trx`, and returns its id. */
  async function insertCancelled(trx: TenantTransaction): Promise<string> {
    const id = newId("ntf");
    await trx
      .insertInto("notifications")
      .values({
        id,
        template_key: "auth.verify_email",
        channel: "email",
        recipient: uniqueEmail("obe030-after-commit"),
        recipient_type: "customer",
        status: "cancelled",
      })
      .execute();
    return id;
  }

  it("runs the work in order once COMMIT succeeded, when other connections see the rows, and drops it on a rollback", async () => {
    const seen: string[] = [];
    await inAlphaTx(async (trx) => {
      const id = await insertCancelled(trx);
      afterCommit(trx, async () => {
        seen.push(`first, the row is visible: ${(await row(id))?.id === id}`);
      });
      afterCommit(trx, () => {
        seen.push("second");
      });
      seen.push("the transaction's function returned");
    });
    const dropped = vi.fn();
    const rolledBack = await inAlphaTx((trx) => {
      afterCommit(trx, dropped);
      return Promise.reject(new RolledBack("the use case failed after registering the work"));
    }).catch((error: unknown) => error);

    expect(seen).toEqual([
      "the transaction's function returned",
      "first, the row is visible: true",
      "second",
    ]);
    expect(rolledBack).toBeInstanceOf(RolledBack);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("keeps the commit when a piece of work fails, still runs the others, and rethrows the failures", async () => {
    let id = "";
    const after = vi.fn();
    const one = await inAlphaTx(async (trx) => {
      id = await insertCancelled(trx);
      afterCommit(trx, () => {
        throw new Error("the work failed");
      });
      afterCommit(trx, after);
    }).catch((error: unknown) => error);
    const two = await inAlphaTx((trx) => {
      afterCommit(trx, () => Promise.reject(new Error("first failure")));
      afterCommit(trx, () => Promise.reject(new Error("second failure")));
      return Promise.resolve();
    }).catch((error: unknown) => error);

    expect(one).toBeInstanceOf(Error);
    expect((one as Error).message).toBe("the work failed");
    expect(after).toHaveBeenCalledOnce();
    expect((await row(id))?.status).toBe("cancelled");
    expect(two).toBeInstanceOf(AggregateError);
    expect((two as AggregateError).errors.map((error: unknown) => (error as Error).message)).toEqual([
      "first failure",
      "second failure",
    ]);
  });

  it("refuses a transaction that TenantTx.run did not open, or one that has finished", async () => {
    const finished = await inAlphaTx((trx) => Promise.resolve(trx));
    const foreign = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      Promise.resolve().then(() => afterCommit(trx, () => undefined)),
    ).catch((error: unknown) => error);

    expect(() => afterCommit(finished, () => undefined)).toThrow(NotInTenantTransactionError);
    expect(foreign).toBeInstanceOf(NotInTenantTransactionError);
  });
});

describe("secrets", () => {
  it("never reach a log line of the API or the worker", () => {
    expect(tokens.length).toBeGreaterThan(5);
    const text = allLogText();
    for (const token of tokens) {
      expect(text).not.toContain(token);
    }
  });

  it("are gone from every row that reached a final status", async () => {
    const rows = await tenantTx(tenantDb, "tenant_alpha", (trx) =>
      trx.selectFrom("notifications").selectAll().execute(),
    );
    const final = rows.filter((current) => !["pending", "sending"].includes(current.status));
    expect(final.length).toBeGreaterThan(0);
    for (const current of final) {
      expect([current.id, current.secret_payload_ciphertext]).toEqual([current.id, null]);
    }
  });
});
