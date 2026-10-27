import type { AiStreamCapability } from "@agency_hub_core/contracts";
import { ARCHIVE_AI_TRANSCRIPT_MAX_ROWS } from "@agency_hub_core/db";
import type { AppConfig, Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

// chat-extension H-6, R20 HF-6: how deep the full Recap, the notes fill,
// Review on Fansly and Coach read.
//
// The AI transcript readers stop at 1500 messages. Four requests read deeper,
// and only from a client that advertises `context-v1` and lets the hub load
// the transcript itself (no `clientContext`):
//
// - the full Recap reads up to the owner's `aiTranscriptDeepMaxRows` (1500,
//   3000 or 5000; one setting for both platforms), on OnlyFans and Fansly;
// - the notes fill (`fan-notes-fill`) reads up to that value, but never fewer
//   than 3000: the Fansly extension 2.10.1 fills its notes from 3000 messages
//   it reads itself, and its successor must not see less of the chat;
// - Review (`chat-review`) on a Fansly page reads up to the owner's value, as
//   the full Recap does (audit 2026-10-20 №6): the Fansly extension 2.13.0
//   reviews the 3000 messages of its deep window, and its successor must not
//   review half of the chat. On OnlyFans Review keeps 1500, the depth the
//   OnlyFans clients have always been served;
// - Coach (`coach-chat`) from a client that also advertises `coach-depth-v1`
//   reads up to the owner's value, on both platforms: the chatter chooses how
//   many messages it reads, up to the whole history the bootstrap's
//   `limits.deepMax` allows (chat-extension, 2026-10-27).
//
// Everything else reads what it read before: the short Recap (300), Coach
// without `coach-depth-v1` (1500: a released extension's Coach keeps its
// depth and its cost), Review on OnlyFans, the reply features, a client
// without `context-v1` (a desktop whose deep window is set to 3000 gets 1500,
// as it always did), and every request that brings its own transcript in
// `clientContext` (the released Fansly extension's, up to 3000 messages),
// which the hub's readers never read.
//
// The owner's value is read in two places, the AI feature stream and the
// bootstrap's `limits.deepMax`, through the one function below: the number a
// client is told is the number the readers are given.

type DepthConfig = Pick<AppConfig, "aiTranscriptDeepMaxRows">;
type DepthApp = Pick<AppContext, "db" | "config" | "logger">;

/** The owner's values above the readers' own cap, and the depth each reads as. */
const RAISED_DEPTHS: ReadonlyMap<unknown, number> = new Map<unknown, number>([["3000", 3000], ["5000", 5000]]);

/** The notes fill never reads fewer messages than this from a context-v1 client
 *  (the depth the released Fansly extension fills its notes from). */
export const FAN_NOTES_FILL_MIN_DEEP_ROWS = 3000;

/**
 * The owner's `aiTranscriptDeepMaxRows` as a row count. Pure.
 *
 * Anything that is not a clear "3000" or "5000" is the readers' ordinary cap,
 * a missing or unreadable value included: the deeper read is an addition, so
 * the safe answer is the depth every generation had before.
 */
export function aiTranscriptDeepMaxRowsOf(config: DepthConfig): number {
  return RAISED_DEPTHS.get(config.aiTranscriptDeepMaxRows) ?? ARCHIVE_AI_TRANSCRIPT_MAX_ROWS;
}

/**
 * The value as a process reads it right now: the owner's live override over
 * the environment. One `config_settings` read. Never throws: a failed read is
 * the ordinary cap, so it can cost a Recap its depth but never the Recap, and
 * never a bootstrap.
 */
export async function loadAiTranscriptDeepMaxRows(app: DepthApp): Promise<number> {
  try {
    return aiTranscriptDeepMaxRowsOf(await loadEffectiveConfig(app.db, app.config));
  } catch (error) {
    app.logger.warn({ err: error }, "ai transcript depth lookup failed; the ordinary cap serves");
    return ARCHIVE_AI_TRANSCRIPT_MAX_ROWS;
  }
}

/** What decides whether a request may read past the ordinary cap. The
 *  platform matters for Review only. */
export interface AiTranscriptDepthRequest {
  feature: string;
  /** The page's platform: Review reads deep on Fansly only. */
  platform: Platform;
  /** `fan-summary` only: absent = the full Recap. */
  summaryMode: "short" | undefined;
  /** Parsed `x-kernel-ai-capabilities` of the request. */
  capabilities: ReadonlySet<AiStreamCapability> | undefined;
}

/**
 * Whether the request is one that may read deep: the full Recap, the notes
 * fill, Review on Fansly or Coach under `coach-depth-v1`, from a client that
 * advertises `context-v1`. Pure.
 *
 * `context-v1` is what tells a new client from a released one. A released
 * client may already send `messageCount: 3000` for its Recap (the desktop's
 * deep window goes that high) and is served 1500; its Recap must not grow, or
 * change cost, because the hub was updated.
 */
export function mayReadDeepTranscript(request: AiTranscriptDepthRequest): boolean {
  if (request.capabilities?.has("context-v1") !== true) {
    return false;
  }
  return (request.feature === "fan-summary" && request.summaryMode !== "short")
    || request.feature === "fan-notes-fill"
    || (request.feature === "chat-review" && request.platform === "fansly")
    || (request.feature === "coach-chat" && request.capabilities?.has("coach-depth-v1") === true);
}

/**
 * The row cap of a deep read for this feature, given the owner's depth. Pure.
 * The full Recap, Review and Coach read the owner's depth; the notes fill
 * reads it too, but never fewer than `FAN_NOTES_FILL_MIN_DEEP_ROWS`.
 */
export function deepTranscriptRowsOf(feature: string, ownerDepth: number): number {
  return feature === "fan-notes-fill" ? Math.max(FAN_NOTES_FILL_MIN_DEEP_ROWS, ownerDepth) : ownerDepth;
}

/**
 * The row cap to hand the transcript readers for this request: its feature's
 * deep depth where the request may read deep and that depth is above the
 * ordinary cap, `undefined` (the readers' own cap) otherwise.
 *
 * The owner's value is read only for a request that could use it, so every
 * other generation makes exactly the reads it made before.
 */
export async function resolveAiTranscriptMaxRows(
  app: DepthApp,
  request: AiTranscriptDepthRequest,
): Promise<number | undefined> {
  if (!mayReadDeepTranscript(request)) {
    return undefined;
  }
  const maxRows = deepTranscriptRowsOf(request.feature, await loadAiTranscriptDeepMaxRows(app));
  return maxRows > ARCHIVE_AI_TRANSCRIPT_MAX_ROWS ? maxRows : undefined;
}
