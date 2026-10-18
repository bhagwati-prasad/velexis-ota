// AuthModule (platform/docs/architecture.md §2.1, layer 1): owns the credentials and the status of `accounts`,
// `account_tokens` and `account_sessions` (and, from PBE-015, `account_recovery_codes`). PBE-013 brings sign-up,
// e-mail verification and the resend of the link; PBE-014 the password sign-in with its lockout, the MFA challenge of
// accounts with MFA, the refresh families and their rotation, sign-out and sign-out everywhere. The password rules
// (`PasswordPolicy`, the breached list read once when the module is built), the repositories, the sessions
// (`SessionsService`, `SignInService.startSession`) and the MFA challenges are exported for the MFA, reset and account
// tasks. TokenService (token signing) is provided by the global CommonModule, since the guards need it.
//
// It queues e-mails through NotificationsModule and audits through AuditModule, both of layer 0; the Redis client and
// the invalidation publisher come from the global RedisModule.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AccountTokensRepository } from "./account-tokens.repository";
import { AccountsRepository } from "./accounts.repository";
import { AuthController } from "./auth.controller";
import { MfaChallengeStore } from "./mfa-challenge.store";
import { PasswordPolicy } from "./password-policy";
import { SessionsRepository } from "./sessions.repository";
import { SessionsService } from "./sessions.service";
import { SignInService } from "./sign-in.service";
import { SignUpService } from "./sign-up.service";

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [AuthController],
  providers: [
    { provide: PasswordPolicy, useFactory: () => PasswordPolicy.load() },
    AccountsRepository,
    AccountTokensRepository,
    SessionsRepository,
    SessionsService,
    MfaChallengeStore,
    SignUpService,
    SignInService,
  ],
  exports: [
    PasswordPolicy,
    AccountsRepository,
    AccountTokensRepository,
    SessionsService,
    SignInService,
    MfaChallengeStore,
  ],
})
export class AuthModule {}
