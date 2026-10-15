// The pricing context (ota/docs/architecture.md §2.1, OADR-0005): the one home of the markup and fee engine, shared by
// shopping, checkout and the console. The engine itself (`priceOffer` in pricing-engine.ts) is a pure function that
// callers import; the module provides the tenant repository that loads the rules it is given. It needs no other
// module: the repository works on the caller's `tenantTx` transaction.
import { Module } from "@nestjs/common";
import { RulesRepository } from "./rules.repository";

@Module({
  providers: [RulesRepository],
  exports: [RulesRepository],
})
export class PricingModule {}
