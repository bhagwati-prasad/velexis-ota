// The Velexis Amadeus routes of the platform admin (platform/docs/api-inventory-admin.md §5, PBE-020): the shared
// accounts under `/v1/admin/amadeus-accounts` (list, create, update, verify again) and the office pool under
// `/v1/admin/amadeus-offices` (list, add in bulk, notes, assign, retire). Every operation is `x-scope:
// platform_admin`, so AdminAuthGuard checks the admin token and re-reads the account first; RecentMfaGuard adds the
// step-up of `adminCreateAmadeusAccount` (`x-mfa-step-up`), and AmadeusAccountsService the one of an update that
// changes the credentials. Thin: each handler binds its operation, reads the validated request and makes one service
// call. The client secret travels in the request body only; nothing here logs a body, and no answer holds it.
import { Controller, Get, HttpCode, Patch, Post, Res } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  AmadeusAccountsService,
  type AdminAmadeusAccount,
  type AdminAmadeusAccountList,
  type CreateAmadeusAccountRequest,
  type UpdateAmadeusAccountRequest,
} from "../supplier-connections/amadeus-accounts.service";
import {
  AmadeusOfficesService,
  type AddAmadeusOfficesRequest,
  type AdminAmadeusOffice,
  type AdminAmadeusOfficeList,
  type AdminReasonRequest,
  type AmadeusOfficeAssigned,
  type AmadeusOfficesAdded,
  type AssignAmadeusOfficeRequest,
  type ListAmadeusOfficesQuery,
  type UpdateAmadeusOfficeRequest,
} from "../supplier-connections/amadeus-offices.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/admin")
export class AdminAmadeusController {
  constructor(
    private readonly accounts: AmadeusAccountsService,
    private readonly offices: AmadeusOfficesService,
  ) {}

  @Get("amadeus-accounts")
  @OpenApiOperation("adminListAmadeusAccounts")
  adminListAmadeusAccounts(): Promise<AdminAmadeusAccountList> {
    return this.accounts.list();
  }

  @Post("amadeus-accounts")
  @OpenApiOperation("adminCreateAmadeusAccount")
  async adminCreateAmadeusAccount(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: CreateAmadeusAccountRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminAmadeusAccount> {
    const account = await this.accounts.create(token, body);
    res.setHeader("ETag", etagOf(account.version));
    return account;
  }

  @Patch("amadeus-accounts/:accountId")
  @OpenApiOperation("adminUpdateAmadeusAccount")
  async adminUpdateAmadeusAccount(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("header") header: RequestParameters,
    @Validated("body") body: UpdateAmadeusAccountRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminAmadeusAccount> {
    const account = await this.accounts.update(
      token,
      path["accountId"] as string,
      versionOfIfMatch(header["if-match"] as string),
      body,
    );
    res.setHeader("ETag", etagOf(account.version));
    return account;
  }

  @Post("amadeus-accounts/:accountId/verify")
  @HttpCode(202)
  @OpenApiOperation("adminVerifyAmadeusAccount")
  async adminVerifyAmadeusAccount(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
  ): Promise<void> {
    await this.accounts.requestVerification(token, path["accountId"] as string);
  }

  @Get("amadeus-offices")
  @OpenApiOperation("adminListAmadeusOffices")
  adminListAmadeusOffices(
    @Validated("query") query: ListAmadeusOfficesQuery,
  ): Promise<AdminAmadeusOfficeList> {
    return this.offices.list(query);
  }

  @Post("amadeus-offices")
  @OpenApiOperation("adminAddAmadeusOffices")
  adminAddAmadeusOffices(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: AddAmadeusOfficesRequest,
  ): Promise<AmadeusOfficesAdded> {
    return this.offices.add(token, body);
  }

  @Patch("amadeus-offices/:officeRowId")
  @OpenApiOperation("adminUpdateAmadeusOffice")
  async adminUpdateAmadeusOffice(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("header") header: RequestParameters,
    @Validated("body") body: UpdateAmadeusOfficeRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminAmadeusOffice> {
    const office = await this.offices.updateNotes(
      token,
      path["officeRowId"] as string,
      versionOfIfMatch(header["if-match"] as string),
      body,
    );
    res.setHeader("ETag", etagOf(office.version));
    return office;
  }

  @Post("amadeus-offices/:officeRowId/assign")
  @HttpCode(200)
  @OpenApiOperation("adminAssignAmadeusOffice")
  adminAssignAmadeusOffice(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AssignAmadeusOfficeRequest,
  ): Promise<AmadeusOfficeAssigned> {
    return this.offices.assign(token, path["officeRowId"] as string, body);
  }

  @Post("amadeus-offices/:officeRowId/retire")
  @HttpCode(200)
  @OpenApiOperation("adminRetireAmadeusOffice")
  adminRetireAmadeusOffice(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AdminReasonRequest,
  ): Promise<AdminAmadeusOffice> {
    return this.offices.retire(token, path["officeRowId"] as string, body);
  }
}
