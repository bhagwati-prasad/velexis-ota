import type { VelexisErrorData } from "@velexis/ota-sdk/react";
import { describeError } from "@/lib/action-state";

/** Renders an action error (works in server and client components). Field errors are listed when not shown inline. */
export function ErrorMessage({ error, showFields = false }: { error: VelexisErrorData | undefined | null; showFields?: boolean }) {
  if (!error) return null;
  return (
    <div role="alert" className="error">
      <p>{describeError(error)}</p>
      {showFields && error.fieldErrors.length > 0 && (
        <ul>
          {error.fieldErrors.map((f) => (
            <li key={f.path + f.code}>
              <code>{f.path}</code>: {f.message ?? f.code}
            </li>
          ))}
        </ul>
      )}
      {error.requestId && <p className="muted">Request {error.requestId}</p>}
    </div>
  );
}
