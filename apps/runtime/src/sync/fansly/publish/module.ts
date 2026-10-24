import {
  admitFanslyWriteCommand,
  autostopPagePublishing,
  getFanslyWriteCommand,
  getFanslyWriteDispatch,
  getFanslyWriteFileFacts,
  getFanslyWritePageFacts,
  getPagePublishingSettings,
  getPublication,
  getPublicationRevision,
  getSyncAttempt,
  getSyncPageTransport,
  listFanslyWriteCommandsOfDispatch,
  listPublicationQueueSnapshots,
  refuseFanslyWriteCommand,
  requeueFanslyWriteCommand,
  settleFanslyWriteCommand,
  type Database,
  type FanslyWriteCommandRecord,
  type FanslyWriteFileFacts,
  type FanslyWriteRequestRecord,
  type SyncAttemptRow,
  type SyncPageTransport,
  type SyncWorkRow,
} from "@agency_hub_core/db";
import { FANSLY_WRITE_BODY_MAX_BYTES, fanslyWritePermission, isFanslyWriteSendable, type FanslyWireId } from "@agency_hub_core/fansly";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { publicationFilePath, publicationFilesRoot } from "../../../services/publication-files.ts";
import { checkApprovedPublication } from "../../../services/publications.ts";
import type { OutcomeDecision } from "../../engine/errors.ts";
import type {
  AdmitInput,
  AnswerApplyInput,
  ApplyInput,
  ConfirmWriteInput,
  ApplyResult,
  CaptureOutcomeInput,
  CaptureOutcomeResult,
  LocalApplyInput,
  PlanContext,
  RequestPlan,
  ResourceModule,
  StepPlan,
} from "../../engine/resource.ts";
import { journalWriteAnswer, readWriteAnswer } from "./answers.ts";
import { FANSLY_WITHDRAW_STEP_STATUS, FANSLY_WITHDRAW_STEPS, FANSLY_WRITE_STEP_ROUTES, nextWriteStep, writeAnswerVerdict, writeOutcomeDecision } from "./commands.ts";
import {
  deriveFanslyWrite,
  describeFanslyCommandRequest,
  fanslyPartRange,
  parseApprovedForm,
  subItemOf,
  type ApprovedForm,
  type FanslyPageFacts,
  type FanslyScheduleFacts,
  type WriteDerivedFacts,
} from "./derive.ts";
import { writeGuard } from "./guard.ts";

// The page actor's write commands (wall posts PR 6): `publish.background` and
// `publish.urgent` (registry.ts), one work row per command (its subject is the
// command's id). The engine runs them as it runs every read — the same single
// sender, the same pause, the admission's ownership and hold checks, the
// answer journaled in `observations` before anything reads it — and this
// module adds what a write needs on top:
//
// - plan (read-only): the command's state and its one attempt decide
//   (`nextWriteStep`); a queued one passes the guard (`writeGuard`: switches,
//   page stop, Node, an unverified route, its window, a browser that takes
//   writes) and is DERIVED from the approval and the dispatch's recorded
//   results (`deriveFanslyWrite`) — or refused, as a `local` step;
// - onAdmit (tx 1, beside the attempt row): the command must still be queued,
//   its publication still approved under the same revision (row-locked), the
//   page not stopped, and the transport's request the very one derived — then
//   `queued → sending` with the request and its fingerprint, BEFORE the send;
// - the outcome: a 2xx goes to the apply (`answered` with the ids it gave, or
//   `unknown` when they are not there); anything else is settled in the
//   capture's transaction (`rejected` only for Fansly's own refusal,
//   otherwise `unknown`; a 401/403/429 stops the page's publishing) and
//   never re-read on a breaker's ladder;
// - after a crash the engine's recovery closes the attempt `unknown` and the
//   next plan settles the command `unknown`: it is never sent again;
// - confirmWrite (PR 7, read-only): the page's browser asks at its pause,
//   right before the engine's grant — the command still `sending` under this
//   attempt with this fingerprint, its approval still in force, the page's
//   publishing (and, to create, the global switch) still on. No: nothing is
//   granted, the attempt ends `write_refused`, and the next plan refuses the
//   command (`refuse_not_sent`): the same request would be refused again.

