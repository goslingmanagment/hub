import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { recordOfapiCreditSpend, recordOfapiPhysicalCreditUsage } from "./ofapi.ts";

/** Financial metadata only. Never put the response body or request payload here. */
export interface OfapiCreditReceipt {
  operation: string;
  httpStatus: number;
  credits: number;
  estimated: boolean;
  balanceAfter: number | null;
  requestId: string;
  pageId: number | null;
  attemptNumber: number;
  isCached: boolean | null;
  actorUserId: number | null;
  budgetScope?: "audience" | "backfill" | "link_stats" | null;
  receivedAt?: string;
  /** A desktop re-read made only to refresh media URLs (read intent media-context-v1). */
  ledgerContext?: "media";
}

export async function captureOfapiCreditReceipt(db: Database, receipt: OfapiCreditReceipt) {
  await db.execute(sql`
    insert into ofapi_credit_receipts (request_id, attempt_number, received_at, observation)
    values (${receipt.requestId}, ${receipt.attemptNumber},
      ${receipt.receivedAt ?? new Date().toISOString()}::timestamptz, ${JSON.stringify(receipt)}::jsonb)
    on conflict (request_id, attempt_number) do nothing
  `);
}

/** The row lock and settlement mark share the ledger/counter transaction.
 * An ambiguous COMMIT or concurrent recovery cannot double-count a receipt. */
export async function settleOfapiCreditReceipt(
  db: Database, identity: { requestId: string; attemptNumber: number },
): Promise<boolean> {
  return db.transaction(async tx => {
    const result = await tx.execute<{
      observation: OfapiCreditReceipt; received_at: Date; accounted_at: Date | null;
    }>(sql`
      select observation, received_at, accounted_at from ofapi_credit_receipts
      where request_id = ${identity.requestId} and attempt_number = ${identity.attemptNumber}
      for update
    `);
    const row = result.rows[0];
    if (!row) return false;
    if (row.accounted_at !== null) return true;
    const receipt = row.observation;
    let path: "ledger" | "physical";
    try {
      // Each repository call owns a savepoint; a failed projection does not
      // abort the outer receipt transaction or drop its pending evidence.
      await recordOfapiCreditSpend(tx, {
        ...receipt, occurredAt: new Date(row.received_at),
        details: { attemptNumber: receipt.attemptNumber,
          ...(receipt.isCached === null ? {} : { isCached: receipt.isCached }),
          ...(receipt.ledgerContext ? { context: receipt.ledgerContext } : {}) },
      });
      path = "ledger";
    } catch {
      try {
        await recordOfapiPhysicalCreditUsage(tx, {
          creditsUsed: receipt.credits, balance: receipt.balanceAfter,
          budgetScope: receipt.budgetScope ?? null, now: new Date(row.received_at),
        });
        path = "physical";
      } catch { return false; }
    }
    await tx.execute(sql`
      update ofapi_credit_receipts set accounted_at = clock_timestamp(), accounting_path = ${path}
      where request_id = ${identity.requestId} and attempt_number = ${identity.attemptNumber}
    `);
    return true;
  });
}

/** Bounded drain on dispatch admission, including after a process restart. */
export async function recoverOfapiCreditReceipts(db: Database): Promise<boolean> {
  const result = await db.execute<{ request_id: string; attempt_number: number }>(sql`
    select request_id, attempt_number from ofapi_credit_receipts
    where accounted_at is null order by received_at, request_id, attempt_number limit 100
  `);
  for (const row of result.rows) {
    if (!await settleOfapiCreditReceipt(db, { requestId: row.request_id, attemptNumber: row.attempt_number })) return false;
  }
  const remaining = await db.execute(sql`select 1 from ofapi_credit_receipts where accounted_at is null limit 1`);
  return remaining.rows.length === 0;
}
