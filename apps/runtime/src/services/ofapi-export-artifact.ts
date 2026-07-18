import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  OfapiExportArtifactCaptureBody,
  OfapiExportArtifactCaptureResponse,
} from "@agency_hub_core/contracts";
import {
  blockOfapiCaptureJobLease,
  completeOfapiExportImportJobLease,
  createOrGetOfapiCaptureJob,
  getOfapiCaptureJob,
  hashOfapiCaptureValue,
  insertObservation,
  markObservationParsed,
  markOfapiExportArtifactCaptured,
  type Database,
  type OfapiCaptureJobRecord,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { OFAPI_CAPTURE_MATERIALIZER_VERSION } from "./ofapi-capture-materialization.ts";
import {
  effectiveOfapiExportEndDate,
  parseOfapiExportCursor,
  parseOfapiExportTarget,
} from "./ofapi-export-quotes.ts";
import { appendOfapiMessageMaterialPage } from "./ofapi-message-material.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

const MAX_PILOT_ARTIFACT_BYTES = 16 * 1024 * 1024;

export const OFAPI_CHAT_EXPORT_COLUMNS = [
  "account_id",
  "account_name",
  "account_username",
  "sent_by",
  "fan_id",
  "fan_username",
  "fan_name",
  "chat_id",
  "message_id",
  "message_text",
  "giphy_id",
  "locked_text",
  "price",
  "tip_amount",
  "is_free",
  "is_tip",
  "is_opened",
  "is_from_queue",
  "is_new",
  "is_reported_by_me",
  "is_couple_people_media",
  "is_markdown_disabled",
  "is_pinned",
  "is_liked",
  "is_media_ready",
  "media_count",
  "cancel_seconds",
  "can_purchase",
  "can_purchase_reason",
  "can_report",
  "can_be_pinned",
  "onlyfans_created_at",
  "onlyfans_changed_at",
] as const;

interface ExportArtifactTarget extends Record<string, unknown> {
  version: "ofapi-export-import-v1";
  exportJobId: string;
  profile: "pilot_chats";
  fileName: string;
  sha256: string;
  byteSize: number;
  rowCount: number;
  artifactObservationId: number;
  artifactObservationReceivedAt: string;
  chatIds: string[];
  startDate: string;
  endDate: string;
}

interface InspectedArtifact {
  fileName: string;
  sha256: string;
  byteSize: number;
  rowCount: number;
  chatCount: number;
  minCreatedAt: Date | null;
  maxCreatedAt: Date | null;
  groups: Array<{ chatId: string; items: Record<string, unknown>[] }>;
}

function parseCsv(textInput: string): string[][] {
  const text = textInput.charCodeAt(0) === 0xfeff ? textInput.slice(1) : textInput;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;

  const finishField = () => {
    row.push(field);
    field = "";
    justClosedQuote = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (justClosedQuote && char !== "," && char !== "\n" && char !== "\r") {
      throw new Error("CSV has trailing characters after a closing quote");
    }
    if (char === '"') {
      if (field.length !== 0) throw new Error("CSV quote started inside an unquoted field");
      quoted = true;
    } else if (char === ",") {
      finishField();
    } else if (char === "\n") {
      finishRow();
    } else if (char === "\r" && text[index + 1] === "\n") {
      // The following LF terminates the record.
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV ended inside a quoted field");
  if (field.length > 0 || row.length > 0) finishRow();
  return rows;
}

function strictBoolean(value: string, field: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`CSV ${field} must be true or false`);
}

function nonnegativeMoney(value: string, field: string) {
  if (value === "" && field === "tip_amount") return 0;
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) {
    throw new Error(`CSV ${field} is not non-negative decimal money`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`CSV ${field} is invalid`);
  return parsed;
}

export function parseOfapiExportCsvTimestamp(value: string, field: string, nullable = false) {
  if (nullable && value === "") return null;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
  );
  if (!match) {
    throw new Error(`CSV ${field} has an unknown timestamp shape`);
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((component) => Number(component)) as [number, number, number, number, number, number];
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  parsed.setUTCHours(hour, minute, second, 0);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
    || parsed.getUTCHours() !== hour
    || parsed.getUTCMinutes() !== minute
    || parsed.getUTCSeconds() !== second
  ) {
    throw new Error(`CSV ${field} is invalid`);
  }
  return parsed;
}

function positiveNumericId(value: string, field: string) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`CSV ${field} must be a positive numeric id`);
  return value;
}

