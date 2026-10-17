// The origin and scope rules of an API key (PADR-0005 items 5 and 6, platform/docs/flows/api-keys.md step 2,
// api-inventory-resources.md §1), checked by createApiKey and updateApiKey after the OpenAPI validation, which only
// checks the shape (`^https?://[^/?#\s]+$`, at most 20 unique origins, scope strings); a roll copies the old key's:
//
// - **Origins** (publishable keys only; a secret key has none, the CHECK `api_keys_origins_ck` of the baseline): exact
//   browser origins `scheme://host[:port]` exactly as a browser sends them in `Origin` (lower case, no default port,
//   no path, no trailing slash, no user info); `https` only, except `http://localhost:<port>` and
//   `http://127.0.0.1:<port>` on test keys; no wildcard; at most 20. An empty list means no browser origin is accepted.
// - **Scopes** (secret keys only; a publishable key has customer scope and no scopes): values of the OTA contract's
//   `ConsoleApiKeyScope` and `StaffPermission`. No scopes (absent or empty) means the default `["storefront"]`, the
//   least privilege of the three set-ups. `storefront` excludes every other scope; `console:automation` needs at
//   least one permission, and permissions are allowed only with it. `console` may come with `console:automation`
//   (which implies it).
//
// The lists are the generated OTA types (`@velexis/api-types`): an object with one entry per value, checked with
// `satisfies Record<…, true>`, does not compile when the OTA document adds or removes a value until the list follows,
// and api-key-rules.test.ts compares the lists with the OTA document itself. Every problem is a field error of
// `400 VALIDATION_FAILED` (`path` a JSON pointer into the request body); no message echoes the value.
import type { components as OtaComponents } from "@velexis/api-types";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";

/** `ConsoleApiKeyScope` of the OTA contract: `storefront`, `console`, `console:automation`. */
export type ConsoleApiKeyScope = OtaComponents["schemas"]["ConsoleApiKeyScope"];
/** `StaffPermission` of the OTA contract (`bookings:read`, …). */
export type StaffPermission = OtaComponents["schemas"]["StaffPermission"];
/** `publishable` or `secret` (the platform document's `ApiKeyKind`; `hosting` keys come after the MVP). */
export type ApiKeyKind = components["schemas"]["ApiKeyKind"];
/** `test` or `live`. */
export type ApiKeyEnvironment = components["schemas"]["Environment"];

/** One entry per `ConsoleApiKeyScope` value, in the order of the OTA document. */
const CONSOLE_SCOPES = {
  storefront: true,
  console: true,
  "console:automation": true,
} as const satisfies Record<ConsoleApiKeyScope, true>;

/** One entry per `StaffPermission` value, in the order of the OTA document. */
const PERMISSIONS = {
  "bookings:read": true,
  "bookings:write": true,
  "bookings:issue": true,
  "bookings:cancel": true,
  "customers:read": true,
  "queues:read": true,
  "supplier_requests:read": true,
  "amadeus:read": true,
  "amadeus:write": true,
  "settings:read": true,
  "settings:write": true,
  "payments:read": true,
  "payments:capture": true,
  "payments:refund": true,
} as const satisfies Record<StaffPermission, true>;

/** The `ConsoleApiKeyScope` values of the OTA contract. */
export const CONSOLE_API_KEY_SCOPES: readonly ConsoleApiKeyScope[] = Object.freeze(
  Object.keys(CONSOLE_SCOPES) as ConsoleApiKeyScope[],
);

/** The `StaffPermission` values of the OTA contract. */
export const STAFF_PERMISSIONS: readonly StaffPermission[] = Object.freeze(
  Object.keys(PERMISSIONS) as StaffPermission[],
);

/** The scopes of a secret key created without any (PADR-0005 item 6). */
export const DEFAULT_SECRET_KEY_SCOPES: readonly ConsoleApiKeyScope[] = Object.freeze(["storefront"]);

/** The most origins a publishable key may list (PADR-0005 item 5). */
export const MAX_ALLOWED_ORIGINS = 20;

/** The hosts a test key may name over plain `http`, always with a port (PADR-0005 item 5). */
const LOOPBACK_HTTP_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

const isConsoleScope = (scope: string): scope is ConsoleApiKeyScope => Object.hasOwn(CONSOLE_SCOPES, scope);
const isPermission = (scope: string): scope is StaffPermission => Object.hasOwn(PERMISSIONS, scope);

