"use client";

// The permission gate of the OTA admin (README §8, OADR-0018 point 4): what a role may not do is hidden, or shown
// disabled with a tooltip that names the permission it needs. This is for clarity only: every server action starts
// with `requireStaff(permission)` and the API decides (`403 FORBIDDEN`). The gate reads `can()` of lib/permissions.ts
// (the role matrix of scope §1.3 and the permissions of `console.auth.me`), plain data without a token.
import type { StaffPermission } from "@velexis/ota-sdk";
import { useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { can, type PermissionHolder } from "@/lib/permissions";

/** The sentence that names the missing permission (tooltip and screen-reader description). */
export function missingPermissionText(permission: StaffPermission): string {
  return `Needs the permission ${permission}`;
}

interface GateBase {
  /** The signed-in staff member (`getStaff()`: role and permissions); none holds nothing. */
  readonly profile: PermissionHolder | null | undefined;
  /** The permission the content needs. */
  readonly permission: StaffPermission;
  /** What the permission allows: a button, a confirmation dialog, a link. */
  readonly children: ReactNode;
}

export type PermissionGateProps = GateBase &
  (
    | {
        /** Without the permission, render nothing (navigation entries, whole sections). */
        readonly mode: "hide";
      }
    | {
        /** Without the permission, render a disabled button with this label and the tooltip (the default). */
        readonly mode?: "disable";
        readonly label: ReactNode;
      }
  );

/**
 * `children` when the staff member holds `permission`; otherwise nothing (`mode="hide"`) or a disabled button labelled
 * `label` with a tooltip naming the permission. A disabled button gets no pointer or focus events, so the tooltip
 * sits on a focusable wrapper, and the button is described by the same sentence for screen readers.
 */
export function PermissionGate(props: PermissionGateProps) {
  const { profile, permission, children } = props;
  const descriptionId = useId();
  if (can(profile, permission)) {
    return <>{children}</>;
  }
  if (props.mode === "hide") {
    return null;
  }
  const text = missingPermissionText(permission);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-permission={permission}
          className="inline-flex rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <Button type="button" variant="outline" disabled aria-describedby={descriptionId}>
            {props.label}
          </Button>
          <span id={descriptionId} className="sr-only">
            {text}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
