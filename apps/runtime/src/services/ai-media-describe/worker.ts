import { createHash, randomUUID } from "node:crypto";

import {
  claimNextDueAiMediaDescription,
  countRecentAiMediaDescribeOutcomes,
  expireAwaitingSourceAiMediaDescriptions,
  finalizeAiGatewayUsageEvent,
  findDescribedAiMediaByContent,
  findPageByLabel,
  finishAiMediaDescription,
  getAiMediaDescribeDay,
  getFirstAiMediaDescriptionLink,
  getNotificationIncidentByKey,
  incrementAiMediaDescribeRefusals,
  insertAiGenerationContent,
  isAiMediaContentRefused,
  isAiMediaRefRefused,
  reserveAiGatewayUsageEvent,
  reserveAiMediaDescribeBudget,
  settleAiMediaDescribeBudget,
  tripAiMediaDescribeBreaker,
  upsertAiMediaDescriptionCandidate,
  type AiMediaDescriptionRow,
  type AiMediaKind,
  type AiMediaPlatform,
  type AiMediaVariant,
} from "@agency_hub_core/db";
import type { ProxyConfig } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { resolveEgress } from "../egress/resolver.ts";
import { downloadMediaForDescribe, type MediaDownloadResult } from "../egress/media-download.ts";
import {
  AI_MEDIA_DESCRIBE_ACCOUNT_STOP_SUBKEY,
  AI_MEDIA_DESCRIBE_BREAKER_SUBKEY,
  incidentKey,
  openCriticalNotificationIncident,
  resolveCriticalNotificationIncident,
} from "../notification-incidents.ts";
import { resolveStoredProxyConfig } from "../page-context.ts";
import {
  MEDIA_DESCRIBE_DEFAULT_MODEL,
  MEDIA_DESCRIBE_PROMPT_VERSION,
  MEDIA_DESCRIBE_SYSTEM_PROMPT,
  describeMedia,
  estimateMediaDescribeReserveMicroUsd,
  type MediaDescribeClientFactory,
  type MediaDescribeOutcome,
} from "./describer.ts";
import { prepareMediaImage } from "./image.ts";
import {
  isAfterAiMediaDescribeBoundary,
  isAiMediaDescribeWindowOpen,
  parseAiMediaDescribePagePolicies,
  type AiMediaDescribePagePolicy,
} from "./policy.ts";

// The AI media describer sweep (plan §6/§9). One claimed row at a time
// (parallelism 1: libvips and the provider see at most one image from this
// process), every paid step behind the day's atomic reservation, every
// provider send behind the row's lease and its ownership token (single
// flight). Rows are claimed one by one, fresh files first, so a new photo
// never waits behind a batch; every settle is stamped with the real time.
//
// Logging rule: ids, statuses and error codes only — never a URL, a
// signature, image bytes or a description.

export const AI_MEDIA_DESCRIBE_FEATURE = "media-describe" as const;
export const AI_MEDIA_DESCRIBE_LEASE_MS = 3 * 60 * 1000;
export const AI_MEDIA_DESCRIBE_SWEEP_LIMIT = 10;
/** Files whose first message is this recent are claimed before the backlog. */
export const AI_MEDIA_DESCRIBE_FRESH_MS = 15 * 60 * 1000;
/** A row waiting for a free source this long becomes unavailable. */
export const AI_MEDIA_AWAITING_SOURCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AI_MEDIA_BREAKER_DAILY_REFUSALS = 25;
export const AI_MEDIA_BREAKER_WINDOW = 40;
export const AI_MEDIA_BREAKER_MIN_SAMPLES = 10;
const MAX_TRANSIENT_ATTEMPTS = 4;
const TRANSIENT_RETRY_MS = 10 * 60 * 1000;

