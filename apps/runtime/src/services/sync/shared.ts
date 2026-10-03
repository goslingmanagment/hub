import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import {
  type Database,
  getPageSyncExecutionContext,
  insertObservation,
  insertRawPayload,
  insertSyncRunEvent,
  nextPageSyncObservationSeq,
  recordSyncHttpAttemptResponseBodyBytes,
  updatePageMetadata,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION, type FanslySendSource } from "@agency_hub_core/fansly";
import { type HttpRequestObserver, millsFromInteger } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { ResolvedFanslyPageContext } from "../page-context.ts";
import { buildFanslyMetadata } from "../fansly.ts";
import { noteCaptureCasRefVanished, putCaptureCasPayloads } from "../capture-cas-dual-write.ts";
import type { NormalizedSyncError } from "./errors.ts";
import { SyncPayloadPersistenceError } from "./errors.ts";
import {
  FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX,
  fanslyCdnTokenStripApplies,
  stripFanslySignedCdnTokens,
} from "../../sync/fansly/lib/cdn-tokens.ts";
import {
  JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX,
  JOURNAL_LONE_SURROGATES_REPLACED_NOTE_CODE,
  replaceJournalLoneSurrogates,
} from "../../sync/fansly/lib/journal-lone-surrogates.ts";
import type { SyncRunTelemetry } from "./observability.ts";
import { fanslyPageSendGuard } from "../fansly-send-guard/index.ts";

// Legacy mapper tag for OnlyFans failed-payload rows (kept byte-identical to
// the retired packages/onlyfans export so recorded rows stay comparable).
const ONLYMONSTER_MAPPER_VERSION = "onlymonster-phase3-v1";

export const DAY_MS = 24 * 60 * 60 * 1000;
// Stage 1 retention stand-down: raw payloads are captured business facts and
// nothing deletes sync_raw_payloads on a schedule (the nightly purge was
// removed; tests/retention-deleters.test.ts pins that). `retain_until` is an
// inert envelope stamp kept far-future; the only deleter is the
// owner-initiated erasure.
const RAW_RETENTION_DAYS = 36500;
const DM_RAW_RETENTION_DAYS = 36500;

export function retentionDate(now = new Date()) {
  return new Date(now.getTime() + RAW_RETENTION_DAYS * DAY_MS);
}

export function dmRetentionDate(now = new Date()) {
  return new Date(now.getTime() + DM_RAW_RETENTION_DAYS * DAY_MS);
}

export type RawPayloadInsertInput = Parameters<typeof insertRawPayload>[1];

