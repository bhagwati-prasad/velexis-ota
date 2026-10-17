// ApiKeysModule (platform/docs/architecture.md §2.1, layer 1; PADR-0005): owns `api_keys`. The static module holds
// what the API and the worker share: the repository and the generator, with the pepper of API_KEY_PEPPER_FILE read
// once when the module starts (`API_KEY_PEPPER`). ProvisioningModule is to import it for `issueInitialTestKeys`
// (PBE-022).
//
// - `ApiKeysModule.forApi()` (AppModule) adds the portal's routes: list, create, update, roll, revoke (PBE-021).
// - `ApiKeysModule.forWorker()` (WorkerModule) adds the `api_keys.flush_usage` handler of the `platform-maintenance`
//   processor.
//
// It uses the global CommonModule (Clock, IdGenerator, PLATFORM_DB; AccountAuthStates in the API) and RedisModule
// (the command client, the InvalidationPublisher).
import { Module, type DynamicModule, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readKeyFile } from "@velexis/config";
import { API_KEY_PEPPER_MIN_BYTES } from "@velexis/crypto";
import { AuditModule } from "../audit/audit.module";
import type { PlatformBackendConfig } from "../config";
import { API_KEY_PEPPER, ApiKeyGenerator } from "./api-key-generator";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysService } from "./api-keys.service";
import { UsageFlushProcessor } from "./usage-flush.processor";

/**
 * The decoded API key pepper (PADR-0005 item 3), read once from API_KEY_PEPPER_FILE, which the configuration checked
 * (it exists, mode 0400 or 0600, at least 32 bytes after base64 decoding). It stays in memory and is never logged.
 */
export const apiKeyPepperProvider: FactoryProvider<Buffer> = {
  provide: API_KEY_PEPPER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<PlatformBackendConfig, true>): Buffer => {
    const pepper = readKeyFile(config.get("API_KEY_PEPPER_FILE", { infer: true }), {
      minBytes: API_KEY_PEPPER_MIN_BYTES,
    });
    if (!Buffer.isBuffer(pepper)) {
      throw new TypeError("API_KEY_PEPPER_FILE must be a base64 key file");
    }
    return pepper;
  },
};

@Module({
  imports: [AuditModule],
  providers: [apiKeyPepperProvider, ApiKeysRepository, ApiKeyGenerator],
  exports: [ApiKeysRepository, ApiKeyGenerator],
})
export class ApiKeysModule {
  /** The module with the portal's API key routes, for AppModule. */
  static forApi(): DynamicModule {
    return {
      module: ApiKeysModule,
      controllers: [ApiKeysController],
      providers: [ApiKeysService],
    };
  }

  /** The module with the usage flush of the `platform-maintenance` processor, for WorkerModule. */
  static forWorker(): DynamicModule {
    return {
      module: ApiKeysModule,
      providers: [UsageFlushProcessor],
    };
  }
}
