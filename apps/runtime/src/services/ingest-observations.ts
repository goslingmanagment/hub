// Stage 11: client-capture lane (core side). The desktop's spool-backed
// uploader posts batches of device-held facts; each event becomes ONE
// observation (source 'client_capture') through the Stage 7 key protocol —
// dedup on <principal>:<clientEventId>, so resend-until-2xx is free. Unknown
// kinds are journaled under desktop.unknown:<kind>, never dropped
// (capture-first). Whole-batch atomic: a failure rolls back every claim, so
// the client resends the whole batch (3c contract).

import { createHash } from "node:crypto";

import { findPageByLabel, insertObservation } from "@agency_hub_core/db";

import type {
  IngestObservationsBody,
  IngestObservationsResponse,
} from "../../../../packages/contracts/src/routes.ts";
import type { AppContext } from "../bootstrap.ts";

// Canonicalizer-backed desktop kinds (spec §2). Everything else journals as
// desktop.unknown:<kind>.
export const INGEST_KIND_ALLOWLIST: ReadonlySet<string> = new Set([
  "ai_acceptance",
  "guard_audit",
  "send_audit",
  "ai_spend",
  "credit_spend",
  "data_purge_notice",
]);

export class InvalidIngestEventError extends Error {
  constructor(
    readonly index: number,
    readonly reason: string,
  ) {
    super(`Invalid ingest event at index ${index}: ${reason}`);
    this.name = "InvalidIngestEventError";
  }
}

function parseObservedAt(value: string, index: number): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidIngestEventError(index, "unparseable observedAt");
  }
  return parsed;
}

export async function ingestClientObservations(
  app: AppContext,
  input: {
    principalUserId: number;
    clientVersion: string;
    events: IngestObservationsBody["events"];
  },
): Promise<IngestObservationsResponse> {
  // Validate BEFORE any write so a schema-invalid batch is all-or-nothing 400.
  const observedAts = input.events.map((event, index) =>
    parseObservedAt(event.observedAt, index));

  // Resolve page labels once per batch. An unknown label journals with a null
  // account (capture-first) — the fact is not lost over a label typo.
  const labels = Array.from(new Set(
    input.events.flatMap((event) => (event.pageLabel ? [event.pageLabel] : [])),
  ));
  const pageByLabel = new Map<string, { id: number; platform: string } | null>();
  for (const label of labels) {
    const stored = await findPageByLabel(app.db, label);
    pageByLabel.set(
      label,
      stored ? { id: stored.page.id, platform: stored.page.platform } : null,
    );
  }

  const producer = `desktop@${input.clientVersion}`;

  return app.db.transaction(async (tx) => {
    let accepted = 0;
    let duplicates = 0;
    for (const [index, event] of input.events.entries()) {
      const page = event.pageLabel ? pageByLabel.get(event.pageLabel) ?? null : null;
      const kind = INGEST_KIND_ALLOWLIST.has(event.kind)
        ? `desktop.${event.kind}`
        : `desktop.unknown:${event.kind}`;
      const result = await insertObservation(tx, {
        source: "client_capture",
        producer,
        platform: page?.platform ?? null,
        accountId: page?.id ?? null,
        kind,
        payload: event.payload,
        payloadHash: createHash("sha256").update(JSON.stringify(event.payload)).digest(),
        idempotencyKey: `${input.principalUserId}:${event.clientEventId}`,
        observedAt: observedAts[index],
        actorPrincipalId: input.principalUserId,
      });
      if (result.inserted) {
        accepted += 1;
      } else {
        duplicates += 1;
      }
    }
    return { accepted, duplicates };
  });
}
