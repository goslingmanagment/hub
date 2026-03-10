type TimestampValue = Date | string | null | undefined;

type SyncRunRow = {
  runId: number;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  stream: string;
  trigger: string;
  status: string;
  startedAt: TimestampValue;
  finishedAt: TimestampValue;
  errorSummary: string | null;
  stats: Record<string, unknown>;
  lastActivityAt?: TimestampValue;
};

type SyncRunEventRow = {
  id: number;
  runId: number;
  pageLabel: string;
  provider: "fansly" | "onlyfans";
  stream: string;
  eventType: string;
  severity: "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown>;
  emittedAt: TimestampValue;
};

type SyncRequestAttemptRow = {
  attemptId: number;
  runId: number;
  pageLabel: string;
  provider: "fansly" | "onlyfans";
  stream: string;
  operation: string;
  logicalRequestId: string;
  attemptNumber: number;
  state: string;
  failureKind: string | null;
  httpStatus: number | null;
  retryDelayMs: number | null;
  durationMs: number | null;
  requestShape: Record<string, unknown>;
  responseShape: Record<string, unknown>;
  errorMessage: string | null;
  startedAt: TimestampValue;
  finishedAt: TimestampValue;
};

const DATE_PLACEHOLDER = "-";

function statsObject(stats: Record<string, unknown> | null | undefined, key: string) {
  const value = stats?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function statsArray(stats: Record<string, unknown> | null | undefined, key: string) {
  const value = stats?.[key];
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

function asNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parseDate(value: TimestampValue) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function firstValidDate(...values: TimestampValue[]) {
  for (const value of values) {
    const parsed = parseDate(value);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function formatDate(value: TimestampValue) {
  return parseDate(value)?.toISOString() ?? DATE_PLACEHOLDER;
}

function formatDuration(startedAt: TimestampValue, finishedAt: TimestampValue, now = new Date()) {
  const start = parseDate(startedAt);
  if (!start) {
    return DATE_PLACEHOLDER;
  }

  const end = finishedAt === null || finishedAt === undefined ? now : parseDate(finishedAt);
  if (!end) {
    return DATE_PLACEHOLDER;
  }

  const ms = Math.max(0, end.getTime() - start.getTime());
  return formatMs(ms);
}

function formatMs(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m${remainder}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function formatAge(since: TimestampValue, now = new Date()) {
  const parsed = parseDate(since);
  return parsed ? formatMs(Math.max(0, now.getTime() - parsed.getTime())) : DATE_PLACEHOLDER;
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function summarizeHealth(stats: Record<string, unknown>) {
  return asString(stats.health) ?? "";
}

function summarizeRequests(stats: Record<string, unknown>) {
  const totals = statsObject(stats, "requestTotals");
  return {
    totalAttempts: asNumber(totals?.totalAttempts) ?? 0,
    retryAttempts: asNumber(totals?.retryAttempts) ?? 0,
    failedAttempts: asNumber(totals?.failedAttempts) ?? 0,
    logicalRequests: asNumber(totals?.logicalRequests) ?? 0,
  };
}

function summarizeBoundary(stats: Record<string, unknown>) {
  const boundary = statsObject(stats, "boundary");
  if (!boundary) {
    return "";
  }
  const requested = asString(boundary.requestedLowerBound);
  const kind = asString(boundary.kind);
  const pages = asNumber(boundary.olderThanBoundaryPages);
  const older = asNumber(boundary.olderThanBoundaryItems);
  const parts = [
    kind,
    requested ? requested.slice(0, 19) : null,
    older !== null ? `old:${older}` : null,
    pages !== null ? `old_pages:${pages}` : null,
  ].filter(Boolean);
  return parts.join(" ");
}

function summarizeScan(stats: Record<string, unknown>) {
  const scan = statsObject(stats, "scan");
  if (!scan) {
    return "";
  }
  const transactionPages = asNumber(scan.transactionPages);
  if (transactionPages !== null) {
    const chargebackPages = asNumber(scan.chargebackPages);
    const processedTransactions = asNumber(scan.processedTransactions);
    const processedChargebacks = asNumber(scan.processedChargebacks);
    return [
      `txp:${transactionPages}`,
      chargebackPages !== null ? `cbp:${chargebackPages}` : null,
      processedTransactions !== null ? `tx:${processedTransactions}` : null,
      processedChargebacks !== null ? `cb:${processedChargebacks}` : null,
    ].filter(Boolean).join(" ");
  }
  const incrementalPages = asNumber(scan.incrementalPages);
  if (incrementalPages !== null) {
    return [
      `inc:${incrementalPages}`,
      `rec:${asNumber(scan.reconcilePages) ?? 0}`,
      asString(scan.stopReason),
      `delta:${asNumber(scan.delta) ?? 0}`,
    ].filter(Boolean).join(" ");
  }
  const subscriberPages = asNumber(scan.subscriberPages);
  if (subscriberPages !== null) {
    return [
      `subp:${subscriberPages}`,
      `active:${asNumber(scan.activeSubscribers) ?? 0}`,
    ].join(" ");
  }
  return "";
}

function summarizeCheckpoint(stats: Record<string, unknown>) {
  const checkpoint = statsObject(stats, "checkpoint");
  if (!checkpoint) {
    return "";
  }
  const advanced = statsObject(checkpoint, "advanced");
  const after = statsObject(checkpoint, "after");
  const labels = Object.keys(advanced ?? {});
  if (labels.length === 0) {
    return "";
  }
  const advancedLabels = labels.filter((label) => advanced?.[label] === true);
  const label = advancedLabels[0] ?? labels[0]!;
  const afterEntry = after?.[label];
  const afterSummary = afterEntry && typeof afterEntry === "object"
    ? afterEntry as Record<string, unknown>
    : null;
  const cursorText = asString(afterSummary?.cursorText);
  const cursorTimestamp = asString(afterSummary?.cursorTimestamp);
  const status = advancedLabels.length > 0 ? `advanced:${advancedLabels.join(",")}` : "unchanged";
  return [status, cursorTimestamp ? cursorTimestamp.slice(0, 19) : cursorText].filter(Boolean).join(" ");
}

function summarizeAnomalies(stats: Record<string, unknown>) {
  const anomalies = statsArray(stats, "anomalies")
    .map((entry) => asString(entry.code))
    .filter((code): code is string => Boolean(code));
  if (anomalies.length === 0) {
    return "";
  }
  if (anomalies.length <= 3) {
    return anomalies.join(",");
  }
  return `${anomalies.slice(0, 3).join(",")}+${anomalies.length - 3}`;
}

function pad(value: string, width: number) {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, " ");
}

export function buildStatusRows(rows: SyncRunRow[]) {
  return rows.map((row) => {
    const requestTotals = summarizeRequests(row.stats);
    return [
      row.runId,
      row.pageLabel,
      row.stream,
      row.trigger,
      row.status,
      summarizeHealth(row.stats),
      formatDuration(row.startedAt, row.finishedAt),
      requestTotals.totalAttempts,
      requestTotals.retryAttempts,
      requestTotals.failedAttempts,
      summarizeBoundary(row.stats) || summarizeScan(row.stats),
      summarizeCheckpoint(row.stats),
      summarizeAnomalies(row.stats),
    ];
  });
}

export function renderStatusDetail(input: {
  run: SyncRunRow;
  events: SyncRunEventRow[];
  attempts: SyncRequestAttemptRow[];
}) {
  const { run, events, attempts } = input;
  const requestTotals = summarizeRequests(run.stats);
  const anomalies = statsArray(run.stats, "anomalies");
  const notes = (run.stats.notes as string[] | undefined) ?? [];
  const telemetryWarnings = (run.stats.telemetryWarnings as string[] | undefined) ?? [];
  const hydration = statsObject(run.stats, "hydration");
  const lines = [
    `Run ${run.runId} ${run.pageLabel} ${run.stream}`,
    `Status: ${run.status}  Health: ${summarizeHealth(run.stats) || "unknown"}`,
    `Started: ${formatDate(run.startedAt)}`,
    `Finished: ${formatDate(run.finishedAt)}`,
    `Duration: ${formatDuration(run.startedAt, run.finishedAt)}`,
    `Requests: attempts=${requestTotals.totalAttempts} logical=${requestTotals.logicalRequests} retries=${requestTotals.retryAttempts} failed=${requestTotals.failedAttempts}`,
    `Boundary: ${summarizeBoundary(run.stats) || "-"}`,
    `Scan: ${summarizeScan(run.stats) || "-"}`,
    `Checkpoint: ${summarizeCheckpoint(run.stats) || "-"}`,
    `Hydration: ${hydration ? JSON.stringify(hydration) : "-"}`,
  ];

  if (run.errorSummary) {
    lines.push(`Error: ${run.errorSummary}`);
  }

  if (anomalies.length > 0) {
    lines.push("Anomalies:");
    for (const anomaly of anomalies) {
      lines.push(`- [${asString(anomaly.severity) ?? "warn"}] ${asString(anomaly.code) ?? "unknown"} ${asString(anomaly.message) ?? ""}`.trim());
    }
  }

  if (notes.length > 0) {
    lines.push("Notes:");
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }

  if (telemetryWarnings.length > 0) {
    lines.push("Telemetry Warnings:");
    for (const warning of telemetryWarnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (events.length > 0) {
    lines.push("Events:");
    for (const event of events) {
      lines.push(`- ${formatDate(event.emittedAt)} [${event.severity}] ${event.eventType} ${event.message}`);
    }
  }

  if (attempts.length > 0) {
    lines.push("Request Attempts:");
    for (const attempt of attempts) {
      const summary = [
        formatDate(attempt.startedAt),
        attempt.operation,
        `#${attempt.attemptNumber}`,
        attempt.state,
        attempt.httpStatus ? `http=${attempt.httpStatus}` : null,
        attempt.failureKind ? `failure=${attempt.failureKind}` : null,
        typeof attempt.durationMs === "number" ? `${attempt.durationMs}ms` : null,
      ].filter(Boolean).join(" ");
      lines.push(`- ${summary}`);
    }
  }

  return lines.join("\n");
}

function findActiveAttempt(
  attempts: SyncRequestAttemptRow[],
  runId: number,
) {
  return attempts.find((attempt) => attempt.runId === runId);
}

function isRunStalled(
  run: SyncRunRow,
  activeAttempt: SyncRequestAttemptRow | undefined,
  now = new Date(),
) {
  const lastActivityAt = firstValidDate(run.lastActivityAt, run.startedAt);
  if (lastActivityAt && now.getTime() - lastActivityAt.getTime() > 45_000) {
    return true;
  }
  const attemptStartedAt = activeAttempt ? parseDate(activeAttempt.startedAt) : null;
  if (attemptStartedAt && now.getTime() - attemptStartedAt.getTime() > 35_000) {
    return true;
  }
  return false;
}

export function listStalledRuns(snapshot: {
  runningRuns: SyncRunRow[];
  inflightAttempts: SyncRequestAttemptRow[];
}, now = new Date()) {
  return snapshot.runningRuns.filter((run) => {
    const activeAttempt = findActiveAttempt(snapshot.inflightAttempts, run.runId);
    return isRunStalled(run, activeAttempt, now);
  });
}

export function renderWatchTty(snapshot: {
  runningRuns: SyncRunRow[];
  recentRuns: SyncRunRow[];
  inflightAttempts: SyncRequestAttemptRow[];
  events: SyncRunEventRow[];
}, now = new Date()) {
  const lines = [
    `Sync Watch ${now.toISOString()}`,
    "",
    "Active Runs",
  ];

  if (snapshot.runningRuns.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(
      `${pad("run", 8)} ${pad("page", 16)} ${pad("stream", 12)} ${pad("status", 10)} ${pad("age", 8)} ${pad("last", 8)} ${pad("request", 18)} anomaly`,
    );
    for (const run of snapshot.runningRuns) {
      const activeAttempt = findActiveAttempt(snapshot.inflightAttempts, run.runId);
      const stalled = isRunStalled(run, activeAttempt, now);
      const status = stalled ? "stalled" : run.status;
      const request = activeAttempt
        ? `${activeAttempt.operation}#${activeAttempt.attemptNumber}`
        : "-";
      lines.push(
        `${pad(String(run.runId), 8)} ${pad(run.pageLabel, 16)} ${pad(run.stream, 12)} ${pad(status, 10)} ${pad(formatDuration(run.startedAt, null, now), 8)} ${pad(formatAge(run.lastActivityAt ?? run.startedAt, now), 8)} ${pad(request, 18)} ${summarizeAnomalies(run.stats)}`,
      );
    }
  }

  lines.push("", "Recent Runs");
  lines.push(
    `${pad("run", 8)} ${pad("page", 16)} ${pad("stream", 12)} ${pad("status", 10)} ${pad("health", 12)} ${pad("dur", 8)} ${pad("req", 5)} anomalies`,
  );
  for (const row of snapshot.recentRuns.slice(0, 10)) {
    const requestTotals = summarizeRequests(row.stats);
    lines.push(
      `${pad(String(row.runId), 8)} ${pad(row.pageLabel, 16)} ${pad(row.stream, 12)} ${pad(row.status, 10)} ${pad(summarizeHealth(row.stats), 12)} ${pad(formatDuration(row.startedAt, row.finishedAt, now), 8)} ${pad(String(requestTotals.totalAttempts), 5)} ${summarizeAnomalies(row.stats)}`,
    );
  }

  lines.push("", "Recent Events");
  for (const event of snapshot.events.slice(-10)) {
    lines.push(`${formatDate(event.emittedAt)} [${event.severity}] ${event.pageLabel}/${event.stream} ${event.eventType} ${event.message}`);
  }

  return lines.join("\n");
}

export function renderWatchEventLine(event: SyncRunEventRow) {
  return `${formatDate(event.emittedAt)} run=${event.runId} page=${event.pageLabel} stream=${event.stream} event=${event.eventType} severity=${event.severity} ${event.message}`;
}

export function renderSyntheticStallLine(run: SyncRunRow, now = new Date()) {
  return `${now.toISOString()} run=${run.runId} page=${run.pageLabel} stream=${run.stream} event=stalled severity=warn No request or event activity for >45s`;
}

export function formatRows(headers: string[], rows: Array<unknown[]>) {
  return [
    headers.join("\t"),
    ...rows.map((row) => row.map((value) => formatValue(value)).join("\t")),
  ].join("\n");
}
