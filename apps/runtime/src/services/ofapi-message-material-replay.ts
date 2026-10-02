import { sql } from "drizzle-orm";

import { listObservationsForReplay, type Database } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  capturedMessagePage,
  materializeOfapiCaptureObservation,
  OFAPI_CAPTURE_MATERIALIZER_VERSION,
} from "./ofapi-capture-materialization.ts";
import { resolveCapturePayloadRow } from "./payload-reader.ts";

export interface OfapiMessageMaterialReplayOptions {
  pageId: number;
  /** Observation receipt window, inclusive from / exclusive to. */
  from: Date;
  to: Date;
  limit?: number;
  afterId?: number;
  execute?: boolean;
}

/** Bounded local repair of v2 captures, including valid ascending tails v2
 * stamped without materializing. No vendor client, coverage claim, watermark
 * reset or parse-version downgrade. A transient failure stops before advancing
 * the resume cursor; already committed rows are idempotent on retry. */
export async function replayOfapiMessageMaterial(
  app: Pick<AppContext, "db" | "logger">,
  options: OfapiMessageMaterialReplayOptions,
) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(options.pageId) || options.pageId <= 0
    || !Number.isFinite(options.from.getTime()) || !Number.isFinite(options.to.getTime())
    || options.from >= options.to || !Number.isInteger(limit) || limit < 1 || limit > 500
    || (options.afterId !== undefined && (!Number.isSafeInteger(options.afterId) || options.afterId < 0))) {
    throw new Error("Replay requires one page, a finite from/to window, and a limit between 1 and 500");
  }
  const pass = async (db: Database) => {
    const seam = { db, logger: app.logger };
    const rows = await listObservationsForReplay(db, {
      belowParseVersion: OFAPI_CAPTURE_MATERIALIZER_VERSION,
      source: "ofapi_capture",
      kinds: ["ofapi.interactive_response.v1"],
      accountId: options.pageId,
      from: options.from,
      to: options.to,
      afterId: options.afterId ?? null,
      limit: limit + 1,
    });
    const result = {
      dryRun: options.execute !== true,
      pageId: options.pageId,
      from: options.from.toISOString(),
      to: options.to.toISOString(),
      scanned: 0,
      candidates: 0,
      candidateItems: 0,
      materialized: 0,
      appended: 0,
      deduped: 0,
      dropped: 0,
      skipped: {} as Record<string, number>,
      stoppedAt: null as number | null,
      nextAfterId: options.afterId ?? null,
      hasMore: rows.length > limit,
    };
    for (const row of rows.slice(0, limit)) {
      result.scanned += 1;
      try {
        const observation = await resolveCapturePayloadRow(seam, "observation", row.id, row);
        const page = capturedMessagePage(observation.payload);
        if (page.kind !== "accepted") {
          const reason = page.kind === "rejected" ? page.reason : "http_not_successful";
          result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
        } else {
          result.candidates += 1;
          result.candidateItems += page.items.length;
          if (options.execute === true) {
            const applied = await materializeOfapiCaptureObservation(seam, observation);
            if (applied.kind !== "materialized") {
              throw new Error(`Material replay deferred: ${applied.kind}`);
            }
            result.materialized += 1;
            result.appended += applied.appended;
            result.deduped += applied.deduped;
            result.dropped += applied.dropped;
          }
        }
        result.nextAfterId = row.id;
      } catch (error) {
        result.stoppedAt = row.id;
        result.hasMore = true;
        app.logger.error({ error, observationId: row.id },
          "OFAPI local material replay stopped; retry from the returned cursor");
        break;
      }
    }
    return result;
  };
  if (options.execute === true) return pass(app.db);
  return app.db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return pass(tx as unknown as Database);
  });
}
