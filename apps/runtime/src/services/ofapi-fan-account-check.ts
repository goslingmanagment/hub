// OnlyFans fan account check (owner request 2026-10-22). OnlyFans never tells
// a page that a fan deleted the account: he just stays on its spender lists,
// with no chat and no way to reach him (a reactivation audit that day found
// 200 of Lora's 536 OnlyFans spenders gone). Four times a day, for every
// mapped OnlyFans page, this asks GET /{account}/users/{id} about the page's
// paying fans — never asked first, then a seen fan after 30 days and a missed
// one after 14 — and keeps the page's answer where the Fansly lookups keep
// theirs (page_fans.account_lookup_at / account_probe_*): a profile is "seen",
// OnlyFans' "User not found" 404 is "not seen". The answer cannot tell a
// deleted account from a fan who blocked the page, so it stays the page's own
// fact: the shared fans.deleted_detected_at is never touched (arena "vanished
// chat" D2, #509), and the page's spender lists show it (FanNotVisibleMark).
//
// Every answer is journaled (`ofapi_user_details`) before it is written. One
// credit a fan, on the `audience` lane under the shared day budget and the
// credit floor. A pass stops a page at its first other failure and the fleet
// at a budget block or its own cap; the next pass resumes from what is due.

import {
  listOfapiMappedPages,
  listOnlyfansFansDueForAccountCheck,
  markFanPageAccountLookups,
  recordFanPageAccountLookupAnswers,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { resolveEgress } from "./egress/resolver.ts";
import { idToString } from "./ofapi-payloads.ts";
import { OfapiApiError, ofapiUserNotFound, type OfapiRequestContext } from "./ofapi.ts";
import {
  ensureQueueCreated,
  type QueueCreationClient,
  type SyncQueueLifecycleClient,
} from "./sync-queue.ts";
import { buildNormalizedSyncError } from "./sync/errors.ts";
import { createOfapiRestGuard } from "./sync/ofapi-dm-sync.ts";
import { persistRawPayload, retentionDate } from "./sync/shared.ts";

export const OFAPI_FAN_ACCOUNT_CHECK_QUEUE = "ofapi.fan-account-check";

// A failed pass changes nothing it did not journal; the next window asks again.
const OFAPI_FAN_ACCOUNT_CHECK_QUEUE_OPTIONS = {
  policy: "exclusive",
  retryLimit: 0,
} as const;

/** Checks a pass may send across the fleet: 4 passes ≤ 200 credits a day. The
 *  first walk of ~950 paying fans takes about five days, then ~40 a day. */
export const OFAPI_FAN_ACCOUNT_CHECKS_PER_PASS = 50;
const SEEN_RECHECK_AFTER_DAYS = 30;
const MISSED_RECHECK_AFTER_DAYS = 14;
const JOURNAL_ENDPOINT = "ofapi_user_details";
const JOURNAL_MAPPER_VERSION = "ofapi-user-details-v1";
const JOURNAL_ACTION = "journal user details";

export interface OfapiFanAccountCheckPageResult {
  pageLabel: string;
  status: "checked" | "blocked" | "failed";
  reason: string | null;
  seen: number;
  notSeen: number;
}

function parsedBody(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

async function journalAnswer(
  app: AppContext,
  input: { pageId: number; ofapiAccountId: string; userId: string; status: number; body: unknown },
) {
  try {
    await persistRawPayload(app.db, {
      platformAccountId: input.pageId,
      endpoint: JOURNAL_ENDPOINT,
      requestParams: { path: "/:accountId/users/:userId", userId: input.userId },
      responsePayload: {
        ofapiAccountId: input.ofapiAccountId,
        userId: input.userId,
        status: input.status,
        body: input.body,
      },
      mapperVersion: JOURNAL_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, { action: JOURNAL_ACTION, platform: "onlyfans" });
  } catch (error) {
    // The driver's error carries the INSERT's bound values (the fan's profile);
    // only the sanitized summary travels on.
    const summary = buildNormalizedSyncError(error, { endpoint: JOURNAL_ENDPOINT, action: JOURNAL_ACTION }).summary;
    // eslint-disable-next-line preserve-caught-error -- the cause holds the vendor body; only the summary may travel
    throw new Error(`OFAPI user details not journaled: ${summary}`);
  }
}

async function recordAnswer(
  db: Database,
  input: { pageId: number; fanId: number; seen: boolean; answeredAt: Date },
) {
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await markFanPageAccountLookups(database, {
      platformAccountId: input.pageId,
      fanIds: [input.fanId],
      lookedUpAt: input.answeredAt,
    });
    await recordFanPageAccountLookupAnswers(database, {
      platformAccountId: input.pageId,
      answeredAt: input.answeredAt,
      resolvedFanIds: input.seen ? [input.fanId] : [],
      unresolvedFanIds: input.seen ? [] : [input.fanId],
    });
  });
}

async function checkPage(
  app: AppContext,
  input: {
    pageId: number;
    pageLabel: string;
    ofapiAccountId: string;
    limit: number;
    guard: ReturnType<typeof createOfapiRestGuard>;
  },
): Promise<OfapiFanAccountCheckPageResult> {
  const result: OfapiFanAccountCheckPageResult = {
    pageLabel: input.pageLabel, status: "checked", reason: null, seen: 0, notSeen: 0,
  };
  const due = await listOnlyfansFansDueForAccountCheck(app.db, {
    platformAccountId: input.pageId,
    now: new Date(),
    seenAfterDays: SEEN_RECHECK_AFTER_DAYS,
    missedAfterDays: MISSED_RECHECK_AFTER_DAYS,
    limit: input.limit,
  });
  if (due.length === 0) return result;

  const egress = await resolveEgress(app, { kind: "vendor", vendor: "ofapi" });
  const context: OfapiRequestContext = {
    pageId: input.pageId,
    dispatcher: egress.dispatcher,
    egressKey: egress.egressKey,
    creditBudgetScope: "audience",
  };

  for (const fan of due) {
    const block = await input.guard.resolveBlock();
    if (block !== null) {
      return { ...result, status: "blocked", reason: block };
    }
    let seen: boolean;
    try {
      const page = await app.ofapi!.getUserDetails!(context, input.ofapiAccountId, fan.platformUserId);
      try {
        await journalAnswer(app, {
          pageId: input.pageId, ofapiAccountId: input.ofapiAccountId, userId: fan.platformUserId,
          status: 200, body: page.rawBody ?? null,
        });
      } finally {
        await input.guard.recordResponse(page);
      }
      const answeredId = idToString(page.items[0]?.id);
      if (answeredId !== fan.platformUserId) {
        throw new Error(`OFAPI user details answered for another user (asked ${fan.platformUserId})`);
      }
      seen = true;
    } catch (error) {
      // A thrown request leaves its day-budget reservation charged as is.
      input.guard.abandonPendingReservation();
      if (!(error instanceof OfapiApiError) || !ofapiUserNotFound(error.status, error.body)) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ...result, status: "failed", reason };
      }
      await journalAnswer(app, {
        pageId: input.pageId, ofapiAccountId: input.ofapiAccountId, userId: fan.platformUserId,
        status: 404, body: parsedBody(error.body),
      });
      seen = false;
    }
    await recordAnswer(app.db, { pageId: input.pageId, fanId: fan.fanId, seen, answeredAt: new Date() });
    if (seen) result.seen += 1;
    else result.notSeen += 1;
  }
  return result;
}