export async function persistRawPayload(
  db: Database,
  served: RawPayloadInsertInput,
  options?: {
    action?: string;
    /** Producer platform for the observation (Stage 7); callers know theirs. */
    platform?: "fansly" | "onlyfans";
    /** Optional contextual observation envelope. The raw table still stores
     * `responsePayload` verbatim (bar the CDN-token strip below); this is
     * reserved for a quarantined response that a future parser needs request
     * context to replay safely. */
    observationPayload?: unknown;
  },
) {
  // G5 slice 1 (§7 step 1): ONE capture instant for this response, fixed before
  // anything is written, so the raw envelope and its observation can never land
  // in different content-addressed months across a UTC boundary. The observation
  // keeps deriving its own received_at as before — this instant addresses the
  // payload object, it does not restamp the journal.
  const captureInstant = new Date();
  // Owner decision 2026-09-29 (sync/fansly/lib/cdn-tokens.ts): for the named Fansly
  // kinds the one-off CDN signing tokens leave BOTH bodies here, before the
  // catalog write and the payload hash, so the catalog object, the inline raw
  // row and the inline observation all hold the same stripped body and the
  // parity job compares like with like. The served object is never mutated —
  // the lane keeps parsing it after this returns.
  const stripCdnTokens = fanslyCdnTokenStripApplies(options?.platform, served.endpoint);
  const stripped: RawPayloadInsertInput = stripCdnTokens
    ? {
      ...served,
      responsePayload: stripFanslySignedCdnTokens(served.responsePayload),
      mapperVersion: `${served.mapperVersion}${FANSLY_CDN_TOKENS_STRIPPED_MAPPER_SUFFIX}`,
    }
    : served;
  let observedPayload: unknown = options !== undefined
      && Object.hasOwn(options, "observationPayload")
    ? options.observationPayload ?? null
    : served.responsePayload ?? null;
  if (stripCdnTokens) {
    // The ordinary path journals the very object the raw row stores; keep it
    // ONE object so the catalog write below still does a single put.
    observedPayload = observedPayload === served.responsePayload
      ? stripped.responsePayload ?? null
      : stripFanslySignedCdnTokens(observedPayload);
  }
  // Production 2026-09-30 (sync/fansly/lib/journal-lone-surrogates.ts): json/jsonb refuse an
  // unpaired UTF-16 surrogate, so a vendor body holding one is journaled with
  // each replaced by U+FFFD, in both bodies and the catalog object alike. A
  // body without one is the same object, with no copy and no marker; the
  // served object is never mutated.
  const rawSurrogates = replaceJournalLoneSurrogates(stripped.responsePayload);
  const observedSurrogates = observedPayload === stripped.responsePayload
    ? rawSurrogates
    : replaceJournalLoneSurrogates(observedPayload);
  observedPayload = observedSurrogates.value;
  const input: RawPayloadInsertInput = rawSurrogates.replaced === 0
    ? stripped
    : {
      ...stripped,
      responsePayload: rawSurrogates.value,
      mapperVersion: `${stripped.mapperVersion}${JOURNAL_LONE_SURROGATES_REPLACED_MAPPER_SUFFIX}`,
    };
  // Content-addressed copy FIRST, in its own transaction, and it can never
  // throw: on any failure it returns null references and the two inline writes
  // below proceed byte-identically to the pre-slice code. Default-off; a page
  // outside the canary does no work here at all. See capture-cas-dual-write.ts
  // for why this is not folded into the inline transactions.
  const casRefs = await putCaptureCasPayloads(db, {
    pageId: input.platformAccountId,
    captureInstant,
    responsePayload: input.responsePayload,
    observationPayload: observedPayload,
  });

  // G5 slice 3c-1: the inline bodies are skipped ONLY when the catalog write
  // above actually stored them (`pointerOnly` is set on the success return of
  // putCaptureCasPayloads and nowhere else) AND the page is in the pointer-only
  // canary. Every other outcome — canary off, page outside either list, codec
  // refusal, dead connection — leaves this false and both inserts below behave
  // byte-identically to the pre-slice code. The repositories re-check the
  // reference themselves, so the worst a bug here can cost is a duplicated body,
  // never a missing one.
  //
  // DECISION #222 made that re-check load-bearing rather than defensive: each
  // insert proves its reference is still ALIVE under a row lock it holds until
  // it commits, and an object an erasure took in the meantime is dropped in
  // favour of the inline body. So `omitInlinePayload` is a REQUEST here and a
  // decision there, which is why the counter below is fed from the receipts
  // rather than from anything this function knows.
  const omitInlinePayload = casRefs.pointerOnly;

  let rawPayload;
  try {
    rawPayload = await insertRawPayload(db, {
      ...input,
      payloadRef: casRefs.raw,
      omitInlinePayload,
    });
  } catch (error) {
    throw new SyncPayloadPersistenceError({
      endpoint: input.endpoint,
      action: options?.action ?? `inserting ${input.endpoint} raw payload`,
      cause: error,
    });
  }

  // Stage 7 producer 2: every fetched page is also an observation. As loud as
  // the raw insert — a failed capture fails the chunk (which retries); never a
  // silent drop. The idempotency key is unique per fetch by construction
  // (page:stream:run:requestSeq.fetchN — the fetch counter lives on the
  // executor context, so multi-page walks journal every page; continuation
  // chunks share requestSeq and restart fetchN, so an in-context caller MUST
  // pass syncRunId or its key repeats across chunks); outside the
  // page-executor context a UUID takes its place — retries then produce extra
  // observations with distinct keys, which the Stage 7 reconciliation expects.
  const context = getPageSyncExecutionContext();
  const stream = context?.stream ?? null;
  const platform = options?.platform ?? null;
  // WP-F1: the observation id is returned to the caller so a capture that
  // discovers a FLOOR can point `capture_coverage.proof_observation_id` at the
  // exact journaled response that proves it. An empty window is the evidence,
  // and evidence with no address is a claim.
  let journalledObservationId!: number | null;
  // `observedPayload` is hoisted above the CAS write — normalized there so an
  // adapter (or test stub) handing back undefined still hashes and journals
  // deterministically as JSON null, and so the catalog stores exactly the value
  // this insert stores inline. The hash below is taken from that OBJECT, never
  // from the column, so a pointer-only row carries the same payload_hash it
  // would have carried with its body inline — which is why 0128 leaves
  // payload_hash NOT NULL.
  if (rawPayload.payloadRefVanished) {
    noteCaptureCasRefVanished();
  }

  try {
    const journalled = await insertObservation(db, {
      source: "pull",
      producer: `sync:${platform ?? "unknown"}:${stream ?? input.endpoint}`,
      platform,
      accountId: input.platformAccountId,
      kind: input.endpoint,
      payload: observedPayload,
      payloadHash: createHash("sha256").update(JSON.stringify(observedPayload)).digest(),
      idempotencyKey: [
        input.platformAccountId,
        stream ?? input.endpoint,
        input.syncRunId ?? "norun",
        nextPageSyncObservationSeq() ?? randomUUID(),
      ].join(":"),
      payloadRef: casRefs.observation,
      omitInlinePayload,
    });
    journalledObservationId = journalled.observationId;
    if (journalled.payloadRefVanished) {
      noteCaptureCasRefVanished();
    }
  } catch (error) {
    throw new SyncPayloadPersistenceError({
      endpoint: input.endpoint,
      action: `inserting ${input.endpoint} observation`,
      cause: error,
    });
  }

  // An info note on the run, never an anomaly: the capture succeeded, and the
  // mapper suffix on the raw row stays the durable marker for a capture that
  // ran outside one. Like the measurement below, it can never fail a capture.
  const replacedSurrogates = rawSurrogates.replaced + observedSurrogates.replaced;
  if (replacedSurrogates > 0 && input.syncRunId != null && stream !== null && platform) {
    try {
      await insertSyncRunEvent(db, {
        syncRunId: input.syncRunId,
        platformAccountId: input.platformAccountId,
        provider: platform,
        stream,
        eventType: "note",
        severity: "info",
        message: "Unpaired UTF-16 surrogates in the response were journaled as U+FFFD",
        details: {
          code: JOURNAL_LONE_SURROGATES_REPLACED_NOTE_CODE,
          endpoint: input.endpoint,
          rawPayloadId: rawPayload.id,
          observationId: journalledObservationId,
          rawPayloadReplacements: rawSurrogates.replaced,
          observationReplacements: observedSurrogates.replaced,
        },
      });
    } catch {
      // A missing note is worth strictly less than the capture it describes.
    }
  }

  // [E2] measurement, F0(a). Byte length of the payload OBJECT this capture
  // journaled — the real disk-trend input for the widened Fansly capture. It
  // is instrumentation and NOTHING else: no ceiling, no deferral, no config
  // key ([A20] deleted all three), and a failure here can never fail a capture.
  if (input.syncRunId != null && stream !== null) {
    try {
      await recordSyncHttpAttemptResponseBodyBytes(db, {
        syncRunId: input.syncRunId,
        platformAccountId: input.platformAccountId,
        stream,
        responseBodyBytes: Buffer.byteLength(
          JSON.stringify(input.responsePayload ?? null),
          "utf8",
        ),
      });
    } catch {
      // Measurement only — a missing sample is worth strictly less than the
      // capture it would have failed.
    }
  }

  // `observationPayload` is the body the observation holds, by reference: the
  // served object itself, unless the CDN strip or the surrogate replacement
  // above made a copy. A caller that hashes or points into the journaled body
  // (the DM shadow witness) takes it from here, not from what it served.
  return { ...rawPayload, observationId: journalledObservationId, observationPayload: observedPayload };
}

