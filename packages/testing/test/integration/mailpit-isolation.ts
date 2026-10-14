// Sending for the Mailpit integration tests, and the scenario of X-025 AC3 run by two integration test files at the
// same time (mailpit.int.test.ts and mailpit-parallel.int.test.ts): each file sends one e-mail with nodemailer to its
// own uniqueEmail("parallel") address, with the same subject as the other file, waits until the other file's e-mail is
// in Mailpit too, and then must find only its own e-mail when it looks for mail to its address.
//
// "At the same time" is proven, not assumed: Mailpit itself is the meeting point. The subject carries the run id of the
// template both files were given (unique per run, so mail left by an earlier or a concurrent run never counts), and
// each file waits until the two e-mails of its run are there, so a file that ran alone would wait in vain.
import { setTimeout as delay } from "node:timers/promises";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { createTransport } from "nodemailer";
import { expect, inject } from "vitest";
import { runIdOfTemplate, TEMPLATE_DATABASE_KEY } from "../../src/index.js";
import { mailpit, uniqueEmail, waitForMessage, type MailpitMessageSummary } from "../../src/mailpit.js";

export type ParallelFile = "first" | "second";

/** How long a file waits for the other file's e-mail. */
export const MEETING_TIMEOUT_MS = 60_000;

/** The sender of the test e-mails: a reserved example domain, like every recipient. */
export const TEST_MAIL_FROM = '"Velexis tests" <no-reply@example.com>';

const OTHER: Readonly<Record<ParallelFile, ParallelFile>> = { first: "second", second: "first" };

/** The part of a nodemailer transport the tests use. */
export interface MailSender {
  sendMail(mail: {
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly html?: string;
  }): Promise<{ readonly messageId: string }>;
  close(): void;
}

/**
 * A nodemailer SMTP transport to SMTP_URL (Mailpit, `smtp://127.0.0.1:1025`): the environment (CI services), else the
 * `.env.local` files, read through @velexis/config. Close it in `afterAll`.
 */
export function createSmtpTransport(): MailSender {
  loadDevEnvFiles({ appDir: process.cwd() });
  const { SMTP_URL } = defineConfig({ SMTP_URL: env.url({ protocols: ["smtp:", "smtps:"] }) });
  return createTransport(SMTP_URL);
}

/** The Message-ID nodemailer gave the e-mail, as Mailpit shows it: without the angle brackets. */
export function mailpitMessageId(sent: { readonly messageId: string }): string {
  return sent.messageId.replace(/^<(.*)>$/, "$1");
}

/** The subject both files of this run send: unique per run through the template's run id. */
export function isolationSubject(): string {
  const template = (inject as (key: string) => unknown)(TEMPLATE_DATABASE_KEY);
  if (typeof template !== "string") {
    throw new Error("no template database was provided to this test file");
  }
  return `X-025 parallel isolation ${runIdOfTemplate(template)}`;
}

/** Waits until the e-mails of both files of this run are in Mailpit, and returns them. */
async function meet(file: ParallelFile, subject: string): Promise<MailpitMessageSummary[]> {
  const deadline = Date.now() + MEETING_TIMEOUT_MS;
  for (;;) {
    const messages = await mailpit.search({ subject });
    if (messages.length >= 2) {
      return messages;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the ${OTHER[file]} Mailpit test file did not send its e-mail within ${MEETING_TIMEOUT_MS} ms: run both ` +
          "mailpit files together (pnpm test:int), in parallel",
      );
    }
    await delay(100);
  }
}

const PARALLEL_ADDRESS =
  /^parallel\+[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@example\.com$/;

/**
 * X-025 AC3 for one file: send to this file's own `uniqueEmail("parallel")` address, meet the other file in Mailpit,
 * then look for mail to the own address and find this file's e-mail only, although the other file's e-mail has the
 * same subject and an address with the same label.
 */
export async function expectOnlyOwnMail(file: ParallelFile, transport: MailSender): Promise<void> {
  const subject = isolationSubject();
  const own = uniqueEmail("parallel");
  const ownMessageId = mailpitMessageId(
    await transport.sendMail({
      from: TEST_MAIL_FROM,
      to: own,
      subject,
      text: `Sent by the ${file} Mailpit test file.`,
    }),
  );

  const both = await meet(file, subject);
  expect(both).toHaveLength(2);
  const other = both.find((message) => message.MessageID !== ownMessageId);
  const otherAddress = other?.To[0]?.Address ?? "";
  expect(otherAddress).toMatch(PARALLEL_ADDRESS);
  expect(own).toMatch(PARALLEL_ADDRESS);
  expect(otherAddress).not.toBe(own);

  // Mail to the own address: this file's e-mail, never the other file's.
  const mine = await waitForMessage({ to: own, subject });
  expect(mine.MessageID).toBe(ownMessageId);
  expect(mine.Text).toContain(`Sent by the ${file} Mailpit test file.`);
  expect((await mailpit.search({ to: own })).map((message) => message.MessageID)).toEqual([ownMessageId]);
  expect((await mailpit.search({ to: own, subject })).map((message) => message.MessageID)).toEqual([
    ownMessageId,
  ]);
  // The other file's e-mail is there, for the other file's address only.
  expect((await mailpit.search({ to: otherAddress })).map((message) => message.ID)).toEqual([other?.ID]);
}