function artifactFilePath(artifactDir: string, exportJobId: string) {
  const fileName = `${exportJobId}.csv`;
  const root = path.resolve(artifactDir);
  const resolved = path.resolve(root, fileName);
  if (path.dirname(resolved) !== root) throw new Error("Artifact path escaped its configured root");
  return { fileName, resolved };
}

async function inspectPilotArtifact(input: {
  artifactDir: string;
  exportJobId: string;
  expectedAccountId: string;
  expectedChatIds: readonly string[];
  expectedRows: number;
  expectedStartDate: string;
  expectedEndDate: string;
  expectedSha256?: string;
  expectedByteSize?: number;
}): Promise<InspectedArtifact> {
  const location = artifactFilePath(input.artifactDir, input.exportJobId);
  const fileStat = await stat(location.resolved);
  if (!fileStat.isFile() || fileStat.size < 1 || fileStat.size > MAX_PILOT_ARTIFACT_BYTES) {
    throw new Error("Pilot artifact must be a non-empty regular file no larger than 16 MiB");
  }
  if (input.expectedByteSize !== undefined && fileStat.size !== input.expectedByteSize) {
    throw new Error("Pilot artifact byte size changed after registration");
  }
  const bytes = await readFile(location.resolved);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) {
    throw new Error("Pilot artifact checksum changed after registration");
  }
  const records = parseCsv(bytes.toString("utf8"));
  const header = records.shift() ?? [];
  if (header.join("\u0000") !== OFAPI_CHAT_EXPORT_COLUMNS.join("\u0000")) {
    throw new Error("OFAPI chat-export CSV header drifted from the accepted contract");
  }
  if (records.length !== input.expectedRows || records.length > 1_000) {
    throw new Error(
      `OFAPI chat-export row count ${records.length} does not match terminal status ${input.expectedRows}`,
    );
  }

  const startMs = new Date(input.expectedStartDate).getTime();
  const effectiveEnd = effectiveOfapiExportEndDate(input.expectedEndDate);
  const endMs = effectiveEnd?.getTime() ?? Number.NaN;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error("Frozen OFAPI export date range is invalid");
  }
  const expectedChats = new Set(input.expectedChatIds);
  const messageIds = new Set<string>();
  const grouped = new Map<string, Record<string, unknown>[]>();
  let minCreatedMs: number | null = null;
  let maxCreatedMs: number | null = null;

  for (const values of records) {
    if (values.length !== OFAPI_CHAT_EXPORT_COLUMNS.length) {
      throw new Error("OFAPI chat-export CSV record has the wrong column count");
    }
    const row = Object.fromEntries(
      OFAPI_CHAT_EXPORT_COLUMNS.map((column, index) => [column, values[index] ?? ""]),
    );
    if (row.account_id !== input.expectedAccountId) {
      throw new Error("OFAPI chat-export account_id does not match the frozen export target");
    }
    const chatId = positiveNumericId(row.chat_id!, "chat_id");
    if (!expectedChats.has(chatId)) {
      throw new Error("OFAPI chat-export contains a chat outside the frozen pilot target");
    }
    const messageId = positiveNumericId(row.message_id!, "message_id");
    if (messageIds.has(messageId)) throw new Error("OFAPI chat-export contains duplicate messages");
    messageIds.add(messageId);
    const fanId = positiveNumericId(row.fan_id!, "fan_id");
    const sentBy = row.sent_by;
    if (sentBy !== "creator" && sentBy !== "fan") {
      throw new Error("OFAPI chat-export sent_by is outside creator|fan");
    }
    const createdAt = parseOfapiExportCsvTimestamp(
      row.onlyfans_created_at!,
      "onlyfans_created_at",
    )!;
    const changedAt = parseOfapiExportCsvTimestamp(
      row.onlyfans_changed_at!,
      "onlyfans_changed_at",
      true,
    );
    if (createdAt.getTime() < startMs || createdAt.getTime() > endMs) {
      throw new Error("OFAPI chat-export message is outside the frozen date range");
    }
    minCreatedMs = minCreatedMs === null
      ? createdAt.getTime()
      : Math.min(minCreatedMs, createdAt.getTime());
    maxCreatedMs = maxCreatedMs === null
      ? createdAt.getTime()
      : Math.max(maxCreatedMs, createdAt.getTime());

    const isSentByMe = sentBy === "creator";
    const item: Record<string, unknown> = {
      id: messageId,
      createdAt: createdAt.toISOString(),
      changedAt: changedAt?.toISOString() ?? null,
      isSentByMe,
      text: row.message_text ?? "",
      price: nonnegativeMoney(row.price!, "price"),
      tipAmount: nonnegativeMoney(row.tip_amount!, "tip_amount"),
      isTip: strictBoolean(row.is_tip!, "is_tip"),
      isOpened: strictBoolean(row.is_opened!, "is_opened"),
      isNew: strictBoolean(row.is_new!, "is_new"),
      fromUser: { id: isSentByMe ? input.expectedAccountId : fanId },
      toUser: { id: isSentByMe ? fanId : input.expectedAccountId },
      media: row.giphy_id ? [{ id: row.giphy_id, type: "gif" }] : [],
      materialPresence: { media: false, reply: false, tipText: false },
    };
    const items = grouped.get(chatId) ?? [];
    items.push(item);
    grouped.set(chatId, items);
  }

  return {
    fileName: location.fileName,
    sha256,
    byteSize: fileStat.size,
    rowCount: records.length,
    chatCount: grouped.size,
    minCreatedAt: minCreatedMs === null ? null : new Date(minCreatedMs),
    maxCreatedAt: maxCreatedMs === null ? null : new Date(maxCreatedMs),
    groups: [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([chatId, items]) => ({ chatId, items })),
  };
}

