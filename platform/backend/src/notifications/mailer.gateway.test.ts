// The SMTP gateway (PBE-011; ADR-0017, PADR-0013 item 6) with a recording transport: what it hands Nodemailer for one
// e-mail (sender, one recipient also as the SMTP envelope, the Message-ID of the outbox id), and what it keeps of a
// failure (codes only, never the server's reply text). Sending through Mailpit runs in
// test/integration/notifications/email-outbox.int.test.ts.
//
// PBE-068 (Nodemailer 10, security review F-2): the SMTP transport of createSmtpTransport, with only its SMTP stage
// replaced by one that builds each message from the stream the transport sends in DATA (`message.build` reads
// `createReadStream`), proves that the transport reads no file and no URL (for an attachment, a body or a `raw` message,
// also when the message or SMTP_URL asks it to) and that the gateway's e-mails come out as before. The refusal is the
// stream's error (`EFILEACCESS`, `EURLACCESS`); through SMTP the connection reports it as `ESTREAM` with the command
// `API`, and the message is not delivered.
import type { ConfigService } from "@nestjs/config";
import type { SendMailOptions } from "nodemailer";
import { describe, expect, it } from "vitest";
import type { PlatformBackendConfig } from "../config";
import {
  createSmtpTransport,
  describeFailure,
  failureOf,
  MailerError,
  MailerGateway,
  parseMailbox,
  SMTP_TIMEOUTS,
  smtpTransportOptions,
  type MailTransport,
  type SmtpTransport,
} from "./mailer.gateway";

const EMAIL_ID = "eml_01JTESTMAILER0000000000000";

/** A transport that records the messages, or fails with `error`. */
function recordingTransport(
  error?: unknown,
): MailTransport & { readonly sent: SendMailOptions[]; closed: boolean } {
  const sent: SendMailOptions[] = [];
  const transport = {
    sent,
    closed: false,
    sendMail: (message: SendMailOptions) => {
      sent.push(message);
      return error === undefined ? Promise.resolve({ messageId: message.messageId }) : Promise.reject(error);
    },
    close: () => {
      transport.closed = true;
    },
  };
  return transport as unknown as MailTransport & { readonly sent: SendMailOptions[]; closed: boolean };
}

function gateway(
  transport: MailTransport,
  from = '"Velexis" <no-reply@mail.platform.example.com>',
): MailerGateway {
  const config = { get: () => from } as unknown as ConfigService<PlatformBackendConfig, true>;
  return new MailerGateway(transport, config);
}

const EMAIL = {
  emailId: EMAIL_ID,
  to: "ana.lima@example.com",
  subject: "Confirm your e-mail address for Velexis",
  html: "<p>Hi</p>",
  text: "Hi",
};

describe("parseMailbox", () => {
  it.each([
    ['"Velexis" <no-reply@mail.platform.example.com>', "Velexis"],
    ["Velexis <no-reply@mail.platform.example.com>", "Velexis"],
    ["Velexis (dev) <no-reply@mail.platform.example.com>", "Velexis (dev)"],
    ["no-reply@mail.platform.example.com", ""],
  ])("reads %s", (value, name) => {
    expect(parseMailbox(value)).toEqual({ name, address: "no-reply@mail.platform.example.com" });
  });

  it("refuses a value without a valid address", () => {
    expect(() => parseMailbox("Velexis <no-reply@localhost>")).toThrow(TypeError);
  });
});

