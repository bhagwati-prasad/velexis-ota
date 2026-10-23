// The environment switch of the console shell (README §4 "Environment switch", OADR-0018 point 6, routes.md §1). Every
// SDK client of a request sends the environment of `__Host-vx_env` (`X-Velexis-Environment`); these server actions are
// the only writers of that cookie besides the sign-in, the refreshes and `requireStaffSession`'s reset of a refused
// live environment, and they set it only to an environment the session allows: `test` always, `live` only when
// `console.auth.me` lists it and the role may open it
// (`canOpenEnvironment`: a live OTA and a role other than viewer). The API refuses everything else too
// (`403 ENVIRONMENT_NOT_ALLOWED`); the check here keeps a refused value out of the cookie.
"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { actionFailure, fromZod, type ActionState } from "@/lib/action-state";
import { DEFAULT_NEXT_PATH } from "@/lib/auth-routes";
import { errorMessage, fromVelexisError } from "@/lib/errors";
import { canOpenEnvironment } from "@/lib/permissions";
import { environmentCookie, requireStaffSession, writeCookies } from "@/lib/session";

const SwitchForm = z.object({
  environment: z.enum(["test", "live"], { message: "Choose TEST or LIVE." }),
});

/** The refusal of a live environment the OTA or the role does not allow (routes.md §1). */
function liveRefused(): ActionState {
  return actionFailure(errorMessage("ENVIRONMENT_NOT_ALLOWED"), { code: "ENVIRONMENT_NOT_ALLOWED" });
}

/**
 * The TEST / LIVE switch (`useActionState`): the form's `environment` is `test` or `live`.
 *
 * - `test` is always allowed: the cookie is set without a call.
 * - `live` needs the session (`requireStaffSession`: refreshed when needed, then `console.auth.me`) to allow it. A
 *   refusal answers "Live is not available for this OTA or role" and leaves the cookie at `test` (reset to it when
 *   it held `live`), so no request of the session asks for live again.
 *
 * After a switch the staff member lands on the dashboard of the new environment: the record on the page belongs to
 * the old one.
 */
export async function switchEnvironment(_previous: ActionState, form: FormData): Promise<ActionState> {
  const input = SwitchForm.safeParse({ environment: form.get("environment") });
  if (!input.success) {
    return fromZod(input.error);
  }
  const wanted = input.data.environment;
  const jar = await cookies();
  if (wanted === "live") {
    let allowed: boolean;
    try {
      allowed = canOpenEnvironment((await requireStaffSession()).staff, "live");
    } catch (error) {
      // A cookie that held live which the API refused for this OTA or role is already reset to test by
      // requireStaffSession; redirects and bugs are thrown again by fromVelexisError.
      return fromVelexisError(error);
    }
    if (!allowed) {
      writeCookies(jar, [environmentCookie("test")]);
      return liveRefused();
    }
  }
  writeCookies(jar, [environmentCookie(wanted)]);
  redirect(DEFAULT_NEXT_PATH);
}

/**
 * Resets `__Host-vx_env` to `test`, which every session allows: the shell's banner calls it once after a request
 * whose live environment was refused (routes.md §1), because the server component that saw the refusal cannot write
 * cookies.
 */
export async function resetEnvironment(): Promise<void> {
  writeCookies(await cookies(), [environmentCookie("test")]);
}