function publicArtifact(artifact: InspectedArtifact) {
  return {
    fileName: artifact.fileName,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    rowCount: artifact.rowCount,
    chatCount: artifact.chatCount,
    minCreatedAt: artifact.minCreatedAt?.toISOString() ?? null,
    maxCreatedAt: artifact.maxCreatedAt?.toISOString() ?? null,
  };
}

export async function captureOwnerOfapiExportArtifact(
  app: AppContext,
  input: OfapiExportArtifactCaptureBody & {
    jobId: string;
    actorUserId: number;
    now?: Date;
  },
): Promise<OfapiExportArtifactCaptureResponse> {
  const job = await getOfapiCaptureJob(app.db, input.jobId);
  if (!job || job.kind !== "account_export") {
    throw new NotFoundError(`OFAPI export job ${input.jobId} was not found`);
  }
  const target = parseOfapiExportTarget(job);
  const cursor = parseOfapiExportCursor(job);
  if (
    !target
    || target.profile !== "pilot_chats"
    || target.maxMessages > 1_000
    || !cursor
    || cursor.phase !== "artifact_pending"
    || cursor.vendorStatus !== "completed"
    || cursor.totalRows === null
    || cursor.rowsProcessed !== cursor.totalRows
    || cursor.failedDownloads !== 0
    || job.state !== "blocked"
    || job.reasonCode !== "artifact_capture_required"
  ) {
    throw new ConflictError(`OFAPI export job ${input.jobId} is not awaiting a valid pilot artifact`);
  }
  if (job.rowVersion !== input.expectedRowVersion) {
    throw new ConflictError(`OFAPI export job ${input.jobId} changed; refresh rowVersion`);
  }

  let artifact: InspectedArtifact;
  try {
    artifact = await inspectPilotArtifact({
      artifactDir: app.config.ofapiExportArtifactDir
        ?? "/var/lib/agency-hub/ofapi-export-artifacts",
      exportJobId: job.id,
      expectedAccountId: job.ofapiAccountId,
      expectedChatIds: target.chatIds,
      expectedRows: cursor.totalRows,
      expectedStartDate: target.startDate,
      expectedEndDate: target.endDate,
      expectedSha256: input.expectedSha256,
    });
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : String(error));
  }

  if (input.dryRun !== false) {
    return {
      dryRun: true,
      status: "would_capture",
      jobId: job.id,
      pageId: job.pageId,
      expectedRowVersion: job.rowVersion,
      nextRowVersion: job.rowVersion + 1,
      importJobId: null,
      importJobState: null,
      classification: "item_presence",
      artifact: publicArtifact(artifact),
    };
  }

  const now = input.now ?? new Date();
  const completed = await app.db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const current = await getOfapiCaptureJob(database, job.id);
    if (
      !current
      || current.rowVersion !== input.expectedRowVersion
      || current.state !== "blocked"
      || current.reasonCode !== "artifact_capture_required"
    ) {
      throw new ConflictError(`OFAPI export job ${job.id} changed during artifact capture`);
    }
    const pointerPayload = {
      version: "ofapi-export-artifact-pointer-v1",
      exportJobId: job.id,
      vendorExportId: cursor.vendorExportId,
      targetHash: job.targetHash,
      artifact: publicArtifact(artifact),
      classification: "item_presence",
    };
    const observation = await insertObservation(database, {
      source: "ofapi_capture",
      producer: "ofapi-export-artifact",
      platform: "onlyfans",
      accountId: job.pageId,
      nativeAccountRef: job.ofapiAccountId,
      kind: "ofapi.export_artifact_pointer.v1",
      payload: pointerPayload,
      payloadHash: Buffer.from(hashOfapiCaptureValue(pointerPayload), "hex"),
      idempotencyKey: `export-artifact:${job.id}:${artifact.sha256}`,
      observedAt: now,
      actorPrincipalId: input.actorUserId,
      receivedAt: now,
    });
    const importTarget: ExportArtifactTarget = {
      version: "ofapi-export-import-v1",
      exportJobId: job.id,
      profile: "pilot_chats",
      fileName: artifact.fileName,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
      rowCount: artifact.rowCount,
      artifactObservationId: observation.observationId,
      artifactObservationReceivedAt: observation.receivedAt.toISOString(),
      chatIds: target.chatIds,
      startDate: target.startDate,
      endDate: target.endDate,
    };
    const importJob = await createOrGetOfapiCaptureJob(database, {
      pageId: job.pageId,
      ofapiAccountId: job.ofapiAccountId,
      kind: "export_import",
      activeSlotKey: `page:${job.pageId}:export-import:${job.id}`,
      target: importTarget,
      manifest: {
        version: "ofapi-export-import-v1",
        exportJobId: job.id,
        artifactSha256: artifact.sha256,
        classification: "item_presence",
      },
      budgetScope: "bulk",
      originPrincipalId: input.actorUserId,
      createdBy: "owner",
      priority: 10,
      maxItems: artifact.rowCount,
      sourceContractVersion: "ofapi-export-chat-messages-csv-v1",
      parserVersion: "ofapi-export-import-v1",
      now,
    });
    if (importJob.job.targetHash !== hashOfapiCaptureValue(importTarget)) {
      throw new ConflictError(`Export import slot for ${job.id} has a different target`);
    }
    const nextCursor = {
      ...cursor,
      phase: "artifact_captured",
      downloadUrl: null,
      artifact: publicArtifact(artifact),
      artifactObservationId: observation.observationId,
      artifactObservationReceivedAt: observation.receivedAt.toISOString(),
      importJobId: importJob.job.id,
    };
    const parent = await markOfapiExportArtifactCaptured(database, {
      jobId: job.id,
      expectedRowVersion: input.expectedRowVersion,
      cursor: nextCursor,
      result: {
        classification: "item_presence",
        artifact: publicArtifact(artifact),
        importJobId: importJob.job.id,
        reason: input.reason,
      },
      observationId: observation.observationId,
      observationReceivedAt: observation.receivedAt,
      now,
    });
    if (!parent) throw new ConflictError(`OFAPI export job ${job.id} changed during commit`);
    return { parent, importJob: importJob.job };
  });

  return {
    dryRun: false,
    status: "captured",
    jobId: job.id,
    pageId: job.pageId,
    expectedRowVersion: input.expectedRowVersion,
    nextRowVersion: completed.parent.rowVersion,
    importJobId: completed.importJob.id,
    importJobState: completed.importJob.state,
    classification: "item_presence",
    artifact: publicArtifact(artifact),
  };
}

