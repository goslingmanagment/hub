import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../client.ts";
import { fans, transactions } from "../schema.ts";
import { upsertTransaction, type UpsertTransactionInput } from "./transactions.ts";
import { markFanEarningsDirty, recordEarningsAttribution } from "./fan-earnings-refresh.ts";
import { tryAcquireDmArchiveWriterFenceLock } from "./erasure-fence.ts";

type Transaction = typeof transactions.$inferSelect;
const semanticFields = [
  "fanId", "walletId", "accountId", "correlationId", "correlationAccountId",
  "rawType", "canonicalType", "transactionState", "destination", "rawStatus",
  "grossAmountMills", "sourceDestinationAmountMills", "creatorNetAmountMills",
  "platformFeeMills", "vatAmountMills", "taxAmountMills", "rawDestinationTax",
  "senderId", "receiverId", "isActive", "inactiveReason",
] as const satisfies readonly (keyof Transaction)[];

export function hasSemanticTransactionChange(previous: Transaction | undefined, next: Transaction) {
  return !previous || semanticFields.some((field) => previous[field] !== next[field])
    || previous.occurredAt.getTime() !== next.occurredAt.getTime();
}

/** The only Fansly transaction writer calls this inside its owned page
 * transaction. Compare persisted values after fill-only/sticky upsert rules,
 * excluding receipt timestamps, scan tokens and the unrelated wallet balance. */
export async function upsertFanslyTransactionWithEarningsDirty(
  db: Database,
  input: UpsertTransactionInput & { source: "fansly:rest" },
) {
  return db.transaction(async (tx) => {
    if (!await tryAcquireDmArchiveWriterFenceLock(tx, input.platformAccountId)) {
      throw new Error("Earnings transaction shadow deferred by active erasure");
    }
    const [previous] = await tx.select().from(transactions).where(and(
      eq(transactions.platformAccountId, input.platformAccountId),
      eq(transactions.transactionId, input.transactionId),
    )).for("update");
    const next = await upsertTransaction(tx, input);
    if (!next) throw new Error("Fansly transaction upsert returned no receipt");
    if (!hasSemanticTransactionChange(previous, next)) return next;

    const fanIds = [previous?.fanId, next.fanId].filter((id): id is number => id != null);
    const identities = fanIds.length === 0 ? [] : await tx.select({
      id: fans.id, ref: fans.platformUserId,
    }).from(fans).where(inArray(fans.id, fanIds));
    const fanRefs = [previous?.correlationAccountId, next.correlationAccountId,
      ...identities.map((identity) => identity.ref)].filter((value): value is string => Boolean(value));
    const boundRef = identities.find((identity) => identity.id === next.fanId)?.ref;
    const now = new Date();
    await markFanEarningsDirty(tx, { pageId: input.platformAccountId, fanRefs, now });
    await recordEarningsAttribution(tx, {
      pageId: input.platformAccountId, transactionRef: input.transactionId,
      known: Boolean(next.correlationAccountId)
        && (boundRef === undefined || boundRef === next.correlationAccountId), now,
    });
    return next;
  });
}
