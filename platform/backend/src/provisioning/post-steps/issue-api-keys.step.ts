// Post-step `issue_api_keys` (PBE-022; platform/docs/flows/provisioning.md §3 and §4, flows/api-keys.md step 4,
// PADR-0005): the two test keys of a new OTA, `pk_test_…` without origins and `sk_test_…` scoped `storefront`, made by
// the PBE-021 generator (`ApiKeyGenerator.issueInitialTestKeys`, which audits `api_key.created` as the system). The
// rows hold only the prefix, `last4` and the HMAC. The two raw keys are envelope-encrypted together, as the
// `InitialKeys` answer of `revealInitialKeys` (`{keys: [{id, kind, environment, prefix, key}]}`), into
// `provisioning_jobs.reveal_ciphertext` with the associated data `platform.provisioning_jobs.reveal_ciphertext:<jobId>`,
// for one reveal by an owner (PBE-023); they are never stored in clear, logged, queued or put in the job's `result`,
// which keeps the key ids only (`apiKeyIds`).
//
// Idempotent: a job whose `result` has `apiKeyIds` already gets no new keys (its keys, their audit rows and the
// ciphertext were written in one transaction with that result).
import { Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { ApiKeyGenerator, type IssuedApiKey } from "../../api-keys/api-key-generator";
import { EnvelopeService, type CiphertextPlace } from "../../common/crypto.provider";
import { ProvisioningJobsRepository } from "../provisioning-jobs.repository";
import type { PostStep, PostStepContext, PostStepOutcome } from "./post-steps.runner";

/** What the reveal answers, and so what the ciphertext holds. */
export type InitialKeys = components["schemas"]["InitialKeys"];
type InitialKey = components["schemas"]["InitialKey"];

/** The place of a job's initial keys, for the envelope's associated data. */
export function revealPlace(jobId: string): CiphertextPlace {
  return { table: "provisioning_jobs", column: "reveal_ciphertext", rowId: jobId };
}

/** The key ids of a job's `result`, or `undefined` when it has none yet. */
export function apiKeyIdsOf(result: unknown): string[] | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return undefined;
  }
  const ids: unknown = (result as Record<string, unknown>)["apiKeyIds"];
  return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string")
    ? (ids as string[])
    : undefined;
}

/** One revealed key: its row's id, kind, environment and prefix, and the full key. */
function initialKey(issued: IssuedApiKey): InitialKey {
  return {
    id: issued.row.id,
    kind: issued.row.kind as InitialKey["kind"],
    environment: issued.row.environment as InitialKey["environment"],
    prefix: issued.row.prefix,
    key: issued.key,
  };
}

@Injectable()
export class IssueApiKeysStep implements PostStep {
  readonly name = "issue_api_keys";

  constructor(
    private readonly generator: ApiKeyGenerator,
    private readonly envelope: EnvelopeService,
    private readonly jobs: ProvisioningJobsRepository,
  ) {}

  async run({ trx, job, now }: PostStepContext): Promise<PostStepOutcome> {
    if (apiKeyIdsOf(job.result) !== undefined) {
      return { status: "succeeded" };
    }
    const { publishable, secret } = await this.generator.issueInitialTestKeys(trx, job.tenant_id);
    const reveal: InitialKeys = { keys: [initialKey(publishable), initialKey(secret)] };
    const encrypted = await this.envelope.encryptJson(reveal, revealPlace(job.id));
    await this.jobs.storeReveal(
      trx,
      job.id,
      { ciphertext: encrypted.ciphertext, kekId: encrypted.kekId },
      now,
    );
    return { status: "succeeded", result: { apiKeyIds: [publishable.row.id, secret.row.id] } };
  }
}
