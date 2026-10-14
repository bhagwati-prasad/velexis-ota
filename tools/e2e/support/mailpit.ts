// E-mail in end-to-end journeys (PFE-014): `@velexis/testing/mailpit` with the timeouts of a running stack, where a
// message goes through the outbox and the worker before it reaches Mailpit (ADR-0015 "E-mail", X-025).
//
//   const email = uniqueEmail("signup");                                     // this test's own inbox
//   …sign up in the portal…
//   const link = await waitForLink({ to: email, subject: /verify/i, path: "/verify-email" });
//   await page.goto(link.href);
//
// One recipient per test: every journey sends to its own `uniqueEmail` address and reads only that address, because
// other test files, runs and agents share the same Mailpit. Never empty Mailpit from a test.
import {
  createMailpitClient,
  extractLinks,
  mailpitApiUrl,
  uniqueEmail,
  type MailpitClient,
  type MailpitMessage,
} from "@velexis/testing/mailpit";

export { extractLinks, uniqueEmail, type MailpitMessage };

/** How long a journey waits for an e-mail: the outbox, the worker and SMTP are in the way. */
export const E2E_MAIL_TIMEOUT_MS = 15_000;

let client: MailpitClient | undefined;

/** The Mailpit at MAILPIT_API_URL (the stack sends its e-mail to the SMTP port of the same Mailpit). */
export function mailpit(): MailpitClient {
  client ??= createMailpitClient({ apiUrl: mailpitApiUrl() });
  return client;
}

export interface WaitForEmailOptions {
  /** The recipient, from `uniqueEmail`. */
  readonly to: string;
  /** A string must equal the subject; a `RegExp` must match it. */
  readonly subject?: string | RegExp;
  /** Default E2E_MAIL_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/** The newest e-mail to `to` (with `subject`), waiting up to `timeoutMs`; a readable error when none arrives. */
export async function waitForEmail(options: WaitForEmailOptions): Promise<MailpitMessage> {
  return await mailpit().waitForMessage({
    to: options.to,
    ...(options.subject === undefined ? {} : { subject: options.subject }),
    timeoutMs: options.timeoutMs ?? E2E_MAIL_TIMEOUT_MS,
  });
}

export interface WaitForLinkOptions extends WaitForEmailOptions {
  /** The path the link must have, for example `/verify-email` or `/reset-password`. */
  readonly path: string;
  /** The origin the link must point at, for example PORTAL_URL. Any origin when left out. */
  readonly origin?: string;
}

/**
 * The first link of the newest e-mail to `to` (with `subject`) whose path is `path` (and whose origin is `origin`).
 * Throws, naming the links the e-mail did have (without their query strings, which hold the tokens), when none fits.
 */
export async function waitForLink(options: WaitForLinkOptions): Promise<URL> {
  const message = await waitForEmail(options);
  const links = extractLinks(message).flatMap((href) => {
    try {
      return [new URL(href)];
    } catch {
      return [];
    }
  });
  const match = links.find(
    (url) => url.pathname === options.path && (options.origin === undefined || url.origin === options.origin),
  );
  if (match === undefined) {
    const seen = links.map((url) => `${url.origin}${url.pathname}`).join(", ") || "none";
    throw new Error(
      `the e-mail "${message.Subject}" to ${options.to} has no link to ${options.origin ?? ""}${options.path} ` +
        `(links: ${seen})`,
    );
  }
  return match;
}
