// The SMTP gateway of the platform worker (PBE-011; ADR-0017 "E-mail", PADR-0013 item 3): Nodemailer over SMTP_URL,
// Mailpit in development and tests. Only the e-mail processor calls it, outside any database transaction
// (conventions §2, "External calls").
//
// What it sends is fixed by the processor: one recipient, from MAIL_FROM, a subject, an HTML part and a text part, and a
// Message-ID made of the e-mail's id (`<eml_…@sender domain>`), so every attempt of one e-mail is the same message for
// the receiving servers. The recipient must be one plain address (EMAIL_ADDRESS of config.ts) and is also given as the
// SMTP envelope, so no display name, comment or second address can reach the RCPT TO command. Nodemailer may not read
// files or URLs for a message (`disableFileAccess`, `disableUrlAccess`), writes no logs of its own, and waits at most
// 10 seconds for a connection or a greeting and 30 seconds for a reply.
//
// A failure is a `MailerError` with the SMTP error code, response code and command only: the server's reply text may
// quote the recipient, so it is never kept, logged or stored.
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, type SendMailOptions, type Transporter } from "nodemailer";
import { parseConnectionUrl } from "nodemailer/lib/shared";
import { EMAIL_ADDRESS, type PlatformBackendConfig } from "../config";

/** How long Nodemailer waits for a TCP connection, for the server's greeting, and for any reply. */
export const SMTP_TIMEOUTS = Object.freeze({
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
});

/** A sender or recipient: an address and an optional display name. */
export interface Mailbox {
  readonly name: string;
  readonly address: string;
}

/** Reads MAIL_FROM (`"Velexis" <no-reply@…>`, `Velexis <no-reply@…>` or a bare address) into a name and an address. */
export function parseMailbox(value: string): Mailbox {
  const angle = /^(.*?)\s*<([^<>]+)>$/.exec(value.trim());
  const address = (angle?.[2] ?? value).trim();
  if (!EMAIL_ADDRESS.test(address)) {
    throw new TypeError("parseMailbox(): the value has no valid e-mail address");
  }
  let name = (angle?.[1] ?? "").trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    name = name.slice(1, -1);
  }
  return { name, address };
}

/** One e-mail to send. */
export interface OutgoingEmail {
  /** The outbox id (`eml_…`): it makes the Message-ID. */
  readonly emailId: string;
  /** One plain address (EMAIL_ADDRESS). */
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** What the SMTP server accepted. */
export interface SentEmail {
  /** The Message-ID header of the message, as sent (`<eml_…@domain>`). */
  readonly messageId: string;
}

/** Why a send failed, without the server's reply text or the message. */
export interface MailerFailure {
  /** Nodemailer's error code (`ECONNECTION`, `ETIMEDOUT`, `EENVELOPE`, `EMESSAGE`, …), or the error's name. */
  readonly code: string;
  /** The SMTP reply code when the server answered (`421`, `550`, …). */
  readonly responseCode?: number;
  /** The SMTP command that failed (`CONN`, `RCPT TO`, `DATA`, …). */
  readonly command?: string;
}

/** A send that failed: its message is `code[ responseCode][ command]`, safe to log and to store in `last_error`. */
export class MailerError extends Error {
  override readonly name = "MailerError";

  constructor(readonly failure: MailerFailure) {
    super(describeFailure(failure));
  }
}

/** `ECONNECTION`, `EENVELOPE 550 RCPT TO`: the code, the reply code and the command. */
export function describeFailure(failure: MailerFailure): string {
  return [failure.code, failure.responseCode, failure.command]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
}

/** The parts of an error that are safe to keep: never `message` or `response`, which may quote the recipient. */
export function failureOf(error: unknown): MailerFailure {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code =
    typeof record["code"] === "string" && /^[A-Z0-9_]{1,40}$/.test(record["code"])
      ? record["code"]
      : undefined;
  const responseCode =
    typeof record["responseCode"] === "number" && Number.isInteger(record["responseCode"])
      ? record["responseCode"]
      : undefined;
  const command =
    typeof record["command"] === "string" && /^[A-Z ]{1,20}$/.test(record["command"])
      ? record["command"]
      : undefined;
  const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
  return {
    code: code ?? name,
    ...(responseCode === undefined ? {} : { responseCode }),
    ...(command === undefined ? {} : { command }),
  };
}

/** The Nodemailer transport the gateway sends with (a test may give its own). */
export type MailTransport = Pick<Transporter, "sendMail" | "close">;

/** Injection token of the MailTransport. */
export const MAIL_TRANSPORT = "MAIL_TRANSPORT";

/**
 * The SMTP transport of SMTP_URL: no pooling (one connection per e-mail), no logs, no file or URL access, the timeouts
 * above. The URL is parsed here (host, port, `smtps:` for implicit TLS, the credentials, query options) because
 * Nodemailer drops every other option of a configuration that carries a `url`.
 */
export function createSmtpTransport(smtpUrl: string): MailTransport {
  return createTransport({
    ...parseConnectionUrl(smtpUrl),
    ...SMTP_TIMEOUTS,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  } as Parameters<typeof createTransport>[0]);
}

/** The provider of MAIL_TRANSPORT from SMTP_URL. */
export const mailTransportProvider = {
  provide: MAIL_TRANSPORT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<PlatformBackendConfig, true>): MailTransport =>
    createSmtpTransport(config.get("SMTP_URL", { infer: true })),
};

/** Sends the platform's e-mails through SMTP (see the file header). */
@Injectable()
export class MailerGateway implements OnApplicationShutdown {
  private readonly from: Mailbox;
  private readonly messageIdDomain: string;

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.from = parseMailbox(config.get("MAIL_FROM", { infer: true }));
    this.messageIdDomain = this.from.address.slice(this.from.address.lastIndexOf("@") + 1);
  }

  /** Sends one e-mail. Rejects with a `MailerError` when the recipient is not one plain address or SMTP fails. */
  async send(email: OutgoingEmail): Promise<SentEmail> {
    if (!EMAIL_ADDRESS.test(email.to)) {
      throw new MailerError({ code: "EINVALIDRECIPIENT" });
    }
    const messageId = `<${email.emailId}@${this.messageIdDomain}>`;
    const message: SendMailOptions = {
      from: { name: this.from.name, address: this.from.address },
      to: { name: "", address: email.to },
      envelope: { from: this.from.address, to: [email.to] },
      messageId,
      subject: email.subject,
      html: email.html,
      text: email.text,
    };
    try {
      await this.transport.sendMail(message);
    } catch (error) {
      throw new MailerError(failureOf(error));
    }
    return { messageId };
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}
