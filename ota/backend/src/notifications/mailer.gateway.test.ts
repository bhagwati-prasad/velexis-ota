// The SMTP gateway of the OTA worker without SMTP (OBE-030; OADR-0013 item 5, ADR-0017): the message it hands to
// Nodemailer (the OTA's brand as the sender's display name on MAIL_FROM's address, the support address as Reply-To,
// the envelope, the Message-ID, the attachments of OBE-055) and the failures it reports. Sending through Mailpit runs
// in test/integration/notifications/outbox.int.test.ts and booking-emails.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import type { SendMailOptions } from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../config";
import {
  attachmentName,
  describeFailure,
  displayName,
  failureOf,
  MailerError,
  MailerGateway,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  parseMailbox,
  type MailTransport,
  type OutgoingEmail,
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
