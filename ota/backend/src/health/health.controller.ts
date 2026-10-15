// The two health endpoints (ADR-0016) on both transports: HealthController serves them in the API's Nest HTTP
// pipeline (PORT), HealthServer serves the same paths and answers on the worker's node:http port (HEALTH_PORT), which
// has no Nest HTTP adapter. Caddy blocks /health/* publicly except /health/live on the API hosts; in the API, the caller
// guard lets /health/live through without a credential and /health/ready on a direct loopback connection only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Controller, Get, Header, Injectable, Res, type BeforeApplicationShutdown } from "@nestjs/common";
import { LocalRoute, PublicRoute } from "../common/auth/caller.guard";
import { HealthService, type LivenessBody, type ReadinessBody } from "./health.service";

/** The part of the Express response the controller uses: the status code of the readiness answer. */
interface StatusWriter {
  status(code: number): unknown;
}

/** Health answers are never cached by a proxy or a client. */
const NO_STORE = "no-store";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** `200 {status: "ok"}` while the process runs. */
  @Get("live")
  @PublicRoute()
  @Header("Cache-Control", NO_STORE)
  live(): LivenessBody {
    return this.health.live();
  }

  /** `200` when PostgreSQL and Redis answer, `503` otherwise; the body names the status of each. */
  @Get("ready")
  @LocalRoute()
  @Header("Cache-Control", NO_STORE)
  async ready(@Res({ passthrough: true }) res: StatusWriter): Promise<ReadinessBody> {
    const readiness = await this.health.ready();
    res.status(readiness.ready ? 200 : 503);
    return readiness.body;
  }
}

/** Socket and request limits of the worker's health port: probes are tiny and local. */
const SERVER_TIMEOUT_MS = 10_000;

/**
 * The worker's health port: a `node:http` server with `GET /health/live` and `GET /health/ready` (and `HEAD`), the
 * same answers as the API. Any other path is `404`, any other method `405`. `worker.ts` starts it on
 * `127.0.0.1:HEALTH_PORT`; it stops accepting connections when the application shuts down.
 */
@Injectable()
export class HealthServer implements BeforeApplicationShutdown {
  private server: Server | undefined;

  constructor(private readonly health: HealthService) {}

  /** Starts listening and resolves with the bound address (port 0 picks a free port). */
  async listen(port: number, host: string): Promise<AddressInfo> {
    if (this.server !== undefined) {
      throw new Error("HealthServer: already listening");
    }
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.requestTimeout = SERVER_TIMEOUT_MS;
    server.headersTimeout = SERVER_TIMEOUT_MS;
    server.keepAliveTimeout = 1_000;
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(port, host, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    this.server = server;
    return server.address() as AddressInfo;
  }

  /** The bound address, or `undefined` before `listen` and after shutdown. */
  address(): AddressInfo | undefined {
    const address = this.server?.address();
    return typeof address === "object" && address !== null ? address : undefined;
  }

  async beforeApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (server === undefined) {
      return;
    }
    this.server = undefined;
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeIdleConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url ?? "/", "http://health.invalid").pathname;
      if (path !== "/health/live" && path !== "/health/ready") {
        send(res, 404, undefined);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        send(res, 405, undefined);
        return;
      }
      if (path === "/health/live") {
        send(res, 200, this.health.live(), req.method);
        return;
      }
      const readiness = await this.health.ready();
      send(res, readiness.ready ? 200 : 503, readiness.body, req.method);
    } catch {
      // HealthService.ready() never rejects; a failure here is a bug, answered as not ready without details.
      if (!res.headersSent) {
        send(res, 503, undefined);
      }
    }
  }
}

function send(res: ServerResponse, status: number, body: object | undefined, method?: string): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", NO_STORE);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (body === undefined) {
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(json));
  res.end(method === "HEAD" ? undefined : json);
}
