import {
  deleteExpiredSyncMediaHandoff,
  setSyncWorkSecretParams,
  storeSyncMediaHandoff,
} from "@agency_hub_core/db";
import type { FanslyCdnAnswer } from "@agency_hub_core/fansly";

import { isFanslyCdnUrl, type MediaDownloadFailure } from "../../../services/egress/media-download.ts";
import type { OutcomeDecision } from "../../engine/errors.ts";
import type {
  AnswerApplyInput,
  ApplyResult,
  OutcomeStep,
  RequestPlan,
  ResourceModule,
  StepPlan,
  WorkOutcome,
} from "../../engine/resource.ts";

// `media-download.fetch` (live only, step 3; design S3-04 items 6–7, §5.20;
// owner decision №17): the CDN download of a chat file for the AI describer,
// as requests of the page. The describer (worker) asks for it through
// `enqueueAndWait` with the signed URL sealed in the work's secret
// parameters; the actor admits one hop per step through the page's pacer and
// egress — the signed URL, then at most two redirects, each its own admission
// (plan §2.4). The work's subject is the description (`desc:<id>`).
//
// - 2xx: the bytes go to the transient handoff buffer (`sync_media_handoff`,
//   0234 — not a captured fact; the describer consumes the row), and the work
//   closes with `{handoffId, contentType, bytes}`;
// - 3xx: the redirect's URL (resolved by the transport) must be a Fansly media
//   CDN URL; it replaces the work's secret (sealed, same transaction) and the
//   next hop is due now;
// - anything else is the download's final answer: the work closes with
//   `{failure, httpStatus}` and no breaker — a describer retry is a new work.
//   A 401/403 is the signed URL's (the CDN request carries no session), so it
//   never holds the page (`subjectScopedAuthStatuses`, G16); a 429 holds the
//   page like any 429 (plan §9); a transport error or timeout ends the
//   download without feeding the page's network streak (a CDN outage is not
//   the page's: its REST requests prove or disprove the proxy themselves).
//
// Nothing here writes, logs or returns the URL (design J7).

export const MEDIA_DOWNLOAD_KEY = "media-download.fetch";
/** Redirects followed after the signed URL (the legacy download's limit). */
export const MEDIA_DOWNLOAD_MAX_REDIRECTS = 2;
/** The subject of a download: the describer's row. */
export const MEDIA_DOWNLOAD_SUBJECT_PREFIX = "desc:";

/** What a closed download answers its waiter (`sync_work.result`). */
export type MediaDownloadResultJson =
  | { handoffId: number; contentType: string | null; bytes: number; hops: number }
  | { failure: MediaDownloadFailure | "description_gone" | "secret_missing" | "secret_unreadable" | "bad_subject"; httpStatus: number | null };

export function mediaDownloadSubject(descriptionId: number): string {
  return `${MEDIA_DOWNLOAD_SUBJECT_PREFIX}${descriptionId}`;
}

