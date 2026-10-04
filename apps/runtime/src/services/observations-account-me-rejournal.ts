// J4 — the one-off, append-only repair for `account_me` captures that reached
// sync_raw_payloads but never became an observation
// (`observations:rejournal-account-me`).
//
// Until J4 the legacy page metadata refresh (`refreshPageMetadata`, deleted at
// step 4) journaled account_me without a sync run id, so
// its observation key was `page:stream:norun:requestSeq.fetchN`. Continuation
// chunks of one request share requestSeq and restart fetchN, so when
// followers_reconcile ran its closing account_me as the first capture of a
// later chunk, the key repeated the sweep-start one and the (source,
// idempotency_key) claim silently dropped it (466 followers_reconcile captures
// and 1 light capture in production on 2026-09-28). The raw rows are intact.
//
// The census is per request: every account_me raw row of a (page, stream,
// requestSeq) is paired with an account_me observation of the same request by
// BODY (the catalog reference both rows were written with, else the inline
// body), in capture order — the first claim of a key always won, so the
// earlier of two identical captures is the journaled one. A request that
// journaled at least one capture and fewer than it made is the defect's
// signature; its unpaired raw rows are the dropped captures. A request whose
// observations do not all pair with a raw row is reported and left alone: this
// never guesses.
//
// Each dropped capture is re-journaled VERBATIM from its raw row under producer
// `repair:account_me` and the per-raw-row key `repair:account_me:raw:<id>`, so
// a re-run is a no-op. It is dated at its capture instant (received_at =
// captured_at, the month the original would have landed in), because the
// replay dates `page.identity_observed` by it. A pointer-only raw row gives a
// pointer-only observation of the same catalog object, exactly as the capture
// seam writes one. Nothing is ever updated or deleted.
//
// Owner-run, never scheduled: dry-run is the DEFAULT and is provably read-only
// (one READ ONLY transaction, body reads included); `--execute` opts in. It
// makes no platform call. The older observations:rejournal-collisions campaign
// cannot reach these rows: it keys on sync_run_id, which they never had.

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import {
  capturePayloadRefFromColumns,
  insertObservation,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { isCapturePayloadUnavailable, resolveCapturePayload } from "./payload-reader.ts";

export const ACCOUNT_ME_REPAIR_PRODUCER = "repair:account_me";

export function accountMeRepairKey(rawPayloadId: number): string {
  return `${ACCOUNT_ME_REPAIR_PRODUCER}:raw:${rawPayloadId}`;
}

/** A capture-seam key: `page:stream:<run id | norun>:requestSeq[.fetchN]`.
 *  The fetch suffix is absent on keys from before it existed (E5). */
const CAPTURE_KEY = /^(\d+):([a-z0-9_]+):[^:]+:(\d+)(?:\.\d+)?$/;
const REPAIR_KEY = /^repair:account_me:raw:(\d+)$/;

export interface AccountMeRejournalOptions {
  /** Default true: count what WOULD be re-journaled, write nothing. */
  dryRun?: boolean;
  /** Restrict to one internal page id. */
  accountId?: number | null;
}

export interface AccountMeRejournalCounts {
  /** Captures with no observation of their own (the dropped ones). */
  missing: number;
  /** Written this run (dry-run: that WOULD be written). */
  rejournaled: number;
  /** Missing captures an earlier run already re-journaled. */
  alreadyRejournaled: number;
  /** Body unreadable right now (catalog unavailable) — skipped; re-run. */
  unavailableBody: number;
  errored: number;
}

export interface AccountMeRejournalResult {
  dryRun: boolean;
  /** Requests that journaled fewer captures than they made. */
  requests: number;
  /** Requests left alone because an observation paired with no raw row. */
  unpairedRequests: number;
  perStream: Record<string, AccountMeRejournalCounts>;
  totals: AccountMeRejournalCounts;
}

interface Body {
  bucketMonth: string | null;
  objectId: string | null;
  inlineMd5: string | null;
}

interface RawCapture extends Body {
  id: number;
  pageId: number;
  stream: string;
  requestSeq: number;
}

interface JournaledCapture extends Body {
  id: number;
  receivedAt: number;
}

interface RequestGroup {
  pageId: number;
  stream: string;
  requestSeq: number;
  raws: RawCapture[];
  journaled: JournaledCapture[];
}

function emptyCounts(): AccountMeRejournalCounts {
  return { missing: 0, rejournaled: 0, alreadyRejournaled: 0, unavailableBody: 0, errored: 0 };
}

function groupKey(pageId: number, stream: string, requestSeq: number): string {
  return `${pageId}:${stream}:${requestSeq}`;
}

/** Same body: one catalog object when both rows point at one, else equal
 *  inline bodies (jsonb text is canonical). A pair it cannot compare is not
 *  a pair. */
function sameBody(a: Body, b: Body): boolean {
  if (a.objectId !== null && b.objectId !== null) {
    return a.bucketMonth === b.bucketMonth && a.objectId === b.objectId;
  }
  return a.inlineMd5 !== null && a.inlineMd5 === b.inlineMd5;
}

async function loadRequestGroups(
  db: Database,
  accountId: number | null,
): Promise<{ groups: RequestGroup[]; repairedRawIds: Set<number> }> {
  // sync_raw_payloads has no endpoint index: one scan, grouped here. `failed`
  // rows journal as `account_me:failed` under their own key family.
  const raws = await db.execute<{
    id: string;
    page_id: string;
    stream: string;
    request_seq: string;
    bucket_month: string | null;
    object_id: string | null;
    inline_md5: string | null;
  }>(sql`
    select r.id::text as id, r.page_id::text as page_id, r.stream::text as stream,
           r.request_seq::text as request_seq,
           to_char(r.payload_bucket_month, 'YYYY-MM-DD') as bucket_month,
           r.payload_object_id::text as object_id,
           md5(r.response_payload::text) as inline_md5
    from sync_raw_payloads r
    where r.endpoint = 'account_me'
      and r.payload_kind <> 'failed'
      and r.stream is not null
      and r.request_seq is not null
      ${accountId === null ? sql`` : sql`and r.page_id = ${accountId}`}
  `);
  const journaled = await db.execute<{
    id: string;
    idempotency_key: string;
    received_at: Date | string;
    bucket_month: string | null;
    object_id: string | null;
    inline_md5: string | null;
  }>(sql`
    select o.id::text as id, o.idempotency_key, o.received_at,
           to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket_month,
           o.payload_object_id::text as object_id,
           md5(o.payload::text) as inline_md5
    from observations o
    where o.source = 'pull'
      and o.kind = 'account_me'
      ${accountId === null ? sql`` : sql`and o.account_id = ${accountId}`}
  `);

  const groups = new Map<string, RequestGroup>();
  for (const row of raws.rows) {
    const raw: RawCapture = {
      id: Number(row.id),
      pageId: Number(row.page_id),
      stream: row.stream,
      requestSeq: Number(row.request_seq),
      bucketMonth: row.bucket_month,
      objectId: row.object_id,
      inlineMd5: row.inline_md5,
    };
    const key = groupKey(raw.pageId, raw.stream, raw.requestSeq);
    const group = groups.get(key)
      ?? { pageId: raw.pageId, stream: raw.stream, requestSeq: raw.requestSeq, raws: [], journaled: [] };
    group.raws.push(raw);
    groups.set(key, group);
  }

  const repairedRawIds = new Set<number>();
  for (const row of journaled.rows) {
    const repaired = REPAIR_KEY.exec(row.idempotency_key);
    if (repaired) {
      repairedRawIds.add(Number(repaired[1]));
      continue;
    }
    const capture = CAPTURE_KEY.exec(row.idempotency_key);
    if (!capture) {
      continue; // outside any request (CLI/catalog captures carry a UUID)
    }
    const group = groups.get(groupKey(Number(capture[1]), capture[2]!, Number(capture[3])));
    group?.journaled.push({
      id: Number(row.id),
      receivedAt: new Date(row.received_at).getTime(),
      bucketMonth: row.bucket_month,
      objectId: row.object_id,
      inlineMd5: row.inline_md5,
    });
  }
  return {
    groups: [...groups.values()].sort((a, b) =>
      a.pageId - b.pageId || a.requestSeq - b.requestSeq || a.stream.localeCompare(b.stream)),
    repairedRawIds,
  };
}

/** The captures of one request that no observation accounts for, or null when
 *  an observation pairs with no capture (then nothing is safe to conclude). */
function droppedCaptures(group: RequestGroup): RawCapture[] | null {
  const journaled = [...group.journaled].sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id);
  const paired = new Set<number>();
  const dropped: RawCapture[] = [];
  for (const raw of [...group.raws].sort((a, b) => a.id - b.id)) {
    const match = journaled.find((observation) =>
      !paired.has(observation.id) && sameBody(raw, observation));
    if (match) {
      paired.add(match.id);
    } else {
      dropped.push(raw);
    }
  }
  return paired.size === journaled.length ? dropped : null;
}

