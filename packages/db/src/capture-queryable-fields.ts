// G5 slice 3a — the QUERYABLE FIELDS (§6.4 of
// investigations/storage-compaction-architecture-2026-08-11.md).
//
// WHY THIS MODULE EXISTS. Slices 0–2 put a content-addressed copy of every
// capture body on disk and taught the readers that SERVE a body to fetch it
// from there. What they could not touch is the other kind of read: the SQL
// sites where PostgreSQL digs INSIDE `observations.payload` /
// `sync_raw_payloads.response_payload` and returns a FIELD, never the body.
// Those sites cannot go through the read seam — there is no body to route —
// and every one of them breaks the instant the inline column stops being
// written. So each query-critical field gets a narrow typed column of its own,
// populated at write time from the SAME parsed object the inline column
// receives, and the SQL falls back to the inline extraction only for rows
// written before this slice.
//
// THE DERIVATION LIVES IN packages/db, NOT IN THE PRODUCERS. Every observation
// in the system is written by exactly one function (repositories/observations.ts
// insertObservation) and every raw capture by exactly one other
// (repositories/sync.ts insertRawPayload). Deriving here — one call, inside the
// same INSERT — makes it structurally impossible for a typed column to disagree
// with the payload it was derived from, and it covers producers this slice
// never looked at (the re-journal path, tests, a future harvest lane) for free.
//
// FIDELITY, and why a TypeScript mirror of `->>` is exact enough. The inline
// column is written as `JSON.stringify(payload)` of the very object handed to
// these functions, so the number that reaches PostgreSQL is already the one
// `JSON.stringify` produced — there is no original wire literal left for
// `payload->>'x'` to preserve that this code could lose. The two renderings
// therefore agree for every string, boolean and ordinary number. They can
// differ in exactly two pathological places, both documented on the helper
// below, and neither one is reachable by the values these columns exist to
// find (machine uuids, OFAPI transaction ids, dollar amounts).

/**
 * The text PostgreSQL's `->>` operator would return for a JSON member.
 *
 * `->>` yields SQL NULL for a missing key AND for a JSON null (the two are
 * indistinguishable through it, which is why the columns below are nullable),
 * the unquoted characters of a string, and the rendered text of any other
 * scalar.
 *
 * NON-SCALARS RETURN NULL HERE, deliberately. `->>` renders an object or array
 * as PostgreSQL's own jsonb text (`{"a": 1}`, with the space), which
 * `JSON.stringify` does not reproduce — so a faithful mirror is impossible.
 * Returning null instead of a near-miss keeps the column honestly empty, and
 * costs nothing real: these columns serve equality against a machine uuid or a
 * transaction id, and a caller that passed a rendered JSON document as one of
 * those would be looking for a row that has never existed.
 *
 * Very large or very small numbers are the second difference: `JSON.stringify`
 * switches to exponent notation (`1e+21`) where jsonb's numeric renders every
 * digit. Harvest amounts are dollars; no reachable value crosses that line.
 */
export function jsonMemberText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : null;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return null;
}

function memberOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/**
 * The typed projection of one observation payload.
 *
 * Every member is null for the overwhelming majority of observations: these
 * columns exist for the Stage 12 harvest lane and nothing else. A nullable
 * column that a row does not set costs that row nothing — `observations` already
 * carries a null bitmap wide enough for them.
 */
export interface ObservationQueryableFields {
  /** `payload->>'machineId'` — the harvest reconciliation lookup key. */
  harvestMachineId: string | null;
  /** `payload->'row'->>'tx_id'` — probed against `transactions.transaction_id`. */
  harvestTxId: string | null;
  /** `payload->'row'->>'amount'` — report-only, kept text so the residue report
   *  reproduces what the extraction produced rather than reinterpreting it. */
  harvestTxAmount: string | null;
  /** `payload->'row'->>'created_at'` — report-only, same reasoning. */
  harvestTxCreatedAt: string | null;
}

