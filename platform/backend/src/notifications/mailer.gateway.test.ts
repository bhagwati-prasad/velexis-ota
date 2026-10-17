// The SMTP gateway (PBE-011; ADR-0017, PADR-0013 item 6) with a recording transport: what it hands Nodemailer for one
// e-mail (sender, one recipient also as the SMTP envelope, the Message-ID of the outbox id), and what it keeps of a
// failure (codes only, never the server's reply text).
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
  type MailTransport,
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
