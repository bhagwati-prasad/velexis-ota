import type { components } from "@velexis/api-types/platform";

import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS } from "@/lib/strings";
import { cn } from "@/lib/utils";

type Schemas = components["schemas"];

/**
 * The statuses each kind of badge shows, from the platform document. Settlement statuses arrive with the
 * settlement operations in M5; until then they follow platform/docs/data-model.md (`settlements.status`).
 */
interface StatusesByKind {
  tenant: Schemas["TenantStatus"];
  job: Schemas["ProvisioningJobStatus"];
  jobStep: Schemas["ProvisioningStep"]["status"];
  amadeusConnection: Schemas["AmadeusConnection"]["status"];
  paymentConnection: Schemas["PaymentConnection"]["status"];
  credentialSubmission: Schemas["PendingCredentialSubmission"]["status"];
  domain: Schemas["Domain"]["verificationStatus"];
  tls: Schemas["Domain"]["tlsStatus"];
  subscription: Schemas["Subscription"]["status"];
  membership: Schemas["Member"]["status"];
  invitation: Schemas["Invitation"]["status"];
  settlement: "draft" | "approved" | "paid" | "carried_forward" | "void";
  /** The review status of the payout account (PFE-025). */
  payoutAccount: Schemas["PayoutAccountStatus"];
}

/** What a badge is about: tenant, job, connection, domain, settlement and the other statuses of the portal. */
export type StatusKind = keyof StatusesByKind;
/** The statuses of one kind. */
export type StatusOf<Kind extends StatusKind> = StatusesByKind[Kind];

/** How a status reads at a glance; the label always says it in words, so colour is never the only signal. */
type Tone = "success" | "info" | "warning" | "danger" | "neutral";

const TONES: { readonly [Kind in StatusKind]: Readonly<Record<StatusOf<Kind>, Tone>> } = {
  tenant: { provisioning: "info", active: "success", suspended: "warning", failed: "danger" },
  job: { queued: "neutral", running: "info", succeeded: "success", failed: "danger", canceled: "neutral" },
  jobStep: { succeeded: "success", failed: "danger", skipped: "neutral" },
  amadeusConnection: {
    pending_verification: "warning",
    active: "success",
    invalid_credentials: "danger",
    disabled: "neutral",
  },
  paymentConnection: { pending: "warning", active: "success", disabled: "neutral", error: "danger" },
  credentialSubmission: { pending: "info", verifying: "info", failed: "danger" },
  domain: { pending: "warning", verified: "success", failed: "danger" },
  tls: { pending: "warning", issued: "success", failed: "danger", expired: "danger" },
  subscription: {
    trialing: "info",
    active: "success",
    past_due: "warning",
    paused: "warning",
    canceled: "neutral",
    incomplete: "warning",
    incomplete_expired: "neutral",
    unpaid: "danger",
  },
  membership: { active: "success", suspended: "warning", removed: "neutral" },
  invitation: { pending: "info", accepted: "success", revoked: "neutral", expired: "neutral" },
  settlement: {
    draft: "neutral",
    approved: "info",
    paid: "success",
    carried_forward: "neutral",
    void: "neutral",
  },
  payoutAccount: { pending_review: "warning", verified: "success", rejected: "danger" },
};

/** Every status of every kind has a label (a new status in the document fails the type check until it has one). */
const LABELS: { readonly [Kind in StatusKind]: Readonly<Record<StatusOf<Kind>, string>> } = STATUS_LABELS;

const TONE_CLASSES: Readonly<Record<Tone, string>> = {
  success: "border-transparent bg-emerald-100 text-emerald-900",
  info: "border-transparent bg-sky-100 text-sky-900",
  warning: "border-transparent bg-amber-100 text-amber-900",
  danger: "border-transparent bg-red-100 text-red-900",
  neutral: "border-transparent bg-secondary text-secondary-foreground",
};

export interface StatusBadgeProps<Kind extends StatusKind> {
  readonly kind: Kind;
  readonly status: StatusOf<Kind>;
  readonly className?: string;
}

/** A status in words with a matching colour (README §4). Server or client; it holds no state. */
export function StatusBadge<Kind extends StatusKind>({ kind, status, className }: StatusBadgeProps<Kind>) {
  const labels: Readonly<Record<string, string>> = LABELS[kind];
  const tones: Readonly<Record<string, Tone>> = TONES[kind];
  const known = Object.hasOwn(labels, status);
  // A status the portal does not know yet (a newer API) still renders, neutral and in its raw form.
  const label = (known ? labels[status] : undefined) ?? status.replaceAll("_", " ");
  const tone = (known ? tones[status] : undefined) ?? "neutral";
  return (
    <Badge
      variant="outline"
      data-status={status}
      data-tone={tone}
      className={cn(TONE_CLASSES[tone], className)}
    >
      {label}
    </Badge>
  );
}
