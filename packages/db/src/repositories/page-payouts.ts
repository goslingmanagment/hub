// WP-F7 payout writers (migration 0141).
//
// The house shape, unchanged from `post-comments.ts` and `fansly-catalog.ts`:
// guarded upsert returning `applied`; the newer OBSERVATION wins with
// `source_account_seq` as the same-instant tie-break, because ledger order is
// APPEND order and a replayed older capture must never overwrite a fresher
// head; `first_observed_at` only ever moves backwards; NULL is never coalesced
// to 0.
//
// TWO THINGS ARE SPECIFIC TO PAYOUTS.
//
// 1. `masked_label` IS THE ONLY THING `metadata` PRODUCES. The migration's
//    CHECK enforces the mask shape, so a canonicalizer regression that let a
//    full email through fails at the INSERT. This file does no masking of its
//    own — one masker, in the canonicalizer, where a fixture can bite it.
//
// 2. A PAYOUT REQUEST IS NOT A ROSTER SUBJECT. `/payments/payout/requests` is
//    OFFSET-PAGED, and a page is not a listing: a roster built from ten rows
//    would mark the other seventy-three missing and the next page would
//    un-mark them. Only METHODS — served as one complete array — get
//    `missing_since`, and `reconcilePagePayoutMethodPresence` is driven by the
//    `payout.method_list_observed` roster event, so the mark is derived from
//    the ledger and survives truncate-and-replay.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

export type PagePayoutPlatform = "fansly" | "onlyfans";

/** `mapped` when the platform code has an observed UI label, `unmapped`
 *  otherwise. The payout status map is ONE code deep and says so. */
export type PayoutStatusConfidence = "mapped" | "unmapped";

export interface PagePayoutLineage {
  observedAt: Date;
  contentHash: string;
  sourceEventId: number;
  sourceObservationId: number;
  sourceAccountSeq: number;
}

function newerWins(table: string) {
  const name = sql.identifier(table);
  return sql`
    excluded.last_observed_at > ${name}.last_observed_at
    or (
      excluded.last_observed_at = ${name}.last_observed_at
      and excluded.source_account_seq > ${name}.source_account_seq
    )
  `;
}

function pick(table: string, column: string): SQL {
  const tableName = sql.identifier(table);
  const columnName = sql.identifier(column);
  return sql`
    case when ${newerWins(table)} then excluded.${columnName} else ${tableName}.${columnName} end
  `;
}

function millsParam(value: bigint | null): SQL {
  return value === null ? sql`null` : sql`${value.toString()}::bigint`;
}

/**
 * ONE bound parameter carrying a Postgres array literal, then cast.
 *
 * Not `sql`${array}`` — drizzle expands an array chunk into a comma-separated
 * parameter LIST, so an EMPTY array expands to nothing and the statement
 * becomes a syntax error at runtime on exactly the common case. An empty roster
 * is not an edge case here: a creator who removes their last payout method
 * serves `[]`, and that is precisely the response `missing_since` exists for.
 */
function textArrayParam(values: readonly string[]): SQL {
  const literal = `{${values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`;
  return sql`${literal}::text[]`;
}

export interface UpsertPagePayoutMethodInput extends PagePayoutLineage {
  pageId: number;
  platform: PagePayoutPlatform;
  methodRef: string;
  /** RAW platform code; NULL when the served value was not an integer. */
  providerId: number | null;
  /** Derived from `providerId` ALONE — never from `metadata`. */
  providerLabel: string;
  type: number | null;
  flags: number | null;
  status: number | null;
  /** OURS, never the provider's. The migration's CHECK pins its shape. */
  maskedLabel: string | null;
  metadataParseOk: boolean;
}