export const EMPTY_OBSERVATION_QUERYABLE_FIELDS: ObservationQueryableFields = {
  harvestMachineId: null,
  harvestTxId: null,
  harvestTxAmount: null,
  harvestTxCreatedAt: null,
};

/** Mirrors the `producer like 'desktop-harvest@%'` half of every harvest
 *  predicate in repositories/observations.ts. */
const HARVEST_PRODUCER_PREFIX = "desktop-harvest@";
/** Mirrors `kind like 'harvest.%'`. */
const HARVEST_KIND_PREFIX = "harvest.";
/** The one harvest kind whose `row` members are extracted (the residue report). */
const HARVEST_TRANSACTION_KIND = "harvest.fan_transactions";

/**
 * Derives the typed columns for one observation.
 *
 * The gate is the PRODUCER + KIND pair the harvest queries already filter on,
 * and it is deliberately a SUPERSET of any single query: the column states what
 * the payload carries, and each query keeps its own `source` / exact-kind
 * clause. Populating on a narrower rule than the queries read on would leave a
 * row findable through the inline fallback and invisible without it — a
 * difference that would only surface the day the fallback is removed.
 */
export function deriveObservationQueryableFields(input: {
  producer: string;
  kind: string;
  payload: unknown;
}): ObservationQueryableFields {
  if (
    !input.producer.startsWith(HARVEST_PRODUCER_PREFIX) ||
    !input.kind.startsWith(HARVEST_KIND_PREFIX)
  ) {
    return EMPTY_OBSERVATION_QUERYABLE_FIELDS;
  }

  const harvestMachineId = jsonMemberText(memberOf(input.payload, "machineId"));
  if (input.kind !== HARVEST_TRANSACTION_KIND) {
    return { ...EMPTY_OBSERVATION_QUERYABLE_FIELDS, harvestMachineId };
  }

  const row = memberOf(input.payload, "row");
  return {
    harvestMachineId,
    harvestTxId: jsonMemberText(memberOf(row, "tx_id")),
    harvestTxAmount: jsonMemberText(memberOf(row, "amount")),
    harvestTxCreatedAt: jsonMemberText(memberOf(row, "created_at")),
  };
}

/**
 * The `{tips}` slice of a Fansly DM capture, or `undefined` when this row is not
 * one (leave the column NULL).
 *
 * WHY A STORED SLICE AND NOT AN APP-SIDE NARROWING. The replay reader
 * (repositories/transaction-tip-contexts.ts) narrows to `{tips}` IN SQL
 * precisely so a keyset walk over 500 retained DM pages does not drag 500 whole
 * message bodies across the wire and through `JSON.parse`. Reading the body
 * through the payload seam and narrowing in TypeScript would pay exactly that
 * cost — the opposite of the narrowing's purpose. A slice written once at
 * capture time keeps the walk cheap AND survives the inline body's removal.
 *
 * SHAPE-EXACT with `jsonb_build_object('tips', response_payload -> 'tips')`: a
 * missing `tips` key and an explicit `tips: null` both become `{"tips": null}`
 * there, so both become `{ tips: null }` here. The parser reads that as an
 * ABSENT sidecar, which is what it already reads today.
 *
 * A NON-OBJECT response leaves the column null. Today's `CASE` hands such a
 * payload back whole; storing a copy of it would duplicate a body to preserve a
 * value the only consumer cannot use — a non-record response and SQL NULL are
 * both `envelopeStatus: "invalid"` to the sidecar parser
 * (services/sync/fansly-tip-contexts.ts). The fallback keeps historical rows on
 * the old path either way.
 */
export function deriveRawPayloadTipsSlice(input: {
  endpoint: string;
  payloadKind: string;
  responsePayload: unknown;
}): { tips: unknown } | undefined {
  if (input.endpoint !== "dm_messages" || input.payloadKind !== "dm_messages") {
    return undefined;
  }
  const payload = input.responsePayload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const tips = (payload as Record<string, unknown>).tips;
  return { tips: tips === undefined ? null : tips };
}
