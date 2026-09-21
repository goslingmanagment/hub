import {
  admitFanslyWsHintAttempt, advanceFanslyWsHint, assertOwnedPageSyncLease,
  claimFanslyWsHint, finalizePageDmConversationMessageSync, getPageSyncExecutionContext,
  listPageDmConversationsByPlatformConversationIds, lockFanslyWsGeneration,
  listFanslyWsHintRawPages,
  getExistingPageDmMessageIds, hasUnconfirmedFanslyWsHintTargets,
  saveFanslyWsHintWalk, tryAcquireDmArchiveWriterFenceLock, upsertPageDmMessages, isFanslyWsHintClaimEnabled,
  withOwnedPageSyncTransaction, type Database,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION, FanslyApiError, type FanslyMessage } from "@agency_hub_core/fansly";
import { isFanslyDmMessageSyncExcluded, resolveFanslyWsHintPolicy, type HttpRequestObserver } from "@agency_hub_core/shared";
import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { readFanslyPageGeneration } from "../egress/fansly-probe-context.ts";
import { resolvePageContext } from "../page-context.ts";
import type { ExecutorRequestContext } from "./executor-types.ts";
import { fetchAndJournalFanslyDmMessagePage, normalizeFanslyDmMessagePage } from "./fansly-dm-messages.ts";
import { resolveCapturePayloadRow } from "../payload-reader.ts";
import { dmRetentionDate, persistRawPayload } from "./shared.ts";
import { createPageRateLimitWaiter } from "./rate-limiter.ts";

class HintDeferred extends Error {}

const hintPolicyExpired = (expiresAt: string | undefined) =>
  expiresAt !== undefined && Date.now() >= Date.parse(expiresAt);

/** One additional physical request per ordinary DM chunk leaves at least
 * four request slots for the existing live/history policy. No separate job,
 * cursor, membership sweep or dependency priority replaces that policy. */
