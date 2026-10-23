// The documents module (OBE-053; ota/docs/architecture.md §2.1 and §6, OADR-0013 items 6 and 7, ADR-0017): the
// itinerary and e-ticket receipt PDFs of the bookings (documents.processor.ts, renderers/), their `booking_documents`
// rows (documents.repository.ts) and, in the worker, the StorageAdapter they are stored with.
//
//   API     DocumentsModule.forApi()     DocumentRequests: the booking events of a request (checkout.complete records
//                                        the order) ask for their documents, enqueued after the commit; the downloads
//                                        (OBE-054): DocumentDownloadsService with the URL signer of
//                                        DOCUMENT_URL_KEY_FILE (signed-url.ts) and the StorageAdapter, read only, and
//                                        FilesController (the file endpoint `GET /v1/files/{storageKey}`)
//   worker  DocumentsModule.forWorker()  the same (the ticketing and reconciliation jobs write booking events too),
//                                        the StorageAdapter of STORAGE_DRIVER and STORAGE_DIR, DocumentRenderService
//                                        and the `ota-documents` consumer, DocumentsProcessor
//
// Both are global, so OrderRecorder (bookings) injects `DocumentRequests` without importing this module, as AppModule
// and WorkerModule import it once; this module imports nothing of the bookings module (it reads the booking tables
// through its own repository), so the dependency stays one way, bookings → documents (architecture §2). Rendering
// happens in the worker only: the API never renders or stores a document, it reads the stored files. The booking
// operations of the downloads (bookings.listDocuments, bookings.getDocumentDownloadUrl) sit on `/v1/bookings/{id}` behind
// the booking access guard, which reads the booking through the bookings module: their controller
// (documents.controller.ts) is BookingsModule's, over DocumentDownloadsService, which this module exports. The service
// reads the guard's decision from the request context (BookingAccessContext, a view of nestjs-cls provided here again).
import { Module, type DynamicModule, type FactoryProvider, type Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createStorage, type StorageAdapter } from "@velexis/db/storage";
import { BookingAccessContext } from "../common/auth/booking-access.guard";
import { QueuesModule } from "../common/queues/queues.module";
import type { SharedConfig } from "../config";
import { TenancyModule } from "../tenancy/tenancy.module";
import {
  DOCUMENT_STORAGE,
  DocumentRenderService,
  DocumentRequests,
  DocumentsProcessor,
} from "./documents.processor";
import { DocumentDownloadsService } from "./document-downloads.service";
import { DocumentsRepository } from "./documents.repository";
import { FilesController } from "./files.controller";
import { DocumentUrlSigner, documentUrlKeyProvider } from "./signed-url";

/**
 * The StorageAdapter of both processes (ADR-0017): `local` under STORAGE_DIR. Nothing is read or written at start-up;
 * `s3` throws here, so neither process starts with a driver that does not exist yet. No URL signer: the API signs the
 * file endpoint's URLs with DocumentUrlSigner and the injected clock (the adapter's `signedUrl` reads the system clock
 * and could not report the expiry it signed), and the worker signs none.
 */
export const documentStorageProvider: FactoryProvider<StorageAdapter> = {
  provide: DOCUMENT_STORAGE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<SharedConfig, true>) =>
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

  /** The API's module: asking for documents, and their downloads (OBE-054); no rendering. */
  static forApi(): DynamicModule {
    DocumentsModule.api ??= {
      module: DocumentsModule,
      global: true,
      imports: [TenancyModule.forApi(), QueuesModule],
      controllers: [FilesController],
      providers: [
        ...SHARED_PROVIDERS,
        documentStorageProvider,
        documentUrlKeyProvider,
        DocumentUrlSigner,
        DocumentDownloadsService,
        BookingAccessContext,
      ],
      exports: [DocumentRequests, DocumentDownloadsService],
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