/** A work's subject is its command's id. */
export function writeCommandIdOf(work: Pick<SyncWorkRow, "subject">): number | null {
  return /^[1-9][0-9]{0,17}$/.test(work.subject) ? Number(work.subject) : null;
}

/** How long a plan waits for its attempt's answer to be applied. */
export const WRITE_AWAIT_MS = 5_000;
/** An upload's part waits for the part before it this often (wall posts PR 8). */
export const PART_ORDER_RECHECK_MS = 3_000;
/** A withdrawal waits this long for the fresh read of the schedule it needs… */
export const WITHDRAW_READ_WAIT_MS = 15 * 60_000;
/** …looking again this often. */
const WITHDRAW_READ_RECHECK_MS = 30_000;

/** What a write's context reads for the derivation. */
export type WriteDeriveContext =
  | {
    ok: true;
    dispatch: { kind: "create" | "withdraw" | "delete"; mode: string; revisionId: number };
    form: ApprovedForm;
    publication: { status: string; platformPostRef: string | null };
    files: ReadonlyMap<number, FanslyWriteFileFacts>;
    /** The page's walls and tiers (the contract §3–§4). */
    page: FanslyPageFacts;
    commands: readonly FanslyWriteCommandRecord[];
    /** A withdraw's: the page's latest read of its schedule (plan PR 9). */
    schedule?: FanslyScheduleFacts | null;
  }
  | { ok: false; reason: string };

/** The database as this module uses it (tests pass their own). */
export interface WriteModuleStore {
  getCommand(db: Database, id: number, forUpdate?: boolean): Promise<FanslyWriteCommandRecord | null>;
  getAttempt(db: Database, attemptId: number): Promise<Pick<SyncAttemptRow, "id" | "outcome" | "applyState" | "errorClass"> | null>;
  readTransport(db: Database, pageId: number): Promise<SyncPageTransport | null>;
  readPageSettings(db: Database, pageId: number): Promise<{ enabled: boolean; autostopReason: string | null }>;
  readDeriveContext(db: Database, command: FanslyWriteCommandRecord): Promise<WriteDeriveContext>;
  /** The publication, its row locked for the admission's transaction. */
  lockPublication(db: Database, publicationId: number): Promise<{ status: string; approvedRevisionId: number | null } | null>;
  /** The publication as it stands, unlocked (a write's confirmation). */
  readPublication(db: Database, publicationId: number): Promise<{ status: string; approvedRevisionId: number | null } | null>;
  admit(db: Database, input: Parameters<typeof admitFanslyWriteCommand>[1]): Promise<boolean>;
  settle(db: Database, input: Parameters<typeof settleFanslyWriteCommand>[1]): Promise<boolean>;
  requeue(db: Database, input: Parameters<typeof requeueFanslyWriteCommand>[1]): Promise<boolean>;
  refuse(db: Database, input: Parameters<typeof refuseFanslyWriteCommand>[1]): Promise<boolean>;
  autostop(db: Database, pageId: number, reason: string): Promise<boolean>;
  /** Whether a write route's contract is verified (`isFanslyWriteSendable`). */
  isSendable(spec: FanslyWireId): boolean;
  /** The sha256 of a range of a publication's file on disk (an upload's
   *  part, wall posts PR 8); null: it does not read whole. */
  readPartSha256(input: { file: FanslyWriteFileFacts; byteOffset: number; byteLength: number; root: string }): Promise<string | null>;
}

/** The sha256 of `byteLength` bytes of a file at `byteOffset`; null when it
 *  does not read whole (deleted, shorter). */
