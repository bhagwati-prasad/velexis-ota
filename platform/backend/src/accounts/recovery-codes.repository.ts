// The `account_recovery_codes` repository (PBE-015; PADR-0008 item 3, platform/docs/data-model.md): ten single-use MFA
// recovery codes per account, stored only as the SHA-256 of the normalised code (`code_hash`, part of the primary
// key with `account_id`). Enabling MFA and regenerating the codes replace the whole set, disabling MFA removes it, and
// a code is used up by setting `used_at` in one statement, so two sign-ins with one code cannot both succeed.
//
// Kysely on the caller's transaction, schema-qualified tables (ADR-0005). Times are the service's `Clock`.
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../audit/audit.repository";
import type { PlatformDb } from "../common/database";

@Injectable()
export class RecoveryCodesRepository {
  /** Replaces every code of `accountId` with `codeHashes` (SHA-256 of the normalised codes), created at `now`. */
  async replaceAll(
    trx: PlatformTransaction,
    accountId: string,
    codeHashes: readonly string[],
    now: Date,
  ): Promise<void> {
    await this.deleteAll(trx, accountId);
    if (codeHashes.length === 0) {
      return;
    }
    await trx
      .insertInto("platform.account_recovery_codes")
      .values(codeHashes.map((codeHash) => ({ account_id: accountId, code_hash: codeHash, created_at: now })))
      .execute();
  }

  /**
   * Uses up the unused code of `accountId` whose hash is `codeHash`, at `now`, in `trx`. Returns `false` when the
   * account has no such code or it was used already (nothing changed).
   */
  async use(trx: PlatformTransaction, accountId: string, codeHash: string, now: Date): Promise<boolean> {
    const used = await trx
      .updateTable("platform.account_recovery_codes")
      .set({ used_at: now })
      .where("account_id", "=", accountId)
      .where("code_hash", "=", codeHash)
      .where("used_at", "is", null)
      .returning("code_hash")
      .executeTakeFirst();
    return used !== undefined;
  }

  /** Removes every code of `accountId`, in `trx`. Returns how many there were. */
  async deleteAll(trx: PlatformTransaction, accountId: string): Promise<number> {
    const rows = await trx
      .deleteFrom("platform.account_recovery_codes")
      .where("account_id", "=", accountId)
      .returning("code_hash")
      .execute();
    return rows.length;
  }

  /** How many codes of `accountId` are still unused, read on `db`. */
  async countUnused(db: PlatformTransaction | PlatformDb, accountId: string): Promise<number> {
    const row = await db
      .selectFrom("platform.account_recovery_codes")
      .select((eb) => eb.fn.countAll<string>().as("unused"))
      .where("account_id", "=", accountId)
      .where("used_at", "is", null)
      .executeTakeFirstOrThrow();
    return Number(row.unused);
  }
}
