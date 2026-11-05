// The SMTP gateway of the OTA worker without SMTP (OBE-030; OADR-0013 item 5, ADR-0017): the message it hands to
// Nodemailer (the OTA's brand as the sender's display name on MAIL_FROM's address, the support address as Reply-To,
// the envelope, the Message-ID, the attachments of OBE-055) and the failures it reports. Sending through Mailpit runs
// in test/integration/notifications/outbox.int.test.ts and booking-emails.int.test.ts.
//
// OBE-093 (Nodemailer 10): the SMTP transport of createSmtpTransport, with only its SMTP stage replaced by one that
// builds each message from the stream the transport sends in DATA (`message.build` reads `createReadStream`), proves
// that the transport reads no file and no URL (for an attachment, a body or a `raw` message, also when the message or
// SMTP_URL asks it to) and that the gateway's own messages come out as before. The refusal is the stream's error
// (`EFILEACCESS`, `EURLACCESS`); through SMTP the connection reports it as `ESTREAM` with the command `API`.
import type { ConfigService } from "@nestjs/config";
import type { SendMailOptions } from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config";
import {
  attachmentName,
  createSmtpTransport,
  describeFailure,
  displayName,
  failureOf,
  MailerError,
  MailerGateway,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  parseMailbox,
  SMTP_TIMEOUTS,
  smtpTransportOptions,
  type MailTransport,
  type OutgoingEmail,
  type SmtpTransport,
} from "./mailer.gateway";

const MAIL_FROM = '"Velexis OTA" <no-reply@mail.ota.example.com>';

function gatewayWith(sendMail: (message: SendMailOptions) => Promise<unknown>): {
  gateway: MailerGateway;
  sent: SendMailOptions[];
} {
  const sent: SendMailOptions[] = [];
  const transport = {
    sendMail: vi.fn(async (message: SendMailOptions) => {
      sent.push(message);
      return sendMail(message);
    }),
    close: vi.fn(),
  } as unknown as MailTransport;
  const config = { get: () => MAIL_FROM } as unknown as ConfigService<WorkerConfig, true>;
  return { gateway: new MailerGateway(transport, config), sent };
}

const EMAIL: OutgoingEmail = {
  notificationId: "ntf_01J9ZA2B4C6D8E0F2G4H6J8K0M",
  to: "alex@example.com",
  fromName: "Alpha Travel",
  replyTo: "help@alpha-travel.example",
  subject: "Confirm your e-mail address for Alpha Travel",
  html: "<p>Hello</p>",
  text: "Hello",
};