export async function runOfapiFanAccountCheck(app: AppContext) {
  if (!app.ofapi?.getUserDetails) {
    return { pages: [] as OfapiFanAccountCheckPageResult[] };
  }
  const mapped = (await listOfapiMappedPages(app.db)).filter((page) => page.platform === "onlyfans");
  const guard = createOfapiRestGuard(app, {
    maxRequestsPerRun: OFAPI_FAN_ACCOUNT_CHECKS_PER_PASS,
    budgetScope: "audience",
  });
  // An even share each, so one page's backlog never starves another's.
  const perPage = Math.ceil(OFAPI_FAN_ACCOUNT_CHECKS_PER_PASS / Math.max(1, mapped.length));

  const pages: OfapiFanAccountCheckPageResult[] = [];
  for (const page of mapped) {
    try {
      pages.push(await checkPage(app, {
        pageId: page.id,
        pageLabel: page.label,
        ofapiAccountId: page.ofapiAccountId,
        limit: perPage,
        guard,
      }));
    } catch (error) {
      guard.abandonPendingReservation();
      pages.push({
        pageLabel: page.label,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
        seen: 0,
        notSeen: 0,
      });
    }
    // A budget block holds for the whole fleet: the rest waits for the next pass.
    if (pages.at(-1)?.status === "blocked") break;
  }

  const failed = pages.filter((page) => page.status === "failed");
  const log = failed.length > 0 ? app.logger.error.bind(app.logger) : app.logger.info.bind(app.logger);
  log({ pages }, "OFAPI fan account check complete");
  return { pages };
}

export async function ensureOfapiFanAccountCheckQueue(
  boss: SyncQueueLifecycleClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(
    boss,
    OFAPI_FAN_ACCOUNT_CHECK_QUEUE,
    OFAPI_FAN_ACCOUNT_CHECK_QUEUE_OPTIONS,
    createdQueues,
  );
}

export async function ensureOfapiFanAccountCheckSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Four times a day, off the hour the other OFAPI reconciles start on.
  await boss.schedule(OFAPI_FAN_ACCOUNT_CHECK_QUEUE, "40 */6 * * *", null, { tz: "UTC" });
}

export async function startOfapiFanAccountCheckWorker(
  app: AppContext,
  boss: {
    work: (
      queue: string,
      options: { batchSize: number },
      handler: () => Promise<void>,
    ) => Promise<unknown>;
  },
) {
  await boss.work(OFAPI_FAN_ACCOUNT_CHECK_QUEUE, { batchSize: 1 }, async () => {
    const result = await runOfapiFanAccountCheck(app);
    const failed = result.pages.filter((page) => page.status === "failed");
    if (failed.length > 0) {
      throw new Error(`OFAPI fan account check failed for ${failed.length} page(s)`);
    }
  });
}
