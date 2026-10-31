// `getCredentialSubmission` (PBE-052; platform/docs/api-inventory-resources.md §3, PADR-0010): owners and admins of the
// OTA follow the verification of submitted credentials (`GET /v1/tenants/{tenantId}/credential-submissions/
// {submissionId}`); the portal polls it every 2 seconds until the submission is final. The answer is the submission's
// status and error (`toCredentialSubmission`), never a secret, a ciphertext or the submitted public fields; a
// submission of another OTA answers `404 NOT_FOUND`. Thin: the handler binds its operation and makes one
// CredentialSubmissionsService call. TenantRoleGuard answers `404` to non-members and `403` to the other roles before
// it runs. Reads are not audited (PADR-0006: changes and sensitive reads only).
import { Controller, Get } from "@nestjs/common";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../auth/tenant-role.guard";
import { OpenApiOperation, Validated } from "../http/openapi-operation.decorator";
import { tenantRolesOf } from "../../memberships/tenant-roles";
import { CredentialSubmissionsService, type CredentialSubmission } from "./credential-submissions.service";

@Controller("v1/tenants/:tenantId/credential-submissions")
export class CredentialSubmissionsController {
  constructor(private readonly submissions: CredentialSubmissionsService) {}

  @Get(":submissionId")
  @OpenApiOperation("getCredentialSubmission")
  @TenantRoles(...tenantRolesOf("getCredentialSubmission"))
  getCredentialSubmission(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
  ): Promise<CredentialSubmission> {
    return this.submissions.get(membership.tenantId, path["submissionId"] as string);
  }
}