export async function upsertPagePayoutMethod(
  db: Database,
  input: UpsertPagePayoutMethodInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_payout_methods (
      page_id, platform, method_ref, provider_id, provider_label, type, flags,
      status, masked_label, metadata_parse_ok, missing_since,
      first_observed_at, last_observed_at, content_hash,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.methodRef}, ${input.providerId},
      ${input.providerLabel}, ${input.type}, ${input.flags}, ${input.status},
      ${input.maskedLabel}, ${input.metadataParseOk}, null,
      ${input.observedAt}, ${input.observedAt}, ${input.contentHash},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, method_ref) do update set
      platform = ${pick("page_payout_methods", "platform")},
      provider_id = ${pick("page_payout_methods", "provider_id")},
      provider_label = ${pick("page_payout_methods", "provider_label")},
      type = ${pick("page_payout_methods", "type")},
      flags = ${pick("page_payout_methods", "flags")},
      status = ${pick("page_payout_methods", "status")},
      masked_label = ${pick("page_payout_methods", "masked_label")},
      metadata_parse_ok = ${pick("page_payout_methods", "metadata_parse_ok")},
      -- A method that comes BACK is not missing any more. "Gone" is a state,
      -- never a tombstone.
      missing_since = case
        when ${newerWins("page_payout_methods")} then null
        else page_payout_methods.missing_since
      end,
      content_hash = ${pick("page_payout_methods", "content_hash")},
      source_event_id = ${pick("page_payout_methods", "source_event_id")},
      source_observation_id = ${pick("page_payout_methods", "source_observation_id")},
      source_account_seq = ${pick("page_payout_methods", "source_account_seq")},
      first_observed_at =
        least(page_payout_methods.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(page_payout_methods.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

export interface UpsertPagePayoutRequestInput extends PagePayoutLineage {
  pageId: number;
  platform: PagePayoutPlatform;
  payoutRef: string;
  /** MILLS. The wire unit IS mills; there is no scaling in this lane. */
  amountMills: bigint | null;
  methodRef: string | null;
  statusCode: number | null;
  statusLabel: string | null;
  statusConfidence: PayoutStatusConfidence;
  requestedAt: Date | null;
  updatedAtPlatform: Date | null;
  version: number | null;
}

export async function upsertPagePayoutRequest(
  db: Database,
  input: UpsertPagePayoutRequestInput,
): Promise<{ applied: boolean }> {
  const result = await db.execute(sql`
    insert into page_payout_requests (
      page_id, platform, payout_ref, amount_mills, method_ref, status_code,
      status_label, status_confidence, requested_at, updated_at_platform, version,
      first_observed_at, last_observed_at, content_hash,
      source_event_id, source_observation_id, source_account_seq
    ) values (
      ${input.pageId}, ${input.platform}, ${input.payoutRef},
      ${millsParam(input.amountMills)}, ${input.methodRef}, ${input.statusCode},
      ${input.statusLabel}, ${input.statusConfidence}, ${input.requestedAt},
      ${input.updatedAtPlatform}, ${input.version},
      ${input.observedAt}, ${input.observedAt}, ${input.contentHash},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq}
    )
    on conflict (page_id, payout_ref) do update set
      platform = ${pick("page_payout_requests", "platform")},
      amount_mills = ${pick("page_payout_requests", "amount_mills")},
      method_ref = ${pick("page_payout_requests", "method_ref")},
      status_code = ${pick("page_payout_requests", "status_code")},
      status_label = ${pick("page_payout_requests", "status_label")},
      status_confidence = ${pick("page_payout_requests", "status_confidence")},
      requested_at = ${pick("page_payout_requests", "requested_at")},
      updated_at_platform = ${pick("page_payout_requests", "updated_at_platform")},
      version = ${pick("page_payout_requests", "version")},
      content_hash = ${pick("page_payout_requests", "content_hash")},
      source_event_id = ${pick("page_payout_requests", "source_event_id")},
      source_observation_id = ${pick("page_payout_requests", "source_observation_id")},
      source_account_seq = ${pick("page_payout_requests", "source_account_seq")},
      first_observed_at =
        least(page_payout_requests.first_observed_at, excluded.first_observed_at),
      last_observed_at =
        greatest(page_payout_requests.last_observed_at, excluded.last_observed_at),
      updated_at = now()
    returning page_id
  `);
  return { applied: (result.rowCount ?? 0) > 0 };
}

/**
 * Reconcile the page's payout methods against the roster ONE full listing
 * served: mark what it did NOT name, clear the mark on what it did. NEVER a
 * delete (DP 7).
 *
 * `missing_since is null` on the mark is what makes it STICKY: the instant a
 * method FIRST went missing is the interesting one, and a second listing
 * without it must not move the timestamp forward.
 *
 * The CLEAR half is not symmetry for its own sake — a method removed and
 * re-added UNCHANGED emits no row event at all (its content hash is the one it
 * had before), so only the roster can un-mark it.
 */
export async function reconcilePagePayoutMethodPresence(
  db: Database,
  input: {
    pageId: number;
    presentRefs: readonly string[];
    missingSince: Date;
  },
): Promise<{ marked: number; cleared: number }> {
  const present = textArrayParam(input.presentRefs);
  const marked = await db.execute(sql`
    update page_payout_methods
       set missing_since = ${input.missingSince}, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is null
       and not (method_ref = any(${present}))
  `);
  const cleared = await db.execute(sql`
    update page_payout_methods
       set missing_since = null, updated_at = now()
     where page_id = ${input.pageId}
       and missing_since is not null
       and method_ref = any(${present})
  `);
  return { marked: marked.rowCount ?? 0, cleared: cleared.rowCount ?? 0 };
}

/** The lane's progress block: how many methods and payouts this page has
 *  stored, how many methods are marked missing, and the oldest payout the walk
 *  has reached — the floor, read back from the projection rather than trusted
 *  from the cursor. */
export async function countPagePayouts(
  db: Database,
  pageId: number,
): Promise<{
  methods: number;
  methodsMissing: number;
  requests: number;
  oldestRequestedAt: Date | null;
}> {
  const methods = await db.execute<{ total: string; missing: string }>(sql`
    select count(*)::text as total,
           count(*) filter (where missing_since is not null)::text as missing
      from page_payout_methods
     where page_id = ${pageId}
  `);
  const requests = await db.execute<{ total: string; oldest: Date | string | null }>(sql`
    select count(*)::text as total, min(requested_at) as oldest
      from page_payout_requests
     where page_id = ${pageId}
  `);
  const oldest = requests.rows[0]?.oldest ?? null;
  return {
    methods: Number(methods.rows[0]?.total ?? 0),
    methodsMissing: Number(methods.rows[0]?.missing ?? 0),
    requests: Number(requests.rows[0]?.total ?? 0),
    oldestRequestedAt: oldest === null ? null : new Date(oldest),
  };
}
