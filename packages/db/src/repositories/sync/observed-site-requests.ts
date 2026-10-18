import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { toDate, toNumber } from "./values.ts";

// Project Browser, variant Б (0289, protocol minor 6): one hop of a site
// request a page's browser let go and observed, from its send's attempt to
// the observation its answer was kept as. The operator keeps every
// observation until the engine confirmed its commit and sends it again until
// then: the engine takes a hop once by its key (`requestKey`, `hop`) — a send
// told again finds its row and journals no second attempt; an end commits
// only after its send's attempt (its holds with it, in one transaction).
// The buffer's intake links the answer (`site.response`) by the same key,
// whichever of the two comes first. Every write stamps when Hub made it.

/** One hop of one observed site request. */
export interface ObservedSiteRequestKey {
  pageId: number;
  /** The operator's key of the request (minted when it first followed it). */
  requestKey: string;
  /** 0: as it first left; each redirect under its id the next. */
  hop: number;
}

export interface ObservedSiteRequestRow extends ObservedSiteRequestKey {
  browserRequestId: string;
  attemptId: number | null;
  /** The attempt's route (`operation`) and send instant (null: no attempt). */
  route: string | null;
  sentAt: Date | null;
  credentialsGeneration: string | null;
  sessionFingerprint: string | null;
  sentRecordedAt: Date | null;
  endedRecordedAt: Date | null;
  identityRecordedAt: Date | null;
  responseSeq: number | null;
  responseRecordedAt: Date | null;
}

interface RawRow {
  page_id: string | number;
  request_key: string;
  hop: number;
  browser_request_id: string;
  attempt_id: string | number | null;
  route: string | null;
  sent_at: Date | string | null;
  credentials_generation: string | null;
  session_fingerprint: string | null;
  sent_recorded_at: Date | string | null;
  ended_recorded_at: Date | string | null;
  identity_recorded_at: Date | string | null;
  response_seq: string | number | null;
  response_recorded_at: Date | string | null;
  [column: string]: unknown;
}

/** The row of a hop (null: none yet), with its attempt's route and send.
 *  `lock`: held for update until the transaction ends. */