describe("MailerGateway.send", () => {
  it("sends one message from MAIL_FROM to one recipient, also as the SMTP envelope, with the outbox id as Message-ID", async () => {
    const transport = recordingTransport();

    await expect(gateway(transport).send(EMAIL)).resolves.toEqual({
      messageId: `<${EMAIL_ID}@mail.platform.example.com>`,
    });

    expect(transport.sent).toEqual([
      {
        from: { name: "Velexis", address: "no-reply@mail.platform.example.com" },
        to: { name: "", address: "ana.lima@example.com" },
        envelope: { from: "no-reply@mail.platform.example.com", to: ["ana.lima@example.com"] },
        messageId: `<${EMAIL_ID}@mail.platform.example.com>`,
        subject: EMAIL.subject,
        html: EMAIL.html,
        text: EMAIL.text,
      },
    ]);
  });

  it.each([
    '"x@evil.example.net" <ana.lima@example.com>',
    "ana.lima@example.com, x@evil.example.net",
    "ana.lima@example.com\r\nBcc: x@evil.example.net",
    '"x@evil.example.net"@example.com',
  ])("refuses the recipient %j before Nodemailer reads it", async (to) => {
    const transport = recordingTransport();

    await expect(gateway(transport).send({ ...EMAIL, to })).rejects.toEqual(
      new MailerError({ code: "EINVALIDRECIPIENT" }),
    );
    expect(transport.sent).toEqual([]);
  });

  it("keeps the code, the reply code and the command of an SMTP failure, never the reply text", async () => {
    const smtpError = Object.assign(
      new Error("Can't send mail - all recipients were rejected: 550 <ana.lima@example.com>"),
      {
        code: "EENVELOPE",
        responseCode: 550,
        command: "RCPT TO",
        response: "550 5.1.1 <ana.lima@example.com>: Recipient address rejected",
      },
    );

    const error = await gateway(recordingTransport(smtpError))
      .send(EMAIL)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MailerError);
    expect((error as MailerError).message).toBe("EENVELOPE 550 RCPT TO");
    expect(JSON.stringify(error)).not.toContain("ana.lima");
  });

  it("closes the transport at shutdown", () => {
    const transport = recordingTransport();

    gateway(transport).onApplicationShutdown();

    expect(transport.closed).toBe(true);
  });
});

