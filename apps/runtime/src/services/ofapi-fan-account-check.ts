// OnlyFans fan account check (owner request 2026-10-22). OnlyFans never tells
// a page that a fan deleted the account or that it can no longer message
// him: he just stays on its spender lists (a reactivation audit that day found
// 200 of Lora's 536 OnlyFans spenders the single-user route answers 404 for,
// and 21 more whose chat is closed to the page). Four times a day, for every
// mapped OnlyFans page, this reads the page's paying fans through its account,
// ten a credit (GET /{account}/users/list) — never asked first, then those
// asked over a week ago — and keeps the page's own answer where the Fansly
// lookups keep theirs (page_fans.account_lookup_at / account_probe_*), plus
// whether the page can message him (account_contactability):
//   gone        a stub with no username: the account was deleted;
//   blocked     isBlocked;
//   restricted  isRestricted;
//   contactable / unavailable  canReceiveChatMessage true / false (closed
//               chat: an expired fan the page does not subscribe to);
//   unknown     none of these said.
// Gone and blocked are "not seen", which the spender lists show
// (FanNotVisibleMark). The answer is the page's fact only — the shared
// fans.deleted_detected_at is never touched (arena "vanished chat" D2, #509).
//
// Every answer is journaled (`ofapi_users_list`) before it is written, a body
// the client refuses included. Spend rides the `audience` lane under the
// shared day budget and the credit floor. A pass stops a page at its first
// failure and the fleet at a budget block or its own cap; the next pass
// resumes from what is due.