/** The description id of a download's subject, or null. */
export function descriptionIdOfSubject(subject: string): number | null {
  if (!subject.startsWith(MEDIA_DOWNLOAD_SUBJECT_PREFIX)) return null;
  const id = Number(subject.slice(MEDIA_DOWNLOAD_SUBJECT_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** The hop a work is at (0 = the signed URL). */
export function mediaDownloadHop(cursor: unknown): number {
  const hop = typeof cursor === "object" && cursor !== null ? (cursor as { hop?: unknown }).hop : undefined;
  return typeof hop === "number" && Number.isSafeInteger(hop) && hop >= 0 ? hop : 0;
}

function hopRequest(hop: number): RequestPlan<"cdn.media"> {
  return { spec: "cdn.media", params: { hop } };
}

function closed(result: MediaDownloadResultJson, closeReason: string): WorkOutcome {
  return { satisfiesRevision: true, close: "done", closeReason, result };
}

export interface MediaDownloadPolicy {
  /** Whether a hop may request `url`. Default: a Fansly media CDN URL. */
  urlAllowed(url: URL): boolean;
}

export const FANSLY_CDN_POLICY: MediaDownloadPolicy = { urlAllowed: isFanslyCdnUrl };

/** The download's own account of an outcome `errors.onOutcome` decided. */
export function mediaDownloadOutcome(decision: OutcomeDecision, step: OutcomeStep): OutcomeDecision {
  switch (decision.errorClass) {
    case "subject_terminal":
      // A 401/403 of the signed URL (expired, forged): the describer's answer.
      return {
        ...decision,
        work: {
          action: "close",
          closeReason: `subject_terminal:${step.httpStatus ?? "?"}`,
          result: { failure: "http_status", httpStatus: step.httpStatus } satisfies MediaDownloadResultJson,
        },
      };
    case "network":
      return {
        ...decision,
        pageHold: { action: "keep" },
        networkFailureStreak: null,
        alerts: [],
        work: {
          action: "close",
          closeReason: "download_failed",
          result: { failure: step.outcome === "timeout" ? "timeout" : "transport", httpStatus: null } satisfies MediaDownloadResultJson,
        },
      };
    default:
      return decision;
  }
}

export function createMediaDownloadModule(policy: MediaDownloadPolicy = FANSLY_CDN_POLICY): ResourceModule {
  return {
    async plan(work): Promise<StepPlan> {
      if (descriptionIdOfSubject(work.subject) === null) {
        return { kind: "done", reason: "bad_subject", result: { failure: "bad_subject", httpStatus: null } satisfies MediaDownloadResultJson };
      }
      return { kind: "request", request: hopRequest(mediaDownloadHop(work.cursor)) };
    },

    async apply(): Promise<ApplyResult> {
      throw new Error("media-download.fetch journals nothing: its answer is applied from memory (applyAnswer)");
    },

    async applyAnswer(tx, input: AnswerApplyInput): Promise<ApplyResult> {
      const answer = input.parsed as FanslyCdnAnswer;
      const hop = mediaDownloadHop(input.request.params);
      const status = answer.status;
      const fail = (failure: MediaDownloadFailure | "description_gone", reason = "download_failed"): ApplyResult => ({
        work: closed({ failure, httpStatus: status }, reason),
        followups: [],
        counters: { [`download_${failure}`]: 1 },
      });

      if (status >= 300 && status <= 399) {
        if (hop >= MEDIA_DOWNLOAD_MAX_REDIRECTS) return fail("too_many_redirects");
        if (answer.location === null) return fail("http_status");
        let next: URL;
        try {
          next = new URL(answer.location);
        } catch {
          return fail("redirect_not_allowed");
        }
        if (!policy.urlAllowed(next)) return fail("redirect_not_allowed");
        if (input.secrets === null) throw new Error("media-download.fetch: no secret box to seal the next hop with");
        // The next hop's URL replaces the secret in this transaction; the
        // hop is a new admission, due now.
        const sealed = await setSyncWorkSecretParams(tx, {
          workId: input.work.id,
          generation: input.generation,
          secretParams: input.secrets.seal({ url: next.toString() }),
        });
        if (!sealed) return fail("http_status");
        return {
          work: { satisfiesRevision: false, cursor: { hop: hop + 1 }, nextDueAt: input.now },
          followups: [],
          counters: { download_redirects: 1 },
        };
      }
      if (status < 200 || status > 299) return fail("http_status");
      if (answer.tooLarge) return fail("too_large");
      if (answer.body === null) return fail("http_status");
      const descriptionId = descriptionIdOfSubject(input.work.subject);
      if (descriptionId === null) return fail("http_status");
      // Rows nobody consumed within their day go first (owner decision №17).
      await deleteExpiredSyncMediaHandoff(tx, { pageId: input.pageId, maxBatches: 1 });
      const stored = await storeSyncMediaHandoff(tx, {
        pageId: input.pageId,
        descriptionId,
        workId: input.work.id,
        contentType: answer.contentType,
        bytes: answer.body,
      });
      if (stored === null) return fail("description_gone");
      return {
        work: closed({ handoffId: stored.id, contentType: answer.contentType, bytes: stored.byteCount, hops: hop + 1 }, "downloaded"),
        followups: [],
        counters: { downloads: 1 },
      };
    },

    outcome: mediaDownloadOutcome,
  };
}

export const mediaDownloadModule = createMediaDownloadModule();
