import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  findObservationByKey,
  getOfapiCaptureJob,
  hashOfapiCaptureValue,
  reconcileOfapiCapturedAttemptCredit,
  settleOfapiCaptureParse,
  settleOfapiCollectionRequest,
  updateOfapiCollectionJob,
  type Database,
  type OfapiCaptureJobRecord,
} from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import type { parseCapturedOfapiExportQuote } from "./ofapi-export-quotes.ts";
import {
  loadOfapiMediaSourceBytes,
  requireOfapiMediaSource,
} from "./ofapi-media-sources.ts";
import {
  buildOfapiMediaFact,
  mediaRecord,
  recordOfapiMediaFacts,
} from "./projections/ofapi-media.ts";
import { getOfapiAsyncLifecycle } from "./ofapi-async-lifecycle.ts";
import { OFAPI_DEFAULT_BASE_URL } from "./ofapi.ts";
export interface OfapiMediaRequestPlan {
  operation: "ofapi_upload_vault" | "ofapi_upload_cdn" | "ofapi_upload_status";
  endpointClass: "media_upload";
  method: "GET" | "POST";
  requestSemantics: "safe_read" | "stateful";
  pathname: string;
  query: Record<string, string>;
  bodyBytes: Buffer | null;
  contentType: string | null;
  request: Record<string, unknown>;
  observationKind: "ofapi.media_upload_response.v1";
  reservedCredits: number;
  timeoutMs: number;
  maxResponseBytes: number;
}
const uploadId = (value: unknown): value is string =>
  typeof value === "string" && /^ofapi_media_[A-Za-z0-9_-]+$/.test(value);
export const ofapiCdnMaterialRef = (token: string) =>
  `cdn_sha256:${createHash("sha256").update(token).digest("hex")}`;
