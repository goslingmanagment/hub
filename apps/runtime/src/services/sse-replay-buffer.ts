import { Buffer } from "node:buffer";

/**
 * Live events arriving while an SSE connection replays its durable journal
 * must be held until replay completes. The buffer is deliberately fail-closed:
 * once its byte budget is exceeded it releases every retained object and asks
 * the caller to destroy the connection. The client's unchanged cursor then
 * makes the next connection replay every event; dropping one item and keeping
 * the stream open would instead create an unrecoverable gap.
 */
export interface BoundedSseReplayBuffer<T> {
  readonly overflowed: boolean;
  push(item: T): boolean;
  drain(): T[];
}

/** Validates one batch from a ledger whose sequence is gapless by contract.
 * Call this before writing any row in the batch: a concurrent partition detach
 * then closes the stream at the last safe cursor instead of advancing past the
 * missing event. */
export function validateGaplessReplayBatch(input: {
  rows: ReadonlyArray<{ accountSeq: number }>;
  afterSeq: number;
  throughSeq: number;
  limit: number;
}): { ok: true; nextSeq: number; done: boolean } | { ok: false } {
  let nextSeq = input.afterSeq;
  for (const row of input.rows) {
    if (row.accountSeq !== nextSeq + 1 || row.accountSeq > input.throughSeq) {
      return { ok: false };
    }
    nextSeq = row.accountSeq;
  }
  if (input.rows.length < input.limit && nextSeq < input.throughSeq) {
    return { ok: false };
  }
  return { ok: true, nextSeq, done: nextSeq >= input.throughSeq };
}

export function projectionCheckpointHiddenCount(
  row: { type: string; data: unknown },
): number | null {
  if (row.type !== "stream.projection_checkpoint") return null;
  if (typeof row.data !== "object" || row.data === null || Array.isArray(row.data)) return null;
  const value = (row.data as Record<string, unknown>).hiddenCount;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * v2 may omit projection-only material rows, but only an immediately
 * following checkpoint can authorize that numeric sequence jump. Its exact
 * hiddenCount makes a detached business row distinguishable from an intended
 * skip without scanning the hidden range per connection.
 */
export function validateV2DeliverableReplayBatch(input: {
  rows: ReadonlyArray<{ accountSeq: number; type: string; data: unknown }>;
  afterSeq: number;
  throughSeq: number;
  limit: number;
}): { ok: true; nextSeq: number; done: boolean } | { ok: false } {
  let nextSeq = input.afterSeq;
  for (const row of input.rows) {
    if (row.accountSeq > input.throughSeq) return { ok: false };
    const gap = row.accountSeq - nextSeq - 1;
    if (gap < 0) return { ok: false };
    if (gap > 0) {
      const hiddenCount = projectionCheckpointHiddenCount(row);
      if (hiddenCount === null || hiddenCount !== gap) return { ok: false };
    } else if (row.type === "stream.projection_checkpoint") {
      const hiddenCount = projectionCheckpointHiddenCount(row);
      if (hiddenCount !== 0) return { ok: false };
    }
    nextSeq = row.accountSeq;
  }
  if (input.rows.length < input.limit && nextSeq < input.throughSeq) {
    return { ok: false };
  }
  return { ok: true, nextSeq, done: nextSeq >= input.throughSeq };
}

/**
 * Attaches the lossless live lane before reading the durable replay boundary.
 * An event committed before subscribe is then included by the fresh boundary;
 * one committed after subscribe is buffered (and may also replay, with the
 * stream's monotonic guard removing that harmless duplicate).
 */
export async function subscribeBeforeReplayBoundary<TBoundary>(input: {
  subscribe: () => () => void;
  loadBoundary: () => Promise<TBoundary>;
}): Promise<{ boundary: TBoundary; unsubscribe: () => void }> {
  const unsubscribe = input.subscribe();
  try {
    return {
      boundary: await input.loadBoundary(),
      unsubscribe,
    };
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

export function estimatedSseReplayItemBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") + 128;
  } catch {
    // A value that cannot be serialized cannot be safely retained for later
    // delivery. Treat it as an immediate overflow and close the connection.
    return Number.POSITIVE_INFINITY;
  }
}

export function createBoundedSseReplayBuffer<T>(input: {
  maxBytes: number;
  sizeOf?: (item: T) => number;
  onOverflow: () => void;
}): BoundedSseReplayBuffer<T> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new Error("SSE replay buffer maxBytes must be a positive safe integer");
  }
  const sizeOf = input.sizeOf ?? estimatedSseReplayItemBytes;
  let items: T[] = [];
  let bytes = 0;
  let overflowed = false;
  return {
    get overflowed() {
      return overflowed;
    },
    push(item) {
      if (overflowed) {
        return false;
      }
      const itemBytes = sizeOf(item);
      if (!Number.isFinite(itemBytes) || itemBytes < 0 || bytes + itemBytes > input.maxBytes) {
        overflowed = true;
        // Release the backlog before destroying the socket so concurrent stale
        // clients cannot retain one budget apiece until their DB replay exits.
        items = [];
        bytes = 0;
        input.onOverflow();
        return false;
      }
      items.push(item);
      bytes += itemBytes;
      return true;
    },
    drain() {
      if (overflowed) {
        return [];
      }
      const drained = items;
      items = [];
      bytes = 0;
      return drained;
    },
  };
}
