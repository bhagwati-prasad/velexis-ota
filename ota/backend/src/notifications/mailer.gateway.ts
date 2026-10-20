// The SMTP gateway of the OTA worker (OBE-030; ADR-0017 "E-mail", OADR-0013 items 2 and 5): Nodemailer over SMTP_URL,
// Mailpit in development and tests. Only the notifications processor calls it, outside any database transaction
// (conventions §2, "External calls").
//
// The sender (OADR-0013 item 5): `From: "<OTA brand name>" <address of MAIL_FROM>`, the Velexis-controlled sending
// domain, and `Reply-To: <the OTA's support e-mail>` when it has one, so answers reach the OTA and never Velexis. The
// brand name is the display name only: line breaks and control characters are replaced and it is cut to
// MAX_DISPLAY_NAME_LENGTH, and Nodemailer encodes it, so no brand name can add a header or an address. The recipient
// and the Reply-To address must be one plain address (EMAIL_ADDRESS of config.ts); the recipient is also the SMTP
// envelope, so no display name, comment or second address can reach the RCPT TO command. The Message-ID is made of
// the notification's id (`<ntf_…@sender domain>`), so every attempt of one e-mail is the same message for the
// receiving servers. Nodemailer may not read files or URLs for a message (`disableFileAccess`, `disableUrlAccess`),
// writes no logs of its own, and waits at most 10 seconds for a connection or a greeting and 30 seconds for a reply.
//
// A failure is a `MailerError` with the SMTP error code, response code and command only: the server's reply text may
// quote the recipient, so it is never kept, logged or stored. `transport` tells a failure of the connection to the
// SMTP server (every other e-mail of the batch would fail the same way) from a failure of this one message.
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, type SendMailOptions, type Transporter } from "nodemailer";
import { parseConnectionUrl } from "nodemailer/lib/shared";
import { EMAIL_ADDRESS, type WorkerConfig } from "../config";

/** How long Nodemailer waits for a TCP connection, for the server's greeting, and for any reply. */
export const SMTP_TIMEOUTS = Object.freeze({
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
});

/** The provider name the outbox records (`notifications.provider`). */
export const SMTP_PROVIDER = "smtp";

/** The longest display name of the sender, in characters. */
export const MAX_DISPLAY_NAME_LENGTH = 100;

/** A sender or recipient: an address and an optional display name. */
export interface Mailbox {
  readonly name: string;
  readonly address: string;
}

/** Reads MAIL_FROM (`"Velexis OTA" <no-reply@…>`, `Velexis OTA <no-reply@…>` or a bare address). */
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

/** Control characters (C0, DEL) and the Unicode line and paragraph separators. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what a display name may not hold
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

/** A display name as one line: control characters and line breaks become spaces, at most MAX_DISPLAY_NAME_LENGTH. */
export function displayName(value: string): string {
  const line = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return [...line].slice(0, MAX_DISPLAY_NAME_LENGTH).join("").trim();
}

/** One e-mail to send. */
export interface OutgoingEmail {
  /** The outbox id (`ntf_…`): it makes the Message-ID. */
  readonly notificationId: string;
  /** One plain address (EMAIL_ADDRESS). */
  readonly to: string;
  /** The display name of the sender: the OTA's brand name. */
  readonly fromName: string;
  /** The OTA's support address, when it has a valid one. */
  readonly replyTo: string | null;
  readonly subject: string;
  /** `null`: a text-only e-mail. */
  readonly html: string | null;
  readonly text: string;
}

/** What the SMTP server accepted. */
export interface SentEmail {
  /** The Message-ID header of the message, as sent (`<ntf_…@domain>`). */
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

/** `ECONNECTION`, `EENVELOPE 550 RCPT TO`: the code, the reply code and the command. */
export function describeFailure(failure: MailerFailure): string {
  return [failure.code, failure.responseCode, failure.command]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
}

/**
 * Failures of the message itself (the server refused this envelope or this message, or the recipient is not one
 * address); every other failure is the connection's: SMTP is down, unreachable or refuses the worker.
 */
const MESSAGE_FAILURES: ReadonlySet<string> = new Set(["EENVELOPE", "EMESSAGE", "EINVALIDRECIPIENT"]);

/** A send that failed: its message is `code[ responseCode][ command]`, safe to log and to store in `last_error`. */
export class MailerError extends Error {
  override readonly name = "MailerError";

  constructor(readonly failure: MailerFailure) {
    super(describeFailure(failure));
  }

  /** True when the connection to SMTP failed rather than this message: the next e-mails would fail the same way. */
  get transport(): boolean {
    return !MESSAGE_FAILURES.has(this.failure.code);
  }

  /** True when this message can never be sent as it is (the recipient is not one plain address). */
  get permanent(): boolean {
    return this.failure.code === "EINVALIDRECIPIENT";
  }
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
export const MAIL_TRANSPORT = "OTA_MAIL_TRANSPORT";

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
  useFactory: (config: ConfigService<WorkerConfig, true>): MailTransport =>
    createSmtpTransport(config.get("SMTP_URL", { infer: true })),
};

/** Sends the OTAs' e-mails through SMTP (see the file header). */
@Injectable()
export class MailerGateway implements OnApplicationShutdown {
  private readonly from: Mailbox;
  private readonly messageIdDomain: string;

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    config: ConfigService<WorkerConfig, true>,
  ) {
    this.from = parseMailbox(config.get("MAIL_FROM", { infer: true }));
    this.messageIdDomain = this.from.address.slice(this.from.address.lastIndexOf("@") + 1);
  }

  /** The sending address (MAIL_FROM's). */
  get fromAddress(): string {
    return this.from.address;
  }

  /** Sends one e-mail. Rejects with a `MailerError` when the recipient is not one plain address or SMTP fails. */
  async send(email: OutgoingEmail): Promise<SentEmail> {
    if (!EMAIL_ADDRESS.test(email.to)) {
      throw new MailerError({ code: "EINVALIDRECIPIENT" });
    }
    const messageId = `<${email.notificationId}@${this.messageIdDomain}>`;
    const name = displayName(email.fromName);
    const message: SendMailOptions = {
      from: { name: name === "" ? this.from.name : name, address: this.from.address },
      to: { name: "", address: email.to },
      ...(email.replyTo !== null && EMAIL_ADDRESS.test(email.replyTo)
        ? { replyTo: { name: "", address: email.replyTo } }
        : {}),
      envelope: { from: this.from.address, to: [email.to] },
      messageId,
      subject: email.subject,
      ...(email.html === null ? {} : { html: email.html }),
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
