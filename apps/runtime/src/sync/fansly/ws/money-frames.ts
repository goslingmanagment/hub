import {
  listSyncWsReceiptsInWindow,
  readLedgerTransactionsCreatedAt,
  type Database,
  type FanslyWsLivePayloadResolver,
  type SyncWsWindowReceipt,
} from "@agency_hub_core/db";
import { decodeFanslyWsFrame, socketFrameOf, type WsFrameDecode } from "./decode.ts";
import { FANSLY_PAYOUT_TRANSACTION_TYPE, FANSLY_TRANSACTION_STATUS_NEW } from "./router.ts";

// The socket's money news against the ledger (plan §10 `money_lag`, alert 3
// "a WS money frame not in the ledger > 5 min"): a `transaction` frame of a
// new ledger row (status 1; not a payout, 16012) is matched with the ledger
// row of the same transaction id. Read-only.

/** Receipts read per query. */
const RECEIPT_BATCH = 500;

/** One decoded receipt of a window. */
interface DecodedWindowReceipt {
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
async function* decodedReceiptsInWindow(
  db: Database,
  input: MoneyFrameWindowInput,
  skipIds: readonly number[] = [],
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
      ...(skipIds.length === 0 ? {} : { skipIds }),
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

/** What a money read is asked for. */
export interface MoneyFrameWindowInput {
  from: Date;
  to: Date;
  pageIds: readonly number[];
  resolvePayload?: FanslyWsLivePayloadResolver;
}

/** The transaction ids of a decoded receipt that announce a new ledger row
 *  (status 1, not a payout). */
function moneyTransactionIds(decoded: WsFrameDecode): string[] {
  const ids: string[] = [];
  for (const item of decoded.items) {
    if (item.kind !== "transaction" || item.status !== FANSLY_TRANSACTION_STATUS_NEW) continue;
    if (item.type === FANSLY_PAYOUT_TRANSACTION_TYPE) continue;
    ids.push(item.id);
  }
  return ids;
}

/** The money frames of the window's receipts, `skipIds` left unread, each
 *  matched with the ledger; `quiet` hears every receipt read that decoded to
 *  a frame without money. */
async function collectMoneyFrames(
  db: Database,
  input: MoneyFrameWindowInput,
  skipIds: readonly number[],
  quiet: (receipt: DecodedWindowReceipt) => void,
): Promise<MoneyFrame[]> {
  const frames: Array<Omit<MoneyFrame, "ledgerCreatedAt">> = [];
  for await (const batch of decodedReceiptsInWindow(db, input, skipIds)) {
    for (const receipt of batch) {
      if (receipt.decoded === null) continue;
      const transactionIds = moneyTransactionIds(receipt.decoded);
      if (transactionIds.length === 0) quiet(receipt);
      for (const transactionId of transactionIds) {
        frames.push({ pageId: receipt.pageId, observationId: receipt.observationId, receivedAt: receipt.receivedAt, transactionId });
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

/** The money frames of [from, to) for `pageIds`, each matched with the ledger. */
export async function readMoneyFrames(db: Database, input: MoneyFrameWindowInput): Promise<MoneyFrame[]> {
  return collectMoneyFrames(db, input, [], () => undefined);
}

/**
 * `readMoneyFrames` for a caller that reads a moving window again and again
 * (the alert evaluator, every 30 s): the same frames, each receipt without
 * money read and decoded once instead of on every pass.
 *
 * Why the answer is the full read's: the window is still the database's —
 * the same statement, its floor and its pages, decides which receipts are in
 * it; the window only leaves out of the answer the receipts it already
 * decoded to a socket frame without a money item ("quiet"), and such a
 * receipt adds no frame to a full read either: its body is the journal's
 * (never rewritten — an erasure deletes it, the store moves it unchanged), the
 * decoder is a pure function of the body and the receipt's own ref, so read
 * again it is the same quiet frame, or gone, or unreadable — none of which is
 * money. A receipt with money, or whose body could not be read or decoded,
 * is never quiet: it is read and decoded again on every pass, exactly as the
 * full read does (a body erased meanwhile drops out the same way), and its
 * ledger match is looked up fresh. Late or back-dated receipts, the floor,
 * a page added or removed: all the statement's, untouched.
 *
 * Memory: the quiet receipts still in the window — those received in
 * [from, to) of the last read (an hour of the pages' frames at most, ~1–2.5k
 * ids today). A window that moves backwards (a clock step) and any failure
 * of a read start again from nothing: the next read is a full one.
 */
export interface MoneyFrameWindow {
  read(db: Database, input: MoneyFrameWindowInput): Promise<MoneyFrame[]>;
  /** Forget every quiet receipt: the next read is a full one. */
  reset(): void;
  /** Quiet receipts held. */
  readonly size: number;
}

export function createMoneyFrameWindow(): MoneyFrameWindow {
  /** Quiet receipt id → when it was received (ms). */
  let quiet = new Map<number, number>();
  let last: { from: number; to: number } | null = null;
  const reset = () => {
    quiet = new Map();
    last = null;
  };
  return {
    get size() {
      return quiet.size;
    },
    reset,
    async read(db, input) {
      const from = input.from.getTime();
      const to = input.to.getTime();
      if (last !== null && (from < last.from || to < last.to)) reset();
      for (const [id, receivedAt] of quiet) if (receivedAt < from) quiet.delete(id);
      try {
        const frames = await collectMoneyFrames(db, input, [...quiet.keys()], (receipt) => {
          quiet.set(receipt.observationId, receipt.receivedAt.getTime());
        });
        last = { from, to };
        return frames;
      } catch (error) {
        reset();
        throw error;
      }
    },
  };
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
