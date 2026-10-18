// DomainsModule (platform/docs/architecture.md §2.1, layer 1): owns `tenant_domains`. PBE-018 brings the repository
// with the sub-domain row of a new OTA, which ProvisioningModule writes in the create-OTA transaction. The portal's
// domain routes, the DNS verification, the TLS probe and the TLS `ask` endpoint (PADR-0004, ADR-0018) come with
// PBE-027 and M5.
import { Module } from "@nestjs/common";
import { DomainsRepository } from "./domains.repository";

@Module({
  providers: [DomainsRepository],
  exports: [DomainsRepository],
})
export class DomainsModule {}