export async function runFanslyWsHintStep(app: AppContext, input: ExecutorRequestContext & { syncRunId: number }) {
  const pageId = input.pageContext.page.id;
  const label = input.pageContext.page.label;
  const policy = resolveFanslyWsHintPolicy(await loadEffectiveConfig(app.db, app.config), label);
  if (!policy || input.budget.maxRequests < 2 || !input.budget.hasRequestCapacity(2) || !input.budget.hasWallClockCapacity()) return;
  const execution = getPageSyncExecutionContext();
  if (!execution || execution.pageId !== pageId || execution.stream !== "dm_messages") throw new Error("fansly_ws_hint_page_lease_required");
  const owned = <T>(run: (db: Database) => Promise<T>) => withOwnedPageSyncTransaction(app.db, async (db) => {
    // Lock before budget reads, not just the ordinary transaction's final
    // lease assertion. This serializes admissions even within one lease.
    await assertOwnedPageSyncLease(db, { lock: true });
    await lockFanslyWsGeneration(db, pageId);
    if (!await tryAcquireDmArchiveWriterFenceLock(db, pageId)) throw new Error("fansly_ws_hint_erasure_busy");
    if (await readFanslyPageGeneration(db, label) !== policy.generation) throw new HintDeferred("generation_changed");
    return run(db);
  });

  // Resolve the REST credentials and route under the SAME generation lock.
  // The ordinary executor's earlier context may predate a credential change.
  const select = () => owned(async (db) => {
    const claim = await claimFanslyWsHint(db, pageId, policy, new Date());
    if (!claim) return null;
    const context = await resolvePageContext({ ...app, db }, label);
    if (context.platform !== "fansly" || !context.page.platformAccountId) throw new Error("fansly_ws_hint_platform_changed");
    const [conversation] = await listPageDmConversationsByPlatformConversationIds(db, {
      platformAccountId: pageId, platformConversationIds: [claim.groupRef], forUpdate: true,
    });
    const walk = { ...claim.walk };
    if (conversation && walk.conversationId === undefined) {
      walk.conversationId = conversation.id;
      walk.boundaryMessageRef = conversation.newestStoredMessageId;
      walk.before = null;
      walk.pagesRead = 0;
      await saveFanslyWsHintWalk(db, claim, walk);
    }
    return { claim, context, conversation, walk };
  });
  let selected: Awaited<ReturnType<typeof select>>;
  try { selected = await select(); } catch (error) {
    if (error instanceof HintDeferred) return;
    throw error;
  }
  if (!selected) return;
  const { claim, context, conversation, walk } = selected;
  let admitted = 0;
  let admittedRequestId: string | undefined;
  let transportFailure: "transport" | "timeout" | undefined;
  const observer: HttpRequestObserver = {
    async onRequestEvent(event) {
      let expiresAt: string | undefined;
      if (event.state === "started") {
        const live = resolveFanslyWsHintPolicy(await loadEffectiveConfig(app.db, app.config), label);
        if (!live || live.generation !== policy.generation || admitted >= 1
          || !input.budget.hasRequestCapacity(2) || !input.budget.hasWallClockCapacity()) throw new HintDeferred("admission_disabled");
        expiresAt = live.expiresAt;
        await owned(async (db) => {
          if (!await isFanslyWsHintClaimEnabled(db, claim, live)) throw new HintDeferred("type_disabled");
          await saveFanslyWsHintWalk(db, claim, walk);
          // Lock acquisition and claim checks may outlive the policy resolved
          // above. Expiry fences admission, not capture of an admitted response.
          const admissionAt = new Date();
          if (hintPolicyExpired(expiresAt)) throw new HintDeferred("admission_expired");
          try {
            await admitFanslyWsHintAttempt(db, { pageId, generation: policy.generation,
              requestId: event.requestId, attemptNumber: event.attemptNumber,
              maxAttempts24h: live.maxAttempts24h, now: admissionAt, syncRunId: input.syncRunId });
            if (hintPolicyExpired(expiresAt)) throw new HintDeferred("admission_expired");
          } catch (error) {
            if (error instanceof Error && error.message === "fansly_ws_hint_budget_exhausted") throw new HintDeferred("budget_exhausted");
            throw error;
          }
        });
        // A late commit keeps its reservation but cannot authorize dispatch.
        if (hintPolicyExpired(expiresAt)) throw new HintDeferred("admission_expired");
        admitted++;
        admittedRequestId = event.requestId;
        await input.budget.onRequestEvent(event);
      }
      const telemetry = input.telemetry.getRequestObserver();
      await telemetry.onRequestEvent(event);
      // Set evidence AFTER telemetry: an observer/DB failure must propagate.
      // The transport throws immediately after this terminal event, before
      // raw capture or normalization. Policy cancellation is never isolated.
      if (event.state === "failed" && event.requestId === admittedRequestId
        && (event.failureKind === "transport" || event.failureKind === "timeout")) {
        transportFailure = event.failureKind;
      }
      if (event.state === "started" && hintPolicyExpired(expiresAt)) {
        // The started observer is outside the transport's try/catch. Close its
        // telemetry explicitly when the final await crosses the deadline.
        await telemetry.onRequestEvent({ ...event, state: "failed", timestamp: new Date(),
          httpStatus: null, failureKind: "policy", durationMs: Math.max(0, Date.now() - event.timestamp.getTime()),
          errorMessage: "Fansly hint policy expired before dispatch" });
        throw new HintDeferred("admission_expired");
      }
    },
  };
  const requestContext = {
    session: context.session, proxy: context.proxy, egressKey: context.egressKey,
    requestObserver: observer, remainingAttempts: () => Math.max(0, 1 - admitted),
    rateLimitWaiter: createPageRateLimitWaiter(app, context),
  };
  const now = () => new Date();
  const defer = (outcome: string) => owned((db) => advanceFanslyWsHint(db, claim, {
    walk, complete: false, outcome, failed: true, now: now(),
    retryAt: new Date(Date.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(claim.consecutiveFailures, 6))),
  }));
  try {
    if (!conversation) {
      if (!walk.groupDetailCaptured) {
        const detail = await app.adapter.getGroupDetail(requestContext, claim.groupRef);
        await persistRawPayload(app.db, { platformAccountId: pageId, syncRunId: input.syncRunId,
          endpoint: "group_detail", requestParams: { groupId: claim.groupRef }, responsePayload: detail.raw,
          mapperVersion: FANSLY_MAPPER_VERSION, payloadKind: "dm_metadata", retainUntil: dmRetentionDate(),
        }, { action: "inserting B1 group_detail raw payload", platform: "fansly" });
        if (detail.parsed.id !== claim.groupRef) throw new Error("fansly_ws_hint_group_mismatch");
        walk.groupDetailCaptured = true;
      }
      // A group detail is not proof that the group belongs to the visible
      // roster. Keep discovery debt until the unchanged full sweep binds it.
      await defer("membership_pending");
      return;
    }
    if (!conversation.isVisible || conversation.fanId === null || isFanslyDmMessageSyncExcluded(conversation.metadata)) {
      await defer("conversation_ineligible");
      return;
    }
    if (walk.conversationId !== conversation.id) throw new Error("fansly_ws_hint_conversation_changed");
    const normalizationInput = {
      telemetry: input.telemetry, platformAccountId: pageId, platform: context.platform,
      pageAccountId: context.page.platformAccountId!, conversation,
    };
    const page = await fetchAndJournalFanslyDmMessagePage(app, {
      requestContext, telemetry: input.telemetry, syncRunId: input.syncRunId,
      platformAccountId: pageId, platform: context.platform, pageAccountId: context.page.platformAccountId!,
      conversation, before: walk.before ?? null,
    });
    // Only the original boundary settles the walk. Generic overlap could be
    // our own prior partial write/replay after a crash and would hide a gap.
    const boundaryFound = walk.boundaryMessageRef != null && page.normalizedMessages.some(
      (message) => message.platformMessageId === walk.boundaryMessageRef,
    );
    const complete = (boundaryFound || page.providerHistoryExhausted)
      && page.normalizedMessages.length === page.page.items.length;
    if (page.normalizedMessages.length !== page.page.items.length) {
      await defer("normalization_debt");
      return;
    }
    if (!complete && (!page.oldestMessageId || page.oldestMessageId === walk.before)) {
      await defer("cursor_stalled");
      return;
    }
    const pagesRead = (walk.pagesRead ?? 0) + 1;
    const rawPageIds = [...(walk.rawPageIds ?? []), page.rawPayloadId];
    if (!complete) {
      // A partial head must never become ordinary polling's overlap: it can
      // conceal the still-missing middle after B1 is disabled. Keep only raw
      // refs until the boundary, with an absolute five-page staging bound.
      await owned(db => advanceFanslyWsHint(db, claim, {
        walk: pagesRead >= 5 ? { generation: walk.generation } : {
          ...walk, before: page.oldestMessageId, pagesRead, rawPageIds,
        }, complete: false, outcome: pagesRead >= 5 ? "walk_limit" : "walk_pending", now: now(), rawPageIds,
        retryAt: new Date(Date.now() + (pagesRead >= 5 ? 3_600_000 : 60_000)),
      }));
      return;
    }
    const messages = new Map(page.normalizedMessages.map(message => [message.platformMessageId, message]));
    if (walk.rawPageIds?.length) {
      const rows = await listFanslyWsHintRawPages(app.db, pageId, claim.groupRef, walk.rawPageIds);
      for (const row of rows) {
        const resolved = await resolveCapturePayloadRow(app, "raw_payload", row.id, row);
        const raw = resolved.payload;
        if (!raw || typeof raw !== "object" || !("messages" in raw) || !Array.isArray(raw.messages)
          || raw.messages.some(message => !message || typeof message !== "object" || typeof message.id !== "string"
            || (message.groupId !== undefined && message.groupId !== claim.groupRef))) throw new Error("fansly_ws_hint_staged_page_invalid");
        const normalized = await normalizeFanslyDmMessagePage(app, normalizationInput, {
          raw: { ...raw, messages: raw.messages as FanslyMessage[] },
          items: raw.messages as FanslyMessage[], groupId: claim.groupRef, before: null, done: false,
        });
        if (normalized.normalizedMessages.length !== raw.messages.length) throw new Error("fansly_ws_hint_staged_normalization_debt");
        for (const message of normalized.normalizedMessages) {
          if (!messages.has(message.platformMessageId)) messages.set(message.platformMessageId, message);
        }
      }
    }
    await owned(async (db) => {
      const currentIds = new Set(page.normalizedMessages.map(message => message.platformMessageId));
      const existingIds = await getExistingPageDmMessageIds(db, {
        conversationId: conversation.id, platformMessageIds: [...messages.keys()],
      });
      // A later ordinary REST read may already have edited a staged message.
      // Staged pages fill missing IDs; only this step's fresh response may
      // update existing rows through the ordinary writer.
      await upsertPageDmMessages(db, [...messages.values()].filter(message =>
        currentIds.has(message.platformMessageId) || !existingIds.has(message.platformMessageId)));
      await finalizePageDmConversationMessageSync(db, {
        conversationId: conversation.id, messageCoverageStatus: conversation.messageCoverageStatus, enforceRetention: false,
      });
      const targetUnconfirmed = await hasUnconfirmedFanslyWsHintTargets(db, claim, conversation.id, policy);
      await advanceFanslyWsHint(db, claim, {
        // The contiguous material is safe for ordinary polling. A missing
        // exact target remains debt and retries from the head, not behind it.
        walk: { generation: walk.generation }, complete: !targetUnconfirmed,
        outcome: targetUnconfirmed ? "target_unconfirmed" : "boundary_checked", now: now(), rawPageIds,
        settlement: { conversationId: conversation.id, policy },
        ...(targetUnconfirmed ? { retryAt: new Date(Date.now() + 60_000) } : {}),
      });
    });
  } catch (error) {
    // Only admission refusals are a quiet yield. Provider errors (especially
    // 429/Retry-After), capture failures and lost leases retain executor policy.
    if (error instanceof HintDeferred) { await defer(error.message); return; }
    if (error instanceof FanslyApiError && error.retryAfterAt === null
      && (error.status === 404 || (error.status !== undefined && error.status >= 500))) {
      await defer("target_failed");
      return;
    }
    if (!(error instanceof FanslyApiError) && transportFailure) {
      await defer(`target_${transportFailure}`);
      return;
    }
    throw error;
  }
}