async function rejournalPass(
  app: Pick<AppContext, "db" | "logger">,
  db: Database,
  options: { dryRun: boolean; accountId: number | null },
): Promise<AccountMeRejournalResult> {
  const result: AccountMeRejournalResult = {
    dryRun: options.dryRun,
    requests: 0,
    unpairedRequests: 0,
    perStream: {},
    totals: emptyCounts(),
  };
  const seam = { db, logger: app.logger };
  const { groups, repairedRawIds } = await loadRequestGroups(db, options.accountId);

  for (const group of groups) {
    // The defect's signature: the request journaled SOMETHING (a key claim
    // always lets its first capture through) and fewer captures than it made.
    if (group.journaled.length === 0 || group.journaled.length >= group.raws.length) {
      continue;
    }
    result.requests += 1;
    const dropped = droppedCaptures(group);
    if (dropped === null) {
      result.unpairedRequests += 1;
      app.logger.warn(
        { pageId: group.pageId, stream: group.stream, requestSeq: group.requestSeq },
        "account_me re-journal: an observation pairs with no capture; request left alone",
      );
      continue;
    }
    const counts = (result.perStream[group.stream] ??= emptyCounts());
    const tally = (field: keyof AccountMeRejournalCounts) => {
      counts[field] += 1;
      result.totals[field] += 1;
    };

    for (const raw of dropped) {
      tally("missing");
      if (repairedRawIds.has(raw.id)) {
        tally("alreadyRejournaled");
        continue;
      }
      try {
        const rows = await db.execute<{
          response_payload: unknown;
          inline_absent: boolean;
          bucket_month: string | null;
          object_id: string | null;
          captured_at: Date | string;
          platform: string;
        }>(sql`
          select r.response_payload, r.response_payload is null as inline_absent,
                 to_char(r.payload_bucket_month, 'YYYY-MM-DD') as bucket_month,
                 r.payload_object_id::text as object_id,
                 r.captured_at, p.platform
          from sync_raw_payloads r
          join pages p on p.id = r.page_id
          where r.id = ${raw.id}
        `);
        const row = rows.rows[0];
        if (!row) {
          throw new Error(`sync_raw_payloads row ${raw.id} vanished mid-repair`);
        }
        const ref = capturePayloadRefFromColumns(row.bucket_month, row.object_id);
        let payload: unknown;
        try {
          // Through the read seam, which RAISES on an unreadable body: a
          // deterministic key written with a null body would pass for a repair
          // and block the real one forever (#223).
          payload = await resolveCapturePayload(seam, {
            envelope: "raw_payload",
            envelopeId: raw.id,
            inline: row.response_payload ?? null,
            ref,
          }) ?? null;
        } catch (error) {
          if (isCapturePayloadUnavailable(error)) {
            tally("unavailableBody");
            continue;
          }
          throw error;
        }
        if (options.dryRun) {
          tally("rejournaled");
          continue;
        }
        const inserted = await insertObservation(db, {
          source: "pull",
          producer: ACCOUNT_ME_REPAIR_PRODUCER,
          platform: row.platform,
          accountId: group.pageId,
          kind: "account_me",
          payload,
          payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest(),
          idempotencyKey: accountMeRepairKey(raw.id),
          receivedAt: new Date(row.captured_at),
          payloadRef: ref,
          // Mirrors the raw row: pointer-only stays pointer-only. The insert
          // writes the body inline anyway if the object is gone (#222).
          omitInlinePayload: row.inline_absent,
        });
        tally(inserted.inserted ? "rejournaled" : "alreadyRejournaled");
      } catch (error) {
        tally("errored");
        app.logger.error(
          { error, rawPayloadId: raw.id },
          "account_me re-journal failed for a capture; a re-run resumes idempotently",
        );
      }
    }
  }
  return result;
}

export async function runAccountMeRejournal(
  app: Pick<AppContext, "db" | "logger">,
  options: AccountMeRejournalOptions = {},
): Promise<AccountMeRejournalResult> {
  const dryRun = options.dryRun !== false;
  const pass = { dryRun, accountId: options.accountId ?? null };
  if (dryRun) {
    return app.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      return rejournalPass(app, tx as unknown as Database, pass);
    });
  }
  const result = await rejournalPass(app, app.db as Database, pass);
  app.logger.info(result, "account_me captures re-journaled");
  return result;
}