/** Fansly-only since Stage 18: the OnlyMonster metadata refresh is retired
 * (OnlyFans page identity is static post-onboarding; counts ride the OFAPI
 * audience sweep). */
export async function refreshPageMetadata(
  app: AppContext,
  pageContext: ResolvedFanslyPageContext,
  syncType?: "light" | "followers",
  telemetry?: SyncRunTelemetry,
  requestObserver?: HttpRequestObserver | null,
  /** Who sends, for the page's send guard journal. A sync chunk (with
   *  telemetry) by default; the API and CLI page checks name themselves. */
  sendSource: FanslySendSource = telemetry ? "sync_stream" : "account_me_api",
) {
  {
    const accountMe = await app.adapter.getAccountMe({
      session: pageContext.session,
      proxy: pageContext.proxy,
      egressKey: pageContext.egressKey,
      requestObserver: requestObserver ?? telemetry?.getRequestObserver() ?? null,
      sendGuard: fanslyPageSendGuard(app, pageContext.page.id, sendSource),
    });
    await persistRawPayload(app.db, {
      platformAccountId: pageContext.page.id,
      // The run id keeps the observation key unique per chunk: continuation
      // chunks of one request share requestSeq and restart the fetch counter,
      // so without it followers_reconcile's terminal account_me collided with
      // the sweep-start one and was silently dropped by the key claim.
      syncRunId: telemetry?.metadata.runId ?? null,
      endpoint: "account_me",
      requestParams: {},
      responsePayload: accountMe.raw,
      mapperVersion: FANSLY_MAPPER_VERSION,
      payloadKind: "mapping_critical",
      retainUntil: retentionDate(),
    }, {
      action: "inserting account_me raw payload",
      platform: "fansly",
    });

    await updatePageMetadata(app.db, pageContext.page.id, {
      platformAccountIdValue: accountMe.parsed.account.id,
      username: accountMe.parsed.account.username,
      displayName: accountMe.parsed.account.displayName,
      followerCount: accountMe.parsed.account.followCount,
      // This write always advances last_verified_at, which the stated-empty
      // subscribers rule reads as the counter's freshness. A counter missing
      // from the response is cleared, not skipped (Drizzle drops undefined),
      // so the last 0 cannot keep looking fresh.
      subscriberCount: typeof accountMe.parsed.account.subscriberCount === "number"
        ? accountMe.parsed.account.subscriberCount
        : null,
      earningsBalanceMills: millsFromInteger(accountMe.parsed.account.earningsWallet?.balance ?? 0),
      metadata: buildFanslyMetadata(accountMe.parsed.account, pageContext.page.metadata),
      ...(syncType ? { syncType } : {}),
    });

    return accountMe;
  }
}

