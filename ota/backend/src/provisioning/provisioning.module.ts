// The provisioning module of the OTA worker (OBE-005; OADR-0007, ota/docs/architecture.md §2): the `ota-tenant-ops`
// processor, the provisioning service and the `platform-tenant-events` producer. Only WorkerModule imports it: its
// provisioner database is built from DATABASE_PROVISIONER_URL, which only the worker's configuration has, so the
// API process could not even build it (`ProvisionerDsnMissingError`). The read-only platform repository comes from
// `TenancyModule.forWorker()`, the queues from QueuesModule (OBE-002), Clock from the global CommonModule.
import { Inject, Injectable, Module, type FactoryProvider, type OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import { QueuesModule } from "../common/queues/queues.module";
import type { WorkerConfig } from "../config";
import { TenancyModule } from "../tenancy/tenancy.module";
import {
  createProvisionerDatabase,
  DEFAULT_PROVISIONING_OPTIONS,
  PROVISIONER_DATABASE,
  PROVISIONING_OPTIONS,
  ProvisioningService,
  type ProvisionerDatabase,
} from "./provisioning.service";
import { TenantEventsProducer } from "./tenant-events.producer";
import { TenantOpsProcessor } from "./tenant-ops.processor";

/**
 * The provisioner database from the process's validated configuration. In a process whose configuration has no
 * DATABASE_PROVISIONER_URL (the API's never has, config.ts) the factory throws `ProvisionerDsnMissingError`, and the
 * application does not start.
 */
export const provisionerDatabaseProvider: FactoryProvider<ProvisionerDatabase> = {
  provide: PROVISIONER_DATABASE,
  inject: [ConfigService, PinoLogger],
  useFactory: (config: ConfigService<WorkerConfig, true>, logger: PinoLogger) => {
    logger.setContext(ProvisioningModule.name);
    return createProvisionerDatabase(
      {
        APP_ENV: config.get("APP_ENV", { infer: true }),
        DATABASE_PROVISIONER_URL: config.get("DATABASE_PROVISIONER_URL", { infer: true }),
      },
      logger,
    );
  },
};

/** Ends the provisioner pool when the worker shuts down. */
@Injectable()
export class ProvisionerPoolCloser implements OnApplicationShutdown {
  constructor(@Inject(PROVISIONER_DATABASE) private readonly database: ProvisionerDatabase) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.database.pool.ended) {
      await this.database.pool.end();
    }
  }
}

@Module({
  imports: [TenancyModule.forWorker(), QueuesModule],
  providers: [
    provisionerDatabaseProvider,
    ProvisionerPoolCloser,
    { provide: PROVISIONING_OPTIONS, useValue: DEFAULT_PROVISIONING_OPTIONS },
    ProvisioningService,
    TenantEventsProducer,
    TenantOpsProcessor,
  ],
  // The CLI's dev:seed (OBE-007) provisions through the same function.
  exports: [ProvisioningService],
})
export class ProvisioningModule {}
