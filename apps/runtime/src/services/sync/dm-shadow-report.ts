import { saveFanslyDmShadowReport } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import type { SyncRunTelemetry } from "./observability.ts";
import type { DmShadowState } from "./dm-shadow-state.ts";

export async function persistDmShadowReport(
  app: Pick<AppContext, "db" | "logger">,
  input: {
    telemetry: Pick<SyncRunTelemetry, "addNote">;
    pageId: number;
    generation: number;
    state: DmShadowState;
    status: "running" | "complete" | "incomplete";
    reason?: string;
  },
): Promise<boolean> {
  let persisted = false;
  try {
    await saveFanslyDmShadowReport(app.db, {
      pageId: input.pageId,
      generation: input.generation,
      startedAt: new Date(input.state.startedAtMs),
      pageCount: input.state.pageCount,
      status: input.status,
      reason: input.reason ?? null,
      diagnostics: input.state,
    });
    persisted = true;
  } catch (error) {
    app.logger.warn({
      err: error,
      pageId: input.pageId,
      generation: input.generation,
    }, "DM shadow report could not persist; the full sweep continues");
  }
  // The independent run-event receipt keeps a lost report in the denominator.
  // If both sinks fail, the run still appears as unknown in the coverage read.
  await input.telemetry.addNote("DM shadow report", {
    dmShadow: {
      generation: input.generation,
      status: input.status,
      pageCount: input.state.pageCount,
      reportPersisted: persisted,
      reason: input.reason ?? null,
    },
  });
  return persisted;
}
