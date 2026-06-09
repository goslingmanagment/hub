import {
  type Database,
  type Wb3DialogReadCandidate,
  addLlmUsageDailyTokens,
  insertWb3DialogRead,
  listWb3DialogReadCandidates,
  listWb3PageIds,
  reserveLlmUsageDailyCall,
  setWb3DoNotTouch,
} from "@agency_hub_core/db";
import { toBusinessDate, UTC_TIME_ZONE } from "@agency_hub_core/shared";

import { isClosingMessage } from "../workboard-v2/closing.ts";
import { type DialogReader } from "./dialog-reader.ts";

// Hot path of Dialog Reads (PRD §9): event-driven — only threads with a new
// fan message are candidates (the cache key is the latest fan message), the
// free L1 pre-filter cuts pure closings, the rest goes to Haiku in bulk under
// an adaptive daily cap. Leftovers carry to the next run (the cold Batches
// path is a follow-up). Cap and token accounting reuse the v2 wb_llm_usage_daily
// plumbing — ai_usage_events is keyed to a human user and does not fit jobs.

export const WB3_DIALOG_READ_FEATURE = "wb3-dialog-read";
export const WB3_DIALOG_READ_BULK_SIZE = 15; // PRD §9: bulk 10–20 amortizes the prompt
const CANDIDATE_FETCH_LIMIT = 500;

/**
 * The trailing fan burst (consecutive fan messages at the end of the tail).
 * L1 cuts the read ONLY when every message of the burst is a closing — a burst
 * of "how much?" + "ok" must still reach the model.
 */
export function isL1ClosingTail(context: Array<{ role: "fan" | "creator"; text: string }>): boolean {
  let sawFanMessage = false;
  for (let i = context.length - 1; i >= 0; i -= 1) {
    const message = context[i]!;
    if (message.role !== "fan") {
      break;
    }
    sawFanMessage = true;
    if (!isClosingMessage(message.text)) {
      return false;
    }
  }
  return sawFanMessage;
}

export interface RunWb3DialogReadsResult {
  platformAccountId: number;
  candidates: number;
  l1Cut: number;
  read: number;
  failOpen: number;
  deferred: number;
  stopRequests: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export async function runWb3DialogReadsForPage(
  db: Database,
  reader: DialogReader | null,
  input: {
    platformAccountId: number;
    now?: Date;
    capMin?: number;
    capMax?: number;
    bulkSize?: number;
  },
): Promise<RunWb3DialogReadsResult> {
  const { platformAccountId } = input;
  const now = input.now ?? new Date();
  const bulkSize = input.bulkSize ?? WB3_DIALOG_READ_BULK_SIZE;
  const capMin = input.capMin ?? 50;
  const capMax = input.capMax ?? 400;

  const result: RunWb3DialogReadsResult = {
    platformAccountId,
    candidates: 0,
    l1Cut: 0,
    read: 0,
    failOpen: 0,
    deferred: 0,
    stopRequests: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  const candidates = await listWb3DialogReadCandidates(db, {
    platformAccountId,
    limit: CANDIDATE_FETCH_LIMIT,
  });
  result.candidates = candidates.length;
  if (candidates.length === 0) {
    return result;
  }

  // L1 pre-filter — free verdicts, recorded so the cache skips them forever
  // and the recompute sees intent='closing' for the exact message.
  const toRead: Wb3DialogReadCandidate[] = [];
  for (const candidate of candidates) {
    if (isL1ClosingTail(candidate.context)) {
      await insertWb3DialogRead(db, {
        platformAccountId,
        fanId: candidate.fanId,
        conversationId: candidate.conversationId,
        lastFanMessagePk: candidate.lastFanMessagePk,
        verdict: { needs_reply: false, intent: "closing", temperature: null, readiness: null, gist: null },
        model: "l1",
        createdAt: now,
      });
      result.l1Cut += 1;
    } else {
      toRead.push(candidate);
    }
  }

  if (!reader) {
    // L1-only mode (no API key / LLM disabled): leftovers simply wait.
    result.deferred = toRead.length;
    return result;
  }

  // Adaptive daily cap (v2 formula): half the demand, clamped to [min, max].
  const cap = Math.min(capMax, Math.max(capMin, Math.floor(0.5 * candidates.length)));
  const businessDate = toBusinessDate(now, UTC_TIME_ZONE);

  for (let i = 0; i < toRead.length; i += bulkSize) {
    const chunk = toRead.slice(i, i + bulkSize);
    const reserved = await reserveLlmUsageDailyCall(db, {
      platformAccountId,
      businessDate,
      feature: WB3_DIALOG_READ_FEATURE,
      cap,
    });
    if (!reserved) {
      result.deferred += toRead.length - i;
      break;
    }

    let batch: Awaited<ReturnType<DialogReader["readBatch"]>>;
    try {
      batch = await reader.readBatch(
        chunk.map((candidate, index) => ({
          id: String(index),
          context: candidate.context,
        })),
      );
    } catch {
      // API failure: defer the remainder to the next run — verdicts are never
      // invented (fail-open to needs_reply happens at read time on the board).
      result.deferred += toRead.length - i;
      break;
    }

    result.calls += 1;
    result.inputTokens += batch.inputTokens;
    result.outputTokens += batch.outputTokens;
    await addLlmUsageDailyTokens(db, {
      platformAccountId,
      businessDate,
      feature: WB3_DIALOG_READ_FEATURE,
      inputTokens: batch.inputTokens,
      outputTokens: batch.outputTokens,
    });

    for (const item of batch.results) {
      const candidate = chunk[Number(item.id)];
      if (!candidate) {
        continue;
      }
      await insertWb3DialogRead(db, {
        platformAccountId,
        fanId: candidate.fanId,
        conversationId: candidate.conversationId,
        lastFanMessagePk: candidate.lastFanMessagePk,
        verdict: item.verdict,
        model: item.parsed ? reader.model : "fail-open",
        createdAt: now,
      });
      result.read += 1;
      if (!item.parsed) {
        result.failOpen += 1;
      }
      if (item.verdict.intent === "stop_request") {
        await setWb3DoNotTouch(db, {
          platformAccountId,
          fanId: candidate.fanId,
          doNotTouch: true,
          reason: "stop_request (auto, Dialog Read)",
          now,
        });
        result.stopRequests += 1;
      }
    }
  }

  return result;
}

export async function runWb3DialogReadsAllPages(
  db: Database,
  reader: DialogReader | null,
  input?: { now?: Date; capMin?: number; capMax?: number },
): Promise<{ pages: number; l1Cut: number; read: number; deferred: number; calls: number }> {
  const now = input?.now ?? new Date();
  const pageIds = await listWb3PageIds(db);
  const totals = { pages: pageIds.length, l1Cut: 0, read: 0, deferred: 0, calls: 0 };
  for (const platformAccountId of pageIds) {
    const result = await runWb3DialogReadsForPage(db, reader, {
      platformAccountId,
      now,
      capMin: input?.capMin,
      capMax: input?.capMax,
    });
    totals.l1Cut += result.l1Cut;
    totals.read += result.read;
    totals.deferred += result.deferred;
    totals.calls += result.calls;
  }
  return totals;
}
