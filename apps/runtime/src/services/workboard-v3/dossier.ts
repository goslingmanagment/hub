import {
  type Database,
  type Wb3Dossier,
  type Wb3DossierCandidate,
  addLlmUsageDailyTokens,
  listWb3DossierBackfillCandidates,
  listWb3DossierRebuildCandidates,
  listWb3FanCoverage,
  listWb3PageIds,
  loadWb3DossierDialogs,
  upsertWb3FanDossier,
} from "@agency_hub_core/db";
import { toBusinessDate, UTC_TIME_ZONE } from "@agency_hub_core/shared";

import {
  type DossierBatchClient,
  type DossierDialog,
  parseDossierResponse,
} from "./dossier-builder.ts";

// workboard-v3.dossier (PRD §8/§9): one-off per-page backfill over every
// spender (and mass_active fans with messages), then nightly refresh for fans
// active that day and threads reaching complete coverage. History builds go
// through the Message Batches API; the poll job finishes them asynchronously.

export const WB3_DOSSIER_FEATURE = "wb3-dossier";
export const WB3_DOSSIER_BULK_SIZE = 4; // PRD §9: 3–5 dialogs per request
const MAX_HISTORY_FANS_PER_RUN = 1000;
const CUSTOM_ID_PREFIX = "wb3d";

/** Deterministic placeholder until deep backfill delivers history (PRD §9). */
export function buildWb3TransactionsOnlyDossier(): Wb3Dossier {
  return {
    gist: "Переписка не сохранена — пока только транзакции",
    interests: [],
    hooks: [],
    ending: null,
    ending_note: null,
    language: null,
  };
}

export function buildWb3DossierCustomId(platformAccountId: number, fanIds: number[]): string {
  return `${CUSTOM_ID_PREFIX}:${platformAccountId}:${fanIds.join(",")}`;
}

export function parseWb3DossierCustomId(
  customId: string,
): { platformAccountId: number; fanIds: number[] } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== CUSTOM_ID_PREFIX) {
    return null;
  }
  const platformAccountId = Number(parts[1]);
  const fanIds = parts[2]!.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!Number.isFinite(platformAccountId) || fanIds.length === 0) {
    return null;
  }
  return { platformAccountId, fanIds };
}

export interface RunWb3DossierResult {
  platformAccountId: number;
  transactionsOnly: number;
  historyQueued: number;
  batchId: string | null;
}

/**
 * Nightly per-page run: writes deterministic transactions_only dossiers
 * directly, and submits history builds (backfill + refresh) as one batch.
 * Returns the batch id for the poll job, or null when nothing was queued.
 */
export async function runWb3DossierJobForPage(
  db: Database,
  batchClient: DossierBatchClient | null,
  input: { platformAccountId: number; now?: Date },
): Promise<RunWb3DossierResult> {
  const { platformAccountId } = input;
  const now = input.now ?? new Date();
  const result: RunWb3DossierResult = {
    platformAccountId,
    transactionsOnly: 0,
    historyQueued: 0,
    batchId: null,
  };

  const backfill = await listWb3DossierBackfillCandidates(db, {
    platformAccountId,
    limit: MAX_HISTORY_FANS_PER_RUN,
  });

  const history: Wb3DossierCandidate[] = [];
  for (const candidate of backfill) {
    if (candidate.hasMessages) {
      history.push(candidate);
    } else {
      await upsertWb3FanDossier(db, {
        platformAccountId,
        fanId: candidate.fanId,
        dossier: buildWb3TransactionsOnlyDossier(),
        source: "transactions_only",
        coverageAtBuild: candidate.coverage,
        model: null,
        builtAt: now,
      });
      result.transactionsOnly += 1;
    }
  }

  if (!batchClient) {
    return result; // LLM off / no key: placeholders only, history waits
  }

  const rebuild = await listWb3DossierRebuildCandidates(db, {
    platformAccountId,
    limit: Math.max(0, MAX_HISTORY_FANS_PER_RUN - history.length),
  });
  const seen = new Set(history.map((c) => c.fanId));
  for (const candidate of rebuild) {
    if (!seen.has(candidate.fanId)) {
      history.push(candidate);
      seen.add(candidate.fanId);
    }
  }
  if (history.length === 0) {
    return result;
  }

  const dialogsByFan = await loadWb3DossierDialogs(db, {
    platformAccountId,
    fanIds: history.map((c) => c.fanId),
  });
  const buildable = history.filter((c) => (dialogsByFan.get(c.fanId)?.length ?? 0) > 0);

  const requests: Array<{ customId: string; dialogs: DossierDialog[] }> = [];
  for (let i = 0; i < buildable.length; i += WB3_DOSSIER_BULK_SIZE) {
    const chunk = buildable.slice(i, i + WB3_DOSSIER_BULK_SIZE);
    requests.push({
      customId: buildWb3DossierCustomId(platformAccountId, chunk.map((c) => c.fanId)),
      dialogs: chunk.map((c) => ({
        id: String(c.fanId),
        messages: (dialogsByFan.get(c.fanId) ?? []).map((m) => ({ role: m.role, text: m.text })),
      })),
    });
  }
  if (requests.length === 0) {
    return result;
  }

  result.batchId = await batchClient.createBatch(requests);
  result.historyQueued = buildable.length;
  return result;
}

