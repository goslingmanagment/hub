// Project strictly-accepted capture-before-parse message pages into the
// existing full OF material reducer. This is deliberately project-then-stamp:
// a DB failure leaves the raw observation replayable and never advances the
// serving material by implication.

import {
  listObservationsForReplay,
  markObservationParsed,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { resolveCapturePayloadRow } from "./payload-reader.ts";
import {
  capturePayloadResponse,
  parseOfapiJsonBytes,
  parseStrictOfapiMessagePage,
} from "./ofapi-capture-contract.ts";
import type { ReadthroughReconcileRunResult } from "./ofapi-dm-readthrough.ts";
import { appendOfapiMessageMaterialPage } from "./ofapi-message-material.ts";

export const OFAPI_CAPTURE_MATERIALIZER_VERSION = 2;
const SWEEP_PAGE_SIZE = 100;
const SWEEP_MAX_PAGES = 10;
const SWEEP_ITEM_BUDGET = 5_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function chatIdFromPathname(pathname: unknown) {
  if (typeof pathname !== "string") return null;
  const match = /^\/[^/]+\/chats\/([^/]+)\/messages$/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function emptyResult(): ReadthroughReconcileRunResult {
  return {
    scanned: 0,
    stamped: 0,
    upserts: 0,
    noops: 0,
    drops: 0,
    parseSkips: 0,
    deferred: 0,
    errored: 0,
    conflicts: { text: 0, price: 0, direction: 0, timestamp: 0, reply: 0, media: 0 },
  };
}

function capturedMessagePage(payload: unknown) {
  const envelope = asRecord(payload);
  const request = asRecord(envelope?.request);
  const query = asRecord(request?.query) ?? {};
  const chatId = asString(request?.chatId) ?? chatIdFromPathname(request?.pathname);
  const captured = capturePayloadResponse(payload);
  if (!envelope || !request || !chatId || !captured) {
    return { kind: "rejected" as const, reason: "capture_envelope_invalid" };
  }
  if (captured.status < 200 || captured.status >= 300) {
    return { kind: "noop" as const };
  }
  const decoded = parseOfapiJsonBytes(captured.bodyBytes);
  if (!decoded.validJson) {
    return { kind: "rejected" as const, reason: "invalid_json" };
  }
  const page = parseStrictOfapiMessagePage(decoded.body, {
    requiredBoundaryCursor: asString(query.first_id),
    // Background pagination uses an inclusive cursor after page one. The
    // producer records this parse fact in the captured request so every local
    // replay applies the exact same boundary rule as the job parser.
    boundaryIsDuplicate: request.boundaryIsDuplicate === true,
    expectedBoundarySemantics: request.expectedBoundarySemantics === "inclusive" ||
        request.expectedBoundarySemantics === "exclusive"
      ? request.expectedBoundarySemantics
      : null,
  });
  if (!page.accepted) {
    return { kind: "rejected" as const, reason: page.reason };
  }
  return {
    kind: "accepted" as const,
    chatId,
    items: page.items,
  };
}

export interface OfapiCaptureObservationForMaterialization {
  id: number;
  receivedAt: Date;
  producer: string;
  accountId: number | null;
  payload: unknown;
}

export type OfapiCaptureObservationMaterializationResult =
  | { kind: "stamped_noop"; rejected: boolean }
  | { kind: "materialized"; appended: number; deduped: number; itemCount: number }
  | { kind: "deferred" }
  | { kind: "account_missing" };

/**
 * Replays one immutable capture observation locally. This helper deliberately
 * accepts no vendor client or dispatcher, so recovery cannot create egress.
 */
export async function materializeOfapiCaptureObservation(
  app: Pick<AppContext, "db">,
  row: OfapiCaptureObservationForMaterialization,
  input?: { maxItems?: number },
): Promise<OfapiCaptureObservationMaterializationResult> {
  const page = capturedMessagePage(row.payload);
  if (page.kind !== "accepted") {
    await markObservationParsed(app.db, {
      observationId: row.id,
      receivedAt: row.receivedAt,
      parseVersion: OFAPI_CAPTURE_MATERIALIZER_VERSION,
    });
    return { kind: "stamped_noop", rejected: page.kind === "rejected" };
  }
  if (page.items.length > (input?.maxItems ?? SWEEP_ITEM_BUDGET)) {
    return { kind: "deferred" };
  }
  if (row.accountId === null) {
    return { kind: "account_missing" };
  }
  const appended = await appendOfapiMessageMaterialPage(app.db as Database, {
    accountId: row.accountId,
    observationId: row.id,
    observationReceivedAt: row.receivedAt,
    chatId: page.chatId,
    originClass: row.producer === "ofapi-mirror-background"
      ? "capture_background"
      : "capture_interactive",
    items: page.items,
  });
  await markObservationParsed(app.db, {
    observationId: row.id,
    receivedAt: row.receivedAt,
    parseVersion: OFAPI_CAPTURE_MATERIALIZER_VERSION,
  });
  return {
    kind: "materialized",
    appended: appended.appended,
    deduped: appended.deduped,
    itemCount: page.items.length,
  };
}

export async function runOfapiCaptureMaterialization(
  app: Pick<AppContext, "db" | "config" | "logger">,
): Promise<ReadthroughReconcileRunResult> {
  const totals = emptyResult();
  const budget = { itemsLeft: SWEEP_ITEM_BUDGET };
  let afterId: number | null = null;

  for (let pageIndex = 0; pageIndex < SWEEP_MAX_PAGES; pageIndex += 1) {
    const rows = await listObservationsForReplay(app.db as Database, {
      belowParseVersion: OFAPI_CAPTURE_MATERIALIZER_VERSION,
      source: "ofapi_capture",
      kinds: ["ofapi.chat_messages_page.v1", "ofapi.interactive_response.v1"],
      afterId,
      limit: SWEEP_PAGE_SIZE,
    });
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.id;

    for (const row of rows) {
      totals.scanned += 1;
      try {
        // G5 slice 2: the captured body comes through the read seam.
        const observation = await resolveCapturePayloadRow(app, "observation", row.id, row);
        const result = await materializeOfapiCaptureObservation(app, observation, {
          maxItems: budget.itemsLeft,
        });
        if (result.kind === "deferred") {
          return totals;
        }
        if (result.kind === "account_missing") {
          totals.parseSkips += 1;
          continue;
        }
        if (result.kind === "stamped_noop") {
          totals.stamped += 1;
          if (result.rejected) totals.parseSkips += 1;
          continue;
        }
        budget.itemsLeft -= result.itemCount;
        totals.upserts += result.appended;
        totals.noops += result.deduped;
        totals.stamped += 1;
      } catch (error) {
        totals.errored += 1;
        app.logger.error(
          { error, observationId: row.id },
          "OFAPI capture materialization failed; raw observation remains replayable",
        );
      }
    }
    if (rows.length < SWEEP_PAGE_SIZE) break;
  }
  return totals;
}
