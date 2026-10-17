// The Amadeus module (OADR-0001, ADR-0012): the only code of the OTA backend that talks to Amadeus. OBE-017 brings the
// connection resolver (which credential set, base URL and offices serve a tenant) and the token provider (OAuth
// tokens, encrypted in Redis, single flight); OBE-018 adds `AmadeusClient` with the rate limits, timeouts, retries,
// error mapping and `supplier_requests`. Business modules import this module and call the client, never `fetch`.
//
// It runs in the API: it reads the platform rows through the tenancy caches of `TenancyModule.forApi()` and keeps its
// tokens and locks on the process's Redis client. The KEKs of MASTER_KEY_DIR are loaded once, when the module starts:
// a missing current key, or a key file that group or others may read, stops the start-up (@velexis/crypto
// `LocalFileKeyProvider`). They decrypt the client secrets the platform encrypted and encrypt the cached tokens.
import { Module, type FactoryProvider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LocalFileKeyProvider, type KeyProvider } from "@velexis/crypto";
import type { ApiConfig } from "../config";
import { TenancyModule } from "../tenancy/tenancy.module";
import { ConnectionResolver } from "./connection-resolver";
import { AMADEUS_FETCH, KEY_PROVIDER, TokenProvider, type AmadeusFetch } from "./token-provider";

/** The KEKs of MASTER_KEY_DIR, MASTER_KEY_CURRENT wrapping new data keys (ADR-0010, ADR-0026). */
const keyProvider: FactoryProvider<Promise<KeyProvider>> = {
  provide: KEY_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<ApiConfig, true>) =>
    LocalFileKeyProvider.fromDir(
      config.get("MASTER_KEY_DIR", { infer: true }),
      config.get("MASTER_KEY_CURRENT", { infer: true }),
    ),
};

/** Node's built-in `fetch` (ADR-0012), called as a plain function; unit tests construct the services with a fake. */
const amadeusFetch: FactoryProvider<AmadeusFetch> = {
  provide: AMADEUS_FETCH,
  useFactory: (): AmadeusFetch => (input, init) => fetch(input, init),
};

@Module({
  imports: [TenancyModule.forApi()],
  providers: [keyProvider, amadeusFetch, ConnectionResolver, TokenProvider],
  exports: [ConnectionResolver, TokenProvider],
})
export class AmadeusModule {}