export interface ProcessWb3DossierBatchResult {
  done: boolean;
  built: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Poll-job body: drains an ended batch into fan_dossiers (coverage re-read at
 * write time) and accounts tokens. Returns done=false while still processing.
 */
export async function processWb3DossierBatch(
  db: Database,
  batchClient: DossierBatchClient,
  input: { platformAccountId: number; batchId: string; now?: Date },
): Promise<ProcessWb3DossierBatchResult> {
  const { platformAccountId, batchId } = input;
  const now = input.now ?? new Date();
  const batch = await batchClient.getBatchResults(batchId);
  if (batch.status === "in_progress") {
    return { done: false, built: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
  }

  const result: ProcessWb3DossierBatchResult = {
    done: true,
    built: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  for (const item of batch.items) {
    const parsedId = parseWb3DossierCustomId(item.customId);
    if (!parsedId || parsedId.platformAccountId !== platformAccountId) {
      continue;
    }
    result.inputTokens += item.inputTokens;
    result.outputTokens += item.outputTokens;
    if (item.text == null) {
      result.failed += parsedId.fanIds.length;
      continue; // errored request — fans stay dossier-less, retried next nightly
    }
    const dossiers = parseDossierResponse(item.text);
    // Coverage at write time: the batch ran for hours; re-read per fan.
    const coverageRows = await listWb3FanCoverage(db, {
      platformAccountId,
      fanIds: parsedId.fanIds,
    });
    for (const fanId of parsedId.fanIds) {
      const dossier = dossiers.get(String(fanId));
      if (!dossier) {
        result.failed += 1;
        continue;
      }
      await upsertWb3FanDossier(db, {
        platformAccountId,
        fanId,
        dossier,
        source: "history",
        coverageAtBuild: coverageRows.get(fanId) ?? null,
        model: batchClient.model,
        builtAt: now,
      });
      result.built += 1;
    }
  }

  if (result.inputTokens > 0 || result.outputTokens > 0) {
    await addLlmUsageDailyTokens(db, {
      platformAccountId,
      businessDate: toBusinessDate(now, UTC_TIME_ZONE),
      feature: WB3_DOSSIER_FEATURE,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });
  }
  return result;
}

export interface RunWb3DossierAllPagesResult {
  pages: number;
  transactionsOnly: number;
  historyQueued: number;
  batches: Array<{ platformAccountId: number; batchId: string }>;
}

export async function runWb3DossierJobAllPages(
  db: Database,
  batchClient: DossierBatchClient | null,
  input?: { now?: Date },
): Promise<RunWb3DossierAllPagesResult> {
  const now = input?.now ?? new Date();
  const pageIds = await listWb3PageIds(db);
  const totals: RunWb3DossierAllPagesResult = {
    pages: pageIds.length,
    transactionsOnly: 0,
    historyQueued: 0,
    batches: [],
  };
  for (const platformAccountId of pageIds) {
    const result = await runWb3DossierJobForPage(db, batchClient, { platformAccountId, now });
    totals.transactionsOnly += result.transactionsOnly;
    totals.historyQueued += result.historyQueued;
    if (result.batchId) {
      totals.batches.push({ platformAccountId, batchId: result.batchId });
    }
  }
  return totals;
}
