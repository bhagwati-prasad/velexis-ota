// The account context (ota/docs/architecture.md §2.1 `account`; OBE-035): the signed-in customer's profile and its
// deletion (AccountController, AccountService, AccountRepository), in the tenant's `customers` tables through the
// tenancy module's `TenantTx`. It builds on the identity module: the request's customer (`CustomerContext`), the
// sessions a deletion revokes (`SessionsService`) and the verification link of an address change
// (`VerificationService`). The customer rows the identity module reads (`CustomersRepository`), the sign-in lockout the
// re-authentication counts against (`SignInLockout`, on the global RedisModule's client) and the cookie writer (both
// plain providers without state) are provided here again, as BookingsModule does with the cookie writer. A deletion
// queues `payment.void` on `ota-payments` (QueuesModule) for the authorisations of the checkouts it abandons. API only;
// the worker never imports it.
import { Module } from "@nestjs/common";
import { CookieWriter } from "../common/http/cookie-writer";
import { QueuesModule } from "../common/queues/queues.module";
import { CustomersRepository } from "../identity/customers.repository";
import { IdentityModule } from "../identity/identity.module";
import { SignInLockout } from "../identity/lockout";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AccountController } from "./account.controller";
import { AccountRepository } from "./account.repository";
import { AccountService, DeleteAccountIdempotencyHooks } from "./account.service";

@Module({
  imports: [TenancyModule.forApi(), IdentityModule, QueuesModule],
  controllers: [AccountController],
  providers: [
    AccountService,
    AccountRepository,
    DeleteAccountIdempotencyHooks,
    CustomersRepository,
    SignInLockout,
    CookieWriter,
  ],
})
export class AccountModule {}
