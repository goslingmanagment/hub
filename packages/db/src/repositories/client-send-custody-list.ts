import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { readDesktopFollowerOutreach } from "./client-claim.ts";
import {
  confirmedGreeting,
  custodyViewState,
  type ClientClaimPurpose,
  type ClientCustodyStoredState,
  type ClientCustodyViewState,
  type ClientGreetingRow,
  type ClientGreetingSource,
} from "./client-claim-transition.ts";

/**
 * The cabinet's list of chat-extension sends that need a person, or had one
 * (chat-extension hub-pr-plan H-7e). The tables and every write are
 * client-claim.ts (0241, H-7a/H-7b); this file only reads.
 *
 * `held`: a dispatch nobody ended whose ticket ran out. It never frees itself:
 * the dispatcher's late proof or a manual resolve ends it. A dispatch still
 * inside its ticket is in flight and is not listed. The read is the fan's one
 * open send per page, found through `client_send_custody_one_open` (0241),
 * whose predicate is this list's: its cost is the unresolved sends, a handful,
 * never the sends ever made.
 *
 * `resolved`: the sends the owner or a team lead ended by hand, with the
 * resolve as the row keeps it. No index of 0241 or 0246 leads to them, so this
 * read walks the table. The cabinet asks for it when a person opens the page
 * and after a resolve, never on a timer; if the table outgrows that, the fix
 * is one partial index on (resolved_at) where resolved_at is not null.
 *
 * Both name the page by its label and only pages that are still active: the
 * resolve route finds a page by its label among the active ones, so a send of
 * a deleted page could be listed and never resolved.
 *
 * No text of a message is read: these tables hold none.
 */

export type ClientSendCustodyListState = "held" | "resolved";

/** `all`: no page filter (the owner). A list: those pages only, and an empty list answers nothing. */
export type ClientSendCustodyListPages = "all" | readonly number[];

export interface ClientSendCustodyListInput {
  state: ClientSendCustodyListState;
  pages: ClientSendCustodyListPages;
  limit: number;
  offset: number;
}

export interface ClientSendCustodyListRow {
  attemptId: string;
  pageId: number;
  pageLabel: string;
  fanRef: string;
  /** Who dispatched. */
  userId: number;
  username: string;
  /** The client install that dispatched. */
  instanceId: string;
  purpose: ClientClaimPurpose;
  state: ClientCustodyViewState;
  generationRef: string;
  variant: number;
  partIndex: number;
  partCount: number;
  createdAt: Date;
  updatedAt: Date;
  ticketExpiresAt: Date | null;
  /** The fan's confirmed first greeting, as the claim status read answers it; null when there is none. */
  greeting: { at: Date; source: ClientGreetingSource; firstPartIsThisAttempt: boolean } | null;
  resolution: {
    outcome: "sent" | "not_sent";
    at: Date;
    userId: number;
    username: string;
    note: string;
    platformMessageId: string | null;
  } | null;
}

export interface ClientSendCustodyList {
  items: ClientSendCustodyListRow[];
  /** Every send in the asked state on the asked pages. */
  total: number;
  /** The database clock the states were read against. */
  now: Date;
}

type ListDbRow = {
  attempt_id: string; page_id: bigint; page_label: string; fan_ref: string; user_id: bigint; username: string;
  instance_id: string; purpose: ClientClaimPurpose; state: ClientCustodyStoredState; generation_ref: string;
  variant: number; part_index: number; part_count: number; created_at: Date; updated_at: Date;
  ticket_expires_at: Date | null; platform_message_id: string | null; resolved_at: Date | null;
  resolved_by_user_id: bigint | null; resolved_by_username: string | null; resolution_note: string | null;
  greeting_at: Date | null; greeting_source: ClientGreetingRow["source"] | null; greeting_first_attempt_id: string | null;
};

/**
 * The sends of the asked state on the asked pages, as a predicate over `c`
 * (client_send_custody) joined to `p`, its page.
 */
function listPredicate(input: Pick<ClientSendCustodyListInput, "state" | "pages">, now: Date): SQL {
  const parts: SQL[] = [
    sql`p.status = 'active'`,
    input.state === "held"
      // Exactly custodyViewState's `uncertain-held`, so the list and the claim status read cannot disagree.
      ? sql`c.state = 'dispatching' and (c.ticket_expires_at is null or c.ticket_expires_at <= ${now})`
      : sql`c.state in ('resolved_sent', 'resolved_not_sent')`,
  ];
  if (input.pages !== "all") parts.push(sql`c.page_id = any(${sql.param([...input.pages])}::bigint[])`);
  return sql.join(parts, sql` and `);
}