describe("failureOf", () => {
  it("takes only well-formed codes, and the error's name when there is no code", () => {
    expect(
      failureOf(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1025"), { code: "ECONNECTION" })),
    ).toEqual({
      code: "ECONNECTION",
    });
    expect(
      failureOf(Object.assign(new Error("x"), { code: "550 <ana@example.com>", command: "RCPT TO\r\nX" })),
    ).toEqual({
      code: "Error",
    });
    expect(failureOf("not an error")).toEqual({ code: "Error" });
    expect(describeFailure({ code: "ETIMEDOUT", command: "CONN" })).toBe("ETIMEDOUT CONN");
  });
});

describe("createSmtpTransport", () => {
  it("builds a transport of SMTP_URL that reads no file or URL and writes no log", () => {
    const transport = createSmtpTransport("smtp://127.0.0.1:1025") as unknown as {
      options: Record<string, unknown>;
      transporter: { options: Record<string, unknown> };
    };

    expect(transport.options).toMatchObject({
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
    });
    expect(transport.transporter.options).toMatchObject({
      host: "127.0.0.1",
      port: 1025,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    (transport as unknown as MailTransport).close();
  });

  it("reads implicit TLS and the credentials of an smtps:// URL (dummy values)", () => {
    const transport = createSmtpTransport(
      "smtps://dummy-user:dummy%40pass@smtp.example.com:465",
    ) as unknown as {
      transporter: { options: Record<string, unknown> };
    };

    expect(transport.transporter.options).toMatchObject({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "dummy-user", pass: "dummy@pass" },
      socketTimeout: 30_000,
    });
    (transport as unknown as MailTransport).close();
  });
});

/** A message the SMTP transport built (PBE-068): the text it would stream in DATA, and its SMTP envelope. */
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

  it("[PBE-068 AC1] reads SMTP_URL and keeps no logs, no file or URL access and its timeouts whatever the query says", () => {
    expect(smtpTransportOptions("smtp://127.0.0.1:1025")).toEqual({
      secure: false,
      host: "127.0.0.1",
      port: 1025,
      ...GATEWAY_SETTINGS,
    });
    expect(
      smtpTransportOptions(`smtps://dummy-user:dummy-smtp-password@smtp.example.com:465${HOSTILE_QUERY}`),
    ).toEqual({
      secure: true,
      host: "smtp.example.com",
      port: 465,
      auth: { user: "dummy-user", pass: "dummy-smtp-password" },
      tls: { servername: "smtp.example.com" },
      ...GATEWAY_SETTINGS,
    });

    // The options every message of the transport takes its access policy from, and those the SMTP stage connects with.
    const transport = createSmtpTransport(`smtp://127.0.0.1:1025${HOSTILE_QUERY}`);
    expect(transport.options).toMatchObject(GATEWAY_SETTINGS);
    expect(transport.options).not.toHaveProperty("url");
    expect((transport.transporter as unknown as { options: Record<string, unknown> }).options).toMatchObject({
      host: "127.0.0.1",
      port: 1025,
      ...GATEWAY_SETTINGS,
    });
    transport.close();
  });

  it("[PBE-068 AC1] builds the platform's e-mail byte for byte as Nodemailer 6.10.1 did, with the same envelope", async () => {
    // What Nodemailer 6.10.1's SMTP transport built for this e-mail (recorded before the upgrade): only the Date header
    // and the part boundary, which change on every build, are replaced.
    const BEFORE = [
      "From: Velexis <no-reply@mail.platform.example.com>",
      "To: ana.lima@example.com",
      "Subject: =?UTF-8?Q?Confirme_o_seu_e-mail_=E2=80=94_Velexis?=",
      `Message-ID: <${EMAIL_ID}@mail.platform.example.com>`,
      "Date: <date>",
      "MIME-Version: 1.0",
      "Content-Type: multipart/alternative;",
      ' boundary="<boundary>"',
      "",
      "--<boundary>",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Ol=C3=A1 Ana, confirme: https://portal.example.com/sign-in?next=3Dotas",
      "--<boundary>",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      '<p>Ol=C3=A1 Ana, <a href=3D"https://portal.example.com/sign-in?=',
      'next=3Dotas">confirme</a>.</p>',
      "--<boundary>--",
      "",
    ].join("\r\n");
    const { transport, built } = buildingTransport();

    await expect(
      gateway(transport).send({
        ...EMAIL,
        subject: "Confirme o seu e-mail — Velexis",
        html: '<p>Olá Ana, <a href="https://portal.example.com/sign-in?next=otas">confirme</a>.</p>',
        text: "Olá Ana, confirme: https://portal.example.com/sign-in?next=otas",
      }),
    ).resolves.toEqual({ messageId: `<${EMAIL_ID}@mail.platform.example.com>` });

    expect(built).toHaveLength(1);
    const message = built[0] as BuiltMessage;
    expect(message.envelope).toEqual({
      from: "no-reply@mail.platform.example.com",
      to: ["ana.lima@example.com"],
    });
    const boundary = /boundary="([^"]+)"/.exec(message.text)?.[1] ?? "";
    expect(boundary).not.toBe("");
    expect(
      message.text
        .split(boundary)
        .join("<boundary>")
        .replace(/^Date: [^\r\n]+$/m, "Date: <date>"),
    ).toBe(BEFORE);
    // No header of the message names another address than the sender and the recipient.
    expect(headerLines(message.text).filter((line) => /^(bcc|cc|reply-to|sender):/i.test(line))).toEqual([]);
    transport.close();
  });

  it("[PBE-068 AC1] reads no file and no URL for an attachment, a body or a raw message, even when a message asks to", async () => {
    // The transport is given everything a hostile SMTP_URL query can say; the message fields try to reopen access.
    const { transport, built } = buildingTransport(`smtp://127.0.0.1:1025${HOSTILE_QUERY}`);
    const file = __filename; // a readable file: only the access policy keeps it out
    const url = "http://127.0.0.1:9/pbe-068"; // never fetched: the refusal comes before any connection
    const base = {
      from: "no-reply@mail.platform.example.com",
      to: "ana.lima@example.com",
      subject: "PBE-068",
    };
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
    transport.close();
  });

  it("[PBE-068 AC1] never hands Nodemailer a raw message, a path or a URL", async () => {
    const transport = recordingTransport();

    await gateway(transport).send(EMAIL);

    const keys = (value: unknown): string[] =>
      typeof value !== "object" || value === null
        ? []
        : Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)]);
    expect(transport.sent).toHaveLength(1);
    for (const message of transport.sent) {
      expect(
        keys(message).filter((key) =>
          ["raw", "path", "href", "attachments", "disableFileAccess", "disableUrlAccess"].includes(key),
        ),
      ).toEqual([]);
      expect(typeof message.html).toBe("string");
      expect(typeof message.text).toBe("string");
    }
  });
});
