// GET /health/live and GET /health/ready of the API (operations healthLive and healthReady, api-inventory-admin.md).
// Caddy answers 404 for /health/* on the public host except /health/live; deploy.sh and the on-VM checks poll
// /health/ready on 127.0.0.1:3100 (ADR-0016). Neither path writes a request log line (@velexis/logger).
import { Controller, Get, Header, Res } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { HealthService, type LiveReport, type ReadyReport } from "./health.service";

/** The part of the Express response the readiness route uses. */
interface StatusSettable {
  status(code: number): unknown;
}

@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthService,
    @InjectPinoLogger(HealthController.name) private readonly logger: PinoLogger,
  ) {}

  @Get("live")
  @Header("Cache-Control", "no-store")
  live(): LiveReport {
    return this.health.live();
  }

  /** `200` when PostgreSQL and Redis answer, otherwise `503`; the body names the status of each dependency. */
  @Get("ready")
  @Header("Cache-Control", "no-store")
  async ready(@Res({ passthrough: true }) res: StatusSettable): Promise<ReadyReport> {
    const { report, failures } = await this.health.ready();
    for (const { dependency, error } of failures) {
      // The request logger: the line carries the requestId. `err` keeps type, message, stack and code only.
      this.logger.warn({ dependency, err: error }, "health.dependency_down");
    }
    if (report.status !== "ok") {
      res.status(503);
    }
    return report;
  }
}
