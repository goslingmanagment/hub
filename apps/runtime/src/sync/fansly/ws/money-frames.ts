import {
  listSyncWsReceiptsInWindow,
  readLedgerTransactionsCreatedAt,
  type Database,
  type FanslyWsLivePayloadResolver,
  type SyncWsReceiptNode,
  type SyncWsWindowReceipt,
} from "@agency_hub_core/db";
import { decodeFanslyWsFrame, socketFrameOf, WS_ORDER_NODE, type WsFrameDecode } from "./decode.ts";
import { FANSLY_PAYOUT_TRANSACTION_TYPE, FANSLY_TRANSACTION_STATUS_NEW } from "./router.ts";

// The socket's money news against the ledger (plan §10 `money_lag`, alert 3
// "a WS money frame not in the ledger > 5 min", the shadow report's A3): a
// `transaction` frame of a new ledger row (status 1; not a payout, 16012) is
// matched with the ledger row of the same transaction id. Read-only.

/** Receipts read per query. */
const RECEIPT_BATCH = 500;

/** One decoded receipt of a window. */
export interface DecodedWindowReceipt {
  observationId: number;
  pageId: number;
  receivedAt: Date;
  /** Null when the body is gone or is not a socket frame. */
  decoded: WsFrameDecode | null;
}

/**
 * Every receipt received in [from, to) of `pageIds`, decoded with the
 * engine's decoder. A body the payload seam cannot read decodes to null (the
 * caller counts it); nothing is written.
 */
export async function* decodedReceiptsInWindow(
  db: Database,
  input: { from: Date; to: Date; pageIds: readonly number[]; resolvePayload?: FanslyWsLivePayloadResolver; node?: SyncWsReceiptNode },
): AsyncGenerator<DecodedWindowReceipt[]> {
  if (input.pageIds.length === 0) return;
  let afterId = 0;
  for (;;) {
    const rows = await listSyncWsReceiptsInWindow(db, {
      from: input.from,
      to: input.to,
      pageIds: input.pageIds,
      afterId,
      limit: RECEIPT_BATCH,
      ...(input.node === undefined ? {} : { node: input.node }),
    });
    if (rows.length === 0) return;
    const batch: DecodedWindowReceipt[] = [];
    for (const row of rows) batch.push({ ...identity(row), decoded: await decodeReceipt(db, row, input.resolvePayload) });
    yield batch;
    if (rows.length < RECEIPT_BATCH) return;
    afterId = rows.at(-1)!.observationId;
  }
}

function identity(row: SyncWsWindowReceipt) {
  return { observationId: row.observationId, pageId: row.pageId, receivedAt: row.receivedAt };
}

async function decodeReceipt(
  db: Database,
  row: SyncWsWindowReceipt,
  resolvePayload: FanslyWsLivePayloadResolver | undefined,
): Promise<WsFrameDecode | null> {
  if (row.missing) return null;
  try {
    const payload = resolvePayload === undefined
      ? row.payload
      : await resolvePayload(db, row.observationId, { payload: row.payload, payloadRef: row.payloadRef });
    const frame = socketFrameOf(payload);
    return frame === null ? null : decodeFanslyWsFrame(frame, row.ownRef);
  } catch {
    return null;
  }
}

/** A socket frame announcing a new ledger row, and when the ledger stored it. */
export interface MoneyFrame {
  pageId: number;
  observationId: number;
  receivedAt: Date;
  transactionId: string;
  /** Null: the ledger has no row of the transaction (yet). */
  ledgerCreatedAt: Date | null;
}

/** The money frames of [from, to) for `pageIds`, each matched with the ledger. */
export async function readMoneyFrames(
  db: Database,
  input: { from: Date; to: Date; pageIds: readonly number[]; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<MoneyFrame[]> {
  const frames: Array<Omit<MoneyFrame, "ledgerCreatedAt">> = [];
  for await (const batch of decodedReceiptsInWindow(db, input)) {
    for (const receipt of batch) {
      for (const item of receipt.decoded?.items ?? []) {
        if (item.kind !== "transaction" || item.status !== FANSLY_TRANSACTION_STATUS_NEW) continue;
        if (item.type === FANSLY_PAYOUT_TRANSACTION_TYPE) continue;
        frames.push({ pageId: receipt.pageId, observationId: receipt.observationId, receivedAt: receipt.receivedAt, transactionId: item.id });
      }
    }
  }
  const byPage = new Map<number, string[]>();
  for (const frame of frames) byPage.set(frame.pageId, [...(byPage.get(frame.pageId) ?? []), frame.transactionId]);
  const ledger = new Map<number, Map<string, Date>>();
  for (const [pageId, transactionIds] of byPage) {
    ledger.set(pageId, await readLedgerTransactionsCreatedAt(db, { pageId, transactionIds }));
  }
  return frames.map((frame) => ({ ...frame, ledgerCreatedAt: ledger.get(frame.pageId)?.get(frame.transactionId) ?? null }));
}

/** A socket PPV order (svc 2 / type 7) of a page. */
export interface OrderFrame {
  pageId: number;
  receivedAt: Date;
  orderId: string;
}

/** The PPV order frames of [from, to) for `pageIds` (only the receipts whose
 *  nodes list an order envelope are read and decoded). */
export async function readOrderFrames(
  db: Database,
  input: { from: Date; to: Date; pageIds: readonly number[]; resolvePayload?: FanslyWsLivePayloadResolver },
): Promise<OrderFrame[]> {
  const frames: OrderFrame[] = [];
  for await (const batch of decodedReceiptsInWindow(db, { ...input, node: WS_ORDER_NODE })) {
    for (const receipt of batch) {
      for (const item of receipt.decoded?.items ?? []) {
        if (item.kind === "order") frames.push({ pageId: receipt.pageId, receivedAt: receipt.receivedAt, orderId: item.orderId });
      }
    }
  }
  return frames;
}

/** Frames received more than `afterMs` before `now` that the ledger still
 *  lacks, per page (alert 3). */
export function moneyFramesMissing(
  frames: readonly MoneyFrame[],
  now: Date,
  afterMs: number,
): Map<number, { count: number; oldestReceivedAt: Date }> {
  const missing = new Map<number, { count: number; oldestReceivedAt: Date }>();
  for (const frame of frames) {
    if (frame.ledgerCreatedAt !== null || now.getTime() - frame.receivedAt.getTime() <= afterMs) continue;
    const current = missing.get(frame.pageId);
    missing.set(frame.pageId, current === undefined
      ? { count: 1, oldestReceivedAt: frame.receivedAt }
      : {
        count: current.count + 1,
        oldestReceivedAt: current.oldestReceivedAt < frame.receivedAt ? current.oldestReceivedAt : frame.receivedAt,
      });
  }
  return missing;
}