export async function findObservedSiteRequest(
  db: Database,
  key: ObservedSiteRequestKey,
  options: { lock?: boolean } = {},
): Promise<ObservedSiteRequestRow | null> {
  const result = await db.execute<RawRow>(sql`
    select o.page_id, o.request_key, o.hop, o.browser_request_id, o.attempt_id,
           a.operation as route, a.sent_at,
           o.credentials_generation, o.session_fingerprint, o.sent_recorded_at,
           o.ended_recorded_at, o.identity_recorded_at, o.response_seq, o.response_recorded_at
      from sync_observed_site_requests o
      left join sync_attempts a on a.id = o.attempt_id
     where o.page_id = ${key.pageId}
       and o.request_key = ${key.requestKey}
       and o.hop = ${key.hop}::integer
    ${options.lock === true ? sql`for update of o` : sql``}
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    pageId: Number(row.page_id),
    requestKey: row.request_key,
    hop: Number(row.hop),
    browserRequestId: row.browser_request_id,
    attemptId: toNumber(row.attempt_id),
    route: row.route,
    sentAt: toDate(row.sent_at),
    credentialsGeneration: row.credentials_generation,
    sessionFingerprint: row.session_fingerprint,
    sentRecordedAt: toDate(row.sent_recorded_at),
    endedRecordedAt: toDate(row.ended_recorded_at),
    identityRecordedAt: toDate(row.identity_recorded_at),
    responseSeq: toNumber(row.response_seq),
    responseRecordedAt: toDate(row.response_recorded_at),
  };
}

/** The send of a hop journaled as `attemptId` (after `findObservedSiteRequest`
 *  found none, under the page's lock): its row made, or the one its answer
 *  made first completed. False: the hop already had an attempt (nothing
 *  written). */
export async function recordObservedSiteSent(
  db: Database,
  input: ObservedSiteRequestKey & { browserRequestId: string; attemptId: number; credentialsGeneration: string | null; sessionFingerprint: string | null },
): Promise<boolean> {
  const result = await db.execute(sql`
    insert into sync_observed_site_requests as o (
      page_id, request_key, hop, browser_request_id, attempt_id, credentials_generation, session_fingerprint, sent_recorded_at
    ) values (
      ${input.pageId}, ${input.requestKey}, ${input.hop}::integer, ${input.browserRequestId}, ${input.attemptId},
      ${input.credentialsGeneration}, ${input.sessionFingerprint}, clock_timestamp()
    )
    on conflict (page_id, request_key, hop) do update
       set attempt_id = excluded.attempt_id,
           credentials_generation = excluded.credentials_generation,
           session_fingerprint = excluded.session_fingerprint,
           sent_recorded_at = excluded.sent_recorded_at
     where o.attempt_id is null
  `);
  return (result.rowCount ?? 0) > 0;
}

/** How a hop ended, as Hub committed it (once: an end told again keeps the
 *  first). */
export async function recordObservedSiteEnded(
  db: Database,
  input: ObservedSiteRequestKey & { status: number | null; error: string | null },
): Promise<void> {
  await db.execute(sql`
    update sync_observed_site_requests
       set end_status = ${input.status}::integer,
           end_error = ${input.error === null ? null : input.error.slice(0, 1024)},
           ended_recorded_at = clock_timestamp()
     where page_id = ${input.pageId}
       and request_key = ${input.requestKey}
       and hop = ${input.hop}::integer
       and ended_recorded_at is null
  `);
}

/** The account a hop named, taken (once). */
export async function recordObservedSiteIdentity(db: Database, key: ObservedSiteRequestKey): Promise<void> {
  await db.execute(sql`
    update sync_observed_site_requests
       set identity_recorded_at = clock_timestamp()
     where page_id = ${key.pageId}
       and request_key = ${key.requestKey}
       and hop = ${key.hop}::integer
       and identity_recorded_at is null
  `);
}

/** The buffer event that carried a hop's answer and the observation it was
 *  journaled as (null: not written), linked in the intake's batch — before
 *  its send's row, if the answer came first. Once: an event delivered again
 *  keeps the first. */
export async function linkObservedSiteResponse(
  db: Database,
  input: ObservedSiteRequestKey & { browserRequestId: string; bufferId: string; seq: number; observationId: number | null },
): Promise<void> {
  await db.execute(sql`
    insert into sync_observed_site_requests as o (
      page_id, request_key, hop, browser_request_id, response_buffer_id, response_seq, response_observation_id, response_recorded_at
    ) values (
      ${input.pageId}, ${input.requestKey}, ${input.hop}::integer, ${input.browserRequestId},
      ${input.bufferId}::uuid, ${input.seq}, ${input.observationId}, clock_timestamp()
    )
    on conflict (page_id, request_key, hop) do update
       set response_buffer_id = excluded.response_buffer_id,
           response_seq = excluded.response_seq,
           response_observation_id = excluded.response_observation_id,
           response_recorded_at = excluded.response_recorded_at
     where o.response_seq is null
  `);
}

/** A page's observed site requests since an instant, as an audit counts
 *  them: hops whose send was journaled, those ended, those still without an
 *  end past `unendedAfterMs`, those with an answer kept, and answers whose
 *  send Hub has not journaled past the same wait. */
export interface ObservedSiteRequestSummary {
  sent: number;
  ended: number;
  unended: number;
  responses: number;
  responsesWithoutSend: number;
  /** The latest instant Hub wrote any of them (null: none). */
  lastRecordedAt: Date | null;
}

export const EMPTY_OBSERVED_SITE_REQUEST_SUMMARY: Readonly<ObservedSiteRequestSummary> = Object.freeze({
  sent: 0,
  ended: 0,
  unended: 0,
  responses: 0,
  responsesWithoutSend: 0,
  lastRecordedAt: null,
});

/** The summary of each page's hops made since `since` (a page with none is
 *  absent): a range scan of `sync_observed_site_requests_page_created_idx`. */
export async function summarizeObservedSiteRequests(
  db: Database,
  input: { pageIds: readonly number[]; since: Date; now: Date; unendedAfterMs: number },
): Promise<Map<number, ObservedSiteRequestSummary>> {
  const out = new Map<number, ObservedSiteRequestSummary>();
  if (input.pageIds.length === 0) return out;
  const waitedBefore = new Date(input.now.getTime() - input.unendedAfterMs);
  const result = await db.execute<{
    page_id: string | number;
    sent: number;
    ended: number;
    unended: number;
    responses: number;
    responses_without_send: number;
    last_recorded_at: Date | string | null;
  }>(sql`
    select page_id,
           count(*) filter (where sent_recorded_at is not null)::int as sent,
           count(*) filter (where ended_recorded_at is not null)::int as ended,
           count(*) filter (where sent_recorded_at is not null and ended_recorded_at is null
                              and sent_recorded_at < ${waitedBefore}::timestamptz)::int as unended,
           count(*) filter (where response_seq is not null)::int as responses,
           count(*) filter (where response_seq is not null and sent_recorded_at is null
                              and response_recorded_at < ${waitedBefore}::timestamptz)::int as responses_without_send,
           max(greatest(sent_recorded_at, ended_recorded_at, response_recorded_at)) as last_recorded_at
      from sync_observed_site_requests
     where page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
       and created_at >= ${input.since}::timestamptz
     group by page_id
  `);
  for (const row of result.rows) {
    out.set(Number(row.page_id), {
      sent: Number(row.sent),
      ended: Number(row.ended),
      unended: Number(row.unended),
      responses: Number(row.responses),
      responsesWithoutSend: Number(row.responses_without_send),
      lastRecordedAt: toDate(row.last_recorded_at),
    });
  }
  return out;
}
