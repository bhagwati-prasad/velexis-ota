import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { API_KEYS_STRINGS } from "@/lib/strings";

/**
 * The allowed origins of a publishable API key (README §4; PADR-0005 item 5; flow api-keys.md step 2) and their
 * rules, which `api-keys/actions.ts` checks before it calls the API, as `api-key-rules.ts` of the platform API checks
 * them again: exact browser origins `scheme://host[:port]` as a browser sends them in `Origin` (lower case, no default
 * port, no path, no trailing slash, no user info); `https` only, except `http://localhost:<port>` and
 * `http://127.0.0.1:<port>` on test keys; no wildcard; at most 20. An empty list means the key works only without a
 * browser `Origin` (from a server).
 *
 * No directive: the server action uses `originProblem`, and the API key forms (client components) render
 * `OriginsField`, a controlled component without state of its own.
 */

/** `test` or `live` (`Environment` of the platform document). */
export type OriginEnvironment = "test" | "live";

/** The most origins a publishable key may list (PADR-0005 item 5). */
export const MAX_ALLOWED_ORIGINS = 20;

/** What is wrong with one origin; the codes of the platform API's field errors. */
export type OriginProblem = "wildcard" | "origin" | "insecureOrigin" | "notCanonical";

/** The hosts a test key may name over plain `http`, always with a port (PADR-0005 item 5). */
const LOOPBACK_HTTP_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/** The problem of one origin for a key of `environment`, or `undefined` when it is a valid origin. */
export function originProblem(origin: string, environment: OriginEnvironment): OriginProblem | undefined {
  if (origin.includes("*")) {
    return "wildcard";
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "origin";
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    origin.endsWith("/")
  ) {
    return "origin";
  }
  if (url.protocol === "http:") {
    if (environment !== "test" || !LOOPBACK_HTTP_HOSTS.has(url.hostname) || url.port === "") {
      return "insecureOrigin";
    }
  } else if (url.protocol !== "https:") {
    return "insecureOrigin";
  }
  // `URL` lower-cases the host and drops a default port: anything else is not what a browser sends.
  return url.origin === origin ? undefined : "notCanonical";
}

/** The portal's message for the problem of one origin (also for the API's field error codes of an origin). */
export function originMessage(problem: string, environment: OriginEnvironment): string {
  switch (problem) {
    case "wildcard":
      return API_KEYS_STRINGS.originWildcard;
    case "insecureOrigin":
      return API_KEYS_STRINGS.originInsecure(environment);
    case "notCanonical":
      return API_KEYS_STRINGS.originNotCanonical;
    case "uniqueItems":
    case "duplicate":
      return API_KEYS_STRINGS.originDuplicate;
    default:
      // `origin`, and the OpenAPI checks of the API (`pattern`, `maxLength`).
      return API_KEYS_STRINGS.originInvalid;
  }
}

/** The id of the input of the origin in `row` (0-based) of the field `idPrefix`. */
export function originInputId(idPrefix: string, row: number): string {
  return `${idPrefix}-origin-${row}`;
}

export interface OriginsFieldProps {
  /** Makes the ids of the field unique on the page (the create form and an edit dialog can be open together). */
  readonly idPrefix: string;
  /** The key's environment: http origins are allowed on test keys only. */
  readonly environment: OriginEnvironment;
  /** The origins as typed, one row each; empty rows are dropped when the form is sent. */
  readonly origins: readonly string[];
  readonly onChange: (origins: string[]) => void;
  /** A problem of the list as a whole (too many origins). */
  readonly error?: string | undefined;
  /** Problems of single origins, by row. */
  readonly rowErrors?: Readonly<Record<string, string>> | undefined;
}

/**
 * The origins as a list of inputs named `allowedOrigins` (the form sends them in order), each with its own label,
 * error and "Remove" button, and "Add an origin" while there are fewer than 20.
 */
export function OriginsField({
  idPrefix,
  environment,
  origins,
  onChange,
  error,
  rowErrors,
}: OriginsFieldProps) {
  const hintId = `${idPrefix}-origins-hint`;
  const errorId = error === undefined ? undefined : `${idPrefix}-origins-error`;
  const describedBy = [hintId, errorId].filter((id) => id !== undefined).join(" ");

  function setRow(row: number, value: string): void {
    onChange(origins.map((origin, index) => (index === row ? value : origin)));
  }

  return (
    <fieldset
      className="grid gap-4"
      aria-describedby={describedBy}
      data-invalid={errorId === undefined ? undefined : true}
      data-field="allowedOrigins"
    >
      <legend className="mb-2 text-sm font-medium">{API_KEYS_STRINGS.originsLegend}</legend>
      <p id={hintId} className="text-sm text-muted-foreground">
        {API_KEYS_STRINGS.originsHint(environment)}
      </p>
      {origins.map((origin, row) => (
        // The rows have no identity of their own; their position is what the form sends and the errors name.
        <div key={row} className="flex items-end gap-2">
          <FormField
            className="flex-1"
            id={originInputId(idPrefix, row)}
            name="allowedOrigins"
            label={API_KEYS_STRINGS.originLabel(row + 1)}
            error={rowErrors?.[String(row)]}
            value={origin}
            onChange={(event) => setRow(row, event.target.value)}
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="https://www.example.com"
            maxLength={300}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => onChange(origins.filter((_, index) => index !== row))}
          >
            {API_KEYS_STRINGS.removeOrigin}
            <span className="sr-only">{API_KEYS_STRINGS.removeOriginTarget(row + 1)}</span>
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={origins.length >= MAX_ALLOWED_ORIGINS}
          onClick={() => onChange([...origins, ""])}
        >
          {API_KEYS_STRINGS.addOrigin}
        </Button>
      </div>
      {errorId === undefined ? null : (
        <p id={errorId} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
