import {
  getProjectionWatermark,
  insertAiAcceptanceEvent,
  listObservationsByKindAfterId,
  setProjectionWatermark,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { resolveCapturePayloadRow } from "../payload-reader.ts";

// Stage 29 Task 4 — the acceptance feed over the Stage 11 lane.
// desktop.ai_acceptance observations that carry a generation ref project
// into ai_acceptance_events (the restricted class's quality signal).
// Watermark rides projection_seq_watermarks with the account_id=0 sentinel
// (the walk is by OBSERVATION id, not account seq — observations in this
// lane are machine-scoped, not account-scoped). Idempotent by the table's
// (generation_ref, lifecycle, occurred_at) unique + the watermark.
// Correlation is BEST-EFFORT until Stage 31 reports gateway generation ids
// from the desktop (spec assumption 4) — rows without a ref are skipped,
// their facts stay in the journal for a later replay (bump = re-present).

export const AI_ACCEPTANCE_PROJECTION = "ai_acceptance_events";
export const AI_ACCEPTANCE_KIND = "desktop.ai_acceptance";
const PAGE_SIZE = 500;

const LIFECYCLES = new Set(["shown", "copied", "inserted", "edited", "sent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface AiAcceptanceProjectionResult {
  scanned: number;
  projected: number;
  skippedNoRef: number;
}

export async function runAiAcceptanceProjection(
  app: Pick<AppContext, "db" | "logger">,
): Promise<AiAcceptanceProjectionResult> {
  const totals: AiAcceptanceProjectionResult = { scanned: 0, projected: 0, skippedNoRef: 0 };
  let watermark = await getProjectionWatermark(app.db, AI_ACCEPTANCE_PROJECTION, 0);

  for (;;) {
    const rows = await listObservationsByKindAfterId(app.db, {
      kind: AI_ACCEPTANCE_KIND,
      afterId: watermark,
      limit: PAGE_SIZE,
    });
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      totals.scanned += 1;
      // G5 slice 2: the acceptance body comes through the read seam.
      const observation = await resolveCapturePayloadRow(app, "observation", row.id, row);
      const payload = isRecord(observation.payload) ? observation.payload : {};
      // Tolerant field mapping — the desktop's lane predates this consumer.
      const generationRef = asString(payload.generationRef)
        ?? asString(payload.generation_ref)
        ?? asString(payload.requestId)
        ?? asString(payload.request_id);
      const lifecycleRaw = asString(payload.lifecycle) ?? asString(payload.status)
        ?? asString(payload.action);
      const lifecycle = lifecycleRaw !== null && LIFECYCLES.has(lifecycleRaw)
        ? lifecycleRaw as "shown" | "copied" | "inserted" | "edited" | "sent"
        : null;
      if (!generationRef || !lifecycle) {
        totals.skippedNoRef += 1;
        continue;
      }
      const created = await insertAiAcceptanceEvent(app.db, {
        generationRef,
        lifecycle,
        userId: row.actorPrincipalId,
        occurredAt: row.observedAt ?? row.receivedAt,
        sourceObservationId: row.id,
      });
      if (created) {
        totals.projected += 1;
      }
      // Stage 31: the desktop reports 'sent' with an edited flag — the flag
      // maps onto the schema's own 'edited' lifecycle as a companion row.
      if (lifecycle === "sent" && payload.edited === true) {
        const editedRow = await insertAiAcceptanceEvent(app.db, {
          generationRef,
          lifecycle: "edited",
          userId: row.actorPrincipalId,
          occurredAt: row.observedAt ?? row.receivedAt,
          sourceObservationId: row.id,
        });
        if (editedRow) {
          totals.projected += 1;
        }
      }
    }
    watermark = rows[rows.length - 1]!.id;
    await setProjectionWatermark(app.db, AI_ACCEPTANCE_PROJECTION, 0, watermark);
    if (rows.length < PAGE_SIZE) {
      break;
    }
  }
  return totals;
}
