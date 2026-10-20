// The notifications module (OBE-030; ota/docs/architecture.md §2.1 and §6, OADR-0013, ADR-0017): the e-mail outbox of
// every tenant, its templates (tenant rows or code defaults, templates/registry.ts), the renderer and, in the worker,
// the SMTP gateway, the `ota-notifications` consumer and the `notifications.sweep` handler.
//
//   API     NotificationsModule.forApi()     OutboxService (queue an e-mail in a use case's transaction), and the
//                                            template service and renderer the console's template settings use (OBE-073)
//   worker  NotificationsModule.forWorker()  the same, and MailerGateway, OutboxDrainer, NotificationsProcessor and
//                                            NotificationsSweep (`@TenantJob`, found by the jobs module's runner)
//
// Both are global, so a use case anywhere injects `OutboxService` without importing this module (as AppModule and
// WorkerModule import it once). Sending happens in the worker only (ADR-0017): the API never opens an SMTP connection.
// The tenant context, `TenantTx` and the platform cache come from `TenancyModule`, the queues from QueuesModule, Clock
// and IdGenerator from the global CommonModule; the KEKs of MASTER_KEY_DIR are loaded once, at start-up.
import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { QueuesModule } from "../common/queues/queues.module";
import { TenancyModule } from "../tenancy/tenancy.module";
import { MailerGateway, mailTransportProvider } from "./mailer.gateway";
import { NotificationsProcessor, NotificationsSweep, OutboxDrainer } from "./notifications.processor";
import { OutboxRepository } from "./outbox.repository";
import { notificationsKeyProvider, OutboxService } from "./outbox.service";
import { NotificationRenderer } from "./renderer";
import { TemplateService } from "./template.service";

/** What both processes have. */
const SHARED_PROVIDERS: readonly Provider[] = [
  notificationsKeyProvider,
  OutboxRepository,
  OutboxService,
  TemplateService,
  NotificationRenderer,
];

const SHARED_EXPORTS = [OutboxService, TemplateService, NotificationRenderer];

@Module({})
export class NotificationsModule {
  private static api: DynamicModule | undefined;
  private static worker: DynamicModule | undefined;

  /** The API's module: queueing e-mails, templates and rendering; no sending. */
  static forApi(): DynamicModule {
    NotificationsModule.api ??= {
      module: NotificationsModule,
      global: true,
      imports: [TenancyModule.forApi(), QueuesModule],
      providers: [...SHARED_PROVIDERS],
      exports: [...SHARED_EXPORTS],
    };
    return NotificationsModule.api;
  }

  /** The worker's module: the API's, the SMTP gateway, the `ota-notifications` consumer and the sweep's handler. */
  static forWorker(): DynamicModule {
    NotificationsModule.worker ??= {
      module: NotificationsModule,
      global: true,
      imports: [TenancyModule.forWorker(), QueuesModule],
      providers: [
        ...SHARED_PROVIDERS,
        mailTransportProvider,
        MailerGateway,
        OutboxDrainer,
        NotificationsProcessor,
        NotificationsSweep,
      ],
      exports: [...SHARED_EXPORTS, MailerGateway],
    };
    return NotificationsModule.worker;
  }
}
