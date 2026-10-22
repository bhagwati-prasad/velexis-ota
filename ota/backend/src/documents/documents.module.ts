// The documents module (OBE-053; ota/docs/architecture.md §2.1 and §6, OADR-0013 items 6 and 7, ADR-0017): the
// itinerary and e-ticket receipt PDFs of the bookings (documents.processor.ts, renderers/), their `booking_documents`
// rows (documents.repository.ts) and, in the worker, the StorageAdapter they are stored with.
//
//   API     DocumentsModule.forApi()     DocumentRequests: the booking events of a request (checkout.complete records
//                                        the order) ask for their documents, enqueued after the commit
//   worker  DocumentsModule.forWorker()  the same (the ticketing and reconciliation jobs write booking events too),
//                                        the StorageAdapter of STORAGE_DRIVER and STORAGE_DIR, DocumentRenderService
//                                        and the `ota-documents` consumer, DocumentsProcessor
//
// Both are global, so OrderRecorder (bookings) injects `DocumentRequests` without importing this module, as AppModule
// and WorkerModule import it once; this module imports nothing of the bookings module (it reads the booking tables
// through its own repository), so the dependency stays one way, bookings → documents (architecture §2). Rendering
// happens in the worker only: the API never renders or stores a document. The file endpoint and the signed URLs of
// OBE-054 join the API's side.
import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createStorage, type StorageAdapter } from "@velexis/db/storage";
import { QueuesModule } from "../common/queues/queues.module";
import type { WorkerConfig } from "../config";
import { TenancyModule } from "../tenancy/tenancy.module";
import {
  DOCUMENT_STORAGE,
  DocumentRenderService,
  DocumentRequests,
  DocumentsProcessor,
} from "./documents.processor";
import { DocumentsRepository } from "./documents.repository";

/**
 * The worker's StorageAdapter (ADR-0017): `local` under STORAGE_DIR. Nothing is read or written at start-up; `s3`
 * throws here, so the worker does not start with a driver that does not exist yet. The worker signs no URLs.
 */
export const documentStorageProvider: FactoryProvider<StorageAdapter> = {
  provide: DOCUMENT_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<WorkerConfig, true>) =>
    createStorage({
      driver: config.get("STORAGE_DRIVER", { infer: true }),
      dir: config.get("STORAGE_DIR", { infer: true }),
    }),
};

/** What both processes have. */
const SHARED_PROVIDERS: readonly Provider[] = [DocumentsRepository, DocumentRequests];

@Module({})
export class DocumentsModule {
  private static api: DynamicModule | undefined;
  private static worker: DynamicModule | undefined;

  /** The API's module: asking for documents; no rendering or storage. */
  static forApi(): DynamicModule {
    DocumentsModule.api ??= {
      module: DocumentsModule,
      global: true,
      imports: [TenancyModule.forApi(), QueuesModule],
      providers: [...SHARED_PROVIDERS],
      exports: [DocumentRequests],
    };
    return DocumentsModule.api;
  }

  /** The worker's module: the API's, the storage, the renderer and the `ota-documents` consumer. */
  static forWorker(): DynamicModule {
    DocumentsModule.worker ??= {
      module: DocumentsModule,
      global: true,
      imports: [TenancyModule.forWorker(), QueuesModule],
      providers: [...SHARED_PROVIDERS, documentStorageProvider, DocumentRenderService, DocumentsProcessor],
      exports: [DocumentRequests],
    };
    return DocumentsModule.worker;
  }
}
