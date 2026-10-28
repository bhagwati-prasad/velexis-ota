// `console.customers.list` and `console.customers.get` (consoleListCustomers, consoleGetCustomer; `x-scope: console`,
// `x-permission: customers:read`, every role; OBE-066): thin handlers over ConsoleCustomersService
// (customers.service.ts). The global guards resolved the caller (the OTA admin's service key with a staff token, a
// secret key with a staff token, or a `console:automation` key), the tenant and its environment, the staff member, the
// rate limits and the permission (OADR-0011 points 3 to 6); the validation interceptor checked the input against the
// OTA document. Answers are `Cache-Control: private, no-store`.
//
// Viewing a customer is an audited read (OADR-0011 point 8 as decided on 2026-10-21): console.customers.get opts in
// with `@AuditedRead`, and the console audit interceptor writes its `succeeded` row `customer.view` with the customer
// as the target; a refused or failed call (an unknown customer's `404` included) has its row as any console call. The
// customer search writes none.
import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  CONSOLE_CUSTOMER_CACHE_CONTROL,
  ConsoleCustomersService,
  CUSTOMER_VIEW_ACTION,
  type ConsoleCustomer,
  type ConsoleCustomerPage,
} from "./customers.service";
import { AuditedRead } from "./staff-actions.writer";

@Controller("v1/console/customers")
export class ConsoleCustomersController {
  constructor(private readonly customers: ConsoleCustomersService) {}

  @Get()
  @OpenApiOperation("consoleListCustomers")
  async list(
    @OpenApiInput() input: ValidatedInput<"consoleListCustomers">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleCustomerPage> {
    res.setHeader("Cache-Control", CONSOLE_CUSTOMER_CACHE_CONTROL);
    return await this.customers.list(input.query ?? {});
  }

  @Get(":customerId")
  @OpenApiOperation("consoleGetCustomer")
  @AuditedRead({ action: CUSTOMER_VIEW_ACTION })
  async get(
    @OpenApiInput() input: ValidatedInput<"consoleGetCustomer">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleCustomer> {
    res.setHeader("Cache-Control", CONSOLE_CUSTOMER_CACHE_CONTROL);
    return await this.customers.get(input.path.customerId);
  }
}
