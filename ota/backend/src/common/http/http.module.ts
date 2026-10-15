// The HTTP pipeline of the API (architecture §3, steps 1–3, 6 and 13), around the request context that app.module.ts
// mounts (pino-http, then nestjs-cls):
//
//   helmet → cookie-parser → body parsers → [guards of later tasks] → OpenAPI validation → handler → error filter
//
// - helmet: the security headers of a JSON API, aligned with Caddy's `security_headers` so the answer is the same
//   with or without the proxy; Caddy replaces them on the public hosts anyway.
// - cookie-parser: `req.cookies`, unsigned (the storefront session cookies are opaque, OADR-0006).
// - body parsers (body-parsers.ts): raw on `/webhooks/*`, JSON with 256 KB elsewhere, the per-route limits of main.ts.
// - the OpenAPI validation interceptor and the error filter are global (`APP_INTERCEPTOR`, `APP_FILTER`).
// - the not-implemented controller answers `501` for every operation of pending-operations.ts.
//
// The middleware runs after the request context: Nest applies the middleware of global modules first (nestjs-pino),
// then that of the other modules by their distance from the root module, and app.module.ts (nearer the root than
// this module) mounts the context middleware.
import {
  Module,
  RequestMethod,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import cookieParser from "cookie-parser";
import helmet, { type HelmetOptions } from "helmet";
import { BodyParsersMiddleware, HTTP_PIPELINE_OPTIONS, type HttpPipelineOptions } from "./body-parsers";
import { ErrorFilter } from "./error.filter";
import { NotImplementedController } from "./not-implemented.controller";
import {
  loadOpenApiDocument,
  OpenApiDocument,
  OpenApiValidationInterceptor,
} from "./openapi-validation.interceptor";
import { RequestContext } from "./request-context";

/** Every route of the application (path-to-regexp 8 syntax of NestJS 11). */
const ALL_ROUTES = { path: "{*path}", method: RequestMethod.ALL };

/**
 * helmet for an API that only answers JSON: nothing may be framed, loaded or run from an answer. Strict-Transport-
 * Security, Referrer-Policy and X-Frame-Options carry the values of Caddy's `security_headers`
 * (deploy/caddy/Caddyfile). Cross-Origin-Resource-Policy stays `same-origin`; a route whose answer is embedded by
 * other sites (public asset downloads, OBE-071) sets its own.
 */
export const HELMET_OPTIONS: Readonly<HelmetOptions> = Object.freeze<HelmetOptions>({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { "default-src": ["'none'"], "frame-ancestors": ["'none'"] },
  },
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: false },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xFrameOptions: { action: "deny" },
});

@Module({})
export class HttpModule implements NestModule {
  /** The pipeline with the options the entry point decides (per-route JSON body limits). */
  static forRoot(options: HttpPipelineOptions = {}): DynamicModule {
    return {
      module: HttpModule,
      controllers: [NotImplementedController],
      providers: [
        { provide: HTTP_PIPELINE_OPTIONS, useValue: options },
        // Parsed and compiled once per process: every request schema of the document (ADR-0006).
        { provide: OpenApiDocument, useFactory: () => loadOpenApiDocument() },
        RequestContext,
        BodyParsersMiddleware,
        { provide: APP_INTERCEPTOR, useClass: OpenApiValidationInterceptor },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
      exports: [RequestContext, OpenApiDocument],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(helmet(HELMET_OPTIONS), cookieParser(), BodyParsersMiddleware).forRoutes(ALL_ROUTES);
  }
}
