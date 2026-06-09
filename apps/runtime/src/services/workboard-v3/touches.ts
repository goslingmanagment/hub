import {
  type Database,
  confirmWb3Touch,
  forceWb3LatestOpenTouchDone,
  insertWb3Touch,
  listWb3ConfirmableTouches,
  listWb3PageIds,
  resolveWb3PlanItem,
  resolveWb3PlanItemsForTouch,
  setWb3PlanItemInProgress,
  upsertWb3Snooze,
} from "@agency_hub_core/db";

// Touch model (PRD §4). "Открыть чат" creates an open personal touch; the sync
// confirms it with a non-broadcast model message inside the 6h window; "Готово"
// is the manual force; Skip/Snooze close plan items without a touch.

export const WB3_TOUCH_CONFIRM_WINDOW_HOURS = 6;
// How far back the confirm job re-checks open touches. The window above bounds
// which messages count; this only bounds the scan (late-synced messages can
// confirm a touch hours after the window itself has passed).
export const WB3_TOUCH_CONFIRM_LOOKBACK_DAYS = 7;

export type Wb3SkipReason = "nothing_to_say" | "bad_timing" | "suspicious" | "other";

export interface Wb3TouchActor {
  platformAccountId: number;
  fanId: number;
  shiftId?: number | null;
  chatterUserId?: number | null;
  planItemId?: number | null;
  now?: Date;
}

/** "Открыть чат": open touch created, plan item goes in progress. */
export async function openWb3Touch(db: Database, input: Wb3TouchActor): Promise<{ touchId: number }> {
  const now = input.now ?? new Date();
  const touchId = await insertWb3Touch(db, {
    platformAccountId: input.platformAccountId,
    fanId: input.fanId,
    type: "personal",
    shiftId: input.shiftId,
    chatterUserId: input.chatterUserId,
    openedAt: now,
  });
  if (input.planItemId != null) {
    await setWb3PlanItemInProgress(db, input.planItemId);
  }
  return { touchId };
}

/**
 * "Готово": manual force without sync confirmation. Converts the fan's open
 * touch when one exists, otherwise records a fresh manual touch.
 */
export async function completeWb3TouchManually(
  db: Database,
  input: Wb3TouchActor,
): Promise<{ touchId: number }> {
  const now = input.now ?? new Date();
  const converted = await forceWb3LatestOpenTouchDone(db, {
    platformAccountId: input.platformAccountId,
    fanId: input.fanId,
    now,
  });
  const touchId =
    converted ??
    (await insertWb3Touch(db, {
      platformAccountId: input.platformAccountId,
      fanId: input.fanId,
      type: "manual",
      shiftId: input.shiftId,
      chatterUserId: input.chatterUserId,
      confirmedAt: now,
    }));
  if (input.planItemId != null) {
    await resolveWb3PlanItem(db, {
      planItemId: input.planItemId,
      status: "done",
      resolvedAt: now,
      resolvedByTouchId: touchId,
    });
  }
  return { touchId };
}

/** "Скип": closes the plan item with a reason; no touch, no cadence movement. */
export async function skipWb3PlanItem(
  db: Database,
  input: { planItemId: number; reason: Wb3SkipReason; now?: Date },
): Promise<void> {
  await resolveWb3PlanItem(db, {
    planItemId: input.planItemId,
    status: "skipped",
    resolvedAt: input.now ?? new Date(),
    skipReason: input.reason,
  });
}

/** Snooze: suppresses the fan until the date; closes the plan item if given. */
export async function snoozeWb3Fan(
  db: Database,
  input: {
    platformAccountId: number;
    fanId: number;
    snoozedUntil: Date;
    reason?: string | null;
    planItemId?: number | null;
    now?: Date;
  },
): Promise<void> {
  await upsertWb3Snooze(db, {
    platformAccountId: input.platformAccountId,
    fanId: input.fanId,
    snoozedUntil: input.snoozedUntil,
    reason: input.reason,
  });
  if (input.planItemId != null) {
    await resolveWb3PlanItem(db, {
      planItemId: input.planItemId,
      status: "snoozed",
      resolvedAt: input.now ?? new Date(),
    });
  }
}

export interface ConfirmWb3TouchesResult {
  platformAccountId: number;
  confirmed: number;
  planItemsResolved: number;
}

/**
 * The workboard-v3.confirm-touches job body for one page: each open personal
 * touch is confirmed by the first non-broadcast model message in the fan's
 * threads within the window; matching plan items of the shift auto-close.
 */
export async function confirmWb3TouchesForPage(
  db: Database,
  input: {
    platformAccountId: number;
    now?: Date;
    windowHours?: number;
    lookbackDays?: number;
  },
): Promise<ConfirmWb3TouchesResult> {
  const now = input.now ?? new Date();
  const rows = await listWb3ConfirmableTouches(db, {
    platformAccountId: input.platformAccountId,
    now,
    windowHours: input.windowHours ?? WB3_TOUCH_CONFIRM_WINDOW_HOURS,
    lookbackDays: input.lookbackDays ?? WB3_TOUCH_CONFIRM_LOOKBACK_DAYS,
  });

  let planItemsResolved = 0;
  for (const row of rows) {
    await confirmWb3Touch(db, {
      touchId: row.touchId,
      confirmedAt: row.messageCreatedAt,
      modelMessagePk: row.messagePk,
    });
    if (row.shiftId != null) {
      planItemsResolved += await resolveWb3PlanItemsForTouch(db, {
        shiftId: row.shiftId,
        fanId: row.fanId,
        touchId: row.touchId,
        resolvedAt: now,
      });
    }
  }

  return { platformAccountId: input.platformAccountId, confirmed: rows.length, planItemsResolved };
}

export async function confirmWb3TouchesAllPages(
  db: Database,
  input?: { now?: Date; windowHours?: number },
): Promise<{ pages: number; confirmed: number; planItemsResolved: number }> {
  const now = input?.now ?? new Date();
  const pageIds = await listWb3PageIds(db);
  let confirmed = 0;
  let planItemsResolved = 0;
  for (const platformAccountId of pageIds) {
    const result = await confirmWb3TouchesForPage(db, {
      platformAccountId,
      now,
      windowHours: input?.windowHours,
    });
    confirmed += result.confirmed;
    planItemsResolved += result.planItemsResolved;
  }
  return { pages: pageIds.length, confirmed, planItemsResolved };
}