export async function persistFailedSyncPayload(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    platformAccountId: number;
    syncRunId: number;
    endpoint: string;
    platform: "fansly" | "onlyfans";
    failure: NormalizedSyncError;
  },
) {
  try {
    await insertRawPayload(app.db, {
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId,
      endpoint: input.endpoint,
      requestParams: {},
      responsePayload: { error: input.failure.error },
      mapperVersion: input.platform === "fansly"
        ? FANSLY_MAPPER_VERSION
        : ONLYMONSTER_MAPPER_VERSION,
      payloadKind: "failed",
      errorMessage: input.failure.summary,
      retainUntil: retentionDate(),
    });
    // Stage 7 producer 2: failed fetches are pull facts too. Best-effort like
    // the raw insert above — this path already runs inside error handling.
    const failedPayload = { error: input.failure.error, summary: input.failure.summary };
    await insertObservation(app.db, {
      source: "pull",
      producer: `sync:${input.platform}:${getPageSyncExecutionContext()?.stream ?? input.endpoint}`,
      platform: input.platform,
      accountId: input.platformAccountId,
      kind: `${input.endpoint}:failed`,
      payload: failedPayload,
      payloadHash: createHash("sha256").update(JSON.stringify(failedPayload)).digest(),
      idempotencyKey: [
        input.platformAccountId,
        `${input.endpoint}:failed`,
        input.syncRunId,
        nextPageSyncObservationSeq() ?? randomUUID(),
      ].join(":"),
    });
  } catch (error) {
    app.logger.warn(
      {
        syncRunId: input.syncRunId,
        platformAccountId: input.platformAccountId,
        endpoint: input.endpoint,
        err: error,
      },
      "Failed to persist failed sync payload; continuing",
    );
  }
}
