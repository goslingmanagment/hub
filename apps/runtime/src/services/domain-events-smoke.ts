import {
  decodeDomainEventCursor,
  encodeDomainEventCursor,
} from "@agency_hub_core/contracts";
import {
  listDomainEventHighWaters,
  listEventsSince,
  type DomainEventRow,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";

import type { AppContext } from "../bootstrap.ts";
import {
  createAccountSeqGuards,
  createDomainEventHub,
} from "./domain-events-stream.ts";

// Kernel Stage 21: the v2 conformance instrument. A permanent worker-side
// subscriber tailing EVERY account's domain events through the same hub +
// replay machinery the endpoint serves from, checkpointing its cursor and
// counting gaps/duplicates — both must stay zero (Stage 8's gapless proof,
// observed continuously in production; later the Stage 25 delivery-lag
// signal). Read-only besides its one checkpoint row; runs unconditionally,
// like the Stage 7/8 sweeps.

const CHECKPOINT_INTERVAL_MS = 30_000;
const SUMMARY_INTERVAL_MS = 10 * 60 * 1000;
const REPLAY_BATCH_SIZE = 500;

interface SmokeCheckpoint {
  cursor: string;
  framesSeen: number;
  gapCount: number;
  duplicateCount: number;
}

async function readCheckpoint(app: AppContext): Promise<SmokeCheckpoint | null> {
  const result = await app.db.execute<Record<string, unknown>>(sql`
    select cursor, frames_seen::text as frames_seen, gap_count::text as gap_count,
           duplicate_count::text as duplicate_count
    from domain_events_smoke_checkpoint where id = 1
  `);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    cursor: String(row.cursor),
    framesSeen: Number(row.frames_seen),
    gapCount: Number(row.gap_count),
    duplicateCount: Number(row.duplicate_count),
  };
}

async function writeCheckpoint(app: AppContext, checkpoint: SmokeCheckpoint): Promise<void> {
  await app.db.execute(sql`
    insert into domain_events_smoke_checkpoint (id, cursor, frames_seen, gap_count, duplicate_count, updated_at)
    values (1, ${checkpoint.cursor}, ${checkpoint.framesSeen}, ${checkpoint.gapCount}, ${checkpoint.duplicateCount}, now())
    on conflict (id) do update set
      cursor = excluded.cursor,
      frames_seen = excluded.frames_seen,
      gap_count = excluded.gap_count,
      duplicate_count = excluded.duplicate_count,
      updated_at = excluded.updated_at
  `);
}

export interface DomainEventsSmokeHandle {
  stop(): Promise<void>;
}

