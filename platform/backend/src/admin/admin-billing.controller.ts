// The plan and subscription routes of the platform admin (platform/docs/api-inventory-admin.md §4, M1 rows; PBE-033):
// the plans under `/v1/admin/plans` (list with tenant counts, create, edit or retire) and the subscriptions under
// `/v1/admin/subscriptions` (list, detail with invoices and Stripe events, the edit of a manual subscription). Every
// operation is `x-scope: platform_admin`, so AdminAuthGuard checks the admin token and re-reads the account first, and
// the validation interceptor requires the `reason` of `adminUpdateManualSubscription` (`x-reason-required`). Thin:
// each handler binds its operation, reads the validated request and makes one service call (PlansService of
// BillingModule, SubscriptionsService); versioned answers carry their version in `ETag`.
//
// The M5 rows (PBE-048; subscription-billing flow §A and §D, PADR-0002 items 2 and 5, scope PF-88 and PF-89): the price
// comparison of a plan (`adminCheckPlanPrices`; `adminUpdatePlan` links the Stripe prices), the resync of a Stripe
// subscription (`adminResyncSubscription`), the invoices of every OTA (`adminListInvoices`) and the Stripe webhook inbox
// with its reprocessing (`adminListStripeEvents`, `adminReprocessStripeEvent`, AdminStripeEventsService).
import { Controller, Get, HttpCode, Patch, Post, Res } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import {
  PlansService,
  type AdminPlan,
  type AdminPlanList,
  type CreatePlanRequest,
  type PlanPriceCheck,
  type UpdatePlanRequest,
} from "../billing/plans.service";
import {
  SubscriptionsService,
  type AdminInvoiceList,
  type AdminSubscription,
  type AdminSubscriptionDetail,
  type AdminSubscriptionList,
  type ListInvoicesQuery,
  type ListSubscriptionsQuery,
  type UpdateManualSubscriptionRequest,
} from "../billing/subscriptions.service";
import { AccessToken } from "../common/auth/decorators";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  AdminStripeEventsService,
  type AdminStripeEventList,
  type ListStripeEventsQuery,
} from "./admin-stripe-events.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/admin")
export class AdminBillingController {
  constructor(
    private readonly plans: PlansService,
    private readonly subscriptions: SubscriptionsService,
    private readonly stripeEvents: AdminStripeEventsService,
  ) {}

  @Get("plans")
  @OpenApiOperation("adminListPlans")
  adminListPlans(): Promise<AdminPlanList> {
    return this.plans.list();
  }

  @Post("plans")
  @OpenApiOperation("adminCreatePlan")
  async adminCreatePlan(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: CreatePlanRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminPlan> {
    const plan = await this.plans.create(token, body);
    res.setHeader("ETag", etagOf(plan.version));
    return plan;
  }

  @Patch("plans/:planCode")
  @OpenApiOperation("adminUpdatePlan")
  async adminUpdatePlan(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("header") header: RequestParameters,
    @Validated("body") body: UpdatePlanRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminPlan> {
    const plan = await this.plans.update(
      token,
      path["planCode"] as string,
      versionOfIfMatch(header["if-match"] as string),
      body,
    );
    res.setHeader("ETag", etagOf(plan.version));
    return plan;
  }

  @Post("plans/:planCode/check-prices")
  @HttpCode(200)
  @OpenApiOperation("adminCheckPlanPrices")
  adminCheckPlanPrices(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
  ): Promise<PlanPriceCheck> {
    return this.plans.checkPrices(token, path["planCode"] as string);
  }

  @Get("subscriptions")
  @OpenApiOperation("adminListSubscriptions")
  adminListSubscriptions(@Validated("query") query: ListSubscriptionsQuery): Promise<AdminSubscriptionList> {
    return this.subscriptions.list(query);
  }

  @Get("subscriptions/:subscriptionId")
  @OpenApiOperation("adminGetSubscription")
  async adminGetSubscription(
    @Validated("path") path: RequestParameters,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSubscriptionDetail> {
    const detail = await this.subscriptions.get(path["subscriptionId"] as string);
    res.setHeader("ETag", etagOf(detail.subscription.version));
    return detail;
  }

  @Patch("subscriptions/:subscriptionId")
  @OpenApiOperation("adminUpdateManualSubscription")
  async adminUpdateManualSubscription(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("header") header: RequestParameters,
    @Validated("body") body: UpdateManualSubscriptionRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSubscription> {
    const subscription = await this.subscriptions.updateManual(
      token,
      path["subscriptionId"] as string,
      versionOfIfMatch(header["if-match"] as string),
      body,
    );
    res.setHeader("ETag", etagOf(subscription.version));
    return subscription;
  }

  @Post("subscriptions/:subscriptionId/resync")
  @HttpCode(200)
  @OpenApiOperation("adminResyncSubscription")
  async adminResyncSubscription(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSubscription> {
    const subscription = await this.subscriptions.resync(token, path["subscriptionId"] as string);
    res.setHeader("ETag", etagOf(subscription.version));
    return subscription;
  }

  @Get("invoices")
  @OpenApiOperation("adminListInvoices")
  adminListInvoices(@Validated("query") query: ListInvoicesQuery): Promise<AdminInvoiceList> {
    return this.subscriptions.listInvoices(query);
  }

  @Get("stripe-events")
  @OpenApiOperation("adminListStripeEvents")
  adminListStripeEvents(@Validated("query") query: ListStripeEventsQuery): Promise<AdminStripeEventList> {
    return this.stripeEvents.list(query);
  }

  @Post("stripe-events/:eventId/reprocess")
  @HttpCode(202)
  @OpenApiOperation("adminReprocessStripeEvent")
  async adminReprocessStripeEvent(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
  ): Promise<void> {
    await this.stripeEvents.reprocess(token, path["eventId"] as string);
  }
}