describe("MailerGateway.send", () => {
  it("sends from the OTA's brand on MAIL_FROM's address, Reply-To its support, with the envelope and Message-ID", async () => {
    const { gateway, sent } = gatewayWith(() => Promise.resolve({}));

    const result = await gateway.send(EMAIL);

    expect(result).toEqual({ messageId: "<ntf_01J9ZA2B4C6D8E0F2G4H6J8K0M@mail.ota.example.com>" });
    expect(sent).toEqual([
      {
        from: { name: "Alpha Travel", address: "no-reply@mail.ota.example.com" },
        to: { name: "", address: "alex@example.com" },
        replyTo: { name: "", address: "help@alpha-travel.example" },
        envelope: { from: "no-reply@mail.ota.example.com", to: ["alex@example.com"] },
        messageId: "<ntf_01J9ZA2B4C6D8E0F2G4H6J8K0M@mail.ota.example.com>",
        subject: EMAIL.subject,
        html: "<p>Hello</p>",
        text: "Hello",
      },
    ]);
    expect(gateway.fromAddress).toBe("no-reply@mail.ota.example.com");
  });

  it("keeps a brand name to one line, leaves out a Reply-To that is not one address, and sends text-only e-mails", async () => {
    const { gateway, sent } = gatewayWith(() => Promise.resolve({}));

    await gateway.send({
      ...EMAIL,
      fromName: "Alpha\r\nBcc: victim@example.com\tTravel",
      replyTo: "Help <help@alpha-travel.example>",
      html: null,
    });
    await gateway.send({ ...EMAIL, fromName: " \n ", replyTo: null });

    expect(sent[0]?.from).toEqual({
      name: "Alpha Bcc: victim@example.com Travel",
      address: "no-reply@mail.ota.example.com",
    });
    expect(sent[0]).not.toHaveProperty("replyTo");
    expect(sent[0]).not.toHaveProperty("html");
    // An empty brand name falls back to MAIL_FROM's own display name.
    expect(sent[1]?.from).toEqual({ name: "Velexis OTA", address: "no-reply@mail.ota.example.com" });
    expect(sent[1]).not.toHaveProperty("replyTo");
  });

  it("refuses a recipient that is not one plain address without calling SMTP", async () => {
    const { gateway, sent } = gatewayWith(() => Promise.resolve({}));

    for (const to of [
      "Alex <alex@example.com>",
      "a@example.com, b@example.com",
      "alex@example.com\r\nBcc: x@example.com",
    ]) {
      const error = await gateway.send({ ...EMAIL, to }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MailerError);
      expect((error as MailerError).permanent).toBe(true);
      expect((error as MailerError).transport).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  it("reports an SMTP failure by code, reply code and command, never the server's text that may quote the recipient", async () => {
    const refused = Object.assign(new Error("Connection refused for alex@example.com"), {
      code: "ESOCKET",
      command: "CONN",
    });
    const rejected = Object.assign(new Error("550 alex@example.com: no such user"), {
      code: "EENVELOPE",
      responseCode: 550,
      command: "RCPT TO",
      response: "550 alex@example.com: no such user",
    });

    const down = await gatewayWith(() => Promise.reject(refused))
      .gateway.send(EMAIL)
      .catch((caught: unknown) => caught);
    const unknownUser = await gatewayWith(() => Promise.reject(rejected))
      .gateway.send(EMAIL)
      .catch((caught: unknown) => caught);

    expect(down).toBeInstanceOf(MailerError);
    expect((down as MailerError).message).toBe("ESOCKET CONN");
    expect((down as MailerError).transport).toBe(true);
    expect((unknownUser as MailerError).message).toBe("EENVELOPE 550 RCPT TO");
    expect((unknownUser as MailerError).transport).toBe(false);
    expect((unknownUser as MailerError).permanent).toBe(false);
    expect(JSON.stringify([down, unknownUser, (unknownUser as MailerError).failure])).not.toContain("alex@");
  });

  it("[OBE-055] attaches files as bytes, never as a path, with their names on one line", async () => {
    const { gateway, sent } = gatewayWith(() => Promise.resolve({}));
    const pdf = Buffer.from("%PDF-1.7 test");

    await gateway.send({
      ...EMAIL,
      attachments: [
        { fileName: "VX7K2M9Q-itinerary.pdf", contentType: "application/pdf", content: pdf },
        { fileName: "../../etc/passwd\r\nX-Evil: 1", contentType: "application/pdf", content: pdf },
      ],
    });
    await gateway.send({ ...EMAIL, attachments: [] });

    expect(sent[0]?.attachments).toEqual([
      {
        filename: "VX7K2M9Q-itinerary.pdf",
        content: pdf,
        contentType: "application/pdf",
        contentDisposition: "attachment",
      },
      {
        filename: ".._.._etc_passwd X-Evil: 1",
        content: pdf,
        contentType: "application/pdf",
        contentDisposition: "attachment",
      },
    ]);
    expect(sent[1]).not.toHaveProperty("attachments");
  });
});

describe("the helpers", () => {
  it("read MAIL_FROM with and without a display name", () => {
    expect(parseMailbox(MAIL_FROM)).toEqual({
      name: "Velexis OTA",
      address: "no-reply@mail.ota.example.com",
    });
    expect(parseMailbox("no-reply@mail.ota.example.com")).toEqual({
      name: "",
      address: "no-reply@mail.ota.example.com",
    });
    expect(() => parseMailbox("Velexis OTA")).toThrow(TypeError);
  });

  it("cut a display name to its maximum length and keep only safe parts of an error", () => {
    expect([...displayName("é".repeat(MAX_DISPLAY_NAME_LENGTH + 20))]).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
    expect(displayName("Alpha\u2028Travel")).toBe("Alpha Travel");
    expect(failureOf({ code: "lower-case", command: "rm -rf /", responseCode: 4.5 })).toEqual({
      code: "Error",
    });
    expect(describeFailure({ code: "ETIMEDOUT" })).toBe("ETIMEDOUT");
  });

  it("[OBE-055] cuts an attachment's name to one line without path separators", () => {
    expect(attachmentName("e-ticket-VX7K2M9Q-0571234567890.pdf")).toBe("e-ticket-VX7K2M9Q-0571234567890.pdf");
    expect(attachmentName(" a/b\\c\u0000d\u2028e ")).toBe("a_b_c d e");
    expect(attachmentName("\n\t")).toBe("attachment");
    expect([...attachmentName(`${"x".repeat(200)}.pdf`)]).toHaveLength(MAX_ATTACHMENT_NAME_LENGTH);
  });
});

/** A message the SMTP transport built (OBE-093): the text it would stream in DATA, and its SMTP envelope. */
interface BuiltMessage {
  readonly text: string;
  readonly envelope: { readonly from: string | false; readonly to: readonly string[] };
}

/**
 * The transport createSmtpTransport makes, with only its SMTP stage replaced: each message is built the way the SMTP
 * transport streams it in DATA (headers, parts, attachments, `raw` content) and kept instead of being sent. Everything
 * before that stage (the transport's options, Nodemailer's access policy for each message) is the real transport's.
 */
function buildingTransport(smtpUrl = "smtp://127.0.0.1:1025"): {
  transport: SmtpTransport;
  built: BuiltMessage[];
} {
  const transport = createSmtpTransport(smtpUrl);
  const built: BuiltMessage[] = [];
  transport.transporter.send = (mail, callback) => {
    mail.message.build((error, message) => {
      if (error !== null) {
        callback(error);
        return;
      }
      const envelope = mail.message.getEnvelope();
      built.push({ text: message.toString("utf8"), envelope: { from: envelope.from, to: envelope.to } });
      callback(null, {
        envelope,
        messageId: mail.message.messageId(),
        accepted: envelope.to,
        rejected: [],
        envelopeTime: 0,
        messageTime: 0,
        messageSize: message.length,
        response: "250 built, not sent",
      });
    });
  };
  return { transport, built };
}

/** The header lines of a built message, each continuation line joined to its header. */
function headerLines(text: string): string[] {
  const head = text.slice(0, text.indexOf("\r\n\r\n"));
  return head.split(/\r\n(?![ \t])/).map((line) => line.replace(/\r\n[ \t]+/g, " "));
}

/** The error code a send was refused with (`undefined` when it was not refused). */
async function refusalCode(sending: Promise<unknown>): Promise<unknown> {
  const outcome = await sending.then(
    () => undefined,
    (error: unknown) => error,
  );
  return typeof outcome === "object" && outcome !== null ? (outcome as { code?: unknown }).code : outcome;
}

describe("the SMTP transport (Nodemailer 10)", () => {
  // A query of SMTP_URL that asks for everything the gateway forbids, a nested `url` that would win over the gateway's
  // settings again, and a TLS option that is the URL's to give.
  const HOSTILE_QUERY =
    "?disableFileAccess=false&disableUrlAccess=false&logger=true&debug=true&socketTimeout=0" +
    "&url=smtp%3A%2F%2Fother.example%3FdisableFileAccess%3Dfalse%26disableUrlAccess%3Dfalse" +
    "&tls.servername=smtp.example.com";
  const GATEWAY_SETTINGS = {
    ...SMTP_TIMEOUTS,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  };

  it("[OBE-093 AC1] reads SMTP_URL and keeps no logs, no file or URL access and its timeouts whatever the query says", () => {
    expect(smtpTransportOptions("smtp://127.0.0.1:1025")).toEqual({
      secure: false,
      host: "127.0.0.1",
      port: 1025,
      ...GATEWAY_SETTINGS,
    });
    expect(
      smtpTransportOptions(`smtps://mailer:dummy-smtp-password@smtp.example.com:465${HOSTILE_QUERY}`),
    ).toEqual({
      secure: true,
      host: "smtp.example.com",
      port: 465,
      auth: { user: "mailer", pass: "dummy-smtp-password" },
      tls: { servername: "smtp.example.com" },
      ...GATEWAY_SETTINGS,
    });

    // The options every message of the transport takes its access policy from.
    const transport = createSmtpTransport(`smtp://127.0.0.1:1025${HOSTILE_QUERY}`);
    expect(transport.options).toMatchObject(GATEWAY_SETTINGS);
    expect(transport.options).not.toHaveProperty("url");
    transport.close();
  });

  it("[OBE-093 AC1] builds the gateway's e-mail as before: sender, Reply-To, Message-ID, envelope and attachment bytes", async () => {
    const { transport, built } = buildingTransport();
    const config = { get: () => MAIL_FROM } as unknown as ConfigService<WorkerConfig, true>;
    const pdf = Buffer.from("%PDF-1.7 OBE-093");

    const result = await new MailerGateway(transport, config).send({
      ...EMAIL,
      fromName: "Alpha\r\nBcc: victim@example.com\tTravel",
      attachments: [{ fileName: "VX7K2M9Q-itinerary.pdf", contentType: "application/pdf", content: pdf }],
    });

    expect(result).toEqual({ messageId: "<ntf_01J9ZA2B4C6D8E0F2G4H6J8K0M@mail.ota.example.com>" });
    expect(built).toHaveLength(1);
    const message = built[0] as BuiltMessage;
    expect(message.envelope).toEqual({ from: "no-reply@mail.ota.example.com", to: ["alex@example.com"] });
    const headers = headerLines(message.text);
    expect(headers).toEqual(
      expect.arrayContaining([
        'From: "Alpha Bcc: victim@example.com Travel" <no-reply@mail.ota.example.com>',
        "To: alex@example.com",
        "Reply-To: help@alpha-travel.example",
        `Subject: ${EMAIL.subject}`,
        "Message-ID: <ntf_01J9ZA2B4C6D8E0F2G4H6J8K0M@mail.ota.example.com>",
      ]),
    );
    // The brand name stayed a display name: no header of its own, and no other address than the recipient.
    expect(headers.filter((line) => /^(bcc|cc|x-evil):/i.test(line))).toEqual([]);
    expect(message.text).toContain("Content-Disposition: attachment; filename=VX7K2M9Q-itinerary.pdf");
    expect(message.text).toContain(pdf.toString("base64"));
  });

  it("[OBE-093 AC1] reads no file and no URL for an attachment, a body or a raw message, even when a message asks to", async () => {
    // The transport is given everything a hostile SMTP_URL query can say; the message fields try to reopen access.
    const { transport, built } = buildingTransport(`smtp://127.0.0.1:1025${HOSTILE_QUERY}`);
    const file = __filename; // a readable file: only the access policy keeps it out
    const url = "http://127.0.0.1:9/obe-093"; // never fetched: the refusal comes before any connection
    const base = { from: "no-reply@mail.ota.example.com", to: "alex@example.com", subject: "OBE-093" };
    const reopen = { disableFileAccess: false, disableUrlAccess: false };

    const cases: ReadonlyArray<readonly [string, SendMailOptions]> = [
      ["EFILEACCESS", { ...base, text: "x", attachments: [{ filename: "a.txt", path: file }] }],
      ["EURLACCESS", { ...base, text: "x", attachments: [{ filename: "a.txt", href: url }] }],
      ["EFILEACCESS", { ...base, html: { path: file } }],
      ["EURLACCESS", { ...base, html: { href: url } }],
      // GHSA-p6gq-j5cr-w38f: the message-level raw option went around the access policy before Nodemailer 9.0.1.
      ["EFILEACCESS", { ...base, raw: { path: file } }],
      ["EURLACCESS", { ...base, raw: { href: url } }],
      // The message's own flags cannot open what the transport closed.
      ["EFILEACCESS", { ...base, ...reopen, text: "x", attachments: [{ filename: "a.txt", path: file }] }],
      ["EURLACCESS", { ...base, ...reopen, raw: { href: url } }],
    ];
    const codes = [];
    for (const [, message] of cases) {
      codes.push(await refusalCode(transport.sendMail(message)));
    }

    expect(codes).toEqual(cases.map(([code]) => code));
    expect(built).toEqual([]);
  });

  it("[OBE-093 AC1] never hands Nodemailer a raw message, a path or a URL", async () => {
    const { gateway, sent } = gatewayWith(() => Promise.resolve({}));
    const pdf = Buffer.from("%PDF-1.7 test");

    await gateway.send(EMAIL);
    await gateway.send({
      ...EMAIL,
      html: null,
      attachments: [{ fileName: "VX7K2M9Q-itinerary.pdf", contentType: "application/pdf", content: pdf }],
    });

    const keys = (value: unknown): string[] =>
      Buffer.isBuffer(value) || typeof value !== "object" || value === null
        ? []
        : Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]);
    expect(sent).toHaveLength(2);
    for (const message of sent) {
      expect(
        keys(message).filter((key) =>
          ["raw", "path", "href", "disableFileAccess", "disableUrlAccess"].includes(key),
        ),
      ).toEqual([]);
      expect(typeof message.html === "string" || message.html === undefined).toBe(true);
      expect(typeof message.text).toBe("string");
    }
  });
});
