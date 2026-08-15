// The payload read seam (G5 slice 0 — §7 of
// investigations/storage-compaction-architecture-2026-08-11.md).
//
// THE CONTRACT, and it is the whole point of the module:
//
//   * Reads are ENVELOPE-AUTHORIZED. A caller names an observation or a raw
//     capture row — something it already has the right to see — and gets that
//     envelope's body. There is deliberately NO exported "load object id N"
//     entry point: an arbitrary object-id lookup is not a service API, because
//     one payload object may be shared by several envelopes and the object id
//     carries none of the authorization the envelope carries. When the catalog
//     goes live, the lookup by (bucket_month, object_id) stays inside
//     packages/db (repositories/capture-payloads.ts), reachable only through
//     the envelope functions here.
//   * Principal checks stay where they already are — at the route/CLI boundary
//     that decided this caller may read this envelope. The seam does not
//     re-derive authorization from the body it is about to return.
//   * Hot and cold must give ONE contract. Nothing above this module may learn
//     where a payload physically lives; that is the invariant the later cold
//     tier depends on.
//
// TODAY it reads the inline columns, exactly as the existing call sites do —
// observations.payload and sync_raw_payloads.response_payload are still the
// authority and this slice changes no behavior. The later slices add the
// pointer lookup (inline first, object second, then object only) behind these
// same two signatures.
//
// NOT MIGRATED IN THIS SLICE, on purpose — the real inline readers this seam
// will eventually absorb, listed so the next slice does not have to rediscover
// them:
//   * packages/db/src/repositories/ofapi-capture.ts loadOfapiCaptureObservation
//     (partition-exact: id + received_at, joins the request attempt)
//   * packages/db/src/repositories/agent-read.ts findAgentObservationPayload
//     (the purest "one payload by bare id", owner-session only)
//   * packages/db/src/repositories/observations.ts findObservationEnvelopesByIds
//     (batch enrichment for the v2 event stream)
//   * packages/db/src/repositories/domain-events.ts listObservationsForReplay
//     (the bulk replay reader)
//   * apps/runtime/src/services/observations-rejournal.ts (the only true
//     by-primary-key read of sync_raw_payloads.response_payload)
// §6.4 applies to several of them: query-critical `payload->...` predicates
// must move to narrow typed columns BEFORE the inline JSON can go away.

import { sql } from "drizzle-orm";

import type { Database } from "@agency_hub_core/db";

export interface ObservationPayloadRead {
  observationId: number;
  /** The journal row's own received_at — a caller that needs a second,
   *  partition-exact read should use this pair rather than new Date(). */
  receivedAt: Date;
  source: string;
  kind: string;
  /** sha256 of the raw bytes the producer received, as captured. */
  payloadSha256: string;
  payload: unknown;
}

/**
 * One observation's verbatim captured body, by observation id.
 *
 * Partition-spanning by construction (the caller has only the id). Each
 * partition satisfies it from its PK index; callers that already hold the
 * envelope's received_at should keep using the partition-exact repository
 * readers listed above until the pointer slice unifies them here.
 */
export async function loadObservationPayload(
  db: Database,
  observationId: number,
): Promise<ObservationPayloadRead | null> {
  const rows = await db.execute<{
    id: string;
    received_at: Date | string;
    source: string;
    kind: string;
    payload_sha256: string;
    payload: unknown;
  }>(sql`
    select o.id::text as id, o.received_at, o.source, o.kind,
           encode(o.payload_hash, 'hex') as payload_sha256, o.payload
    from observations o
    where o.id = ${observationId}
    limit 1
  `);
  const row = rows.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    observationId: Number(row.id),
    receivedAt: new Date(row.received_at),
    source: row.source,
    kind: row.kind,
    payloadSha256: row.payload_sha256,
    payload: row.payload,
  };
}

export interface RawCaptureBodyRead {
  rawPayloadId: number;
  endpoint: string;
  payloadKind: string;
  capturedAt: Date;
  /** jsonb today; the union widens to Buffer when exact-byte bodies land. */
  body: unknown;
}

/**
 * One raw capture envelope's body, by sync_raw_payloads primary key.
 *
 * `sync_raw_payloads` is unpartitioned and its body column is
 * `response_payload` (jsonb) — see migration 0000; no later migration changed
 * its columns.
 */
export async function loadRawCaptureBody(
  db: Database,
  rawPayloadId: number,
): Promise<RawCaptureBodyRead | null> {
  const rows = await db.execute<{
    id: string;
    endpoint: string;
    payload_kind: string;
    captured_at: Date | string;
    response_payload: unknown;
  }>(sql`
    select rp.id::text as id, rp.endpoint, rp.payload_kind, rp.captured_at,
           rp.response_payload
    from sync_raw_payloads rp
    where rp.id = ${rawPayloadId}
    limit 1
  `);
  const row = rows.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    rawPayloadId: Number(row.id),
    endpoint: row.endpoint,
    payloadKind: row.payload_kind,
    capturedAt: new Date(row.captured_at),
    body: row.response_payload,
  };
}