function parseImportTarget(job: OfapiCaptureJobRecord): ExportArtifactTarget | null {
  const target = job.target;
  if (
    target.version !== "ofapi-export-import-v1"
    || target.profile !== "pilot_chats"
    || typeof target.exportJobId !== "string"
    || !/^[0-9a-f-]{36}$/i.test(target.exportJobId)
    || target.fileName !== `${target.exportJobId}.csv`
    || typeof target.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(target.sha256)
    || !Number.isInteger(target.byteSize)
    || Number(target.byteSize) < 1
    || Number(target.byteSize) > MAX_PILOT_ARTIFACT_BYTES
    || !Number.isInteger(target.rowCount)
    || Number(target.rowCount) < 0
    || Number(target.rowCount) > 1_000
    || !Number.isSafeInteger(target.artifactObservationId)
    || Number(target.artifactObservationId) < 1
    || typeof target.artifactObservationReceivedAt !== "string"
    || Number.isNaN(new Date(target.artifactObservationReceivedAt).getTime())
    || !Array.isArray(target.chatIds)
    || target.chatIds.length < 1
    || target.chatIds.length > 3
    || !target.chatIds.every((id): id is string => typeof id === "string" && /^[1-9]\d*$/.test(id))
    || typeof target.startDate !== "string"
    || typeof target.endDate !== "string"
  ) {
    return null;
  }
  return target as ExportArtifactTarget;
}

