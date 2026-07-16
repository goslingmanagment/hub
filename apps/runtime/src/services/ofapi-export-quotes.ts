import type {
  OfapiExportQuoteBody,
  OfapiExportQuoteCreateResponse,
  OfapiExportQuoteStatusResponse,
} from "@agency_hub_core/contracts";
import {
  cancelBlockedOfapiExportQuoteJob,
  createOrGetOfapiCaptureJob,
  findActiveOfapiCaptureJobBySlot,
  findPageById,
  getOfapiCaptureJob,
  hashOfapiCaptureValue,
  settleOfapiCaptureParse,
  type OfapiCaptureJobRecord,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { ParsedOfapiJsonBody } from "./ofapi-capture-contract.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

// Vendor documents that large export scans may take several hours. Polling
// every 15 minutes for a full day stays bounded without making a second
// stateful create request merely because a normal quote exceeded 30 minutes.
const QUOTE_MAX_CALLS = 97;
const QUOTE_MAX_CREDITS = 5;
const QUOTE_POLL_INTERVAL_MS = 15 * 60_000;

type ExportQuoteProfile = "pilot_chats" | "fleet_tail";

interface ExportQuoteTarget extends Record<string, unknown> {
  profile: ExportQuoteProfile;
  type: "chat_messages";
  accountIds: [string];
  startDate: string;
  endDate: string;
  fileType: "csv";
  maxMessages: number;
  quoteTtlMinutes: number;
  chatIds: string[];
  autoStart: false;
}

interface ExportQuoteCursor extends Record<string, unknown> {
  phase: "quote_calculating" | "quoted" | "vendor_started_unexpectedly";
  vendorExportId: string;
  vendorStatus: string;
  pollCount: number;
  quoteRequestedAt: string;
  lastStatusAt: string;
  totalRows: number | null;
  creditCost: number | null;
  quotedAt: string | null;
  expiresAt: string | null;
  // A manually adopted create has no captured response lineage. The first
  // captured status GET replaces both nulls with real observation provenance.
  lastObservationId: number | null;
  lastObservationReceivedAt: string | null;
}

export interface OfapiExportQuoteRequestPlan {
  operation: "ofapi_export_quote_create" | "ofapi_export_quote_status";
  endpointClass: "data_exports";
  method: "GET" | "POST";
  requestSemantics: "safe_read" | "stateful";
  pathname: string;
  query: Record<string, string>;
  bodyBytes: Buffer | null;
  contentType: string | null;
  request: Record<string, unknown>;
  observationKind: "ofapi.data_export_create.v1" | "ofapi.data_export_status.v1";
  reservedCredits: 1;
  timeoutMs: number;
  maxResponseBytes: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonnegativeInteger(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function sameInstant(value: unknown, expected: string) {
  if (typeof value !== "string") return false;
  const actualMs = new Date(value).getTime();
  const expectedMs = new Date(expected).getTime();
  return Number.isFinite(actualMs) && actualMs === expectedMs;
}

function parseTarget(job: OfapiCaptureJobRecord): ExportQuoteTarget | null {
  const target = job.target;
  const profile = target.profile === "pilot_chats" || target.profile === "fleet_tail"
    ? target.profile
    : null;
  const accountIds = Array.isArray(target.accountIds) && target.accountIds.length === 1
    && typeof target.accountIds[0] === "string"
    ? [target.accountIds[0]] as [string]
    : null;
  const chatIds = Array.isArray(target.chatIds)
    && target.chatIds.every((id): id is string => typeof id === "string" && /^\d+$/.test(id))
    ? target.chatIds
    : null;
  if (
    profile === null
    || target.type !== "chat_messages"
    || accountIds === null
    || accountIds[0] !== job.ofapiAccountId
    || typeof target.startDate !== "string"
    || typeof target.endDate !== "string"
    || target.fileType !== "csv"
    || !Number.isInteger(target.maxMessages)
    || Number(target.maxMessages) < 1
    || Number(target.maxMessages) > 10_000_000
    || !Number.isInteger(target.quoteTtlMinutes)
    || Number(target.quoteTtlMinutes) < 60
    || Number(target.quoteTtlMinutes) > 10_080
    || chatIds === null
    || (profile === "pilot_chats" && (chatIds.length < 1 || chatIds.length > 3))
    || (profile === "fleet_tail" && chatIds.length !== 0)
    || target.autoStart !== false
  ) {
    return null;
  }
  return {
    profile,
    type: "chat_messages",
    accountIds,
    startDate: target.startDate,
    endDate: target.endDate,
    fileType: "csv",
    maxMessages: Number(target.maxMessages),
    quoteTtlMinutes: Number(target.quoteTtlMinutes),
    chatIds,
    autoStart: false,
  };
}

function parseCursor(job: OfapiCaptureJobRecord): ExportQuoteCursor | null {
  const cursor = job.cursor;
  if (!cursor) return null;
  const phase = cursor.phase === "quote_calculating"
      || cursor.phase === "quoted"
      || cursor.phase === "vendor_started_unexpectedly"
    ? cursor.phase
    : null;
  if (
    phase === null
    || typeof cursor.vendorExportId !== "string"
    || !/^data_export_[A-Za-z0-9_-]+$/.test(cursor.vendorExportId)
    || typeof cursor.vendorStatus !== "string"
    || nonnegativeInteger(cursor.pollCount) === null
    || typeof cursor.quoteRequestedAt !== "string"
    || typeof cursor.lastStatusAt !== "string"
    || (cursor.lastObservationId !== null
      && nonnegativeInteger(cursor.lastObservationId) === null)
    || (cursor.lastObservationReceivedAt !== null
      && typeof cursor.lastObservationReceivedAt !== "string")
    || ((cursor.lastObservationId === null) !== (cursor.lastObservationReceivedAt === null))
  ) {
    return null;
  }
  return {
    phase,
    vendorExportId: cursor.vendorExportId,
    vendorStatus: cursor.vendorStatus,
    pollCount: nonnegativeInteger(cursor.pollCount)!,
    quoteRequestedAt: cursor.quoteRequestedAt,
    lastStatusAt: cursor.lastStatusAt,
    totalRows: cursor.totalRows === null ? null : nonnegativeInteger(cursor.totalRows),
    creditCost: cursor.creditCost === null ? null : nonnegativeInteger(cursor.creditCost),
    quotedAt: typeof cursor.quotedAt === "string" ? cursor.quotedAt : null,
    expiresAt: typeof cursor.expiresAt === "string" ? cursor.expiresAt : null,
    lastObservationId: cursor.lastObservationId === null
      ? null
      : nonnegativeInteger(cursor.lastObservationId)!,
    lastObservationReceivedAt: cursor.lastObservationReceivedAt,
  };
}

function validateDateRange(input: OfapiExportQuoteBody, now: Date) {
  const start = new Date(input.startDate);
  const end = new Date(input.endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new BadRequestError("OFAPI export quote requires startDate before endDate");
  }
  if (end.getTime() > now.getTime() + 5 * 60_000) {
    throw new BadRequestError("OFAPI export quote endDate cannot be in the future");
  }
}

function normalizedChatIds(input: OfapiExportQuoteBody) {
  if (input.profile === "fleet_tail") return [];
  const unique = [...new Set(input.chatIds)];
  if (unique.length !== input.chatIds.length) {
    throw new BadRequestError("OFAPI export quote chatIds must be unique");
  }
  for (const id of unique) {
    const numeric = Number(id);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
      throw new BadRequestError(`OFAPI export quote chatId ${id} is outside the safe range`);
    }
  }
  return unique;
}

export async function createOwnerOfapiExportQuote(
  app: AppContext,
  input: OfapiExportQuoteBody & { actorUserId: number; now?: Date },
): Promise<OfapiExportQuoteCreateResponse> {
  const now = input.now ?? new Date();
  validateDateRange(input, now);
  const page = await findPageById(app.db, input.pageId);
  if (!page || page.page.platform !== "onlyfans") {
    throw new NotFoundError(`Active OnlyFans page ${input.pageId} was not found`);
  }
  const ofapiAccountId = page.page.ofapiAccountId;
  if (!ofapiAccountId) {
    throw new ConflictError(`OnlyFans page ${input.pageId} has no OFAPI account mapping`);
  }
  const chatIds = normalizedChatIds(input);
  const target: ExportQuoteTarget = {
    profile: input.profile,
    type: "chat_messages",
    accountIds: [ofapiAccountId],
    startDate: new Date(input.startDate).toISOString(),
    endDate: new Date(input.endDate).toISOString(),
    fileType: "csv",
    maxMessages: input.maxMessages,
    quoteTtlMinutes: input.quoteTtlMinutes,
    chatIds,
    autoStart: false,
  };
  const activeSlotKey = `page:${input.pageId}:export`;
  const targetHash = hashOfapiCaptureValue(target);
  const active = await findActiveOfapiCaptureJobBySlot(app.db, activeSlotKey);
  if (active && active.targetHash !== targetHash) {
    throw new ConflictError(
      `Active export job ${active.id} has a different frozen target for page ${input.pageId}`,
    );
  }
  const dryRun = input.dryRun !== false;
  if (dryRun) {
    return {
      dryRun: true,
      status: active ? "would_coalesce" : "would_create",
      jobId: active?.id ?? null,
      pageId: input.pageId,
      profile: input.profile,
      targetHash,
      state: active?.state ?? null,
      reasonCode: active?.reasonCode ?? null,
    };
  }

  const created = await createOrGetOfapiCaptureJob(app.db, {
    pageId: input.pageId,
    ofapiAccountId,
    kind: "account_export",
    activeSlotKey,
    target,
    manifest: {
      version: "ofapi-export-quote-v1",
      actorUserId: input.actorUserId,
      profile: input.profile,
      maxCalls: QUOTE_MAX_CALLS,
      maxCredits: QUOTE_MAX_CREDITS,
      autoStart: false,
    },
    budgetScope: "bulk",
    originPrincipalId: input.actorUserId,
    createdBy: "owner",
    maxCalls: QUOTE_MAX_CALLS,
    maxCredits: QUOTE_MAX_CREDITS,
    now,
  });
  if (created.job.targetHash !== targetHash) {
    throw new ConflictError(`Export job ${created.job.id} has a different frozen target`);
  }
  return {
    dryRun: false,
    status: created.created ? "created" : "coalesced",
    jobId: created.job.id,
    pageId: input.pageId,
    profile: input.profile,
    targetHash,
    state: created.job.state,
    reasonCode: created.job.reasonCode,
  };
}

export async function getOwnerOfapiExportQuoteStatus(
  app: AppContext,
  jobId: string,
): Promise<OfapiExportQuoteStatusResponse> {
  const job = await getOfapiCaptureJob(app.db, jobId);
  if (!job || job.kind !== "account_export") {
    throw new NotFoundError(`OFAPI export quote job ${jobId} was not found`);
  }
  const target = parseTarget(job);
  if (!target) throw new ConflictError(`OFAPI export quote job ${jobId} has an invalid target`);
  const cursor = parseCursor(job);
  return {
    jobId: job.id,
    pageId: job.pageId,
    profile: target.profile,
    targetHash: job.targetHash,
    state: job.state,
    reasonCode: job.reasonCode,
    reasonMessage: job.reasonMessage,
    attemptCount: job.attemptCount,
    dispatchCount: job.dispatchCount,
    spentCredits: job.spentCredits,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    quote: cursor === null
      ? null
      : {
        vendorExportId: cursor.vendorExportId,
        vendorStatus: cursor.vendorStatus,
        totalRows: cursor.totalRows,
        creditCost: cursor.creditCost,
        pollCount: cursor.pollCount,
        quotedAt: cursor.quotedAt,
        expiresAt: cursor.expiresAt,
      },
  };
}

export async function cancelOwnerOfapiExportQuote(
  app: AppContext,
  input: { jobId: string; actorUserId: number; reason: string },
) {
  const job = await getOfapiCaptureJob(app.db, input.jobId);
  if (!job || job.kind !== "account_export") {
    throw new NotFoundError(`OFAPI export quote job ${input.jobId} was not found`);
  }
  const cancelled = await cancelBlockedOfapiExportQuoteJob(app.db, input);
  if (!cancelled.cancelled) {
    throw new ConflictError(
      `OFAPI export quote ${input.jobId} is not safely cancellable; `
        + "only captured quotes or explicit vendor failures can release the create slot",
    );
  }
  return getOwnerOfapiExportQuoteStatus(app, input.jobId);
}

export function buildOfapiExportQuoteRequest(
  job: OfapiCaptureJobRecord,
): OfapiExportQuoteRequestPlan | null {
  if (job.state !== "leased") return null;
  const target = parseTarget(job);
  if (!target) return null;
  const cursor = parseCursor(job);
  if (cursor === null && job.cursor !== null) return null;
  if (cursor === null) {
    const body = {
      type: target.type,
      account_ids: target.accountIds,
      start_date: target.startDate,
      end_date: target.endDate,
      file_type: target.fileType,
      options: {
        maxMessages: target.maxMessages,
        skipMassMessages: false,
        ...(target.chatIds.length > 0
          ? { chatIds: target.chatIds.map((id) => Number(id)) }
          : {}),
      },
      auto_start: false,
    };
    return {
      operation: "ofapi_export_quote_create",
      endpointClass: "data_exports",
      method: "POST",
      requestSemantics: "stateful",
      pathname: "/data-exports",
      query: {},
      bodyBytes: Buffer.from(JSON.stringify(body)),
      contentType: "application/json",
      request: { body },
      observationKind: "ofapi.data_export_create.v1",
      reservedCredits: 1,
      timeoutMs: 65_000,
      maxResponseBytes: 1024 * 1024,
    };
  }
  if (cursor.phase !== "quote_calculating") return null;
  return {
    operation: "ofapi_export_quote_status",
    endpointClass: "data_exports",
    method: "GET",
    requestSemantics: "safe_read",
    pathname: `/data-exports/${encodeURIComponent(cursor.vendorExportId)}`,
    query: {},
    bodyBytes: null,
    contentType: null,
    request: { vendorExportId: cursor.vendorExportId },
    observationKind: "ofapi.data_export_status.v1",
    reservedCredits: 1,
    timeoutMs: 30_000,
    maxResponseBytes: 1024 * 1024,
  };
}

function responseIdentity(
  job: OfapiCaptureJobRecord,
  target: ExportQuoteTarget,
  body: unknown,
  requireAccounts: boolean,
): { data: Record<string, unknown>; id: string; status: string } | null {
  const root = asRecord(body);
  const data = asRecord(root?.data);
  const id = typeof data?.id === "string" ? data.id : null;
  const status = typeof data?.status === "string" ? data.status : null;
  if (
    !data
    || !id
    || id.length > 200
    || !/^data_export_[A-Za-z0-9_-]+$/.test(id)
    || !status
    || data.type !== target.type
    || data.file_type !== target.fileType
    || !sameInstant(data.start_date, target.startDate)
    || !sameInstant(data.end_date, target.endDate)
  ) {
    return null;
  }
  const accounts = data.accounts;
  if (accounts === undefined) {
    if (requireAccounts) return null;
  } else {
    if (!Array.isArray(accounts)) return null;
    const ids = accounts.flatMap((account) => {
      const record = asRecord(account);
      return typeof record?.id === "string" ? [record.id] : [];
    });
    if (ids.length !== 1 || ids[0] !== job.ofapiAccountId) return null;
  }
  return { data, id, status };
}

export async function parseCapturedOfapiExportQuote(
  app: AppContext,
  input: {
    job: OfapiCaptureJobRecord;
    attemptId: string;
    observationId: number;
    observationReceivedAt: Date;
    status: number;
    headers: Record<string, string>;
    parsedJson: ParsedOfapiJsonBody;
    now?: Date;
  },
): Promise<"success" | "failed" | "blocked"> {
  const { job } = input;
  const now = input.now ?? new Date();
  if (!job.leaseToken) return "failed";
  const target = parseTarget(job);
  const priorCursor = parseCursor(job);
  const isStatusPoll = priorCursor?.phase === "quote_calculating";
  const settle = (args: Parameters<typeof settleOfapiCaptureParse>[1]) =>
    settleOfapiCaptureParse(app.db, args);

  if (input.status < 200 || input.status >= 300) {
    const retryable = isStatusPoll && (input.status === 429 || input.status >= 500);
    await settle({
      jobId: job.id,
      attemptId: input.attemptId,
      leaseToken: job.leaseToken,
      observationId: input.observationId,
      observationReceivedAt: input.observationReceivedAt,
      parserOutcome: "intentional_noop",
      rawCount: 0,
      acceptedCount: 0,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: retryable
        ? {
          kind: "retry",
          nextAttemptAt: new Date(now.getTime() + QUOTE_POLL_INTERVAL_MS),
          reasonCode: input.status === 429 ? "rate_limited" : "vendor_5xx",
        }
        : {
          kind: "blocked",
          reasonCode: isStatusPoll
            ? `export_status_http_${input.status}`
            : `export_create_http_${input.status}`,
          reasonMessage: "Captured export response requires owner review; no POST was retried",
        },
      now,
    });
    return retryable ? "failed" : "blocked";
  }

  const identity = input.parsedJson.validJson && target
    ? responseIdentity(job, target, input.parsedJson.body, isStatusPoll)
    : null;
  if (!identity || !target || (priorCursor && identity.id !== priorCursor.vendorExportId)) {
    await settle({
      jobId: job.id,
      attemptId: input.attemptId,
      leaseToken: job.leaseToken,
      observationId: input.observationId,
      observationReceivedAt: input.observationReceivedAt,
      parserOutcome: "contract_rejected",
      rawCount: 1,
      acceptedCount: 0,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 1,
      disposition: { kind: "blocked", reasonCode: "export_contract_rejected" },
      now,
    });
    return "blocked";
  }

  const baseCursor = {
    vendorExportId: identity.id,
    vendorStatus: identity.status,
    pollCount: (priorCursor?.pollCount ?? 0) + (isStatusPoll ? 1 : 0),
    quoteRequestedAt: priorCursor?.quoteRequestedAt ?? now.toISOString(),
    lastStatusAt: now.toISOString(),
    totalRows: priorCursor?.totalRows ?? null,
    creditCost: priorCursor?.creditCost ?? null,
    quotedAt: priorCursor?.quotedAt ?? null,
    expiresAt: priorCursor?.expiresAt ?? null,
    lastObservationId: input.observationId,
    lastObservationReceivedAt: input.observationReceivedAt.toISOString(),
  };
  if (identity.status === "calculating_credits") {
    const cursor: ExportQuoteCursor = { ...baseCursor, phase: "quote_calculating" };
    await settle({
      jobId: job.id,
      attemptId: input.attemptId,
      leaseToken: job.leaseToken,
      observationId: input.observationId,
      observationReceivedAt: input.observationReceivedAt,
      parserOutcome: "accepted",
      rawCount: 1,
      acceptedCount: 1,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: {
        kind: "retry",
        nextAttemptAt: new Date(now.getTime() + QUOTE_POLL_INTERVAL_MS),
        reasonCode: "quote_calculating",
        cursor,
      },
      now,
    });
    return "success";
  }

  if (identity.status === "calculating_credits_completed") {
    const totalRows = nonnegativeInteger(identity.data.total_rows);
    const creditCost = nonnegativeInteger(identity.data.credit_cost);
    if (totalRows === null || creditCost === null) {
      await settle({
        jobId: job.id,
        attemptId: input.attemptId,
        leaseToken: job.leaseToken,
        observationId: input.observationId,
        observationReceivedAt: input.observationReceivedAt,
        parserOutcome: "contract_rejected",
        rawCount: 1,
        acceptedCount: 0,
        boundaryDuplicateCount: 0,
        explicitlyIrrelevantCount: 0,
        rejectedCount: 1,
        disposition: { kind: "blocked", reasonCode: "export_quote_missing_cost" },
        now,
      });
      return "blocked";
    }
    const quotedAt = now.toISOString();
    const cursor: ExportQuoteCursor = {
      ...baseCursor,
      phase: "quoted",
      totalRows,
      creditCost,
      quotedAt,
      expiresAt: new Date(now.getTime() + target.quoteTtlMinutes * 60_000).toISOString(),
    };
    await settle({
      jobId: job.id,
      attemptId: input.attemptId,
      leaseToken: job.leaseToken,
      observationId: input.observationId,
      observationReceivedAt: input.observationReceivedAt,
      parserOutcome: "accepted",
      rawCount: 1,
      acceptedCount: 1,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: {
        kind: "blocked",
        reasonCode: "owner_approval_required",
        reasonMessage: "Quote captured; this implementation cannot start an export",
        cursor,
      },
      now,
    });
    return "blocked";
  }

  if (identity.status === "calculating_credits_failed" || identity.status === "failed") {
    await settle({
      jobId: job.id,
      attemptId: input.attemptId,
      leaseToken: job.leaseToken,
      observationId: input.observationId,
      observationReceivedAt: input.observationReceivedAt,
      parserOutcome: "accepted",
      rawCount: 1,
      acceptedCount: 1,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: {
        kind: "blocked",
        reasonCode: "export_quote_failed",
        reasonMessage: typeof identity.data.failed_reason === "string"
          ? identity.data.failed_reason.slice(0, 500)
          : "Vendor quote calculation failed",
        cursor: { ...baseCursor, phase: "quote_calculating" },
      },
      now,
    });
    return "blocked";
  }

  if (["pending", "in_progress", "completed"].includes(identity.status)) {
    await settle({
      jobId: job.id,
      attemptId: input.attemptId,
      leaseToken: job.leaseToken,
      observationId: input.observationId,
      observationReceivedAt: input.observationReceivedAt,
      parserOutcome: "accepted",
      rawCount: 1,
      acceptedCount: 1,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: 0,
      disposition: {
        kind: "blocked",
        reasonCode: "export_started_without_approval",
        reasonMessage: "Vendor reports a started export although auto_start was false",
        cursor: { ...baseCursor, phase: "vendor_started_unexpectedly" },
      },
      now,
    });
    return "blocked";
  }

  await settle({
    jobId: job.id,
    attemptId: input.attemptId,
    leaseToken: job.leaseToken,
    observationId: input.observationId,
    observationReceivedAt: input.observationReceivedAt,
    parserOutcome: "contract_rejected",
    rawCount: 1,
    acceptedCount: 0,
    boundaryDuplicateCount: 0,
    explicitlyIrrelevantCount: 0,
    rejectedCount: 1,
    disposition: {
      kind: "blocked",
      reasonCode: "export_status_unknown",
      reasonMessage: identity.status.slice(0, 200),
    },
    now,
  });
  return "blocked";
}
