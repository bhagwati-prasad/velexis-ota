// The customer account operations (`x-scope: customer`; OBE-035): account.get (`GET /v1/account`), account.update
// (`PATCH /v1/account`) and account.delete (`POST /v1/account/deletion`), thin handlers over AccountService. The global
// guards resolved the caller, the tenant and the scope, the customer guard required the customer's access token (a key
// caller's bearer token, the edge's `__Host-vx_at` cookie; every security alternative of these operations names one),
// the CSRF guard checked the edge's PATCH and POST, the validation interceptor checked the input against the OTA
// document (`If-Match` on update, `Idempotency-Key` on delete) and the idempotency interceptor stores the deletion's
// answer under its key (`DeleteAccountIdempotencyHooks`: without the password in its hash).
//
// account.get and account.update answer `Customer` with `ETag: "<version>"` and `Cache-Control: private, no-store`
// (the document: personal data). account.delete answers `202 AccountDeletion` with `Cache-Control: no-store`; for the
// storefront edge it clears `__Host-vx_at` and `__Host-vx_rt` and rotates `__Host-vx_csrf` (api-changes §2.2), key
// callers get no `Set-Cookie` and drop their tokens themselves. A `429 RATE_LIMITED` of the re-authentication or of an
// address change carries `Retry-After`.
import { Controller, Get, HttpCode, Patch, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { CustomerContext } from "../common/auth/customer.guard";
import { CookieWriter } from "../common/http/cookie-writer";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  ACCOUNT_CACHE_CONTROL,
  accountEtagOf,
  DELETION_CACHE_CONTROL,
  toAccount,
  toAccountDeletion,
  type AccountDeletion,
  type Customer,
} from "./account.mapper";
import { AccountRetryLaterError, AccountService } from "./account.service";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

/** Runs `work`, answering a `429` of the account service with its `Retry-After`. */
async function withRetryAfter<T>(res: Response, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AccountRetryLaterError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    throw error;
  }
}

@Controller("v1/account")
export class AccountController {
  constructor(
    private readonly accounts: AccountService,
    private readonly customers: CustomerContext,
    private readonly cookies: CookieWriter,
  ) {}

  @Get()
  @OpenApiOperation("getAccount")
  async get(@Res({ passthrough: true }) res: Response): Promise<Customer> {
    res.setHeader("Cache-Control", ACCOUNT_CACHE_CONTROL);
    // The customer guard requires the access token on this operation.
    const customer = await this.accounts.get(this.customers.require());
    res.setHeader("ETag", accountEtagOf(customer.version));
    return toAccount(customer);
  }

  @Patch()
  @OpenApiOperation("updateAccount")
  async update(
    @OpenApiInput() input: ValidatedInput<"updateAccount">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Customer> {
    res.setHeader("Cache-Control", ACCOUNT_CACHE_CONTROL);
    const principal = this.customers.require();
    const customer = await withRetryAfter(res, () =>
      this.accounts.update(principal, {
        body: bodyOf("updateAccount", input.body),
        ifMatch: input.headers["If-Match"],
      }),
    );
    res.setHeader("ETag", accountEtagOf(customer.version));
    return toAccount(customer);
  }

  @Post("deletion")
  @HttpCode(202)
  @OpenApiOperation("deleteAccount")
  async delete(
    @OpenApiInput() input: ValidatedInput<"deleteAccount">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountDeletion> {
    res.setHeader("Cache-Control", DELETION_CACHE_CONTROL);
    const principal = this.customers.require();
    const deleted = await withRetryAfter(res, () =>
      this.accounts.delete(principal, bodyOf("deleteAccount", input.body)),
    );
    // api-changes §2.2: the session cookies go, and the CSRF value is rotated (edge mode only).
    this.cookies.clearSession(res);
    return toAccountDeletion(deleted);
  }
}
