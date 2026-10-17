// NotificationsModule (PBE-011; platform/docs/architecture.md §2.1, PADR-0013): owns `email_outbox`. A module that
// sends e-mail imports it and calls `OutboxService.queue(trx, …)` in its own transaction; the e-mail is sent by the
// worker after the commit. The API and the worker both import the static module (queue e-mails); only WorkerModule
// imports `NotificationsModule.forWorker()`, which adds the templates, the SMTP gateway, the `platform-emails`
// processor and its sweep scheduler, so the API never sends and never consumes a queue.
//
// It uses the global CommonModule (Clock, IdGenerator, EnvelopeService, PLATFORM_DB in the worker) and the queues of
// QueuesModule.
import { Module, type DynamicModule } from "@nestjs/common";
import { QueuesModule } from "../common/queues/queues.module";
import { EmailProcessor, EmailSweepScheduler } from "./email.processor";
import { MailerGateway, mailTransportProvider } from "./mailer.gateway";
import { OutboxRepository } from "./outbox.repository";
import { OutboxService } from "./outbox.service";
import { EmailTemplates } from "./templates";

@Module({
  imports: [QueuesModule],
  providers: [OutboxRepository, OutboxService],
  exports: [OutboxService],
})
export class NotificationsModule {
  /**
   * The module with the sending side, for WorkerModule: the templates (loaded and checked when the worker starts; an
   * invalid template stops the start), the SMTP gateway, the processor and the sweep scheduler.
   */
  static forWorker(): DynamicModule {
    return {
      module: NotificationsModule,
      providers: [
        { provide: EmailTemplates, useFactory: () => EmailTemplates.load() },
        mailTransportProvider,
        MailerGateway,
        EmailProcessor,
        EmailSweepScheduler,
      ],
    };
  }
}
