import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { queryFanslyDmShadowMaterial } from "./fansly-dm-shadow.ts";
import { queryFanslyDmReaderHeads, type FanslyDmReaderHead } from "./fansly-dm-reader-heads.ts";

/** One diagnostic snapshot and shared remaining query budget. Pool checkout is
 * not cancellable here: elapsed checkout time consumes the budget, but this is
 * not an end-to-end deadline for acquiring a connection or returning it. */
export async function readFanslyDmShadowSnapshot(db: Database, input: {
  pageId: number;
  heads: ReadonlyArray<FanslyDmReaderHead & { conversationId: number | null }>;
  maxDurationMs: number;
  monotonicNowMs?: () => number;
}) {
  if (input.heads.length > 100) throw new Error("DM shadow check exceeds one list page");
  const clock = input.monotonicNowMs ?? (() => performance.now());
  const allowance = Math.floor(Math.min(5000, input.maxDurationMs));
  if (!Number.isFinite(allowance) || allowance <= 0) throw new Error("DM shadow read budget exhausted");
  const deadline = clock() + allowance;
  return db.transaction(async tx => {
    const setRemainingTimeout = async () => {
      const remaining = Math.floor(deadline - clock());
      if (remaining <= 0) throw new Error("DM shadow read budget exhausted");
      await tx.execute(sql`select set_config('statement_timeout', ${`${remaining}ms`}, true)`);
    };
    await setRemainingTimeout();
    await tx.execute(sql`set local lock_timeout = '100ms'`);
    const hotHeads = input.heads.flatMap(head => head.conversationId === null ? [] : [{
      conversationId: head.conversationId, messageId: head.messageId,
    }]);
    await setRemainingTimeout();
    const hot = await queryFanslyDmShadowMaterial(tx, hotHeads);
    await setRemainingTimeout();
    const reader = await queryFanslyDmReaderHeads(tx, input.pageId, input.heads);
    return { hot, reader };
  }, { accessMode: "read only", isolationLevel: "repeatable read" });
}
