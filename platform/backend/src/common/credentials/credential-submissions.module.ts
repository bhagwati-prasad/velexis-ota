// CredentialSubmissionsModule (PBE-052; platform/docs/architecture.md §2.1: CommonModule's shared
// `credential_submissions`, PADR-0010). The credential submission framework that own Amadeus credentials (PBE-053,
// SupplierConnectionsModule) and own Stripe API keys (PBE-057, PaymentConnectionsModule) share:
//
// - the static module (for the modules whose operations submit): CredentialSubmissionsService (`submit(trx, …)`, the
//   read of a submission, the `credentials.verify` enqueue) over CredentialSubmissionsRepository;
// - `CredentialSubmissionsModule.forApi()` (AppModule): the same with the portal's `getCredentialSubmission` route
//   (CredentialSubmissionsController);
// - `CredentialSubmissionsModule.forWorker()`, the static CredentialSubmissionsWorkerModule: the attempt of
//   `credentials.verify` (CredentialsVerifyProcessor, run by the one processor of `platform-connections`,
//   supplier-connections/verification.processor.ts, whose module imports it) and the one registry of verifiers
//   (CredentialVerifiers), exported so the modules that own the connections register their verifier in it. A static
//   module is built once per application, so every importer shares the registry. `forWorker()` therefore answers the
//   class itself, never a new `{ module: … }` object: Nest 11 tells dynamic modules apart by object reference
//   (ByReferenceModuleOpaqueKeyFactory), so a DynamicModule built per call would give each importer a registry and a
//   processor of its own, and a verifier registered by PBE-057's module would never reach the processor of
//   `platform-connections` (credential-submissions.int.test.ts registers its verifier from a module of its own).
//
// It uses the global CommonModule (Clock, IdGenerator, PLATFORM_DB, EnvelopeService), AuditModule, the queues of
// QueuesModule and, in the worker, NotificationsModule (the submitter's e-mail).
import { Module, type DynamicModule, type Type } from "@nestjs/common";
import { AuditModule } from "../../audit/audit.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { QueuesModule } from "../queues/queues.module";
import { CredentialSubmissionsController } from "./credential-submissions.controller";
import { CredentialSubmissionsRepository } from "./credential-submissions.repository";
import { CredentialSubmissionsService } from "./credential-submissions.service";
import { CredentialsVerifyProcessor, CredentialVerifiers } from "./credentials-verify.processor";

/** The worker's part: the attempt of `credentials.verify` and the registry of verifiers. */
@Module({
  imports: [AuditModule, NotificationsModule],
  providers: [CredentialSubmissionsRepository, CredentialVerifiers, CredentialsVerifyProcessor],
  exports: [CredentialVerifiers, CredentialsVerifyProcessor],
})
export class CredentialSubmissionsWorkerModule {}

@Module({
  imports: [AuditModule, QueuesModule],
  providers: [CredentialSubmissionsRepository, CredentialSubmissionsService],
  exports: [CredentialSubmissionsService],
})
export class CredentialSubmissionsModule {
  /** The module with the portal's `getCredentialSubmission` route, for AppModule. */
  static forApi(): DynamicModule {
    return {
      module: CredentialSubmissionsModule,
      controllers: [CredentialSubmissionsController],
    };
  }

  /**
   * The worker's part (the verification attempt and the verifiers), for the processor of `platform-connections` and
   * for every module that registers a verifier: the static CredentialSubmissionsWorkerModule, one instance per
   * application whoever imports it (see the file header).
   */
  static forWorker(): Type<CredentialSubmissionsWorkerModule> {
    return CredentialSubmissionsWorkerModule;
  }
}