/** What a platform source adapter can say about one claimed row. */
export type AiMediaSourceResolution =
  /** A free URL, valid now; downloaded through the page's egress. */
  | { kind: "url"; url: string; source: string }
  /** No free source yet; look again at `retryAt` (null = only when a new
   * source is observed, the projector re-promotes the row). */
  | { kind: "awaiting_source"; retryAt: Date | null; reason: string }
  /** Never describable (deleted, locked, expired, not an image). */
  | { kind: "unavailable"; reason: string }
  /** Policy: not described (a PPV body, disabled creator media, …). */
  | { kind: "skip"; reason: string }
  /** A bundle: one candidate per member file on the same message. */
  | { kind: "expand"; members: Array<{ mediaRef: string; variant: AiMediaVariant; mediaKind: Exclude<AiMediaKind, "bundle"> }>; source: string };

export interface AiMediaSource {
  readonly platform: AiMediaPlatform;
  resolve(
    app: AppContext,
    row: AiMediaDescriptionRow,
    context: { now: Date; modelMedia: "teasers" | "teasers+free" },
  ): Promise<AiMediaSourceResolution>;
}

export interface AiMediaDescribeDeps {
  sources: ReadonlyMap<AiMediaPlatform, AiMediaSource>;
  /** Null when no Anthropic key is configured (the sweep then idles). */
  clientFactory: MediaDescribeClientFactory | null;
  download?: (input: { url: string; pageId: number }) => Promise<MediaDownloadResult>;
  /** The clock; read at every step (claim, reservation, settle). */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface AiMediaDescribeSweepResult extends Record<string, unknown> {
  skipped?: "disabled" | "no_pages" | "no_client" | "account_stopped" | "breaker";
  /** Rows whose claim was taken over by another worker before a settle. */
  leaseLost?: number;
  claimed: number;
  sent: number;
  outcomes: Record<string, number>;
}

export function utcDay(now: Date) {
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function utcDayStart(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function defaultDownload(app: AppContext, input: { url: string; pageId: number }) {
  const egress = await resolveEgress(app, { kind: "page", pageId: input.pageId });
  try {
    return await downloadMediaForDescribe({ url: input.url, dispatcher: egress.dispatcher });
  } finally {
    await egress.close().catch(() => undefined);
  }
}

/** Page ids the describer may work on now (enabled policy, open window). */
export async function listActiveAiMediaDescribePageIds(
  app: AppContext,
  policiesRaw: string | undefined,
  now: Date,
): Promise<number[]> {
  return (await loadActivePages(app, policiesRaw, now)).map((page) => page.id);
}

interface ActivePage {
  id: number;
  label: string;
  policy: AiMediaDescribePagePolicy;
  proxy: ProxyConfig | null;
}

async function loadActivePages(
  app: AppContext,
  policiesRaw: string | undefined,
  now: Date,
): Promise<ActivePage[]> {
  const pages: ActivePage[] = [];
  for (const [label, policy] of parseAiMediaDescribePagePolicies(policiesRaw)) {
    if (!isAiMediaDescribeWindowOpen(policy, now)) {
      continue;
    }
    const stored = await findPageByLabel(app.db, label);
    if (!stored) {
      continue;
    }
    pages.push({ id: stored.page.id, label, policy, proxy: resolveStoredProxyConfig(app, stored.proxy) });
  }
  return pages;
}

async function isAccountStopped(app: AppContext) {
  const incident = await getNotificationIncidentByKey(app.db, incidentKey({
    kind: "ai_provider_failed",
    platformAccountId: null,
    subKey: AI_MEDIA_DESCRIBE_ACCOUNT_STOP_SUBKEY,
  }));
  return incident?.status === "open";
}

/** The breaker latches for the UTC day; a new day resolves the latch. */
async function reconcileBreakerLatch(app: AppContext, now: Date): Promise<boolean> {
  const today = await getAiMediaDescribeDay(app.db, utcDay(now));
  if (today?.breakerTrippedAt) {
    return true;
  }
  const incident = await getNotificationIncidentByKey(app.db, incidentKey({
    kind: "ai_provider_failed",
    platformAccountId: null,
    subKey: AI_MEDIA_DESCRIBE_BREAKER_SUBKEY,
  }));
  if (incident?.status === "open") {
    await resolveCriticalNotificationIncident(app, {
      kind: "ai_provider_failed",
      platformAccountId: null,
      pageLabel: null,
      platform: null,
      subKey: AI_MEDIA_DESCRIBE_BREAKER_SUBKEY,
      recoveredAt: now,
    });
  }
  return false;
}

async function evaluateBreakerAfterRefusal(app: AppContext, now: Date) {
  const day = utcDay(now);
  const refusals = await incrementAiMediaDescribeRefusals(app.db, { day, now });
  let reason: string | null = null;
  if (refusals >= AI_MEDIA_BREAKER_DAILY_REFUSALS) {
    reason = `${refusals} refusals today`;
  } else {
    const recent = await countRecentAiMediaDescribeOutcomes(app.db, {
      since: utcDayStart(now),
      limit: AI_MEDIA_BREAKER_WINDOW,
    });
    if (recent.total >= AI_MEDIA_BREAKER_MIN_SAMPLES && recent.refused * 2 >= recent.total) {
      reason = `${recent.refused} of the last ${recent.total} images refused`;
    }
  }
  if (reason === null) {
    return;
  }
  if (await tripAiMediaDescribeBreaker(app.db, { day, reason, now })) {
    app.logger.warn({ reason }, "ai media describer breaker tripped for the UTC day");
    await openCriticalNotificationIncident(app, {
      kind: "ai_provider_failed",
      platformAccountId: null,
      pageLabel: null,
      platform: null,
      subKey: AI_MEDIA_DESCRIBE_BREAKER_SUBKEY,
      errorCode: "media_describe_refusals",
      errorSummary: `Paused until the next UTC day: ${reason}. Ready descriptions keep working.`,
      occurredAt: now,
    });
  }
}

function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runAiMediaDescribeSweep(
  app: AppContext,
  deps: AiMediaDescribeDeps,
  options: { limit?: number } = {},
): Promise<AiMediaDescribeSweepResult> {
  const clock = deps.now ?? (() => new Date());
  const startedAt = clock();
  const result: AiMediaDescribeSweepResult = { claimed: 0, sent: 0, outcomes: {} };
  const effective = await loadEffectiveConfig(app.db, app.config);
  if (effective.aiMediaDescribeEnabled !== true) {
    return { ...result, skipped: "disabled" };
  }
  await expireAwaitingSourceAiMediaDescriptions(app.db, {
    olderThan: new Date(startedAt.getTime() - AI_MEDIA_AWAITING_SOURCE_TTL_MS),
    now: startedAt,
  });
  const pages = await loadActivePages(app, effective.aiMediaDescribePagePolicies, startedAt);
  if (pages.length === 0) {
    return { ...result, skipped: "no_pages" };
  }
  if (!deps.clientFactory) {
    return { ...result, skipped: "no_client" };
  }
  if (await isAccountStopped(app)) {
    return { ...result, skipped: "account_stopped" };
  }
  if (await reconcileBreakerLatch(app, startedAt)) {
    return { ...result, skipped: "breaker" };
  }

  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const model = effective.aiMediaDescribeModel ?? MEDIA_DESCRIBE_DEFAULT_MODEL;
  const limits = {
    images: Math.max(0, effective.aiMediaDescribeDailyImageLimit ?? 150),
    microUsd: Math.max(0, effective.aiMediaDescribeDailyMicroUsdLimit ?? 1_000_000),
  };
  const limit = Math.max(0, options.limit ?? AI_MEDIA_DESCRIBE_SWEEP_LIMIT);
  for (let index = 0; index < limit; index += 1) {
    const claimAt = clock();
    const leaseToken = randomUUID();
    const row = await claimNextDueAiMediaDescription(app.db, {
      pageIds: pages.map((page) => page.id),
      now: claimAt,
      leaseMs: AI_MEDIA_DESCRIBE_LEASE_MS,
      leaseToken,
      freshSince: new Date(claimAt.getTime() - AI_MEDIA_DESCRIBE_FRESH_MS),
    });
    if (!row) {
      break;
    }
    result.claimed += 1;
    const page = pagesById.get(row.pageId)!;
    let outcome: RowOutcome;
    const progress = { sent: false };
    try {
      outcome = await processRow(app, deps, {
        row,
        leaseToken,
        page,
        clock,
        model,
        limits,
        modelMedia: effective.aiMediaDescribeModelMedia ?? "teasers",
        progress,
      });
    } catch (error) {
      app.logger.warn({
        descriptionId: row.id,
        sent: progress.sent,
        err: error instanceof Error ? { name: error.name, message: error.message.slice(0, 200) } : String(error),
      }, "ai media describe row failed");
      // Once the request may have left, the row is already written ahead as
      // outcome_unknown (or carries its real result): never make it due again.
      if (!progress.sent) {
        const failedAt = clock();
        await finishAiMediaDescription(app.db, {
          id: row.id,
          leaseToken,
          status: row.attempts >= MAX_TRANSIENT_ATTEMPTS ? "failed" : "pending",
          now: failedAt,
          errorCode: "internal_error",
          nextAttemptAt: new Date(failedAt.getTime() + TRANSIENT_RETRY_MS),
        });
      }
      outcome = { status: "internal_error", sent: progress.sent };
    }
    result.outcomes[outcome.status] = (result.outcomes[outcome.status] ?? 0) + 1;
    if (outcome.status === "lease_lost") {
      result.leaseLost = (result.leaseLost ?? 0) + 1;
    }
    if (outcome.sent) {
      result.sent += 1;
    }
    if (outcome.stop) {
      break;
    }
  }
  return result;
}

interface RowOutcome {
  status: string;
  sent: boolean;
  stop?: boolean;
}

async function processRow(
  app: AppContext,
  deps: AiMediaDescribeDeps,
  input: {
    row: AiMediaDescriptionRow;
    /** The claim's ownership token; every settle presents it. */
    leaseToken: string;
    page: ActivePage;
    clock: () => Date;
    model: string;
    limits: { images: number; microUsd: number };
    modelMedia: "teasers" | "teasers+free";
    /** Set before the provider send: a later failure must not make it due. */
    progress: { sent: boolean };
  },
): Promise<RowOutcome> {
  const { row, page, clock } = input;
  const now = clock();
  const finish = async (
    status: Parameters<typeof finishAiMediaDescription>[1]["status"],
    extra: Omit<Parameters<typeof finishAiMediaDescription>[1], "id" | "leaseToken" | "status" | "now"> = {},
  ): Promise<boolean> => {
    const owned = await finishAiMediaDescription(app.db, {
      id: row.id,
      leaseToken: input.leaseToken,
      status,
      now: clock(),
      ...extra,
    });
    if (!owned) {
      app.logger.warn({ descriptionId: row.id, status }, "ai media describe settle skipped: the claim was taken over");
    }
    return owned;
  };

  // Enable boundary: never a message at or before the page's `since`.
  if (!isAfterAiMediaDescribeBoundary(page.policy, row.firstMessageAt)) {
    await finish("skipped_policy", { errorCode: "before_enable_boundary" });
    return { status: "skipped_policy", sent: false };
  }
  // Refusal memory by file, any variant: never sent again.
  if (await isAiMediaRefRefused(app.db, { pageId: row.pageId, platform: row.platform, mediaRef: row.mediaRef })) {
    await finish("refused", { errorCode: "refused_by_media_ref" });
    return { status: "refused_memory", sent: false };
  }
  const source = deps.sources.get(row.platform);
  if (!source) {
    await finish("awaiting_source", {
      errorCode: "no_source_adapter",
      nextAttemptAt: new Date(now.getTime() + AI_MEDIA_AWAITING_SOURCE_TTL_MS),
    });
    return { status: "awaiting_source", sent: false };
  }
  const resolution = await source.resolve(app, row, { now, modelMedia: input.modelMedia });
  switch (resolution.kind) {
    case "awaiting_source":
      await finish("awaiting_source", {
        errorCode: resolution.reason,
        nextAttemptAt: resolution.retryAt ?? new Date(now.getTime() + AI_MEDIA_AWAITING_SOURCE_TTL_MS),
      });
      return { status: "awaiting_source", sent: false };
    case "unavailable":
      await finish("unavailable", { errorCode: resolution.reason });
      return { status: "unavailable", sent: false };
    case "skip":
      await finish("skipped_policy", { errorCode: resolution.reason });
      return { status: "skipped_policy", sent: false };
    case "expand": {
      const link = await getFirstAiMediaDescriptionLink(app.db, row.id);
      if (link) {
        for (const member of resolution.members) {
          await upsertAiMediaDescriptionCandidate(app.db, {
            pageId: row.pageId,
            platform: row.platform,
            mediaRef: member.mediaRef,
            variant: member.variant,
            mediaKind: member.mediaKind,
            senderRole: row.senderRole,
            fanPlatformUserId: row.fanPlatformUserId,
            status: "pending",
            sourceObservationId: row.sourceObservationId,
            link,
            observedAt: now,
            now,
          });
        }
      }
      await finish("skipped_policy", { errorCode: "bundle_expanded", source: resolution.source });
      return { status: "bundle_expanded", sent: false };
    }
    case "url":
      break;
  }

  // Cheap pre-check before any network: a latched breaker or an exhausted
  // day defers without touching the CDN.
  const checkedAt = clock();
  const today = await getAiMediaDescribeDay(app.db, utcDay(checkedAt));
  if (
    today?.breakerTrippedAt
    || (today && (today.imagesReserved >= input.limits.images || today.microUsdReserved >= input.limits.microUsd))
    || input.limits.images === 0
    || input.limits.microUsd === 0
  ) {
    await finish("budget_deferred", { errorCode: "daily_cap", nextAttemptAt: nextUtcMidnight(checkedAt) });
    return { status: "budget_deferred", sent: false, stop: true };
  }

  const download = deps.download ?? ((args) => defaultDownload(app, args));
  const downloaded = await download({ url: resolution.url, pageId: row.pageId });
  if (!downloaded.ok) {
    const transient = downloaded.reason === "timeout" || downloaded.reason === "transport"
      || (downloaded.reason === "http_status" && (downloaded.httpStatus ?? 0) >= 500);
    if (transient && row.attempts < MAX_TRANSIENT_ATTEMPTS) {
      await finish("pending", {
        errorCode: `download_${downloaded.reason}`,
        nextAttemptAt: new Date(clock().getTime() + TRANSIENT_RETRY_MS),
      });
      return { status: "download_retry", sent: false };
    }
    await finish(transient ? "failed" : "unavailable", {
      errorCode: `download_${downloaded.reason}${downloaded.httpStatus ? `_${downloaded.httpStatus}` : ""}`,
      source: resolution.source,
    });
    return { status: transient ? "failed" : "unavailable", sent: false };
  }

  const contentSha256 = sha256Hex(downloaded.bytes);
  if (await isAiMediaContentRefused(app.db, contentSha256)) {
    await finish("refused", { errorCode: "refused_by_content", contentSha256, source: resolution.source });
    return { status: "refused_memory", sent: false };
  }
  const reuse = await findDescribedAiMediaByContent(app.db, contentSha256);
  if (reuse) {
    await finish("described", {
      description: reuse.description,
      model: reuse.model,
      descriptionVersion: reuse.descriptionVersion,
      contentSha256,
      source: resolution.source,
      errorCode: "reused_by_content",
    });
    return { status: "described_reused", sent: false };
  }

  const prepared = await prepareMediaImage(downloaded.bytes);
  if (!prepared.ok) {
    await finish("unavailable", { errorCode: `image_${prepared.reason}`, contentSha256, source: resolution.source });
    return { status: "unavailable", sent: false };
  }
  if (!page.proxy) {
    await finish("pending", { errorCode: "proxy_missing", nextAttemptAt: new Date(clock().getTime() + TRANSIENT_RETRY_MS) });
    return { status: "proxy_missing", sent: false };
  }

  // Atomic reservation of the image and its worst-case cost, BEFORE the send,
  // on the UTC day of the reservation itself (not of the sweep start).
  const reservedAt = clock();
  const day = utcDay(reservedAt);
  const reserveMicroUsd = estimateMediaDescribeReserveMicroUsd(input.model, prepared);
  const reserved = await reserveAiMediaDescribeBudget(app.db, {
    day,
    microUsd: reserveMicroUsd,
    imageLimit: input.limits.images,
    microUsdLimit: input.limits.microUsd,
    now: reservedAt,
  });
  if (!reserved) {
    await finish("budget_deferred", { errorCode: "daily_cap", nextAttemptAt: nextUtcMidnight(reservedAt) });
    return { status: "budget_deferred", sent: false, stop: true };
  }

  const link = await getFirstAiMediaDescriptionLink(app.db, row.id);
  const clientEventId = `media-describe:${row.id}:${row.attempts}`;
  await reserveAiGatewayUsageEvent(app.db, {
    userId: null,
    event: {
      clientEventId,
      feature: AI_MEDIA_DESCRIBE_FEATURE,
      model: input.model,
      pageId: row.pageId,
      provider: "anthropic",
      conversationId: link?.conversationRef ?? null,
      isRegeneration: false,
      reservedAt,
    },
  });

  // Write-ahead: from here the request may reach the provider. A crash, a
  // deploy or a failed settle leaves the row outcome_unknown — terminal, never
  // sent again — instead of a pending row a later sweep would resend. It is
  // also the pre-send ownership check: a claim taken over since never sends.
  const owned = await finish("outcome_unknown", { errorCode: "in_flight", contentSha256, source: resolution.source, model: input.model });
  if (!owned) {
    // Nothing left: the reservation and the ledger row go back as unsent.
    await finalizeAiGatewayUsageEvent(app.db, {
      userId: null,
      event: {
        clientEventId,
        providerResponseId: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costMicroUsd: 0,
        costApproximate: false,
        gatewayOutcome: "failed",
        errorCode: "lease_lost",
        failurePhase: "provider_response",
        providerHttpStatus: null,
        durationMs: 0,
        isCacheHit: false,
        completedAt: clock(),
      },
    });
    await settleAiMediaDescribeBudget(app.db, { day, microUsdDelta: -reserveMicroUsd, releaseImage: true, now: clock() });
    return { status: "lease_lost", sent: false };
  }
  input.progress.sent = true;

  const startedAt = Date.now();
  // The base64 copy lives only inside this call's scope.
  const outcome: MediaDescribeOutcome = await describeMedia({
    model: input.model,
    jpegBase64: prepared.jpeg.toString("base64"),
    proxy: page.proxy,
    clientFactory: deps.clientFactory!,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const completedAt = clock();
  const durationMs = Date.now() - startedAt;

  const settleLedger = async (fields: {
    outcome: "completed" | "failed";
    costMicroUsd: number;
    costApproximate: boolean;
    inputTokens?: number;
    outputTokens?: number;
    providerResponseId?: string | null;
    errorCode?: string | null;
    httpStatus?: number | null;
  }) => finalizeAiGatewayUsageEvent(app.db, {
    userId: null,
    event: {
      clientEventId,
      providerResponseId: fields.providerResponseId ?? null,
      inputTokens: fields.inputTokens ?? 0,
      outputTokens: fields.outputTokens ?? 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costMicroUsd: fields.costMicroUsd,
      costApproximate: fields.costApproximate,
      gatewayOutcome: fields.outcome,
      errorCode: fields.errorCode ?? null,
      failurePhase: fields.outcome === "failed" ? "provider_response" : null,
      providerHttpStatus: fields.httpStatus ?? null,
      durationMs,
      isCacheHit: false,
      completedAt,
    },
  });

  const recordContent = async (usageEventId: number | null, completion: string, status: string, stopReason: string | null) => {
    // Restricted record of the call: the instruction and the result, never
    // the bytes or a URL. fan_ref / conversation_ref make fan erasure reach it.
    await insertAiGenerationContent(app.db, {
      usageEventId,
      generationRef: clientEventId,
      feature: AI_MEDIA_DESCRIBE_FEATURE,
      model: input.model,
      provider: "anthropic",
      userId: null,
      pageId: row.pageId,
      conversationRef: link?.conversationRef ?? null,
      fanRef: link?.fanPlatformUserId ?? row.fanPlatformUserId ?? null,
      promptBlocks: [
        { role: "system", blocks: [{ text: MEDIA_DESCRIBE_SYSTEM_PROMPT }] },
        {
          role: "user",
          blocks: [{ text: "Describe this image." }],
          image: { mediaRef: row.mediaRef, variant: row.variant, contentSha256, width: prepared.width, height: prepared.height },
        },
      ],
      completion,
      params: { status, stopReason, promptVersion: MEDIA_DESCRIBE_PROMPT_VERSION, source: resolution.source },
    });
  };

  switch (outcome.kind) {
    case "described":
    case "refused": {
      const usageEventId = await settleLedger({
        outcome: "completed",
        costMicroUsd: outcome.usage.costMicroUsd,
        costApproximate: false,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        providerResponseId: outcome.usage.providerResponseId,
      });
      await settleAiMediaDescribeBudget(app.db, {
        day,
        microUsdDelta: outcome.usage.costMicroUsd - reserveMicroUsd,
        releaseImage: false,
        now: completedAt,
      });
      await recordContent(
        usageEventId,
        outcome.kind === "described" ? outcome.description : "",
        outcome.kind,
        outcome.stopReason,
      );
      if (outcome.kind === "described") {
        await finish("described", {
          description: outcome.description,
          model: input.model,
          descriptionVersion: MEDIA_DESCRIBE_PROMPT_VERSION,
          contentSha256,
          usageEventId,
          source: resolution.source,
        });
        return { status: "described", sent: true };
      }
      await finish("refused", {
        model: input.model,
        descriptionVersion: MEDIA_DESCRIBE_PROMPT_VERSION,
        contentSha256,
        usageEventId,
        source: resolution.source,
        errorCode: outcome.reason,
      });
      try {
        await evaluateBreakerAfterRefusal(app, completedAt);
      } catch (error) {
        // The refusal is recorded; a breaker/incident hiccup must not undo it.
        app.logger.warn({ descriptionId: row.id, err: error instanceof Error ? error.name : "error" },
          "ai media describer breaker evaluation failed");
      }
      return { status: "refused", sent: true };
    }
    case "outcome_unknown": {
      // The provider may have processed (and billed) it: keep the full
      // reservation, record the estimate as an approximate cost, never retry.
      const usageEventId = await settleLedger({
        outcome: "failed",
        costMicroUsd: reserveMicroUsd,
        costApproximate: true,
        errorCode: outcome.errorCode,
      });
      await finish("outcome_unknown", {
        model: input.model,
        contentSha256,
        usageEventId,
        source: resolution.source,
        errorCode: outcome.errorCode,
      });
      return { status: "outcome_unknown", sent: true };
    }
    case "retryable":
    case "failed":
    case "account_stop": {
      // Proven not processed: nothing billed, the reservation goes back.
      const usageEventId = await settleLedger({
        outcome: "failed",
        costMicroUsd: 0,
        costApproximate: false,
        errorCode: outcome.errorCode,
        httpStatus: outcome.httpStatus,
      });
      await settleAiMediaDescribeBudget(app.db, {
        day,
        microUsdDelta: -reserveMicroUsd,
        releaseImage: true,
        now: completedAt,
      });
      if (outcome.kind === "account_stop") {
        await openCriticalNotificationIncident(app, {
          kind: "ai_provider_failed",
          platformAccountId: null,
          pageLabel: null,
          platform: null,
          subKey: AI_MEDIA_DESCRIBE_ACCOUNT_STOP_SUBKEY,
          errorCode: outcome.errorCode,
          errorSummary: `Anthropic answered ${outcome.httpStatus} to the image describer. Describing is stopped until this incident is resolved by hand.`,
          occurredAt: completedAt,
        });
        await finish("pending", {
          errorCode: outcome.errorCode,
          usageEventId,
          nextAttemptAt: new Date(completedAt.getTime() + TRANSIENT_RETRY_MS),
        });
        return { status: "account_stop", sent: true, stop: true };
      }
      // Plan §6: at most 2 retries, all inside describeMedia; an exhausted
      // transient failure is final (nothing was processed or billed).
      await finish("failed", { errorCode: outcome.errorCode, usageEventId, contentSha256, source: resolution.source });
      return { status: "failed", sent: true };
    }
  }
}