export async function executeOfapiExportImportJob(
  app: AppContext,
  job: OfapiCaptureJobRecord,
): Promise<{ kind: "success" | "blocked" | "failed"; pageId: number; jobId: string }> {
  const target = parseImportTarget(job);
  if (!job.leaseToken || job.state !== "leased" || !target || job.maxItems !== target?.rowCount) {
    if (job.leaseToken) {
      await blockOfapiCaptureJobLease(app.db, {
        jobId: job.id,
        leaseToken: job.leaseToken,
        reasonCode: "target_invalid",
        reasonMessage: "Export import target is malformed or exceeds its item cap",
      });
    }
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }

  let artifact: InspectedArtifact;
  try {
    artifact = await inspectPilotArtifact({
      artifactDir: app.config.ofapiExportArtifactDir
        ?? "/var/lib/agency-hub/ofapi-export-artifacts",
      exportJobId: target.exportJobId,
      expectedAccountId: job.ofapiAccountId,
      expectedChatIds: target.chatIds,
      expectedRows: target.rowCount,
      expectedStartDate: target.startDate,
      expectedEndDate: target.endDate,
      expectedSha256: target.sha256,
      expectedByteSize: target.byteSize,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await blockOfapiCaptureJobLease(app.db, {
      jobId: job.id,
      leaseToken: job.leaseToken,
      reasonCode: message.includes("ENOENT") ? "artifact_lost" : "contract_rejected",
      reasonMessage: message,
    });
    return { kind: "blocked", pageId: job.pageId, jobId: job.id };
  }

  const observationReceivedAt = new Date(target.artifactObservationReceivedAt);
  let highWater = 0;
  try {
    for (const group of artifact.groups) {
      const appended = await appendOfapiMessageMaterialPage(app.db, {
        accountId: job.pageId,
        observationId: target.artifactObservationId,
        observationReceivedAt,
        chatId: group.chatId,
        originClass: "export_import",
        items: group.items,
        checkpointDedupKey:
          `projection-checkpoint:export-import:${job.id}:${group.chatId}:${target.sha256}`,
      });
      highWater = Math.max(highWater, appended.highWater);
    }
    await markObservationParsed(app.db, {
      observationId: target.artifactObservationId,
      receivedAt: observationReceivedAt,
      parseVersion: OFAPI_CAPTURE_MATERIALIZER_VERSION,
    });
  } catch (error) {
    app.logger.error({ err: error, jobId: job.id }, "OFAPI export artifact import failed");
    await blockOfapiCaptureJobLease(app.db, {
      jobId: job.id,
      leaseToken: job.leaseToken,
      reasonCode: "parser_failed",
      reasonMessage: error instanceof Error ? error.message : String(error),
    });
    return { kind: "failed", pageId: job.pageId, jobId: job.id };
  }

  const completed = await completeOfapiExportImportJobLease(app.db, {
    jobId: job.id,
    leaseToken: job.leaseToken,
    cursor: {
      phase: "imported",
      rowOffset: artifact.rowCount,
      rowCount: artifact.rowCount,
      sha256: artifact.sha256,
      requiredServingHighWater: highWater,
    },
    result: {
      classification: "item_presence",
      source: "export_artifact",
      rowCount: artifact.rowCount,
      chatCount: artifact.chatCount,
      requiredServingHighWater: highWater,
      continuousHistory: false,
    },
    observationId: target.artifactObservationId,
    observationReceivedAt,
    acceptedItems: artifact.rowCount,
    acceptedBatches: artifact.groups.length,
  });
  return {
    kind: completed ? "success" : "failed",
    pageId: job.pageId,
    jobId: job.id,
  };
}
