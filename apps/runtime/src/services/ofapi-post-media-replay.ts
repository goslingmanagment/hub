// Replay previously MATERIALIZED post captures only. Jobs retain ownership of
// rejected/in-flight pages. The ledger accepted set preserves stop/overlap
// boundaries even for old verify_head envelopes lacking their stop marker.
import {
  appendProjectionOnlyDomainEvents, listDetachedPartitionsHoldingAccount,
  listObservationsForReplay, listObservedPostRefsForCapture, markObservationParsed,
} from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { clampDraftOccurredAt } from "./canonicalize-driver.ts";
import { buildOnlyFansPostDrafts } from "./canonicalize/onlyfans-post-media.ts";
import { POSTS_CANONICALIZER_VERSION } from "./canonicalize/posts.ts";
import { capturePayloadResponse, parseOfapiJsonBytes, parseStrictOfapiPostPage } from "./ofapi-capture-contract.ts";
import { resolveCapturePayloadRow } from "./payload-reader.ts";

let afterId: number | null = null;
export async function runOfapiPostMediaReplay(app: Pick<AppContext, "db" | "config" | "logger">) {
  const totals = { scanned: 0, stamped: 0, errored: 0 };
  const rows = await listObservationsForReplay(app.db, { source: "ofapi_capture", kinds: ["ofapi.posts_page.v1"],
    atLeastParseVersion: 7, belowParseVersion: POSTS_CANONICALIZER_VERSION, afterId, limit: 10 });
  afterId = rows.length === 10 ? rows[rows.length - 1]!.id : null;
  const checkedPages = new Set<number>();
  for (const row of rows) {
    totals.scanned += 1;
    try {
      if (row.accountId === null || row.platform !== "onlyfans") throw new Error("OF post capture has no mapped page");
      if (!checkedPages.has(row.accountId) && (await listDetachedPartitionsHoldingAccount(app.db, row.accountId)).length > 0) {
        throw new Error("OF post media replay requires the complete attached event ledger");
      }
      checkedPages.add(row.accountId);
      const observation = await resolveCapturePayloadRow(app, "observation", row.id, row);
      const response = capturePayloadResponse(observation.payload);
      if (!response || response.status < 200 || response.status >= 300) throw new Error("Materialized OF capture body is unavailable");
      const decoded = parseOfapiJsonBytes(response.bodyBytes);
      if (!decoded.validJson) throw new Error("Materialized OF capture is not JSON");
      const parsed = parseStrictOfapiPostPage(decoded.body, { requiredOverlapId: null, stopAtPostId: null });
      if (!parsed.accepted) throw new Error(`Materialized OF capture changed shape: ${parsed.reason}`);
      const accepted = new Set(await listObservedPostRefsForCapture(app.db, row.accountId, row.id));
      const items = parsed.items.filter(item => accepted.has(String(item.id)));
      if (items.length !== accepted.size) throw new Error("OF accepted post ids cannot be reproduced from retained capture");
      const drafts = buildOnlyFansPostDrafts(observation, items).map(draft => ({
        ...clampDraftOccurredAt(draft, observation.receivedAt, new Date()), observationId: row.id,
      }));
      await appendProjectionOnlyDomainEvents(app.db, row.accountId, drafts, {
        observationId: row.id, occurredAt: row.receivedAt,
        dedupKey: `projection-checkpoint:ofapi-posts:v${POSTS_CANONICALIZER_VERSION}:${row.id}`,
        data: { profile: "creator_posts_v1", originClass: "ofapi_capture" },
      });
      await markObservationParsed(app.db, { observationId: row.id, receivedAt: row.receivedAt, parseVersion: POSTS_CANONICALIZER_VERSION });
      totals.stamped += 1;
    } catch (error) {
      totals.errored += 1;
      app.logger.error({ error, observationId: row.id }, "OF post media replay failed; capture remains replayable");
    }
  }
  return totals;
}