export async function buildOfapiMediaUploadRequest(
  app: AppContext,
  job: OfapiCaptureJobRecord,
): Promise<OfapiMediaRequestPlan | null> {
  if (
    job.kind !== "media_upload" ||
    typeof job.target.sourceId !== "string" ||
    !["vault", "cdn"].includes(String(job.target.destination)) ||
    typeof job.target.collectionJobId !== "string"
  )
    return null;
  const base = {
    endpointClass: "media_upload" as const,
    query: {},
    observationKind: "ofapi.media_upload_response.v1" as const,
    timeoutMs: 65000,
    maxResponseBytes: 1024 * 1024,
  };
  if (job.cursor?.phase === "poll" && uploadId(job.cursor.uploadId))
    return {
      ...base,
      operation: "ofapi_upload_status",
      method: "GET",
      requestSemantics: "safe_read",
      pathname: `/${job.ofapiAccountId}/media/uploads/${job.cursor.uploadId}/status`,
      bodyBytes: null,
      contentType: null,
      reservedCredits: 0,
      request: {
        method: "GET",
        resource: "media_upload_status",
        uploadRef: ofapiCdnMaterialRef(job.cursor.uploadId),
      },
    };
  if (job.cursor !== null) return null;
  const { source, bytes } = await loadOfapiMediaSourceBytes(
    app,
    job.target.sourceId,
    job.pageId,
  );
  if (
    source.sha256 !== job.target.sourceSha256 ||
    Number(source.byte_size) !== job.target.sourceBytes
  )
    return null;
  const boundary = `ofapi-${job.id}`,
    filename = encodeURIComponent(source.filename);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="async"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${source.mime_type}\r\n\r\n`,
  );
  const bodyBytes = Buffer.concat([
    head,
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    ...base,
    operation:
      job.target.destination === "vault"
        ? "ofapi_upload_vault"
        : "ofapi_upload_cdn",
    method: "POST",
    requestSemantics: "stateful",
    pathname: `/${job.ofapiAccountId}/media/${job.target.destination === "vault" ? "vault" : "upload"}`,
    bodyBytes,
    contentType: `multipart/form-data; boundary=${boundary}`,
    reservedCredits: Number(job.target.maxCredits),
    request: {
      method: "POST",
      resource: "media_upload",
      destination: job.target.destination,
      async: true,
      sourceId: source.id,
      sourceSha256: source.sha256,
      sourceBytes: bytes.length,
      bodyHash: createHash("sha256").update(bodyBytes).digest("hex"),
    },
  };
}
function terminalPayload(
  job: OfapiCaptureJobRecord,
  body: Record<string, unknown>,
) {
  const inlineVault =
    job.target.destination === "vault" &&
    job.cursor?.uploadId === null &&
    body.prefixed_id === null &&
    body.status === "completed";
  if (
    (!inlineVault &&
      (!uploadId(body.prefixed_id) ||
        body.prefixed_id !== job.cursor?.uploadId)) ||
    !["completed", "failed"].includes(String(body.status))
  )
    throw new Error("Upload terminal identity changed");
  if (body.account_id !== undefined && body.account_id !== job.ofapiAccountId)
    throw new Error("Upload account mismatch");
  const media = mediaRecord(body.media) ?? {};
  const ref =
    job.target.destination === "cdn"
      ? uploadId(body.prefixed_id)
        ? body.prefixed_id
        : null
      : typeof media.id === "number" && Number.isSafeInteger(media.id)
        ? String(media.id)
        : typeof media.id === "string"
          ? media.id
          : typeof body.media_id === "number" &&
              Number.isSafeInteger(body.media_id)
            ? String(body.media_id)
            : typeof body.media_id === "string"
              ? body.media_id
              : null;
  if (
    body.status === "completed" &&
    (!ref || (job.target.destination === "vault" && !/^\d+$/.test(ref)))
  )
    throw new Error("Completed upload has no verified media identity");
  const credits =
    typeof body.credits_used === "number" &&
    Number.isSafeInteger(body.credits_used) &&
    body.credits_used >= 0
      ? body.credits_used
      : null;
  return { media, ref, status: String(body.status), credits };
}
async function applyTerminal(
  app: AppContext,
  job: OfapiCaptureJobRecord,
  body: Record<string, unknown>,
  observationId: number,
  receivedAt: Date,
  sourceKind = "ofapi.media_upload_response.v1",
) {
  const terminal = terminalPayload(job, body);
  await requireOfapiMediaSource(app, String(job.target.sourceId), job.pageId);
  const startAttemptId = job.cursor?.startAttemptId;
  if (typeof startAttemptId !== "string")
    throw new Error("Upload start intent is missing");
  if (terminal.credits !== null) {
    await reconcileOfapiCapturedAttemptCredit(app.db, {
      attemptId: startAttemptId,
      actualCredits: terminal.credits,
    });
    await settleOfapiCollectionRequest(
      app.db,
      startAttemptId,
      terminal.credits,
    );
  }
  const overrun =
    terminal.credits !== null &&
    terminal.credits > Number(job.target.maxCredits);
  const cursor = {
    ...job.cursor,
    phase: "terminal",
    status: terminal.status,
    mediaRef: terminal.ref,
    isReady:
      typeof terminal.media.isReady === "boolean"
        ? terminal.media.isReady
        : null,
    hasError:
      typeof terminal.media.hasError === "boolean"
        ? terminal.media.hasError
        : null,
    actualCredits: terminal.credits,
    lastObservationId: observationId,
  };
  if (terminal.status === "completed" && terminal.ref)
    await recordOfapiMediaFacts(app.db, job.pageId, [
      buildOfapiMediaFact(terminal.media, {
        sourceKind,
        accountId: job.ofapiAccountId,
        materialKind: job.target.destination as "vault" | "cdn",
        mediaRef:
          job.target.destination === "cdn"
            ? ofapiCdnMaterialRef(terminal.ref)
            : terminal.ref,
        sourceId: String(job.target.sourceId),
        uploadJobId: job.id,
        uploadStatus: terminal.status,
        observationId,
        observedAt: receivedAt,
      }),
    ]);
  await app.db.execute(
    sql`update ofapi_capture_jobs set state=${terminal.status === "completed" && !overrun ? "complete" : "blocked"},completed_at=${terminal.status === "completed" && !overrun ? new Date() : null},cursor=${JSON.stringify(cursor)}::jsonb,cursor_hash=${hashOfapiCaptureValue(cursor)},terminal_observation_id=${observationId},terminal_observation_received_at=${receivedAt},reason_code=${overrun ? "upload_budget_exceeded" : terminal.status === "failed" ? "upload_failed" : null},row_version=row_version+1,updated_at=now() where id=${job.id}::uuid`,
  );
  await updateOfapiCollectionJob(app.db, String(job.target.collectionJobId), {
    state: terminal.status === "completed" && !overrun ? "completed" : "failed",
    reason: overrun
      ? "upload_budget_exceeded"
      : terminal.status === "failed"
        ? "upload_failed"
        : null,
    checkpoint: { uploadJobId: job.id, status: terminal.status },
    bytesAdded: Number(job.target.sourceBytes),
  });
}
export async function parseCapturedOfapiMediaUpload(
  app: AppContext,
  input: Parameters<typeof parseCapturedOfapiExportQuote>[1],
): Promise<"success" | "failed" | "blocked"> {
  const { job } = input,
    root = input.parsedJson.validJson
      ? mediaRecord(input.parsedJson.body)
      : null;
  const start = job.cursor === null;
  const settle = async (
    accepted: boolean,
    reason: string,
    cursor?: Record<string, unknown>,
  ) =>
    settleOfapiCaptureParse(app.db, {
      jobId: job.id,
      attemptId: input.attemptId,
      leaseToken: job.leaseToken!,
      observationId: input.observationId,
      observationReceivedAt: input.observationReceivedAt,
      parserOutcome: accepted ? "accepted" : "contract_rejected",
      rawCount: 1,
      acceptedCount: accepted ? 1 : 0,
      boundaryDuplicateCount: 0,
      explicitlyIrrelevantCount: 0,
      rejectedCount: accepted ? 0 : 1,
      disposition: {
        kind: "blocked",
        reasonCode: reason,
        ...(cursor ? { cursor } : {}),
      },
    });
  if (input.status < 200 || input.status >= 300) {
    if (!start && (input.status === 429 || input.status >= 500)) {
      await settleOfapiCaptureParse(app.db, {
        jobId: job.id,
        attemptId: input.attemptId,
        leaseToken: job.leaseToken!,
        observationId: input.observationId,
        observationReceivedAt: input.observationReceivedAt,
        parserOutcome: "intentional_noop",
        rawCount: 0,
        acceptedCount: 0,
        boundaryDuplicateCount: 0,
        explicitlyIrrelevantCount: 0,
        rejectedCount: 0,
        disposition: {
          kind: "retry",
          nextAttemptAt: new Date(Date.now() + 60000),
          reasonCode: "upload_status_retry",
        },
      });
      return "failed";
    }
    await settle(false, `upload_http_${input.status}`);
    return "blocked";
  }
  if (
    start &&
    input.status === 200 &&
    root &&
    (root.account_id === undefined || root.account_id === job.ofapiAccountId) &&
    (root.status === undefined || root.status === "completed")
  ) {
    const media =
      job.target.destination === "vault" ? mediaRecord(root.data) : root;
    const prefix = job.target.destination === "vault" ? null : root.prefixed_id;
    if (media && (job.target.destination === "vault" || uploadId(prefix))) {
      const immediate = {
        ...job,
        cursor: {
          phase: "poll",
          uploadId: prefix,
          startAttemptId: input.attemptId,
        },
      };
      const body = {
        status: "completed",
        prefixed_id: prefix,
        media,
        credits_used: input.parsedJson.creditsUsed,
      };
      try {
        terminalPayload(immediate, body);
      } catch {
        await settle(false, "upload_inline_contract_rejected");
        return "blocked";
      }
      await app.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        const accepted = await settleOfapiCaptureParse(db, {
          jobId: job.id,
          attemptId: input.attemptId,
          leaseToken: job.leaseToken!,
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
            reasonCode: "upload_inline_captured",
          },
        });
        if (accepted)
          await applyTerminal(
            { ...app, db },
            immediate,
            body,
            input.observationId,
            input.observationReceivedAt,
          );
      });
      return "success";
    }
  }
  if (
    !root ||
    !uploadId(root.prefixed_id) ||
    (root.account_id !== undefined && root.account_id !== job.ofapiAccountId)
  ) {
    await settle(false, "upload_identity_rejected");
    return "blocked";
  }
  if (start) {
    let pollingValid = false;
    try {
      const url = new URL(String(root.polling_url));
      const base = new URL(OFAPI_DEFAULT_BASE_URL);
      pollingValid =
        url.protocol === "https:" &&
        url.origin === base.origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname ===
          `/api/${job.ofapiAccountId}/media/uploads/${root.prefixed_id}/status`;
    } catch {
      /* Invalid provider location stays captured but unusable. */
    }
    if (input.status !== 202 || root.status !== "pending" || !pollingValid) {
      await settle(false, "upload_start_contract_rejected");
      return "blocked";
    }
  } else if (root.prefixed_id !== job.cursor?.uploadId) {
    await settle(false, "upload_identity_rejected");
    return "blocked";
  }
  const cursor = {
    ...job.cursor,
    phase: "poll",
    uploadId: root.prefixed_id,
    status: root.status,
    startAttemptId: start ? input.attemptId : job.cursor?.startAttemptId,
  };
  if (!start && ["completed", "failed"].includes(String(root.status))) {
    try {
      terminalPayload(job, root);
    } catch {
      await settle(false, "upload_terminal_contract_rejected");
      return "blocked";
    }
    await app.db.transaction(async (tx) => {
      const nested = { ...app, db: tx as unknown as Database };
      const accepted = await settleOfapiCaptureParse(nested.db, {
        jobId: job.id,
        attemptId: input.attemptId,
        leaseToken: job.leaseToken!,
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
          reasonCode: "upload_terminal_captured",
        },
      });
      if (accepted)
        await applyTerminal(
          nested,
          job,
          root,
          input.observationId,
          input.observationReceivedAt,
        );
    });
    return "success";
  }
  if (!["pending", "processing"].includes(String(root.status))) {
    await settle(false, "upload_status_contract_rejected");
    return "blocked";
  }
  await settleOfapiCaptureParse(app.db, {
    jobId: job.id,
    attemptId: input.attemptId,
    leaseToken: job.leaseToken!,
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
      nextAttemptAt: new Date(Date.now() + 60000),
      reasonCode: "upload_processing",
      cursor,
    },
  });
  return "success";
}
/** Signed completion received before 202 stays journaled until this exact ID is known. */
export async function reconcileOfapiUploadWebhook(app: AppContext, id: string) {
  const job = await getOfapiCaptureJob(app.db, id);
  if (
    !job ||
    job.kind !== "media_upload" ||
    !(
      ["ready", "retry_wait"].includes(job.state) ||
      (job.state === "blocked" &&
        ["background_paused", "job_unavailable"].includes(job.reasonCode ?? ""))
    ) ||
    job.cursor?.phase !== "poll" ||
    !uploadId(job.cursor.uploadId)
  )
    return false;
  const hint = await getOfapiAsyncLifecycle(app, {
    resourceKind: "media_upload",
    resourceId: job.cursor.uploadId,
    ofapiAccountId: job.ofapiAccountId,
  });
  if (!hint || hint.conflictingTerminal) return false;
  const row = (
    await app.db.execute<{
      payload: Record<string, unknown>;
      idempotency_key: string;
    }>(
      sql`select payload,idempotency_key from ofapi_webhook_events where id=${hint.eventId} and capture_state='accepted'`,
    )
  ).rows[0];
  const payload = mediaRecord(row?.payload.payload);
  if (!row || !payload) return false;
  const captured = await findObservationByKey(
    app.db,
    "webhook",
    row.idempotency_key,
  );
  if (!captured) return false;
  const body = { ...payload, prefixed_id: payload.id };
  try {
    terminalPayload(job, body);
  } catch {
    return false;
  }
  return app.db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const locked = (
      await database.execute<{ row_version: number }>(
        sql`select row_version from ofapi_capture_jobs where id=${id}::uuid and (state in ('ready','retry_wait') or (state='blocked' and reason_code in ('background_paused','job_unavailable'))) for update`,
      )
    ).rows[0];
    if (!locked || Number(locked.row_version) !== job.rowVersion) return false;
    await applyTerminal(
      { ...app, db: database },
      job,
      body,
      captured.id,
      captured.receivedAt,
      captured.kind,
    );
    return true;
  });
}