export function startDomainEventsSmokeConsumer(app: AppContext): DomainEventsSmokeHandle {
  const hub = createDomainEventHub(app);
  let stopped = false;
  let checkpointTimer: NodeJS.Timeout | null = null;
  let summaryTimer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let dirty = false;

  const state = {
    framesSeen: 0,
    gapCount: 0,
    duplicateCount: 0,
    guards: null as ReturnType<typeof createAccountSeqGuards> | null,
  };

  function recordGap(accountId: number, afterSeq: number, throughSeq: number) {
    if (!state.guards) {
      return;
    }
    const watermark = state.guards.watermarks().get(accountId) ?? 0;
    if (watermark >= throughSeq) {
      return;
    }
    state.gapCount += 1;
    dirty = true;
    app.logger.error({
      accountId,
      afterSeq,
      throughSeq,
    }, "v2 smoke consumer observed an account_seq GAP");

    // The shared hub rebases to the captured head after proving that the
    // interval is no longer readable. Follow that rebase after recording the
    // signal, otherwise every later event would be miscounted as another gap.
    const rebased = new Map(state.guards.watermarks());
    rebased.set(accountId, throughSeq);
    state.guards = createAccountSeqGuards(rebased);
  }

  function consume(event: DomainEventRow) {
    if (!state.guards) {
      return;
    }
    const afterSeq = state.guards.watermarks().get(event.accountId) ?? 0;
    const verdict = state.guards.advance(event.accountId, event.accountSeq);
    if (verdict.gap) {
      recordGap(event.accountId, afterSeq, event.accountSeq);
      return;
    }
    if (!verdict.deliver) {
      // The hub never redelivers behind its own watermark; a duplicate here is
      // a real anomaly, not catch-up overlap (replay buffers before live).
      state.duplicateCount += 1;
      dirty = true;
      app.logger.error({
        accountId: event.accountId,
        accountSeq: event.accountSeq,
      }, "v2 smoke consumer observed a DUPLICATE domain-event frame");
      return;
    }
    state.framesSeen += 1;
    dirty = true;
  }

  async function persist() {
    if (!state.guards || !dirty) {
      return;
    }
    dirty = false;
    try {
      await writeCheckpoint(app, {
        cursor: encodeDomainEventCursor(state.guards.watermarks()),
        framesSeen: state.framesSeen,
        gapCount: state.gapCount,
        duplicateCount: state.duplicateCount,
      });
    } catch (error) {
      dirty = true;
      app.logger.warn({ err: error }, "v2 smoke checkpoint write failed; retrying next tick");
    }
  }

  const started = (async () => {
    // Resume point: the stored cursor, or "now" on first run (the instrument
    // measures forward conformance, not history).
    const stored = await readCheckpoint(app).catch((error) => {
      app.logger.warn({ err: error }, "v2 smoke checkpoint read failed; starting from now");
      return null;
    });
    let watermarks: Map<number, number>;
    if (stored) {
      const decoded = decodeDomainEventCursor(stored.cursor);
      if (decoded.ok) {
        watermarks = decoded.watermarks;
        state.framesSeen = stored.framesSeen;
        state.gapCount = stored.gapCount;
        state.duplicateCount = stored.duplicateCount;
      } else {
        app.logger.error({ reason: decoded.reason }, "v2 smoke checkpoint cursor invalid; rebaselining at now");
        watermarks = await listDomainEventHighWaters(app.db);
      }
    } else {
      watermarks = await listDomainEventHighWaters(app.db);
    }
    state.guards = createAccountSeqGuards(watermarks);

    // Live first (buffered), then replay the gap since the checkpoint — the
    // endpoint's exact ordering discipline.
    let replayDone = false;
    const buffered: DomainEventRow[] = [];
    const pendingContinuityLosses = new Map<number, { afterSeq: number; throughSeq: number }>();
    unsubscribe = hub.subscribe({
      accountIds: undefined,
      deliver(event) {
        if (!replayDone) {
          buffered.push(event);
          return;
        }
        consume(event);
      },
      continuityLost(accountId, afterSeq, throughSeq) {
        if (!replayDone) {
          const pending = pendingContinuityLosses.get(accountId);
          if (!pending || throughSeq > pending.throughSeq) {
            pendingContinuityLosses.set(accountId, { afterSeq, throughSeq });
          }
          return;
        }
        recordGap(accountId, afterSeq, throughSeq);
      },
    });
    await hub.ready().catch(() => undefined);

    const heads = await listDomainEventHighWaters(app.db);
    for (const [accountId, head] of heads) {
      let afterSeq = watermarks.get(accountId) ?? 0;
      if (head <= afterSeq) {
        continue;
      }
      while (!stopped) {
        const rows = await listEventsSince(app.db, {
          accountId,
          afterSeq,
          limit: REPLAY_BATCH_SIZE,
        });
        for (const row of rows) {
          consume(row);
        }
        const lastRow = rows.at(-1);
        if (lastRow) {
          afterSeq = lastRow.accountSeq;
        }
        if (rows.length < REPLAY_BATCH_SIZE) {
          break;
        }
      }
    }
    for (const [accountId, loss] of pendingContinuityLosses) {
      recordGap(accountId, loss.afterSeq, loss.throughSeq);
    }
    pendingContinuityLosses.clear();
    for (const event of buffered) {
      // A live append can be captured both by the fixed replay head and by the
      // already-subscribed hub. That overlap is expected, not a duplicate
      // anomaly; discard it before enabling direct live delivery.
      const watermark = state.guards?.watermarks().get(event.accountId);
      if (watermark !== undefined && event.accountSeq <= watermark) {
        continue;
      }
      consume(event);
    }
    buffered.length = 0;
    replayDone = true;

    checkpointTimer = setInterval(() => {
      void persist();
    }, CHECKPOINT_INTERVAL_MS);
    checkpointTimer.unref?.();
    summaryTimer = setInterval(() => {
      app.logger.info({
        framesSeen: state.framesSeen,
        gapCount: state.gapCount,
        duplicateCount: state.duplicateCount,
      }, "v2 smoke consumer summary");
    }, SUMMARY_INTERVAL_MS);
    summaryTimer.unref?.();
  })().catch((error) => {
    app.logger.error({ err: error }, "v2 smoke consumer failed to start");
  });

  return {
    async stop() {
      stopped = true;
      await started.catch(() => undefined);
      if (checkpointTimer) {
        clearInterval(checkpointTimer);
      }
      if (summaryTimer) {
        clearInterval(summaryTimer);
      }
      unsubscribe?.();
      await persist().catch(() => undefined);
      await hub.close();
    },
  };
}