/** The field error of one origin, or `undefined` when it is a valid origin for a key of `environment`. */
function originProblem(origin: string, environment: ApiKeyEnvironment, path: string): FieldError | undefined {
  if (origin.includes("*")) {
    return { path, code: "wildcard", message: "Wildcards are not allowed: list each origin exactly." };
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { path, code: "origin", message: "Must be an origin: scheme://host or scheme://host:port." };
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    origin.endsWith("/")
  ) {
    return {
      path,
      code: "origin",
      message: "Must be an origin only: no user info, path, query, fragment or trailing slash.",
    };
  }
  if (url.protocol === "http:") {
    if (environment !== "test" || !LOOPBACK_HTTP_HOSTS.has(url.hostname) || url.port === "") {
      return {
        path,
        code: "insecureOrigin",
        message:
          "Must use https; http is allowed only for http://localhost:<port> and http://127.0.0.1:<port> on test keys.",
      };
    }
  } else if (url.protocol !== "https:") {
    return { path, code: "insecureOrigin", message: "Must use https." };
  }
  if (url.origin !== origin) {
    return {
      path,
      code: "notCanonical",
      message: "Must be written as a browser sends it: lower case, without a default port or trailing slash.",
    };
  }
  return undefined;
}

/**
 * The field errors of a publishable key's origins (`basePath` is the array's pointer, `/allowedOrigins`): each origin
 * at `<basePath>/<index>`, and more than MAX_ALLOWED_ORIGINS at `basePath`.
 */
export function originProblems(
  origins: readonly string[],
  environment: ApiKeyEnvironment,
  basePath = "/allowedOrigins",
): FieldError[] {
  const problems: FieldError[] = [];
  if (origins.length > MAX_ALLOWED_ORIGINS) {
    problems.push({
      path: basePath,
      code: "maxItems",
      message: `At most ${MAX_ALLOWED_ORIGINS} origins are allowed.`,
    });
  }
  origins.forEach((origin, index) => {
    const problem = originProblem(origin, environment, `${basePath}/${index}`);
    if (problem !== undefined) {
      problems.push(problem);
    }
  });
  return problems;
}

/**
 * The field errors of a secret key's scopes (not empty: an empty list takes the default before): unknown values at
 * `<basePath>/<index>`, then the combination rules at `basePath`.
 */
export function scopeProblems(scopes: readonly string[], basePath = "/scopes"): FieldError[] {
  const problems: FieldError[] = [];
  scopes.forEach((scope, index) => {
    if (!isConsoleScope(scope) && !isPermission(scope)) {
      problems.push({
        path: `${basePath}/${index}`,
        code: "unknownScope",
        message: "Must be a ConsoleApiKeyScope or StaffPermission value of the OTA booking API.",
      });
    }
  });
  if (problems.length > 0) {
    return problems;
  }
  const permissions = scopes.filter(isPermission);
  const automation = scopes.includes("console:automation");
  if (scopes.includes("storefront") && scopes.length > 1) {
    problems.push({
      path: basePath,
      code: "scopeCombination",
      message: "storefront cannot be combined with console scopes or permissions.",
    });
  } else if (permissions.length > 0 && !automation) {
    problems.push({
      path: basePath,
      code: "scopeCombination",
      message: "Permissions are allowed only together with console:automation.",
    });
  } else if (automation && permissions.length === 0) {
    problems.push({
      path: basePath,
      code: "scopeCombination",
      message: "console:automation needs at least one permission.",
    });
  }
  return problems;
}

/** What a create request says about a key's access. */
export interface ApiKeyAccessRequest {
  readonly kind: ApiKeyKind;
  readonly environment: ApiKeyEnvironment;
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly scopes?: readonly string[] | undefined;
}

/** The origins and scopes a key is stored with: one of the two lists is always empty. */
export interface ApiKeyAccess {
  readonly allowedOrigins: readonly string[];
  readonly scopes: readonly string[];
}

/**
 * The origins and scopes of a new key and the field errors of the request: a publishable key takes origins and no
 * scopes, a secret key scopes (the default when none) and no origins.
 */
export function apiKeyAccess(request: ApiKeyAccessRequest): {
  readonly access: ApiKeyAccess;
  readonly fieldErrors: FieldError[];
} {
  const origins = request.allowedOrigins ?? [];
  const scopes = request.scopes ?? [];
  if (request.kind === "publishable") {
    const fieldErrors = originProblems(origins, request.environment);
    if (scopes.length > 0) {
      fieldErrors.push({
        path: "/scopes",
        code: "notAllowed",
        message: "A publishable key has customer scope only and takes no scopes.",
      });
    }
    return { access: { allowedOrigins: [...origins], scopes: [] }, fieldErrors };
  }
  const granted = scopes.length === 0 ? DEFAULT_SECRET_KEY_SCOPES : scopes;
  const fieldErrors = scopeProblems(granted);
  if (origins.length > 0) {
    fieldErrors.unshift({
      path: "/allowedOrigins",
      code: "notAllowed",
      message: "A secret key is used from servers only and takes no browser origins.",
    });
  }
  return { access: { allowedOrigins: [], scopes: [...granted] }, fieldErrors };
}

/** `apiKeyAccess`, throwing `400 VALIDATION_FAILED` with the field errors when the request breaks a rule. */
export function checkedApiKeyAccess(request: ApiKeyAccessRequest): ApiKeyAccess {
  const { access, fieldErrors } = apiKeyAccess(request);
  if (fieldErrors.length > 0) {
    throw new AppError("VALIDATION_FAILED", { fieldErrors });
  }
  return access;
}
