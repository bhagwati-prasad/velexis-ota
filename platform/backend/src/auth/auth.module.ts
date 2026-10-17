// AuthModule (platform/docs/architecture.md §2.1, layer 1): owns the credentials and the status of `accounts`, and
// `account_tokens` (and, from PBE-014 and PBE-015, `account_sessions` and `account_recovery_codes`). PBE-013 brings
// sign-up, e-mail verification and the resend of the link; the password rules (`PasswordPolicy`, the breached list
// read once when the module is built) and the two repositories are exported for the sign-in, reset and account tasks.
// TokenService (token signing) is provided by the global CommonModule, since the guards need it.
//
// It queues e-mails through NotificationsModule and audits through AuditModule, both of layer 0.
import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AccountTokensRepository } from "./account-tokens.repository";
import { AccountsRepository } from "./accounts.repository";
import { AuthController } from "./auth.controller";
import { PasswordPolicy } from "./password-policy";
import { SignUpService } from "./sign-up.service";

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [AuthController],
  providers: [
    { provide: PasswordPolicy, useFactory: () => PasswordPolicy.load() },
    AccountsRepository,
    AccountTokensRepository,
    SignUpService,
  ],
  exports: [PasswordPolicy, AccountsRepository, AccountTokensRepository],
})
export class AuthModule {}