async function readPartSha256(input: { file: FanslyWriteFileFacts; byteOffset: number; byteLength: number; root: string }): Promise<string | null> {
  if (input.file.bytesDeletedAt !== null || input.byteLength <= 0) return null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(publicationFilePath(input.root, input.file), "r");
    const bytes = Buffer.alloc(input.byteLength);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, input.byteOffset + read);
      if (bytesRead === 0) return null;
      read += bytesRead;
    }
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readDeriveContext(db: Database, command: FanslyWriteCommandRecord): Promise<WriteDeriveContext> {
  const dispatch = await getFanslyWriteDispatch(db, command.dispatchId);
  if (dispatch === null || dispatch.platform !== "fansly" || dispatch.publicationId !== command.publicationId || dispatch.pageId !== command.pageId) {
    return { ok: false, reason: "dispatch_mismatch" };
  }
  const publication = await getPublication(db, command.publicationId);
  if (publication === null) return { ok: false, reason: "publication_missing" };
  if (dispatch.kind === "create") {
    // The publication, its page's account and model and its files' bytes are
    // still exactly what the person approved, under this dispatch's approval.
    const approval = await checkApprovedPublication(db, command.publicationId, { statuses: ["approved", "submitting"], revisionId: dispatch.revisionId });
    if (!approval.ok) return { ok: false, reason: `approval_${approval.reason}` };
  }
  const revision = await getPublicationRevision(db, dispatch.revisionId);
  const form = revision === null || revision.publicationId !== command.publicationId ? null : parseApprovedForm(revision.form);
  if (form === null) return { ok: false, reason: "approval_form_unreadable" };
  const fileIds = form.media.flatMap((media) => (media.fileId === null ? [] : [media.fileId]));
  const [files, commands, snapshots, page] = await Promise.all([
    getFanslyWriteFileFacts(db, fileIds),
    listFanslyWriteCommandsOfDispatch(db, command.dispatchId),
    dispatch.kind === "withdraw" ? listPublicationQueueSnapshots(db, [command.pageId]) : Promise.resolve([]),
    getFanslyWritePageFacts(db, command.pageId),
  ]);
  const snapshot = snapshots[0];
  return {
    ok: true,
    dispatch: { kind: dispatch.kind, mode: dispatch.mode, revisionId: dispatch.revisionId },
    form,
    publication: { status: publication.status, platformPostRef: publication.platformPostRef },
    files: new Map(files.map((file) => [file.id, file])),
    page,
    commands,
    schedule: snapshot?.readAt == null ? null : {
      readAtMs: snapshot.readAt.getTime(),
      postIds: snapshot.entries.flatMap((entry) => (entry.postRef === null ? [] : [entry.postRef])),
    },
  };
}

export const databaseWriteStore: WriteModuleStore = {
  getCommand: (db, id, forUpdate) => getFanslyWriteCommand(db, id, { forUpdate: forUpdate === true }),
  getAttempt: (db, attemptId) => getSyncAttempt(db, attemptId),
  readTransport: (db, pageId) => getSyncPageTransport(db, pageId),
  async readPageSettings(db, pageId) {
    const settings = await getPagePublishingSettings(db, pageId);
    return { enabled: settings.enabled, autostopReason: settings.autostopReason };
  },
  readDeriveContext,
  async lockPublication(db, publicationId) {
    const result = await db.execute<{ status: string; approved_revision_id: string | null }>(sql`
      select status, approved_revision_id::text from publications where id = ${publicationId} for share
    `);
    const row = result.rows[0];
    return row === undefined ? null : { status: row.status, approvedRevisionId: row.approved_revision_id === null ? null : Number(row.approved_revision_id) };
  },
  async readPublication(db, publicationId) {
    const publication = await getPublication(db, publicationId);
    return publication === null ? null : { status: publication.status, approvedRevisionId: publication.approvedRevisionId };
  },
  admit: admitFanslyWriteCommand,
  settle: settleFanslyWriteCommand,
  requeue: requeueFanslyWriteCommand,
  refuse: refuseFanslyWriteCommand,
  autostop: autostopPagePublishing,
  isSendable: isFanslyWriteSendable,
  readPartSha256,
};

/** An admission a write command refuses (tx 1 rolls back: nothing is sent). */
export class WriteAdmissionRefusedError extends Error {
  constructor(readonly commandId: number, readonly reason: string) {
    super(`Fansly write command ${commandId} is not admitted: ${reason}`);
    this.name = "WriteAdmissionRefusedError";
  }
}

/** What a `local` step of a write does, as its plan decided it. */
export type WriteLocalDetail =
  | { action: "refuse"; commandId: number; reason: string }
  | { action: "requeue"; commandId: number; attemptId: number; reason: string }
  | { action: "settle_unknown"; commandId: number; attemptId: number; reason: string }
  | { action: "refuse_not_sent"; commandId: number; attemptId: number; reason: string };

