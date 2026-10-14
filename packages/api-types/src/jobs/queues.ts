// Queue names, the BullMQ prefix and the BullMQ job id of a dispatch attempt (ADR-0009 items 1, 3 and 4,
// PADR-0001 item 3, platform/docs/architecture.md §5 and §6.1). Task PBE-004.
//
// Every queue belongs to the backend whose worker consumes it, and its name starts with that owner
// (`<owner>-<topic>`, ADR-0009 item 4): `ota-tenant-ops` is consumed by the OTA worker, `platform-tenant-events`
// by the platform worker. The platform admin's queue view (PBE-031) shows `PLATFORM_QUEUES` and `OTA_QUEUES`;
// only platform queues may be retried from it, `ota-*` queues are view-only.

/** The BullMQ key prefix of every queue of both backends (ADR-0009 item 1): keys are `vx:<queue>:…`. */
export const BULLMQ_PREFIX = "vx";

/** Platform → OTA: `tenant.provision`, `tenant.migrate`, `tenant.suspend`, `tenant.resume` (ADR-0009 item 3). */
export const OTA_TENANT_OPS = "ota-tenant-ops";

/**
 * OTA → platform: `tenant.provisioned`, `tenant.provision_failed`, `tenant.migrated`, `tenant.migration_failed`,
 * `tenant.suspended`, `tenant.resumed` (ADR-0009 item 3).
 */
export const PLATFORM_TENANT_EVENTS = "platform-tenant-events";

/**
 * The queues consumed by the platform worker (platform/docs/architecture.md §5), in the order of that table.
 * Together with the first entry of {@link OTA_QUEUES} (`ota-tenant-ops`, which the platform produces and the OTA
 * worker consumes) they are the eight queues of §5.
 */
export const PLATFORM_QUEUES = Object.freeze([
  PLATFORM_TENANT_EVENTS,
  "platform-emails",
  "platform-stripe-events",
  "platform-domains",
  "platform-connections",
  "platform-settlements",
  "platform-maintenance",
] as const);

/**
 * The queues consumed by the OTA worker, starting with `ota-tenant-ops`. The OTA plan appends its own queue
 * names here (OBE-002); the platform admin shows them read-only.
 */
export const OTA_QUEUES = Object.freeze([OTA_TENANT_OPS] as const);

/** A queue consumed by the platform worker. */
export type PlatformQueueName = (typeof PLATFORM_QUEUES)[number];
/** A queue consumed by the OTA worker. */
export type OtaQueueName = (typeof OTA_QUEUES)[number];
/** Any queue of the two backends. */
export type QueueName = PlatformQueueName | OtaQueueName;

/** A provisioning job id as BullMQ accepts it in a custom job id: a letter, then letters, digits or `_`. */
const JOB_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
/** `<jobId>-<attempt>`, the shape {@link bullmqJobId} writes. */
const BULLMQ_JOB_ID_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)-([1-9][0-9]*)$/;

/**
 * The BullMQ job id of one dispatch attempt of a provisioning job: `<jobId>-<attempt>` (PADR-0001 item 3,
 * architecture §6.1). A re-dispatch after a failure is a new attempt and so a new BullMQ job, while a duplicate
 * dispatch of the same attempt adds nothing, because BullMQ ignores an add with an id it already holds.
 *
 * @param jobId the `platform.provisioning_jobs.id` (`job_` + ULID)
 * @param attempt the job's `attempt` after the dispatch: 1 for the first dispatch
 * @throws {TypeError} on a job id that is not letters, digits and `_`, or an attempt that is not a positive
 *   integer
 */
export function bullmqJobId(jobId: string, attempt: number): string {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new TypeError(
      `invalid provisioning job id ${JSON.stringify(jobId)}: use a letter, then letters, digits or _ (job_01HZX…)`,
    );
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError(`invalid attempt ${String(attempt)}: use an integer of at least 1`);
  }
  return `${jobId}-${attempt}`;
}

/**
 * Reads a BullMQ job id written by {@link bullmqJobId} back into the provisioning job id and the attempt, for
 * the event consumer (stale attempts are ignored, PADR-0001 item 5) and the reconciler. Returns `null` for any
 * other id, for example one BullMQ generated itself.
 */
export function parseBullmqJobId(id: string): { readonly jobId: string; readonly attempt: number } | null {
  const match = BULLMQ_JOB_ID_PATTERN.exec(id);
  if (match === null) {
    return null;
  }
  const attempt = Number(match[2]);
  return Number.isSafeInteger(attempt) ? { jobId: String(match[1]), attempt } : null;
}
