import { randomUUID } from "node:crypto";

import {
  beginFanslyWsConnection,
  captureFanslyWsFrame,
  createFanslyPage,
  createModel,
  ensureSyncPage,
  upsertFans,
  type Database,
} from "@agency_hub_core/db";
import type { Pool } from "pg";

import { serviceFrame, wrapped } from "./fansly-ws-fixtures.ts";

// Captured socket frames for the Sync Engine's WebSocket router tests: a
// Fansly page with its own account id, its engine row and an open receiver
// connection, frames captured through the real B0 capture (observation +
// pending receipt in one transaction), and the page's DM threads.

const GENERATION = "a".repeat(64);

export interface WsCapturePage {
  pageId: number;
  label: string;
  /** The page's own Fansly account id (`pages.external_page_id`). */
  ownRef: string;
  /** Capture one frame as the legacy receiver would; returns its observation id. */
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
  const connectionId = randomUUID();
  await beginFanslyWsConnection(handles.db, { id: connectionId, pageId, generation: GENERATION });
  let ordinal = 0;
  return {
    pageId,
    label,
    ownRef: input.ownRef,
    capture: (frame, receivedAt = new Date()) => captureFanslyWsFrame(handles.db, {
      connectionId, pageId, generation: GENERATION, accountRef: input.ownRef,
      ordinal: ++ordinal, frame, receivedAt, validate: async () => undefined,
    }),
  };
}

/** A DM thread of the page; bound threads get a fan row. */
export async function seedWsThread(
  handles: { db: Database; pool: Pool },
  input: { pageId: number; groupId: string; fanRef?: string | null; excluded?: boolean; headConfirmedId?: string | null },
): Promise<number> {
  let fanId: number | null = null;
  if (input.fanRef !== null && input.fanRef !== undefined) {
    const [fan] = await upsertFans(handles.db, [{ platform: "fansly" as const, platformUserId: input.fanRef }]);
    fanId = fan!.id;
  }
  const metadata = input.excluded === true ? { messageSyncExcludedReason: "partner_missing_from_aggregation_accounts" } : {};
  const result = await handles.pool.query<{ id: string }>(
    `insert into page_dm_threads (platform_account_id, fan_id, platform_conversation_id, metadata, head_confirmed_id)
     values ($1, $2, $3, $4::jsonb, $5) returning id::text as id`,
    [input.pageId, fanId, input.groupId, JSON.stringify(metadata), input.headConfirmedId ?? null],
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
