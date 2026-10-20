"use client";

import { startTransition, useActionState, useMemo, useState, type FormEvent } from "react";

import { inviteMember, type InviteField, type InviteState } from "@/app/(app)/otas/[tenantId]/team/actions";
import { FormErrorSummary, type FormErrorItem } from "@/components/form-error-summary";
import { FormField, fieldId } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { assignableRoles, type TenantRole } from "@/lib/roles";
import { ROLE_LABELS, TEAM_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * The invite form of the team page (README §2 `/otas/[tenantId]/team`, §4; PF-20 AC1): an e-mail address and a role,
 * sent to `inviteMember` (`createInvitation`). The role list holds only the roles the caller may give
 * (`assignableRoles`): every role for an owner, agent, finance and viewer for an admin, so an admin cannot pick `owner`
 * or `admin` (the API refuses it with `403` all the same). `ALREADY_MEMBER` and `INVITATION_PENDING` show at the
 * address, `PLAN_LIMIT_REACHED` names the seats used and the plan's limit. The form holds nothing secret: the
 * invitation's link goes only into the e-mail.
 */

const FIELD_ORDER: readonly InviteField[] = ["email", "role"];

/** The entries of the error summary: the field errors in form order, then a problem of no field. */
function summaryOf(state: InviteState): FormErrorItem[] {
  const items: FormErrorItem[] = [];
  for (const field of FIELD_ORDER) {
    const message = state.fieldErrors[field];
    if (message !== undefined) {
      items.push({ message, fieldId: fieldId(field) });
    }
  }
  if (state.status === "failed" && state.message !== undefined) {
    items.push({ message: state.message });
  }
  return items;
}

/** The role preselected in a new form: agent, the role most invitations are for, when the caller may give it. */
function defaultRole(roles: readonly TenantRole[]): string {
  return roles.includes("agent") ? "agent" : (roles[0] ?? "");
}

const SELECT_CLASSES = cn(
  "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export interface InviteFormProps {
  readonly tenantId: string;
  /** The caller's role in the OTA (`getTenant` `myRole`): it decides which roles the list offers. */
  readonly callerRole: TenantRole;
}

/**
 * Invite someone by e-mail. After a refused submission the fields keep what was typed; after an invitation the address
 * is empty again and the role stays. The fields are controlled and the form posts its data to the action in a
 * transition, so React's reset of an action form never puts other values in them.
 */
export function InviteForm({ tenantId, callerRole }: InviteFormProps) {
  const roles = useMemo(() => assignableRoles(callerRole), [callerRole]);
  const initialState = useMemo<InviteState>(
    () => ({ status: "idle", values: { email: "", role: defaultRole(roles) }, fieldErrors: {} }),
    [roles],
  );
  const [state, dispatch, pending] = useActionState(inviteMember, initialState);
  const [values, setValues] = useState(state.values);
  // A new array per answer, so the summary takes the focus again after each refused submission.
  const summary = useMemo(() => summaryOf(state), [state]);

  // Each answer of the action sets the fields, in the render that shows the answer.
  const [answered, setAnswered] = useState(state);
  if (answered !== state) {
    setAnswered(state);
    setValues(state.values);
  }

  function setValue(field: InviteField, value: string): void {
    setValues((previous) => ({ ...previous, [field]: value }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) {
      return;
    }
    const formData = new FormData(event.currentTarget);
    startTransition(() => {
      dispatch(formData);
    });
  }

  const roleHint =
    roles.includes("owner") || roles.includes("admin")
      ? TEAM_STRINGS.roleHint
      : `${TEAM_STRINGS.roleHint} ${TEAM_STRINGS.roleHintAdmin}`;

  return (
    // `action` serves a form posted before the page hydrated; once hydrated, `onSubmit` sends the data itself.
    <form action={dispatch} onSubmit={onSubmit} noValidate className="grid gap-5" data-form="invite">
      <input type="hidden" name="tenantId" value={tenantId} />
      <FormErrorSummary errors={summary} />
      {state.status === "invited" ? (
        <p role="status" className="rounded-lg border px-4 py-3 text-sm font-medium">
          {state.message}
        </p>
      ) : null}
      <FormField
        label={TEAM_STRINGS.emailLabel}
        name="email"
        type="email"
        autoComplete="off"
        required
        maxLength={254}
        description={TEAM_STRINGS.emailHint}
        error={state.fieldErrors.email}
        value={values.email}
        onChange={(event) => setValue("email", event.target.value)}
      />
      <FormField
        label={TEAM_STRINGS.roleLabel}
        name="role"
        description={roleHint}
        error={state.fieldErrors.role}
      >
        {(control) => (
          <select
            {...control}
            value={values.role}
            onChange={(event) => setValue("role", event.target.value)}
            required
            className={SELECT_CLASSES}
          >
            {roles.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? TEAM_STRINGS.inviting : TEAM_STRINGS.invite}
        </Button>
      </div>
    </form>
  );
}
