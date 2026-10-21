// The console context (ota/docs/architecture.md §2.1, OADR-0011, flows/console-operations.md): what the OTA admin and
// custom consoles call in console scope. Since OBE-060 it holds the console audit: the `staff_actions` writer
// (staff-actions.writer.ts), which the permission guard and the audit interceptor of app.module.ts use, and which use
// cases of every module inject to write their row in their own transaction (console.auth.signIn in identity/staff).
// It is global for that reason, as the e-mail outbox is: a module that audits a console action does not import it, and
// the identity module, which this one would otherwise import for the staff context, does not need to.
//
// The console operations themselves (bookings, PNR import, queues, customers, supplier log, raw Amadeus reads,
// payments, settings) join with OBE-061 to OBE-074.
import { Global, Module } from "@nestjs/common";
import { StaffContext } from "../common/auth/staff.guard";
import { RequestContext } from "../common/http/request-context";
import { TenancyModule } from "../tenancy/tenancy.module";
import { StaffActionsWriter } from "./staff-actions.writer";

@Global()
@Module({
  imports: [TenancyModule.forApi()],
  providers: [
    StaffActionsWriter,
    // Typed views of the request context (nestjs-cls), as the identity and HTTP modules provide them: stateless, so
    // these instances read the same request state as theirs.
    StaffContext,
    RequestContext,
  ],
  exports: [StaffActionsWriter],
})
export class ConsoleModule {}
