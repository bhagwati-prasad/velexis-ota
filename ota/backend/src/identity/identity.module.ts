// The identity context (ota/docs/architecture.md §2.1, ADR-0008, OADR-0006): customer access tokens (TokenService,
// with the key of JWT_PRIVATE_KEY_FILE, read once at start-up), customer sessions (the refresh families of
// `customer_sessions`) and the request's signed-in customer (`CustomerContext`, which the global customer guard of
// app.module.ts fills). The auth operations live in AuthController: sign-in with its lockout, refresh, sign-out and
// getSession (OBE-033); sign-up, verification and passwords (OBE-032, OBE-034) add theirs. Staff sessions follow in
// M4. API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { CustomerContext } from "../common/auth/customer.guard";
import { CookieWriter } from "../common/http/cookie-writer";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AuthController, RefreshIdempotencyHooks } from "./auth.controller";
import { CustomersRepository } from "./customers.repository";
import { SignInLockout } from "./lockout";
import { SessionsRepository } from "./sessions.repository";
import { SessionsService } from "./sessions.service";
import { SignInIdempotencyHooks, SignInService } from "./sign-in.service";
import { TokenService } from "./token.service";

@Module({
  imports: [TenancyModule.forApi()],
  controllers: [AuthController],
  providers: [
    TokenService,
    SessionsRepository,
    SessionsService,
    CustomersRepository,
    SignInLockout,
    SignInService,
    SignInIdempotencyHooks,
    RefreshIdempotencyHooks,
    CustomerContext,
    CookieWriter,
  ],
  exports: [TokenService, SessionsService, CustomerContext],
})
export class IdentityModule {}