function listQuery(input: ClientSendCustodyListInput, now: Date): SQL {
  // The longest held first: it has waited longest. The last resolved first: the trail reads newest down.
  const order = input.state === "held" ? sql`c.created_at, c.attempt_id` : sql`c.resolved_at desc, c.attempt_id desc`;
  return sql`
    select c.attempt_id::text, c.page_id, p.label as page_label, c.fan_ref, c.user_id, u.username,
      c.instance_id::text, c.purpose, c.state, c.generation_ref, c.variant, c.part_index, c.part_count,
      c.created_at, c.updated_at, c.ticket_expires_at, c.platform_message_id, c.resolved_at,
      c.resolved_by_user_id, r.username as resolved_by_username, c.resolution_note,
      g.confirmed_at as greeting_at, g.source as greeting_source, g.first_attempt_id::text as greeting_first_attempt_id
    from client_send_custody c
    join pages p on p.id = c.page_id
    join users u on u.id = c.user_id
    left join users r on r.id = c.resolved_by_user_id
    left join client_greetings g on g.page_id = c.page_id and g.fan_ref = c.fan_ref
    where ${listPredicate(input, now)}
    order by ${order} limit ${input.limit} offset ${input.offset}`;
}

/** The plan of the list's own statement, for the test that holds the held read to the open-send index. */
export async function explainClientSendCustodyListQuery(db: Database, input: ClientSendCustodyListInput): Promise<string> {
  const result = await db.execute<{ "QUERY PLAN": string }>(sql`explain (format text) ${listQuery(input, new Date())}`);
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/**
 * One page of the list and its total, read in one read-only snapshot: a send
 * resolved between the two reads cannot be counted and not listed.
 */
export async function listClientSendCustody(db: Database, input: ClientSendCustodyListInput): Promise<ClientSendCustodyList> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const now = new Date((await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`)).rows[0]!.now);
    if (input.pages !== "all" && input.pages.length === 0) return { items: [], total: 0, now };

    const total = Number((await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from client_send_custody c join pages p on p.id = c.page_id
      where ${listPredicate(input, now)}`)).rows[0]!.n);
    const rows = (await tx.execute<ListDbRow>(listQuery(input, now))).rows;

    // A fan the client never greeted may have been greeted by the desktop: the same second source the
    // claim status read falls back to (confirmedGreeting), read per page for the fans that need it.
    const ungreeted = new Map<number, string[]>();
    for (const row of rows) {
      if (row.greeting_at !== null) continue;
      const pageId = Number(row.page_id);
      ungreeted.set(pageId, [...(ungreeted.get(pageId) ?? []), row.fan_ref]);
    }
    const desktop = new Map<number, Awaited<ReturnType<typeof readDesktopFollowerOutreach>>>();
    for (const [pageId, fanRefs] of ungreeted) {
      desktop.set(pageId, await readDesktopFollowerOutreach(tx, pageId, [...new Set(fanRefs)]));
    }

    const items = rows.map((row): ClientSendCustodyListRow => {
      const pageId = Number(row.page_id);
      const ticketExpiresAt = row.ticket_expires_at === null ? null : new Date(row.ticket_expires_at);
      const greeting = confirmedGreeting({
        greeting: row.greeting_at === null ? null : {
          // When and how, which is all the list says of a greeting. Its owner, its group and its
          // message id are not read: the id is the proof of another send, not of this one.
          ownerUserId: null, generationRef: null, variant: null, partCount: null, firstMessageRef: null,
          confirmedAt: new Date(row.greeting_at), source: row.greeting_source!,
        },
        desktop: desktop.get(pageId)?.get(row.fan_ref) ?? null,
      });
      return {
        attemptId: row.attempt_id, pageId, pageLabel: row.page_label, fanRef: row.fan_ref,
        userId: Number(row.user_id), username: row.username, instanceId: row.instance_id, purpose: row.purpose,
        state: custodyViewState({ state: row.state, ticketExpiresAt }, now),
        generationRef: row.generation_ref, variant: Number(row.variant), partIndex: Number(row.part_index),
        partCount: Number(row.part_count), createdAt: new Date(row.created_at), updatedAt: new Date(row.updated_at),
        ticketExpiresAt,
        greeting: greeting && {
          at: greeting.at, source: greeting.source,
          firstPartIsThisAttempt: row.greeting_first_attempt_id === row.attempt_id,
        },
        resolution: row.resolved_at === null ? null : {
          outcome: row.state === "resolved_sent" ? "sent" : "not_sent",
          at: new Date(row.resolved_at), userId: Number(row.resolved_by_user_id), username: row.resolved_by_username!,
          note: row.resolution_note!, platformMessageId: row.platform_message_id,
        },
      };
    });
    return { items, total, now };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
