// The dashboard route of the platform admin (platform/docs/api-inventory-admin.md §2 `adminGetDashboard`, PBE-029):
// the counters of the admin home page. `x-scope: platform_admin`, so AdminAuthGuard checks the admin token and re-reads
// the account first. Thin: one AdminDashboardService call.
import { Controller, Get } from "@nestjs/common";
import { OpenApiOperation } from "../common/http/openapi-operation.decorator";
import { AdminDashboardService, type AdminDashboard } from "./admin-dashboard.service";

@Controller("v1/admin/dashboard")
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get()
  @OpenApiOperation("adminGetDashboard")
  adminGetDashboard(): Promise<AdminDashboard> {
    return this.dashboard.get();
  }
}