import {
  listOfapiMappedPages,
  listOnlyfansFansDueForAccountCheck,
  OfapiCollectionPolicyError,
  recordOnlyfansAccountCheck,
  type Database,
  type FanPageContactability,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { resolveEgress } from "./egress/resolver.ts";
import { asRecord, idToString } from "./ofapi-payloads.ts";
import { OfapiApiError, type OfapiListPage, type OfapiRequestContext } from "./ofapi.ts";
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

/** Requests a pass may send across the fleet, ten fans each: the first walk
 *  of ~950 paying fans is about four passes, then ~15 credits a day. */
export const OFAPI_FAN_ACCOUNT_CHECK_REQUESTS_PER_PASS = 25;
const FANS_PER_REQUEST = 10;
const RECHECK_AFTER_DAYS = 7;
const JOURNAL_ENDPOINT = "ofapi_users_list";
const JOURNAL_MAPPER_VERSION = "ofapi-users-list-v1";
const JOURNAL_ACTION = "journal users list";

export interface OfapiFanAccountCheckPageResult {
  pageLabel: string;
  status: "checked" | "blocked" | "failed";
  reason: string | null;
  requests: number;
  answers: Partial<Record<FanPageContactability, number>>;
  unanswered: number;
}

/** The page's answer for one returned profile, in the order it decides. */
export function ofapiProfileContactability(profile: Record<string, unknown>): FanPageContactability {
  if (typeof profile.username !== "string" || profile.username.trim().length === 0) return "gone";
  if (profile.isBlocked === true) return "blocked";
  if (profile.isRestricted === true) return "restricted";
  if (profile.canReceiveChatMessage === true) return "contactable";
  if (profile.canReceiveChatMessage === false) return "unavailable";
  return "unknown";
}

async function journalAnswer(
  app: AppContext,
  input: { pageId: number; ofapiAccountId: string; userIds: string[]; body: unknown },
) {
  try {
    await persistRawPayload(app.db, {
      platformAccountId: input.pageId,
      endpoint: JOURNAL_ENDPOINT,
      requestParams: { path: "/:accountId/users/list", ids: input.userIds },
      responsePayload: { ofapiAccountId: input.ofapiAccountId, userIds: input.userIds, body: input.body },
      mapperVersion: JOURNAL_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, { action: JOURNAL_ACTION, platform: "onlyfans" });
  } catch (error) {
    // The driver's error carries the INSERT's bound values (the fans'
    // profiles); only the sanitized summary travels on.
    const summary = buildNormalizedSyncError(error, { endpoint: JOURNAL_ENDPOINT, action: JOURNAL_ACTION }).summary;
    // eslint-disable-next-line preserve-caught-error -- the cause holds the vendor body; only the summary may travel
    throw new Error(`OFAPI users list not journaled: ${summary}`);
  }
}

async function checkPage(
  app: AppContext,
  input: {
    pageId: number;
    pageLabel: string;
    ofapiAccountId: string;
    maxRequests: number;
    guard: ReturnType<typeof createOfapiRestGuard>;
  },
): Promise<OfapiFanAccountCheckPageResult> {
  const result: OfapiFanAccountCheckPageResult = {
    pageLabel: input.pageLabel, status: "checked", reason: null, requests: 0, answers: {}, unanswered: 0,
  };
  const due = await listOnlyfansFansDueForAccountCheck(app.db, {
    platformAccountId: input.pageId,
    now: new Date(),
    recheckAfterDays: RECHECK_AFTER_DAYS,
    limit: input.maxRequests * FANS_PER_REQUEST,
  });
  if (due.length === 0) return result;

  const egress = await resolveEgress(app, { kind: "vendor", vendor: "ofapi" });
  const context: OfapiRequestContext = {
    pageId: input.pageId,
    dispatcher: egress.dispatcher,
    egressKey: egress.egressKey,
    creditBudgetScope: "audience",
  };

  for (let offset = 0; offset < due.length; offset += FANS_PER_REQUEST) {
    const batch = due.slice(offset, offset + FANS_PER_REQUEST);
    const userIds = batch.map((fan) => fan.platformUserId);
    const block = await input.guard.resolveBlock();
    if (block !== null) {
      return { ...result, status: "blocked", reason: block };
    }
    let page: OfapiListPage;
    try {
      page = await app.ofapi!.getUserDetailsList!(context, input.ofapiAccountId, userIds);
    } catch (error) {
      if (error instanceof OfapiCollectionPolicyError) {
        // Refused before anything was sent: release the estimate, and the
        // owner's policy (a cap, a pause) is not a fault.
        await input.guard.recordResponse({ items: [], hasNextPage: false, meta: null, creditSpendAccounted: true });
        return { ...result, status: "blocked", reason: error.code };
      }
      // The outcome is unknown: the reservation stays charged.
      input.guard.abandonPendingReservation();
      if (error instanceof OfapiApiError && error.refusedListBody !== undefined) {
        await journalAnswer(app, {
          pageId: input.pageId, ofapiAccountId: input.ofapiAccountId, userIds, body: error.refusedListBody,
        });
      }
      const reason = error instanceof Error ? error.message : String(error);
      return { ...result, status: "failed", reason };
    }
    try {
      await journalAnswer(app, {
        pageId: input.pageId, ofapiAccountId: input.ofapiAccountId, userIds, body: page.rawBody ?? null,
      });
    } finally {
      await input.guard.recordResponse(page);
    }
    result.requests += 1;

    const profiles = new Map(page.items.flatMap((item) => {
      const id = idToString(asRecord(item)?.id);
      return id ? [[id, item] as const] : [];
    }));
    const answers = batch.flatMap((fan) => {
      const profile = profiles.get(fan.platformUserId);
      return profile ? [{ fanId: fan.fanId, contactability: ofapiProfileContactability(profile) }] : [];
    });
    await app.db.transaction(async (tx) => {
      await recordOnlyfansAccountCheck(tx as unknown as Database, {
        platformAccountId: input.pageId,
        answeredAt: new Date(),
        askedFanIds: batch.map((fan) => fan.fanId),
        answers,
      });
    });
    for (const answer of answers) {
      result.answers[answer.contactability] = (result.answers[answer.contactability] ?? 0) + 1;
    }
    result.unanswered += batch.length - answers.length;
  }
  return result;
}

export async function runOfapiFanAccountCheck(app: AppContext) {
  if (!app.ofapi?.getUserDetailsList) {
    return { pages: [] as OfapiFanAccountCheckPageResult[] };
  }
  const mapped = (await listOfapiMappedPages(app.db)).filter((page) => page.platform === "onlyfans");
  const guard = createOfapiRestGuard(app, {
    maxRequestsPerRun: OFAPI_FAN_ACCOUNT_CHECK_REQUESTS_PER_PASS,
    budgetScope: "audience",
  });
  // An even share first, so one page's backlog never starves another; then
  // what a page left unused goes to the pages that still have fans due.
  const share = Math.ceil(OFAPI_FAN_ACCOUNT_CHECK_REQUESTS_PER_PASS / Math.max(1, mapped.length));
  const results = new Map<number, OfapiFanAccountCheckPageResult>();

  for (const round of ["share", "rest"] as const) {
    for (const page of mapped) {
      const previous = results.get(page.id);
      if (round === "rest" && (previous?.status !== "checked" || previous.requests < share)) continue;
      const left = OFAPI_FAN_ACCOUNT_CHECK_REQUESTS_PER_PASS - guard.requestsUsed;
      if (left <= 0) break;
      let pass: OfapiFanAccountCheckPageResult;
      try {
        pass = await checkPage(app, {
          pageId: page.id,
          pageLabel: page.label,
          ofapiAccountId: page.ofapiAccountId,
          maxRequests: round === "share" ? Math.min(share, left) : left,
          guard,
        });
      } catch (error) {
        guard.abandonPendingReservation();
        pass = {
          pageLabel: page.label, status: "failed", reason: error instanceof Error ? error.message : String(error),
          requests: 0, answers: {}, unanswered: 0,
        };
      }
      results.set(page.id, previous ? mergePasses(previous, pass) : pass);
      // A budget block holds for the whole fleet: the rest waits for the next
      // pass. A collection policy answers for its own page only.
      if (pass.status === "blocked" && !pass.reason?.startsWith("ofapi_collection_")) {
        return finish(app, [...results.values()]);
      }
    }
  }
  return finish(app, [...results.values()]);
}

function mergePasses(
  first: OfapiFanAccountCheckPageResult,
  second: OfapiFanAccountCheckPageResult,
): OfapiFanAccountCheckPageResult {
  const answers = { ...first.answers };
  for (const [state, count] of Object.entries(second.answers) as Array<[FanPageContactability, number]>) {
    answers[state] = (answers[state] ?? 0) + count;
  }
  return {
    ...second,
    requests: first.requests + second.requests,
    answers,
    unanswered: first.unanswered + second.unanswered,
  };
}

function finish(app: AppContext, pages: OfapiFanAccountCheckPageResult[]) {
  const failed = pages.some((page) => page.status === "failed");
  const log = failed ? app.logger.error.bind(app.logger) : app.logger.info.bind(app.logger);
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
