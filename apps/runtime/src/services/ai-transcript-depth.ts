import type { AiStreamCapability } from "@agency_hub_core/contracts";
import { AI_TRANSCRIPT_DEEP_MAX_ROWS, ARCHIVE_AI_TRANSCRIPT_MAX_ROWS } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

// chat-extension H-6 — how deep the full Recap reads.
//
// The AI transcript readers stop at 1500 messages. One request reads deeper,
// up to 3000: the full Recap of an OnlyFans chat, asked for by a client that
// advertises `context-v1`, and only once the owner has raised
// `aiTranscriptDeepMaxRows`. Everything else reads what it read before: the
// short Recap (300), Review and Coach (1500), the reply features, a client
// without `context-v1` (a desktop whose deep window is set to 3000 gets 1500,
// as it always did), and Fansly, whose transcript the client sends itself or
// the socket overlay reads.
//
// The owner's value is read in two places, the AI feature stream and the
// bootstrap's `limits.deepMax`, through the one function below: the number a
// client is told is the number the readers are given.

type DepthConfig = Pick<AppConfig, "aiTranscriptDeepMaxRows">;
type DepthApp = Pick<AppContext, "db" | "config" | "logger">;

/**
 * The owner's `aiTranscriptDeepMaxRows` as a row count. Pure.
 *
 * Anything that is not a clear "3000" is the readers' ordinary cap, a missing
 * or unreadable value included: the deeper read is an addition, so the safe
 * answer is the depth every generation had before.
 */
export function aiTranscriptDeepMaxRowsOf(config: DepthConfig): number {
  return config.aiTranscriptDeepMaxRows === String(AI_TRANSCRIPT_DEEP_MAX_ROWS)
    ? AI_TRANSCRIPT_DEEP_MAX_ROWS
    : ARCHIVE_AI_TRANSCRIPT_MAX_ROWS;
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

/** What decides whether a request may read past the ordinary cap. */
export interface AiTranscriptDepthRequest {
  feature: string;
  /** `fan-summary` only: absent = the full Recap. */
  summaryMode: "short" | undefined;
  /** From the feature service's single platform-branch site. */
  isFanslyRequest: boolean;
  /** Parsed `x-kernel-ai-capabilities` of the request. */
  capabilities: ReadonlySet<AiStreamCapability> | undefined;
}

/**
 * Whether the request is the one that may read deep: the full Recap of an
 * OnlyFans chat from a client that advertises `context-v1`. Pure.
 *
 * `context-v1` is what tells a new client from a released one. A released
 * client may already send `messageCount: 3000` for its Recap (the desktop's
 * deep window goes that high) and is served 1500; its Recap must not grow, or
 * change cost, because the hub was updated.
 */
export function mayReadDeepTranscript(request: AiTranscriptDepthRequest): boolean {
  return request.feature === "fan-summary"
    && request.summaryMode !== "short"
    && !request.isFanslyRequest
    && request.capabilities?.has("context-v1") === true;
}

/**
 * The row cap to hand the transcript readers for this request: the owner's
 * value where it is raised and the request may read deep, `undefined` (the
 * readers' own cap) otherwise.
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
  const maxRows = await loadAiTranscriptDeepMaxRows(app);
  return maxRows > ARCHIVE_AI_TRANSCRIPT_MAX_ROWS ? maxRows : undefined;
}
