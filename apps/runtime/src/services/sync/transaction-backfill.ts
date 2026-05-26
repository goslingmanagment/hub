type TransactionBackfillBase = {
  mode: "backfill";
  completed: false;
  provider: "fansly" | "onlyfans";
  snapshotEnd: string;
  providerReportedTotal?: number | null;
  newestSeenAt: string | null;
  dirtyFrom: string | null;
  processedTransactions: number;
  processedChargebacks: number;
  transactionPages: number;
  chargebackPages: number;
};

export type FanslyTransactionBackfillState = TransactionBackfillBase & {
  provider: "fansly";
  phase: "transactions";
  offset: number;
  lastPageTransactionIds?: string[];
};

export type OnlyFansTransactionBackfillState = TransactionBackfillBase & {
  provider: "onlyfans";
  phase: "transactions" | "chargebacks";
  oldestSeenAt: string | null;
  cursor: string | null;
  start: string;
  fallbackStartUsed: boolean;
  windowEnd: string;
  windowPageCount: number;
  emptyWindowCount: number;
};

export type TransactionBackfillState =
  | FanslyTransactionBackfillState
  | OnlyFansTransactionBackfillState;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asIsoString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asNullableIsoString(value: unknown) {
  if (value === null) {
    return null;
  }
  return asIsoString(value);
}

function asNonNegativeInt(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function asNullableNonNegativeInt(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  return asNonNegativeInt(value);
}

function asBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function asNullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : null;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

export function parseTransactionBackfillState(value: unknown): TransactionBackfillState | null {
  const state = asRecord(value);
  if (!state || state.mode !== "backfill" || state.completed !== false) {
    return null;
  }

  const provider = state.provider;
  const snapshotEnd = asIsoString(state.snapshotEnd);
  const providerReportedTotal = asNullableNonNegativeInt(state.providerReportedTotal);
  const newestSeenAt = asNullableIsoString(state.newestSeenAt);
  const dirtyFrom = asNullableIsoString(state.dirtyFrom);
  const processedTransactions = asNonNegativeInt(state.processedTransactions);
  const processedChargebacks = asNonNegativeInt(state.processedChargebacks);
  const transactionPages = asNonNegativeInt(state.transactionPages);
  const chargebackPages = asNonNegativeInt(state.chargebackPages);

  if (
    snapshotEnd === null ||
    newestSeenAt === undefined ||
    dirtyFrom === undefined ||
    processedTransactions === null ||
    processedChargebacks === null ||
    transactionPages === null ||
    chargebackPages === null
  ) {
    return null;
  }

  if (provider === "fansly") {
    const offset = asNonNegativeInt(state.offset);
    const lastPageTransactionIds = state.lastPageTransactionIds === undefined
      ? []
      : asStringArray(state.lastPageTransactionIds);
    if (offset === null || state.phase !== "transactions") {
      return null;
    }
    if (lastPageTransactionIds === null) {
      return null;
    }

    return {
      mode: "backfill",
      completed: false,
      provider,
      phase: "transactions",
      snapshotEnd,
      providerReportedTotal,
      newestSeenAt,
      dirtyFrom,
      processedTransactions,
      processedChargebacks,
      transactionPages,
      chargebackPages,
      offset,
      lastPageTransactionIds,
    };
  }

  if (provider === "onlyfans") {
    const start = asIsoString(state.start);
    const oldestSeenAt = asNullableIsoString(state.oldestSeenAt);
    const fallbackStartUsed = asBoolean(state.fallbackStartUsed);
    const cursor = asNullableString(state.cursor);
    const windowEnd = asIsoString(state.windowEnd);
    const windowPageCount = asNonNegativeInt(state.windowPageCount);
    const emptyWindowCount = asNonNegativeInt(state.emptyWindowCount);
    if (
      start === null ||
      fallbackStartUsed === null ||
      cursor === undefined ||
      (state.phase !== "transactions" && state.phase !== "chargebacks")
    ) {
      return null;
    }

    return {
      mode: "backfill",
      completed: false,
      provider,
      phase: state.phase,
      snapshotEnd,
      providerReportedTotal,
      newestSeenAt,
      dirtyFrom,
      processedTransactions,
      processedChargebacks,
      transactionPages,
      chargebackPages,
      oldestSeenAt: oldestSeenAt ?? null,
      start,
      fallbackStartUsed,
      cursor,
      windowEnd: windowEnd ?? snapshotEnd,
      windowPageCount: windowPageCount ?? 0,
      emptyWindowCount: emptyWindowCount ?? 0,
    };
  }

  return null;
}

export function isoDateOrNull(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

export function buildBackfillProgressMessage(input: {
  provider: "fansly" | "onlyfans";
  phase: "transactions" | "chargebacks";
  page: number;
  processedTransactions: number;
  processedChargebacks?: number;
  oldestSeenAt?: Date | null;
  newestSeenAt?: Date | null;
}) {
  const parts = [
    "backfill progress:",
    `provider=${input.provider}`,
    `phase=${input.phase}`,
    `page=${input.page}`,
    `processedTransactions=${input.processedTransactions}`,
  ];

  if (typeof input.processedChargebacks === "number") {
    parts.push(`processedChargebacks=${input.processedChargebacks}`);
  }

  if (input.oldestSeenAt) {
    parts.push(`oldestSeen=${input.oldestSeenAt.toISOString()}`);
  }

  if (input.newestSeenAt) {
    parts.push(`newestSeen=${input.newestSeenAt.toISOString()}`);
  }

  return parts.join(" ");
}