function isLocalDetail(value: unknown): value is WriteLocalDetail {
  const detail = value as Partial<WriteLocalDetail> | null;
  return typeof detail === "object" && detail !== null && typeof detail.commandId === "number" && typeof detail.reason === "string"
    && (detail.action === "refuse" || ((detail.action === "requeue" || detail.action === "settle_unknown" || detail.action === "refuse_not_sent") && typeof detail.attemptId === "number"));
}

function local(detail: WriteLocalDetail): StepPlan {
  return { kind: "local", reason: `write_${detail.action}`, detail };
}

export function fanslyWriteModule(store: WriteModuleStore = databaseWriteStore): ResourceModule {
  /** Why an admission of a still-queued command was refused (its transaction
   *  rolled back, so this process remembers it): the next plan refuses the
   *  command instead of planning the same request lap after lap. */
  const refusedAdmissions = new Map<number, string>();
  const refuseAdmission = (id: number, reason: string): never => {
    refusedAdmissions.set(id, reason);
    throw new WriteAdmissionRefusedError(id, reason);
  };
  return {
    async plan(work, ctx: PlanContext): Promise<StepPlan> {
      const id = writeCommandIdOf(work);
      if (id === null) return { kind: "quarantine", reason: "write_subject_invalid" };
      const command = await store.getCommand(ctx.db, id);
      if (command === null) return { kind: "done", reason: "write_command_missing" };
      if (command.pageId !== ctx.pageId) return { kind: "quarantine", reason: "write_of_another_page" };
      const admissionRefused = refusedAdmissions.get(id);
      if (admissionRefused !== undefined) {
        refusedAdmissions.delete(id);
        if (command.state === "queued") return local({ action: "refuse", commandId: id, reason: `admission_refused:${admissionRefused}` });
      }
      const attempt = command.state === "sending" && command.attemptId !== null ? await store.getAttempt(ctx.db, command.attemptId) : null;
      const next = nextWriteStep(command, attempt);
      const soon = new Date(ctx.now.getTime() + WRITE_AWAIT_MS);
      switch (next.kind) {
        case "closed":
          return { kind: "done", reason: `write_${command.state}` };
        case "await_apply":
        case "await_attempt":
          return { kind: "wait", reason: "dependency", until: soon };
        case "requeue":
          return local({ action: "requeue", commandId: command.id, attemptId: command.attemptId!, reason: next.reason });
        case "settle_unknown":
          return local({ action: "settle_unknown", commandId: command.id, attemptId: command.attemptId!, reason: next.reason });
        case "refuse_not_sent":
          return local({ action: "refuse_not_sent", commandId: command.id, attemptId: command.attemptId!, reason: next.reason });
        case "derive":
          break;
      }
      const spec = FANSLY_WRITE_STEP_ROUTES[command.step];
      const [config, pageSettings, transport] = await Promise.all([
        ctx.settings === undefined ? Promise.resolve(null) : ctx.settings.read(),
        store.readPageSettings(ctx.db, ctx.pageId),
        store.readTransport(ctx.db, ctx.pageId),
      ]);
      const verdict = writeGuard({
        step: command.step,
        now: ctx.now,
        notBefore: command.notBefore,
        notAfter: command.notAfter,
        // Fail closed: no live settings, no publishing.
        publishingEnabled: config?.publishingEnabled === true,
        page: pageSettings,
        transport: transport ?? "node",
        transportWrites: ctx.transportWrites?.(fanslyWritePermission(spec), spec) === true,
        contractVerified: store.isSendable(spec),
      });
      if (verdict.kind === "refuse") return local({ action: "refuse", commandId: command.id, reason: verdict.reason });
      if (verdict.kind === "wait") return { kind: "wait", reason: verdict.reason === "not_before" ? "not_due" : "dependency", until: verdict.until };
      const context = await store.readDeriveContext(ctx.db, command);
      if (!context.ok) return local({ action: "refuse", commandId: command.id, reason: context.reason });
      // A withdrawal goes only after a fresh read of the page's schedule (the
      // Publications job makes its poll due): until one taken after the
      // withdrawal was asked for has landed, it waits — a while, not forever.
      // (A delete's post is on the wall, not in the schedule: it needs none.)
      if (command.step === "post_cancel"
        && (context.schedule == null || context.schedule.readAtMs <= command.createdAt.getTime())) {
        if (ctx.now.getTime() - command.createdAt.getTime() > WITHDRAW_READ_WAIT_MS) {
          return local({ action: "refuse", commandId: command.id, reason: "schedule_not_read" });
        }
        return { kind: "wait", reason: "dependency", until: new Date(ctx.now.getTime() + WITHDRAW_READ_RECHECK_MS) };
      }
      // An upload's part (wall posts PR 8): after the part before it was
      // answered — one at a time, in order, as the site's own — and of the
      // bytes on disk for its range, read and hashed now.
      let partBytes: { fileId: number; byteOffset: number; byteLength: number; sha256: string } | null = null;
      if (command.step === "upload_part") {
        const sub = subItemOf(command.item, "part");
        if (sub !== null && sub.index > 0) {
          const before = context.commands.find((candidate) => candidate.step === "upload_part" && candidate.item === `${sub.base}/part:${sub.index - 1}` && candidate.state !== "refused");
          if (before === undefined || before.state === "queued" || before.state === "sending") {
            return { kind: "wait", reason: "dependency", until: new Date(ctx.now.getTime() + PART_ORDER_RECHECK_MS) };
          }
          if (before.state !== "answered") return local({ action: "refuse", commandId: command.id, reason: "previous_part_not_answered" });
        }
        const range = fanslyPartRange({ command, form: context.form, files: context.files, commands: context.commands });
        if (!range.ok) return local({ action: "refuse", commandId: command.id, reason: range.reason });
        const file = context.files.get(range.fileId);
        const sha256 = file === undefined || config === null ? null : await store.readPartSha256({ file, byteOffset: range.byteOffset, byteLength: range.byteLength, root: publicationFilesRoot(config) });
        if (sha256 === null) return local({ action: "refuse", commandId: command.id, reason: "part_bytes_unreadable" });
        partBytes = { fileId: range.fileId, byteOffset: range.byteOffset, byteLength: range.byteLength, sha256 };
      }
      const derived = deriveFanslyWrite({
        command,
        dispatch: context.dispatch,
        form: context.form,
        publication: context.publication,
        files: context.files,
        page: context.page,
        commands: context.commands,
        now: ctx.now,
        schedule: context.schedule ?? null,
        partBytes,
      });
      if (!derived.ok) return local({ action: "refuse", commandId: command.id, reason: derived.reason });
      // The page's browser lets a body of one HTTP/2 DATA frame go, no more.
      if (Buffer.byteLength(derived.write.body, "utf8") > FANSLY_WRITE_BODY_MAX_BYTES) return local({ action: "refuse", commandId: command.id, reason: "body_too_large" });
      return { kind: "request", request: derived.request };
    },

    async onAdmit(tx, work, request: RequestPlan, admission: AdmitInput): Promise<void> {
      const id = writeCommandIdOf(work);
      const facts = request.step as WriteDerivedFacts | undefined;
      if (id === null || facts === undefined || facts.commandId !== id) throw new WriteAdmissionRefusedError(id ?? 0, "request_not_of_command");
      const command = await store.getCommand(tx, id, true);
      if (command === null || command.state !== "queued") throw new WriteAdmissionRefusedError(id, `state_${command?.state ?? "missing"}`);
      if (FANSLY_WRITE_STEP_ROUTES[command.step] !== request.spec) refuseAdmission(id, "route_not_of_step");
      if (!store.isSendable(request.spec)) refuseAdmission(id, "route_unverified");
      // The request that will go is the one derived: same method, path, body.
      // An upload's status read is a GET: its transport names no fingerprint.
      const write = describeFanslyCommandRequest(request.spec, request.params);
      const read = request.spec === "publish.upload_status";
      if (write.fingerprint !== facts.fingerprint || (read ? admission.writeFingerprint !== null : admission.writeFingerprint !== facts.fingerprint)) {
        refuseAdmission(id, "fingerprint_mismatch");
      }
      // The approval still stands, under the row lock of this transaction: an
      // edit, a cancel or a new approval between the plan and now refuses.
      const publication = await store.lockPublication(tx, command.publicationId);
      const withdraw = FANSLY_WITHDRAW_STEPS.includes(command.step);
      if (publication === null) return refuseAdmission(id, "publication_missing");
      // A cancel's post still in the schedule, a delete's still on the wall.
      if (withdraw ? publication.status !== FANSLY_WITHDRAW_STEP_STATUS[command.step] : !["approved", "submitting"].includes(publication.status) || publication.approvedRevisionId !== facts.revisionId) {
        refuseAdmission(id, `publication_${publication.status}`);
      }
      const page = await store.readPageSettings(tx, command.pageId);
      if (page.autostopReason !== null || (!withdraw && !page.enabled)) refuseAdmission(id, "page_publishing_off");
      const record: FanslyWriteRequestRecord = { spec: request.spec, ...write, facts };
      if (!await store.admit(tx, { id, attemptId: admission.attemptId, workId: work.id, request: record })) {
        throw new WriteAdmissionRefusedError(id, "not_queued");
      }
      refusedAdmissions.delete(id);
    },

    async confirmWrite(db, work, input: ConfirmWriteInput): Promise<string | null> {
      const id = writeCommandIdOf(work);
      if (id === null) return "write_subject_invalid";
      const command = await store.getCommand(db, id);
      if (command === null || command.state !== "sending" || command.attemptId !== input.attemptId) return `command_${command?.state ?? "missing"}`;
      if (command.requestFingerprint !== input.writeFingerprint) return "fingerprint_mismatch";
      const facts = command.request?.facts as Partial<WriteDerivedFacts> | undefined;
      const withdraw = FANSLY_WITHDRAW_STEPS.includes(command.step);
      const [publication, page, config] = await Promise.all([
        store.readPublication(db, command.publicationId),
        store.readPageSettings(db, command.pageId),
        input.settings === undefined ? Promise.resolve(null) : input.settings.read(),
      ]);
      if (publication === null) return "publication_missing";
      if (withdraw ? publication.status !== FANSLY_WITHDRAW_STEP_STATUS[command.step] : !["approved", "submitting"].includes(publication.status) || publication.approvedRevisionId !== facts?.revisionId) {
        return `publication_${publication.status}`;
      }
      if (page.autostopReason !== null) return `page_stopped:${page.autostopReason}`;
      if (!withdraw && !page.enabled) return "page_publishing_off";
      // Fail closed: no live settings, no publishing.
      if (!withdraw && config?.publishingEnabled !== true) return "publishing_off";
      return null;
    },

    outcome(decision: OutcomeDecision): OutcomeDecision {
      return writeOutcomeDecision(decision);
    },

    // An upload's signed part URLs never reach the journal (the contract §2).
    journal: journalWriteAnswer,

    async outcomeInCapture(tx, decision, input: CaptureOutcomeInput): Promise<CaptureOutcomeResult> {
      if (decision.work.action === "apply") return { decision };
      const id = writeCommandIdOf(input.work);
      if (id === null) return { decision };
      const command = await store.getCommand(tx, id, true);
      if (command === null || command.state !== "sending" || command.attemptId !== input.attemptId) return { decision };
      const verdict = writeAnswerVerdict({
        errorClass: decision.errorClass,
        outcome: input.step.outcome,
        httpStatus: input.step.httpStatus,
        fanslyErrorEnvelope: input.step.fanslyErrorEnvelope,
      });
      if (verdict === null) return { decision };
      const settled = await store.settle(tx, {
        id,
        attemptId: input.attemptId,
        to: verdict.to,
        reason: verdict.reason,
        httpStatus: input.step.httpStatus,
        observationId: input.observation?.id ?? null,
      });
      if (!settled) return { decision };
      if (verdict.autostop !== null) await store.autostop(tx, input.pageId, verdict.autostop);
      return {
        decision: {
          ...decision,
          work: { action: "close", closeReason: `write_${verdict.to}`, result: { commandId: id, state: verdict.to, reason: verdict.reason } },
        },
      };
    },

    async apply(tx, input: ApplyInput): Promise<ApplyResult> {
      const id = writeCommandIdOf(input.work);
      const command = id === null ? null : await store.getCommand(tx, id, true);
      if (command === null || command.state !== "sending" || command.attemptId !== input.attempt.id) {
        return { work: { satisfiesRevision: true, close: "done", closeReason: "write_not_in_flight" }, followups: [] };
      }
      // The answer as served (in memory right after the capture; the
      // journal's copy has no signed URL — an upload's create read from it
      // ends unknown, never sends unsigned parts).
      const read = readWriteAnswer(command.step, input.response, input.request.params);
      let result = read.ok ? read.result : null;
      let reason = read.ok ? null : read.reason;
      if (read.ok && read.secret !== undefined) {
        // An upload's part URLs: sealed on the command, opened only by the
        // page's transport right before a part's send (wall posts PR 8).
        if (input.secrets == null) {
          result = null;
          reason = "part_urls_not_sealed";
        } else {
          result = { ...read.result, partUrlsSealed: input.secrets.seal(read.secret) };
        }
      }
      const to = result !== null ? "answered" : "unknown";
      await store.settle(tx, {
        id: command.id,
        attemptId: input.attempt.id,
        to,
        reason: to === "answered" ? null : reason,
        result,
        httpStatus: input.attempt.httpStatus,
        observationId: input.observation.id,
      });
      return {
        work: { satisfiesRevision: true, close: "done", closeReason: `write_${to}`, result: { commandId: command.id, state: to } },
        followups: [],
        counters: { [`write_${to}`]: 1 },
      };
    },

    /** An upload part's answer (wall posts PR 8): the storage's receipt,
     *  read from memory right after its capture — never journaled. */
    async applyAnswer(tx, input: AnswerApplyInput): Promise<ApplyResult> {
      const id = writeCommandIdOf(input.work);
      const command = id === null ? null : await store.getCommand(tx, id, true);
      if (command === null || command.state !== "sending" || command.attemptId !== input.attempt.id) {
        return { work: { satisfiesRevision: true, close: "done", closeReason: "write_not_in_flight" }, followups: [] };
      }
      const read = readWriteAnswer(command.step, input.parsed, input.request.params);
      const to = read.ok ? "answered" : "unknown";
      await store.settle(tx, {
        id: command.id,
        attemptId: input.attempt.id,
        to,
        reason: read.ok ? null : read.reason,
        result: read.ok ? read.result : null,
        httpStatus: input.attempt.httpStatus,
        observationId: null,
      });
      return {
        work: { satisfiesRevision: true, close: "done", closeReason: `write_${to}`, result: { commandId: command.id, state: to } },
        followups: [],
        counters: { [`write_${to}`]: 1 },
      };
    },

    async applyLocal(tx, input: LocalApplyInput): Promise<ApplyResult> {
      const detail = input.plan?.detail;
      const id = writeCommandIdOf(input.work);
      // A local step without the plan's word: plan again at once.
      if (!isLocalDetail(detail) || id === null || detail.commandId !== id) {
        return { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
      }
      switch (detail.action) {
        case "refuse": {
          // Only a command still queued is refused: nothing of it was sent.
          const refused = await store.refuse(tx, { id, reason: detail.reason });
          return refused
            ? { work: { satisfiesRevision: true, close: "done", closeReason: "write_refused", result: { commandId: id, state: "refused", reason: detail.reason } }, followups: [], counters: { write_refused: 1 } }
            : { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
        }
        case "requeue": {
          // Its attempt never left: queued again, planned again at once.
          await store.requeue(tx, { id, attemptId: detail.attemptId, reason: detail.reason });
          return { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [], counters: { write_not_sent: 1 } };
        }
        case "refuse_not_sent": {
          // Its attempt never left; the same request would be refused again:
          // back to the queue, and refused there — in one transaction.
          const refused = await store.requeue(tx, { id, attemptId: detail.attemptId, reason: detail.reason }) && await store.refuse(tx, { id, reason: detail.reason });
          return refused
            ? { work: { satisfiesRevision: true, close: "done", closeReason: "write_refused", result: { commandId: id, state: "refused", reason: detail.reason } }, followups: [], counters: { write_refused: 1 } }
            : { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
        }
        case "settle_unknown": {
          const settled = await store.settle(tx, { id, attemptId: detail.attemptId, to: "unknown", reason: detail.reason });
          return settled
            ? { work: { satisfiesRevision: true, close: "done", closeReason: "write_unknown", result: { commandId: id, state: "unknown", reason: detail.reason } }, followups: [], counters: { write_unknown: 1 } }
            : { work: { satisfiesRevision: false, nextDueAt: input.now }, followups: [] };
        }
      }
    },
  };
}
