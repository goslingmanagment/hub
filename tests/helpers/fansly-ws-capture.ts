import { randomUUID } from "node:crypto";

import {
  beginBrowserWsConnection,
  captureBrowserWsFrame,
  createFanslyPage,
  createModel,
  ensureSyncPage,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import type { Pool } from "pg";

import { serviceFrame, wrapped } from "./fansly-ws-fixtures.ts";

// Captured socket frames for the Sync Engine's WebSocket router tests: a
// Fansly page with its own account id, its engine row and an open site
// socket connection, frames captured as the page's browser buffer delivers
// them (observation + pending receipt in one transaction), and the page's DM
// threads.

const GENERATION = "a".repeat(64);

export interface WsCapturePage {
  pageId: number;
  label: string;
  /** The page's own Fansly account id (`pages.external_page_id`). */
  ownRef: string;
  /** Capture one frame as the browser intake would; returns its observation id. */
  capture(frame: string, receivedAt?: Date): Promise<number>;
}

export async function seedWsCapturePage(
  handles: { db: Database; pool: Pool },
  input: { ownRef: string; label?: string },
): Promise<WsCapturePage> {
  const label = input.label ?? `ws-${randomUUID().slice(0, 8)}`;
  const model = await createModel(handles.db, { slug: `model-${label}`, name: label });
  const page = await createFanslyPage(handles.db, { modelId: model!.id, label });
  const pageId = page!.id;
  await handles.pool.query("update pages set external_page_id = $2 where id = $1", [pageId, input.ownRef]);
  await ensureSyncPage(handles.db, { pageId });
  return { pageId, label, ownRef: input.ownRef, capture: await openWsCapture(handles, { pageId, ownRef: input.ownRef }) };
}

/** An open site socket connection of an existing page under the session the
 *  engine trusts: its frames captured through the real browser capture, as
 *  the intake takes them from the operator's buffer. */
export async function openWsCapture(
  handles: { db: Database },
  input: { pageId: number; ownRef: string },
): Promise<WsCapturePage["capture"]> {
  const browserConnectionId = randomUUID();
  const bufferId = randomUUID();
  await beginBrowserWsConnection(handles.db, {
    id: randomUUID(), pageId: input.pageId, generation: GENERATION, browserConnectionId, startedAt: new Date(),
  });
  let seq = 0;
  return async (frame, receivedAt = new Date()) => {
    seq += 1;
    const captured = await handles.db.transaction(async (tx) => captureBrowserWsFrame(tx as unknown as Database, {
      pageId: input.pageId, browserConnectionId, bufferId, seq, accountRef: input.ownRef, frame, receivedAt,
      trustedGeneration: GENERATION,
    }));
    if (captured.kind !== "captured") throw new Error(`fansly-ws-capture: the frame was not captured (${captured.kind})`);
    return captured.observationId;
  };
}

/** A DM thread of the page; bound threads get a fan row. */
export async function seedWsThread(
  handles: { db: Database; pool: Pool },
  input: {
    pageId: number;
    groupId: string;
    fanRef?: string | null;
    excluded?: boolean;
    headConfirmedId?: string | null;
    /** Capture time of the page that confirmed the head (default: now when a head is given). */
    headConfirmedAt?: Date;
    /** When the row was first written (default: now). */
    firstSeenAt?: Date;
  },
): Promise<number> {
  let fanId: number | null = null;
  if (input.fanRef !== null && input.fanRef !== undefined) {
    const [fan] = await upsertFans(handles.db, [{ platform: "fansly" as const, platformUserId: input.fanRef }]);
    fanId = fan!.id;
  }
  const metadata = input.excluded === true ? { messageSyncExcludedReason: "partner_missing_from_aggregation_accounts" } : {};
  const headConfirmedId = input.headConfirmedId ?? null;
  const result = await handles.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, metadata, head_confirmed_id,
                                  head_confirmed_at, first_seen_at)
     values ($1, $2, $3, $4::jsonb, $5, $6, coalesce($7::timestamptz, now())) returning id::text as id`,
    [
      input.pageId, fanId, input.groupId, JSON.stringify(metadata), headConfirmedId,
      headConfirmedId === null ? null : input.headConfirmedAt ?? new Date(), input.firstSeenAt ?? null,
    ],
  );
  return Number(result.rows[0]!.id);
}

let nextMessageId = 910_000_000_000_000_000n;

/** A socket message (svc 5 / type 1 payload). */
export function wsMessage(overrides: Record<string, unknown> & { groupId: string; senderId: string }) {
  return {
    id: String(nextMessageId++), createdAt: Date.now() / 1000 - 1, content: "hello", attachments: [], type: 1,
    ...overrides,
  } as Record<string, unknown> & { id: string; groupId: string; senderId: string };
}

export const wsCreated = (...messages: Record<string, unknown>[]) => messages.length === 1
  ? serviceFrame({ type: 1, message: messages[0] })
  : wrapped(10001, messages.map((item) => serviceFrame({ type: 1, message: item })));

export const wsDeleted = (id: string, groupId: string | null) =>
  serviceFrame({ type: 10, message: { id, ...(groupId === null ? {} : { groupId }), type: 1 } });

export const wsTransaction = (id: string, status: number, type = 2110) =>
  serviceFrame({ type: 3, transaction: { id, type, status, amount: 5000, correlationId: null } }, 6);
