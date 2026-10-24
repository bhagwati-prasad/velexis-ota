// The identity context (ota/docs/architecture.md §2.1, ADR-0008, OADR-0006): customer access tokens (TokenService,
// with the key of JWT_PRIVATE_KEY_FILE, read once at start-up), customer sessions (the refresh families of
// `customer_sessions`) and the request's signed-in customer (`CustomerContext`, which the global customer guard of
// app.module.ts fills). The auth operations live in AuthController: sign-in with its lockout, refresh, sign-out and
// getSession (OBE-033); sign-up with its password rules (`CustomerPasswordPolicy`, the breached-password list read
// once at start-up), e-mail verification and its resend (`VerificationService`, which account.update's address change
// reuses; OBE-032); the password reset and change (`PasswordService`, with the same password rules; OBE-034). Staff
// sign-in by portal token, the staff sessions in Redis and the request's signed-in staff member (`StaffContext`, which
// the global staff guard fills) are in `staff/` (OBE-059). API only; the worker never imports it.
import { Module } from "@nestjs/common";
import { CustomerContext } from "../common/auth/customer.guard";
import { StaffContext } from "../common/auth/staff.guard";
import { CookieWriter } from "../common/http/cookie-writer";
import { RequestContext } from "../common/http/request-context";
import { TenancyModule } from "../tenancy/tenancy.module";
import { AuthController, RefreshIdempotencyHooks } from "./auth.controller";
import { CustomerAccess } from "./customer-access";
import { CustomersRepository } from "./customers.repository";
import { SignInLockout } from "./lockout";
import { CustomerPasswordPolicy } from "./password-policy";
import { PasswordResetsRepository } from "./password-resets.repository";
import {
  ChangePasswordIdempotencyHooks,
  PasswordService,
  ResetPasswordIdempotencyHooks,
} from "./password.service";
import { SessionsRepository } from "./sessions.repository";
import { SessionsService } from "./sessions.service";
import { SignInIdempotencyHooks, SignInService } from "./sign-in.service";
import { SignUpIdempotencyHooks, SignUpService } from "./sign-up.service";
import { StaffAuthController } from "./staff/staff-auth.controller";
import { ConsoleSignInIdempotencyHooks, StaffAuthService } from "./staff/staff-auth.service";
import { StaffSessions, StaffTokens } from "./staff/staff-sessions";
import { TokenService } from "./token.service";
import { VerificationService } from "./verification.service";

@Module({
  imports: [TenancyModule.forApi()],
  controllers: [AuthController, StaffAuthController],
  providers: [
    TokenService,
    SessionsRepository,
    SessionsService,
    CustomersRepository,
    SignInLockout,
    SignInService,
    SignInIdempotencyHooks,
    // The breached-password list is read once, when the module is built.
    { provide: CustomerPasswordPolicy, useFactory: () => CustomerPasswordPolicy.load() },
    VerificationService,
    SignUpService,
    SignUpIdempotencyHooks,
    PasswordResetsRepository,
    PasswordService,
    ResetPasswordIdempotencyHooks,
    ChangePasswordIdempotencyHooks,
    RefreshIdempotencyHooks,
    CustomerContext,
    // Whether the customer of a valid token may still act: the customer guard asks it, account.delete revokes it.
    CustomerAccess,
    CookieWriter,
    StaffTokens,
    StaffSessions,
    StaffAuthService,
    ConsoleSignInIdempotencyHooks,
    StaffContext,
    // RequestContext only reads the request context (nestjs-cls): the staff auth handlers read the end user the caller
    // guard decided (OBE-060).
    RequestContext,
  ],
  exports: [
    TokenService,
    SessionsService,
    CustomerContext,
    CustomerAccess,
    CustomerPasswordPolicy,
    VerificationService,
    StaffTokens,
    StaffSessions,
    StaffContext,
  ],
})
export class IdentityModule {}
