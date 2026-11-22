/**
 * The plan chosen on `/pricing`, carried as `?plan=<code>` through sign-up to the create-OTA wizard (FIX-W69-SIGNUP,
 * KI-009). A query value is only ever a plan code the platform document allows, never anything else: the wizard then
 * preselects it only when `listPlans` offers it.
 */

/** `PlanCode` of the platform document. */
const PLAN_CODE = /^[a-z][a-z0-9_]{1,39}$/;

/** The create-OTA wizard. */
export const NEW_OTA_PATH = "/otas/new";

/** `value` when it is a well-formed plan code, otherwise `undefined` (a repeated parameter counts as absent). */
export function planCodeOf(value: string | string[] | null | undefined): string | undefined {
  return typeof value === "string" && PLAN_CODE.test(value) ? value : undefined;
}

/** `/otas/new?plan=<code>`, or `/otas/new` without a well-formed code. */
export function newOtaPath(code: string | undefined): string {
  const plan = planCodeOf(code);
  return plan === undefined ? NEW_OTA_PATH : `${NEW_OTA_PATH}?${new URLSearchParams({ plan }).toString()}`;
}
