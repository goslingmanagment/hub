import { describe, expect, it } from "vitest";

import type { Database, FanslyWriteCommandRecord, FanslyWriteFileFacts, SyncAttemptRow, SyncPageRow, SyncWorkRow } from "@agency_hub_core/db";
import { describeFanslyWrite, type FanslyWireId } from "@agency_hub_core/fansly";

import type { OutcomeDecision } from "../apps/runtime/src/sync/engine/errors.ts";
import type { CaptureOutcomeInput, PlanContext, RequestPlan, StepPlan } from "../apps/runtime/src/sync/engine/resource.ts";
import { yieldingToUrgent } from "../apps/runtime/src/sync/engine/resource.ts";
import { pick, type ClassWorkSource } from "../apps/runtime/src/sync/engine/scheduler.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { readWriteAnswer } from "../apps/runtime/src/sync/fansly/publish/answers.ts";
import { FANSLY_WRITE_OPERATIONS, nextWriteStep, writeAnswerVerdict, writeOutcomeDecision } from "../apps/runtime/src/sync/fansly/publish/commands.ts";
import { deriveFanslyWrite, FANSLY_WITHDRAW_LEAD_MS, parseApprovedForm, type ApprovedForm, type WriteDeriveInput } from "../apps/runtime/src/sync/fansly/publish/derive.ts";
import { writeGuard, type WriteGuardInput } from "../apps/runtime/src/sync/fansly/publish/guard.ts";
import { fanslyWriteModule, WriteAdmissionRefusedError, type WriteDeriveContext, type WriteModuleStore } from "../apps/runtime/src/sync/fansly/publish/module.ts";

// Wall posts PR 6: the page actor's write commands. One attempt (a command
// is sent only from `queued`; after it may have gone it is never sent again),
// the request derived from the approval with its fingerprint recorded before
// the send, the answer journaled first and read by the apply, Node refused,
// and writes behind the page's urgent reads.

const NOW = new Date("2026-10-24T12:00:00.000Z");
const PUBLISH_AT = new Date("2026-10-26T18:00:00.000Z");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const db = {} as Database;

function form(overrides: Partial<Record<string, unknown>> = {}): ApprovedForm {
  const parsed = parseApprovedForm({
    v: 1,
    publicationId: 41,
    page: { id: 7, platform: "fansly" },
    kind: "subscriber_post",
    text: "hello",
    publishAt: PUBLISH_AT.toISOString(),
    expiresAt: null,
    wallRefs: ["w2", "w1"],
    tierRefs: ["t9", "t3"],
    priceMills: null,
    repost: false,
    media: [{ role: "media", position: 0, source: "file", mediaRef: null, fileId: 5, fileSha256: SHA_A }],
    ...overrides,
  });
  if (parsed === null) throw new Error("test form does not parse");
  return parsed;
}

function command(overrides: Partial<FanslyWriteCommandRecord> = {}): FanslyWriteCommandRecord {
  return {
    id: 100,
    pageId: 7,
    dispatchId: 9,
    publicationId: 41,
    step: "post",
    item: "",
    priority: "background",
    notBefore: new Date(NOW.getTime() - 60_000),
    notAfter: null,
    state: "queued",
    stateReason: null,
    workId: 500,
    attemptId: null,
    notSentCount: 0,
    request: null,
    requestFingerprint: null,
    result: null,
    httpStatus: null,
    observationId: null,
    createdAt: NOW,
    admittedAt: null,
    settledAt: null,
    ...overrides,
  };
}

/** An earlier step of the dispatch, answered. */
function done(step: FanslyWriteCommandRecord["step"], item: string, result: Record<string, unknown>, facts: Record<string, unknown> = {}, id = 90): FanslyWriteCommandRecord {
  return command({ id, step, item, state: "answered", attemptId: id, requestFingerprint: "f".repeat(64), admittedAt: NOW, settledAt: NOW, result, request: { spec: "x", method: "POST", host: "api", pathAndQuery: "/", body: "{}", fingerprint: "f".repeat(64), facts } });
}

const FILE: FanslyWriteFileFacts = { id: 5, modelId: 3, contentSha256: SHA_A, byteSize: 2_048, mimeType: "image/jpeg", originalName: "beach.jpg", bytesDeletedAt: null };

function deriveInput(overrides: Partial<WriteDeriveInput> = {}): WriteDeriveInput {
  return {
    command: command(),
    dispatch: { kind: "create", mode: "scheduled", revisionId: 33 },
    form: form(),
    publication: { status: "submitting", platformPostRef: null },
    files: new Map([[5, FILE]]),
    commands: [],
    now: NOW,
    ...overrides,
  };
}

describe("one attempt: what comes next for a command (spec §8.2)", () => {
  const attempt = (outcome: SyncAttemptRow["outcome"], applyState: SyncAttemptRow["applyState"] = "none") =>
    ({ id: 8, outcome, applyState, errorClass: null });
  const sending = command({ state: "sending", attemptId: 8 });

  it("sends only from queued; a final command is closed for good", () => {
    expect(nextWriteStep(command(), null)).toEqual({ kind: "derive" });
    for (const state of ["answered", "rejected", "unknown", "refused"] as const) {
      expect(nextWriteStep(command({ state, attemptId: state === "refused" ? null : 8 }), attempt("unknown")), state).toEqual({ kind: "closed" });
    }
  });

  it("a crash after the send (the attempt recovered unknown), a lost answer or a timeout: unknown, never sent again", () => {
    expect(nextWriteStep(sending, attempt("unknown"))).toEqual({ kind: "settle_unknown", reason: "no_answer:unknown" });
    expect(nextWriteStep(sending, attempt("transport_error"))).toEqual({ kind: "settle_unknown", reason: "no_answer:transport_error" });
    expect(nextWriteStep(sending, attempt("timeout"))).toEqual({ kind: "settle_unknown", reason: "no_answer:timeout" });
    // Its attempt is gone from the journal: whether it left cannot be known.
    expect(nextWriteStep(sending, null)).toEqual({ kind: "settle_unknown", reason: "attempt_missing" });
    expect(nextWriteStep(sending, { ...attempt("response"), id: 9 })).toEqual({ kind: "settle_unknown", reason: "attempt_missing" });
    // An answer nobody could apply is no answer.
    expect(nextWriteStep(sending, attempt("response", "quarantined"))).toEqual({ kind: "settle_unknown", reason: "answer_not_applied:quarantined" });
    expect(nextWriteStep(sending, attempt("response", "none"))).toEqual({ kind: "settle_unknown", reason: "answer_not_applied:none" });
  });

  it("an attempt that provably never left goes back to the queue; one in flight or captured is waited for", () => {
    expect(nextWriteStep(sending, { ...attempt("aborted_before_send"), errorClass: "not_sent:pace" })).toEqual({ kind: "requeue", reason: "not_sent:not_sent:pace" });
    expect(nextWriteStep(sending, attempt("admitted"))).toEqual({ kind: "await_attempt" });
    expect(nextWriteStep(sending, attempt("sent"))).toEqual({ kind: "await_attempt" });
    expect(nextWriteStep(sending, attempt("response", "captured"))).toEqual({ kind: "await_apply" });
    expect(nextWriteStep(sending, attempt("response", "deferred"))).toEqual({ kind: "await_apply" });
  });
});

describe("the answer of a write that is not one to apply", () => {
  const verdict = (errorClass: string, status: number | null, envelope: boolean, outcome: "response" | "transport_error" | "timeout" = "response") =>
    writeAnswerVerdict({ errorClass: errorClass as never, httpStatus: status, fanslyErrorEnvelope: envelope, outcome });

  it("is Fansly's refusal only as a 4xx carrying its own error; anything else may hide a created post", () => {
    expect(verdict("ok", 200, false)).toBeNull();
    expect(verdict("subject_failure", 400, true)).toEqual({ to: "rejected", reason: "fansly_http_400", autostop: null });
    expect(verdict("envelope_unsuccessful", 200, true)).toEqual({ to: "rejected", reason: "fansly_unsuccessful", autostop: null });
    expect(verdict("subject_failure", 500, true)).toEqual({ to: "unknown", reason: "answer_subject_failure:500", autostop: null });
    expect(verdict("subject_failure", 502, false)).toEqual({ to: "unknown", reason: "answer_subject_failure:502", autostop: null });
    expect(verdict("subject_failure", 400, false)).toEqual({ to: "unknown", reason: "answer_subject_failure:400", autostop: null });
    expect(verdict("network", null, false, "timeout")).toEqual({ to: "unknown", reason: "no_answer:timeout", autostop: null });
    expect(verdict("network", null, false, "transport_error")).toEqual({ to: "unknown", reason: "no_answer:transport_error", autostop: null });
  });

  it("stops the page's publishing on a 401, 403 or 429 (spec §8.3)", () => {
    expect(verdict("auth", 401, true)).toEqual({ to: "rejected", reason: "fansly_http_401", autostop: "fansly_http_401" });
    expect(verdict("auth", 403, false)).toEqual({ to: "unknown", reason: "answer_auth:403", autostop: "fansly_http_403" });
    expect(verdict("rate_limit", 429, true)).toEqual({ to: "rejected", reason: "fansly_http_429", autostop: "fansly_http_429" });
  });

  it("never puts the row on a breaker's ladder; the page's and the route's holds stay", () => {
    const decision = {
      errorClass: "rate_limit", attemptErrorClass: "rate_limit", pageHold: { action: "keep" }, networkFailureStreak: null,
      work: { action: "reopen", dueAt: new Date(NOW.getTime() + 600_000), waitingReason: "subject_breaker", waitingUntil: null },
      subjectBreaker: { failureCount: 1, breakerUntil: new Date(NOW.getTime() + 600_000), blockedByVendorAt: null, terminal: false },
      resourceHold: { action: "keep" }, routeHold: { action: "set", route: "publish.post" } as never, quarantineAttempt: false, alerts: [],
    } as unknown as OutcomeDecision;
    const written = writeOutcomeDecision(decision);
    expect(written.work).toEqual({ action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null });
    expect(written.subjectBreaker).toBeNull();
    expect(written.routeHold).toBe(decision.routeHold);
    const apply = { ...decision, work: { action: "apply" } } as OutcomeDecision;
    expect(writeOutcomeDecision(apply)).toBe(apply);
  });
});

describe("the guard of a write (spec §8.3–8.4)", () => {
  const base: WriteGuardInput = {
    step: "post", now: NOW, notBefore: new Date(NOW.getTime() - 1), notAfter: null, publishingEnabled: true,
    page: { enabled: true, autostopReason: null }, transport: "browser", transportWrites: true, contractVerified: true,
  };

  it("goes only on a browser page with every switch on and a verified route", () => {
    expect(writeGuard(base)).toEqual({ kind: "go" });
    expect(writeGuard({ ...base, transport: "node" })).toEqual({ kind: "refuse", reason: "transport_node" });
    expect(writeGuard({ ...base, contractVerified: false })).toEqual({ kind: "refuse", reason: "route_unverified" });
    expect(writeGuard({ ...base, publishingEnabled: false })).toEqual({ kind: "refuse", reason: "publishing_off" });
    expect(writeGuard({ ...base, page: { enabled: false, autostopReason: null } })).toEqual({ kind: "refuse", reason: "page_publishing_off" });
    expect(writeGuard({ ...base, page: { enabled: false, autostopReason: "fansly_http_401" } })).toEqual({ kind: "refuse", reason: "page_stopped:fansly_http_401" });
  });

  it("withdraws with publishing off, never on a stopped page", () => {
    const cancel = { ...base, step: "post_cancel" as const, publishingEnabled: false, page: { enabled: false, autostopReason: null } };
    expect(writeGuard(cancel)).toEqual({ kind: "go" });
    expect(writeGuard({ ...cancel, page: { enabled: false, autostopReason: "login_lost" } })).toEqual({ kind: "refuse", reason: "page_stopped:login_lost" });
    expect(writeGuard({ ...cancel, transport: "node" })).toEqual({ kind: "refuse", reason: "transport_node" });
  });

  it("waits for its time and for a browser that takes writes, never past its window", () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(writeGuard({ ...base, notBefore: later })).toEqual({ kind: "wait", until: later, reason: "not_before" });
    expect(writeGuard({ ...base, transportWrites: false })).toEqual({ kind: "wait", until: new Date(NOW.getTime() + 60_000), reason: "transport_cannot_write" });
    const soon = new Date(NOW.getTime() + 10_000);
    expect(writeGuard({ ...base, transportWrites: false, notAfter: soon })).toEqual({ kind: "wait", until: soon, reason: "transport_cannot_write" });
    expect(writeGuard({ ...base, notAfter: NOW })).toEqual({ kind: "refuse", reason: "window_passed" });
  });
});

describe("a request derived from the approval and the dispatch's results (spec §5)", () => {
  it("uploads the approved bytes, and nothing else", () => {
    const upload = deriveFanslyWrite(deriveInput({ command: command({ step: "upload_create", item: "media:0" }) }));
    expect(upload).toMatchObject({ ok: true, request: { spec: "publish.upload_create", params: { fileSize: 2_048, mimeType: "image/jpeg", fileName: "beach.jpg" } } });
    if (!upload.ok) throw new Error("unreachable");
    expect(upload.facts).toMatchObject({ commandId: 100, dispatchId: 9, revisionId: 33, fileSha256: SHA_A });
    // The bytes changed since the approval: never uploaded.
    const changed = deriveFanslyWrite(deriveInput({ command: command({ step: "upload_create", item: "media:0" }), files: new Map([[5, { ...FILE, contentSha256: SHA_B }]]) }));
    expect(changed).toEqual({ ok: false, reason: "file_changed" });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "upload_create", item: "media:0" }), files: new Map([[5, { ...FILE, byteSize: null }]]) })))
      .toEqual({ ok: false, reason: "file_facts_missing" });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "upload_create", item: "media:0" }), files: new Map([[5, { ...FILE, bytesDeletedAt: NOW }]]) })))
      .toEqual({ ok: false, reason: "file_bytes_deleted" });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "upload_create", item: "media:3" }) }))).toEqual({ ok: false, reason: "item_not_in_approval" });
  });

  it("completes an upload only with the parts the byte upload recorded (PR 8)", () => {
    const created = done("upload_create", "media:0", { uploadId: "u1", partSize: 1_024, uploadType: 1 }, { fileSha256: SHA_A });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "upload_complete", item: "media:0" }), commands: [created] })))
      .toEqual({ ok: false, reason: "upload_parts_not_recorded" });
    const withParts = { ...created, result: { ...created.result, uploadedParts: [{ index: 0, eTag: "e0" }, { index: 1, eTag: "e1" }] } };
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "upload_complete", item: "media:0" }), commands: [withParts] })))
      .toMatchObject({ ok: true, request: { spec: "publish.upload_complete", params: { uploadId: "u1", partSize: 1_024 } }, facts: { from: [90] } });
  });

  it("takes who sees it and the price from the approval", () => {
    const vault = [{ role: "media", position: 0, source: "vault", mediaRef: "m1", fileId: null, fileSha256: null }];
    const subscribers = deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: form({ media: vault }) }));
    expect(subscribers).toMatchObject({ ok: true, request: { params: { mediaIds: ["m1"], audience: { kind: "subscribers", tierIds: ["t3", "t9"] } } } });
    const paid = deriveFanslyWrite(deriveInput({
      command: command({ step: "account_media" }),
      form: form({ kind: "paid_post", priceMills: "7500", tierRefs: [], media: vault }),
    }));
    expect(paid).toMatchObject({ ok: true, request: { params: { audience: { kind: "price", priceMills: 7_500 } } } });
    // A media not uploaded yet is not guessed.
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }) }))).toEqual({ ok: false, reason: "media_not_ready" });
  });

  it("never attaches an upload of other bytes than the approved ones", () => {
    const created = done("upload_create", "media:0", { uploadId: "u1", partSize: 1_024, uploadType: 1 }, { fileSha256: SHA_B }, 91);
    const completed = done("upload_complete", "media:0", { mediaId: "m9" }, {}, 92);
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), commands: [created, completed] })))
      .toEqual({ ok: false, reason: "upload_of_other_bytes" });
    const right = { ...created, request: { ...created.request!, facts: { fileSha256: SHA_A } } };
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), commands: [right, completed] })))
      .toMatchObject({ ok: true, request: { params: { mediaIds: ["m9"] } }, facts: { from: [91, 92] } });
  });

  it("makes the post of the approval and the account media, and its fingerprint is what the wire builds", () => {
    const accountMedia = done("account_media", "", { accountMediaIds: ["am1"] });
    const post = deriveFanslyWrite(deriveInput({ commands: [accountMedia] }));
    if (!post.ok) throw new Error(post.reason);
    expect(post.request.params).toEqual({
      content: "hello",
      attachments: [{ contentId: "am1", contentType: 1, pos: 0 }],
      scheduledForMs: PUBLISH_AT.getTime(),
      expiresAtMs: 0,
      wallIds: ["w1", "w2"],
      fyp: false,
    });
    expect(post.facts.fingerprint).toBe(describeFanslyWrite("publish.post", post.request.params as never).fingerprint);
    expect(post.write.fingerprint).toBe(post.facts.fingerprint);
    // Another earlier result is another request.
    const other = deriveFanslyWrite(deriveInput({ commands: [done("account_media", "", { accountMediaIds: ["am2"] })] }));
    expect(other.ok && other.facts.fingerprint).not.toBe(post.facts.fingerprint);
    // A post due now goes now; a FYP post carries its flag.
    expect(deriveFanslyWrite(deriveInput({ commands: [accountMedia], dispatch: { kind: "create", mode: "now", revisionId: 33 } })))
      .toMatchObject({ ok: true, request: { params: { scheduledForMs: 0 } } });
    expect(deriveFanslyWrite(deriveInput({ commands: [accountMedia], form: form({ kind: "fyp_post", tierRefs: [] }) })))
      .toMatchObject({ ok: true, request: { params: { fyp: true } } });
    expect(deriveFanslyWrite(deriveInput())).toEqual({ ok: false, reason: "account_media_missing" });
  });

  it("puts a paid post of several files or with a preview in one bundle", () => {
    const paid = form({
      kind: "paid_post", priceMills: "5000", tierRefs: [],
      media: [
        { role: "media", position: 0, source: "vault", mediaRef: "m1", fileId: null, fileSha256: null },
        { role: "media", position: 1, source: "vault", mediaRef: "m2", fileId: null, fileSha256: null },
        { role: "preview", position: 0, source: "vault", mediaRef: "p1", fileId: null, fileSha256: null },
      ],
    });
    const accountMedia = done("account_media", "", { accountMediaIds: ["am1", "am2"] }, {}, 93);
    expect(deriveFanslyWrite(deriveInput({ form: paid, commands: [accountMedia] }))).toEqual({ ok: false, reason: "bundle_missing" });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media_bundle" }), form: paid, commands: [accountMedia] })))
      .toMatchObject({ ok: true, request: { params: { accountMediaIds: ["am1", "am2"], previewMediaId: "p1", audience: { kind: "price", priceMills: 5_000 } } } });
    const bundle = done("account_media_bundle", "", { bundleId: "b1" }, {}, 94);
    expect(deriveFanslyWrite(deriveInput({ form: paid, commands: [accountMedia, bundle] })))
      .toMatchObject({ ok: true, request: { params: { attachments: [{ contentId: "b1", contentType: 2, pos: 0 }] } } });
    // A bundle is a paid post's only.
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media_bundle" }), commands: [accountMedia] })))
      .toEqual({ ok: false, reason: "bundle_not_paid" });
  });

  it("withdraws only its own scheduled post, only well before its time, and only while a fresh read of the schedule shows it", () => {
    const withdraw = { kind: "withdraw" as const, mode: "withdraw", revisionId: 33 };
    const cancel = command({ step: "post_cancel" });
    const scheduled = { status: "scheduled", platformPostRef: "p77" };
    const fresh = { readAtMs: cancel.createdAt.getTime() + 1, postIds: ["p77"] };
    expect(deriveFanslyWrite(deriveInput({ command: cancel, dispatch: withdraw, publication: scheduled, schedule: fresh })))
      .toMatchObject({ ok: true, request: { spec: "publish.post_cancel", params: { postId: "p77" } } });
    expect(deriveFanslyWrite(deriveInput({ command: cancel, dispatch: withdraw, publication: { status: "published", platformPostRef: "p77" }, schedule: fresh })))
      .toEqual({ ok: false, reason: "not_scheduled" });
    const close = new Date(PUBLISH_AT.getTime() - FANSLY_WITHDRAW_LEAD_MS + 1);
    expect(deriveFanslyWrite(deriveInput({ command: cancel, dispatch: withdraw, now: close, publication: scheduled, schedule: fresh })))
      .toEqual({ ok: false, reason: "too_close_to_publish" });
    // The read must be taken after the withdrawal was asked for, and still show the post.
    expect(deriveFanslyWrite(deriveInput({ command: cancel, dispatch: withdraw, publication: scheduled }))).toEqual({ ok: false, reason: "schedule_not_read" });
    expect(deriveFanslyWrite(deriveInput({ command: cancel, dispatch: withdraw, publication: scheduled, schedule: { ...fresh, readAtMs: cancel.createdAt.getTime() } })))
      .toEqual({ ok: false, reason: "schedule_not_fresh" });
    expect(deriveFanslyWrite(deriveInput({ command: cancel, dispatch: withdraw, publication: scheduled, schedule: { ...fresh, postIds: ["p78"] } })))
      .toEqual({ ok: false, reason: "not_in_schedule" });
    // A create dispatch withdraws nothing; a withdraw creates nothing.
    expect(deriveFanslyWrite(deriveInput({ command: cancel }))).toEqual({ ok: false, reason: "step_not_of_dispatch" });
    expect(deriveFanslyWrite(deriveInput({ dispatch: withdraw }))).toEqual({ ok: false, reason: "step_not_of_dispatch" });
  });

  it("refuses an approval of another publication and a form it cannot read whole", () => {
    expect(deriveFanslyWrite(deriveInput({ form: { ...form(), publicationId: 42 } }))).toEqual({ ok: false, reason: "approval_of_other_publication" });
    expect(parseApprovedForm({ v: 2 })).toBeNull();
    expect(parseApprovedForm({ ...{ v: 1, publicationId: 41, kind: "paid_post", text: "", publishAt: PUBLISH_AT.toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], media: [] }, priceMills: "7.5" })).toBeNull();
  });
});

describe("the answer the apply reads (journaled first)", () => {
  it("takes the ids the next steps need, and calls an answer without them unknown", () => {
    expect(readWriteAnswer("post", { id: "p1" }, {})).toEqual({ ok: true, result: { postId: "p1" } });
    expect(readWriteAnswer("post", { post: { id: 12 } }, {})).toEqual({ ok: true, result: { postId: "12" } });
    expect(readWriteAnswer("post", { success: true }, {})).toEqual({ ok: false, reason: "answer_without_post_id" });
    expect(readWriteAnswer("account_media", [{ id: "a" }, { id: "b" }], { mediaIds: ["m1", "m2"] })).toEqual({ ok: true, result: { accountMediaIds: ["a", "b"] } });
    expect(readWriteAnswer("account_media", [{ id: "a" }], { mediaIds: ["m1", "m2"] })).toEqual({ ok: false, reason: "answer_count_differs" });
    // The upload's signed part URLs stay in the journal only.
    const upload = readWriteAnswer("upload_create", { id: "u1", partSize: 5, parts: [{ index: 0, uploadUrl: "https://s3/x?X-Amz-Signature=secret" }], type: 1 }, {});
    expect(upload).toEqual({ ok: true, result: { uploadId: "u1", partSize: 5, partCount: 1, uploadType: 1 } });
    expect(JSON.stringify(upload)).not.toContain("Signature");
  });
});

// ── the module against a store in memory ───────────────────────────────────

interface FakeState {
  command: FanslyWriteCommandRecord;
  attempts: Map<number, Pick<SyncAttemptRow, "id" | "outcome" | "applyState" | "errorClass">>;
  publication: { status: string; approvedRevisionId: number | null };
  page: { enabled: boolean; autostopReason: string | null };
  transport: "node" | "browser";
  sendable: boolean;
  admitted: number;
  autostops: string[];
}

function fakeStore(state: FakeState): WriteModuleStore {
  const accountMedia = done("account_media", "", { accountMediaIds: ["am1"] });
  return {
    async getCommand(_db, id) {
      return state.command.id === id ? { ...state.command } : null;
    },
    async getAttempt(_db, attemptId) {
      return state.attempts.get(attemptId) ?? null;
    },
    async readTransport() {
      return state.transport;
    },
    async readPageSettings() {
      return state.page;
    },
    async readDeriveContext(): Promise<WriteDeriveContext> {
      return {
        ok: true,
        dispatch: { kind: "create", mode: "scheduled", revisionId: 33 },
        form: form(),
        publication: { status: state.publication.status, platformPostRef: null },
        files: new Map([[5, FILE]]),
        commands: [accountMedia],
      };
    },
    async lockPublication() {
      return state.publication;
    },
    async readPublication() {
      return state.publication;
    },
    async admit(_db, input) {
      if (state.command.state !== "queued" || state.command.attemptId !== null) return false;
      state.admitted += 1;
      state.command = { ...state.command, state: "sending", attemptId: input.attemptId, request: input.request, requestFingerprint: input.request.fingerprint, admittedAt: NOW };
      return true;
    },
    async settle(_db, input) {
      if (state.command.state !== "sending" || state.command.attemptId !== input.attemptId) return false;
      state.command = { ...state.command, state: input.to, stateReason: input.reason, result: input.result ?? null, httpStatus: input.httpStatus ?? null, observationId: input.observationId ?? null, settledAt: NOW };
      return true;
    },
    async requeue(_db, input) {
      if (state.command.state !== "sending" || state.command.attemptId !== input.attemptId) return false;
      state.command = { ...state.command, state: "queued", attemptId: null, admittedAt: null, notSentCount: state.command.notSentCount + 1 };
      return true;
    },
    async refuse(_db, input) {
      if (state.command.state !== "queued") return false;
      state.command = { ...state.command, state: "refused", stateReason: input.reason, settledAt: NOW };
      return true;
    },
    async autostop(_db, _pageId, reason) {
      state.autostops.push(reason);
      return true;
    },
    isSendable: () => state.sendable,
  };
}

function fresh(overrides: Partial<FakeState> = {}): FakeState {
  return {
    command: command(),
    attempts: new Map(),
    publication: { status: "submitting", approvedRevisionId: 33 },
    page: { enabled: true, autostopReason: null },
    transport: "browser",
    sendable: true,
    admitted: 0,
    autostops: [],
    ...overrides,
  };
}

const WORK = { id: 500, subject: "100" } as SyncWorkRow;

function planContext(overrides: Partial<PlanContext> = {}): PlanContext {
  return {
    db,
    pageId: 7,
    now: NOW,
    page: {} as SyncPageRow,
    registry: {} as never,
    settings: { read: async () => ({ publishingEnabled: true }) as never },
    transportWrites: () => true,
    ...overrides,
  };
}

async function admitOnce(module: ReturnType<typeof fanslyWriteModule>, plan: StepPlan, attemptId: number): Promise<void> {
  if (plan.kind !== "request") throw new Error(`expected a request, got ${plan.kind}`);
  const fingerprint = (plan.request.step as { fingerprint: string }).fingerprint;
  await module.onAdmit!(db, WORK, plan.request, { attemptId, writeFingerprint: fingerprint });
}

async function runLocal(module: ReturnType<typeof fanslyWriteModule>, plan: StepPlan) {
  if (plan.kind !== "local") throw new Error(`expected a local step, got ${plan.kind}`);
  return module.applyLocal!(db, { pageId: 7, work: WORK, now: NOW, ownRef: null, plan: { reason: plan.reason, detail: plan.detail } });
}

describe("the module: one attempt across a crash", () => {
  it("a crash after the send: the recovered attempt makes the command unknown and it is never planned again", async () => {
    const state = fresh();
    const module = fanslyWriteModule(fakeStore(state));
    const first = await module.plan(WORK, planContext());
    await admitOnce(module, first, 8);
    // Recorded before the send: the request and its fingerprint, under the one attempt.
    expect(state.command).toMatchObject({ state: "sending", attemptId: 8, requestFingerprint: (first as { request: { step: { fingerprint: string } } }).request.step.fingerprint });
    expect(state.command.request?.fingerprint).toBe(state.command.requestFingerprint);
    // The process died after the send; the next owner's recovery closed the attempt `unknown`.
    state.attempts.set(8, { id: 8, outcome: "unknown", applyState: "none", errorClass: null });
    const after = await module.plan(WORK, planContext());
    expect(after).toMatchObject({ kind: "local", detail: { action: "settle_unknown", reason: "no_answer:unknown" } });
    await runLocal(module, after);
    expect(state.command.state).toBe("unknown");
    // Planned again and again: closed, never a request.
    for (let i = 0; i < 3; i += 1) expect(await module.plan(WORK, planContext())).toMatchObject({ kind: "done" });
    expect(state.admitted).toBe(1);
    // A second admission is refused even if someone asked for one.
    await expect(module.onAdmit!(db, WORK, (first as { request: RequestPlan }).request, { attemptId: 9, writeFingerprint: (first as { request: { step: { fingerprint: string } } }).request.step.fingerprint }))
      .rejects.toBeInstanceOf(WriteAdmissionRefusedError);
    expect(state.admitted).toBe(1);
  });

  it("an attempt that never left: queued again and sent once, under a new attempt", async () => {
    const state = fresh();
    const module = fanslyWriteModule(fakeStore(state));
    await admitOnce(module, await module.plan(WORK, planContext()), 8);
    state.attempts.set(8, { id: 8, outcome: "aborted_before_send", applyState: "none", errorClass: "not_sent:lease_inactive" });
    await runLocal(module, await module.plan(WORK, planContext()));
    expect(state.command).toMatchObject({ state: "queued", attemptId: null, notSentCount: 1 });
    await admitOnce(module, await module.plan(WORK, planContext()), 11);
    expect(state.command).toMatchObject({ state: "sending", attemptId: 11 });
    expect(state.admitted).toBe(2);
  });

  it("waits while its answer is captured and not applied yet", async () => {
    const state = fresh();
    const module = fanslyWriteModule(fakeStore(state));
    await admitOnce(module, await module.plan(WORK, planContext()), 8);
    state.attempts.set(8, { id: 8, outcome: "response", applyState: "captured", errorClass: null });
    expect(await module.plan(WORK, planContext())).toMatchObject({ kind: "wait", reason: "dependency" });
  });
});

describe("the module: the fingerprint is recorded before the send, of the request that goes", () => {
  it("refuses an admission whose transport built another request, or whose approval moved", async () => {
    const state = fresh();
    const module = fanslyWriteModule(fakeStore(state));
    const plan = await module.plan(WORK, planContext());
    if (plan.kind !== "request") throw new Error("expected a request");
    await expect(module.onAdmit!(db, WORK, plan.request, { attemptId: 8, writeFingerprint: "0".repeat(64) })).rejects.toThrow(/fingerprint_mismatch/);
    await expect(module.onAdmit!(db, WORK, { ...plan.request, params: { ...(plan.request.params as object), content: "edited" } as never }, {
      attemptId: 8, writeFingerprint: (plan.request.step as { fingerprint: string }).fingerprint,
    })).rejects.toThrow(/fingerprint_mismatch/);
    state.publication = { status: "draft", approvedRevisionId: null };
    await expect(admitOnce(module, plan, 8)).rejects.toThrow(/publication_draft/);
    state.publication = { status: "submitting", approvedRevisionId: 34 };
    await expect(admitOnce(module, plan, 8)).rejects.toThrow(/publication_submitting/);
    state.publication = { status: "submitting", approvedRevisionId: 33 };
    state.page = { enabled: false, autostopReason: null };
    await expect(admitOnce(module, plan, 8)).rejects.toThrow(/page_publishing_off/);
    state.page = { enabled: true, autostopReason: null };
    state.sendable = false;
    await expect(admitOnce(module, plan, 8)).rejects.toThrow(/route_unverified/);
    expect(state.admitted).toBe(0);
    expect(state.command.state).toBe("queued");
    state.sendable = true;
    await admitOnce(module, plan, 8);
    expect(state.command.requestFingerprint).toBe((plan.request.step as { fingerprint: string }).fingerprint);
    expect(state.command.request).toMatchObject({ spec: "publish.post", method: "POST", host: "api", pathAndQuery: "/api/v1/post?ngsw-bypass=true" });
  });
});

describe("the module: a refused admission is not tried lap after lap", () => {
  it("the next plan refuses the command, which is never sent", async () => {
    const state = fresh();
    const module = fanslyWriteModule(fakeStore(state));
    const plan = await module.plan(WORK, planContext());
    if (plan.kind !== "request") throw new Error("expected a request");
    // A transport that built another request than the one derived (a bug).
    await expect(module.onAdmit!(db, WORK, plan.request, { attemptId: 8, writeFingerprint: "0".repeat(64) })).rejects.toThrow(/fingerprint_mismatch/);
    const next = await module.plan(WORK, planContext());
    expect(next).toMatchObject({ kind: "local", detail: { action: "refuse", reason: "admission_refused:fingerprint_mismatch" } });
    await runLocal(module, next);
    expect(state.command.state).toBe("refused");
    expect(state.admitted).toBe(0);
    expect(await module.plan(WORK, planContext())).toMatchObject({ kind: "done" });
  });
});

describe("the module: the page's browser asks again at its pause (PR 7)", () => {
  const settingsOn = { read: async () => ({ publishingEnabled: true }) as never };
  const settingsOff = { read: async () => ({ publishingEnabled: false }) as never };

  it("confirms only the command in flight under its attempt and fingerprint, its approval in force, the page's publishing and the switch on", async () => {
    const state = fresh();
    const module = fanslyWriteModule(fakeStore(state));
    const plan = await module.plan(WORK, planContext());
    await admitOnce(module, plan, 8);
    const fingerprint = state.command.requestFingerprint!;
    const confirm = (input: Partial<{ attemptId: number; writeFingerprint: string; settings: typeof settingsOn }> = {}) =>
      module.confirmWrite!(db, WORK, { attemptId: 8, writeFingerprint: fingerprint, settings: settingsOn, ...input });
    expect(await confirm()).toBeNull();
    expect(await confirm({ attemptId: 9 })).toBe("command_sending");
    expect(await confirm({ writeFingerprint: "0".repeat(64) })).toBe("fingerprint_mismatch");
    expect(await confirm({ settings: settingsOff })).toBe("publishing_off");
    // No live settings: fail closed.
    expect(await module.confirmWrite!(db, WORK, { attemptId: 8, writeFingerprint: fingerprint })).toBe("publishing_off");
    state.publication = { status: "submitting", approvedRevisionId: 34 };
    expect(await confirm()).toBe("publication_submitting");
    state.publication = { status: "draft", approvedRevisionId: null };
    expect(await confirm()).toBe("publication_draft");
    state.publication = { status: "submitting", approvedRevisionId: 33 };
    state.page = { enabled: false, autostopReason: null };
    expect(await confirm()).toBe("page_publishing_off");
    state.page = { enabled: true, autostopReason: "fansly_http_429" };
    expect(await confirm()).toBe("page_stopped:fansly_http_429");
  });

  it("a write the browser refused, or the engine at its check, ends refused: the same request is never tried again", async () => {
    const state = fresh();
    const module = fanslyWriteModule(fakeStore(state));
    await admitOnce(module, await module.plan(WORK, planContext()), 8);
    state.attempts.set(8, { id: 8, outcome: "aborted_before_send", applyState: "none", errorClass: "not_sent:write_refused" });
    const next = await module.plan(WORK, planContext());
    expect(next).toMatchObject({ kind: "local", detail: { action: "refuse_not_sent", attemptId: 8, reason: "not_sent:not_sent:write_refused" } });
    await runLocal(module, next);
    expect(state.command).toMatchObject({ state: "refused", attemptId: null, notSentCount: 1 });
    for (let i = 0; i < 2; i += 1) expect(await module.plan(WORK, planContext())).toMatchObject({ kind: "done" });
    expect(state.admitted).toBe(1);
  });

  it("asks the browser for the permission of its step: a post needs create, a cancel withdraw", async () => {
    const asked: string[] = [];
    const module = fanslyWriteModule(fakeStore(fresh()));
    expect(await module.plan(WORK, planContext({ transportWrites: (permission) => (asked.push(permission), permission === "withdraw") }))).toMatchObject({ kind: "wait", reason: "dependency" });
    expect(asked).toEqual(["create"]);
  });
});

describe("the module: Node and the switches refuse before anything is admitted", () => {
  it("a page on Node, an unverified route, publishing off: refused, never a request", async () => {
    for (const [overrides, reason] of [
      [{ transport: "node" }, "transport_node"],
      [{ sendable: false }, "route_unverified"],
      [{ page: { enabled: false, autostopReason: null } }, "page_publishing_off"],
    ] as const) {
      const state = fresh(overrides as Partial<FakeState>);
      const module = fanslyWriteModule(fakeStore(state));
      const plan = await module.plan(WORK, planContext());
      expect(plan, reason).toMatchObject({ kind: "local", detail: { action: "refuse", reason } });
      await runLocal(module, plan);
      expect(state.command.state, reason).toBe("refused");
      expect(state.admitted).toBe(0);
    }
    // No live settings: fail closed.
    const state = fresh();
    const module = fanslyWriteModule(fakeStore(state));
    const { settings: _none, ...withoutSettings } = planContext();
    expect(await module.plan(WORK, withoutSettings)).toMatchObject({ kind: "local", detail: { reason: "publishing_off" } });
    // A browser that does not take writes yet (PR 7): it waits, it is not sent.
    expect(await module.plan(WORK, planContext({ transportWrites: () => false }))).toMatchObject({ kind: "wait", reason: "dependency" });
  });
});

describe("the module: the answer settles the command", () => {
  const capture = (status: number | null, envelope: boolean, outcome: "response" | "transport_error" | "timeout" = "response"): CaptureOutcomeInput => ({
    pageId: 7, generation: 1n, now: NOW, work: WORK, attemptId: 8, demandRevision: 1, demand: {} as never, sent: true, sentAt: NOW,
    step: { request: {} as RequestPlan, httpStatus: status, outcome, fanslyErrorEnvelope: envelope },
    observation: status === null ? null : { id: 777, receivedAt: NOW },
  });
  const decision = (errorClass: string, work: OutcomeDecision["work"] = { action: "reopen", dueAt: null, waitingReason: null, waitingUntil: null }) =>
    ({ errorClass, work } as unknown as OutcomeDecision);

  async function sendingModule() {
    const state = fresh();
    const module = fanslyWriteModule(fakeStore(state));
    await admitOnce(module, await module.plan(WORK, planContext()), 8);
    return { state, module };
  }

  it("Fansly's refusal is rejected, and a 401 stops the page; the work closes", async () => {
    const { state, module } = await sendingModule();
    const result = await module.outcomeInCapture!(db, decision("auth"), capture(401, true));
    expect(state.command).toMatchObject({ state: "rejected", stateReason: "fansly_http_401", httpStatus: 401, observationId: 777 });
    expect(state.autostops).toEqual(["fansly_http_401"]);
    expect(result.decision.work).toMatchObject({ action: "close", closeReason: "write_rejected" });
  });

  it("no answer or a server's error is unknown", async () => {
    const { state, module } = await sendingModule();
    await module.outcomeInCapture!(db, decision("network"), capture(null, false, "timeout"));
    expect(state.command).toMatchObject({ state: "unknown", stateReason: "no_answer:timeout", observationId: null });
    expect(state.autostops).toEqual([]);
  });

  it("a 2xx is left to the apply, which reads the journaled answer", async () => {
    const { state, module } = await sendingModule();
    const ok = decision("ok", { action: "apply" });
    expect((await module.outcomeInCapture!(db, ok, capture(200, false))).decision).toBe(ok);
    expect(state.command.state).toBe("sending");
    const attempt = { id: 8, httpStatus: 200 } as SyncAttemptRow;
    const applied = await module.apply(db, {
      pageId: 7, now: NOW, ownRef: null, work: WORK, attempt, request: { spec: "publish.post" as FanslyWireId, params: {} as never },
      parsed: { id: "p5" }, response: { id: "p5" }, observation: { id: 778, receivedAt: NOW }, fenced: false, page: {} as SyncPageRow,
    });
    expect(state.command).toMatchObject({ state: "answered", result: { postId: "p5" }, observationId: 778, httpStatus: 200 });
    expect(applied.work).toMatchObject({ close: "done", closeReason: "write_answered" });
  });

  it("a 2xx without the id its step must give is unknown, not answered", async () => {
    const { state, module } = await sendingModule();
    await module.apply(db, {
      pageId: 7, now: NOW, ownRef: null, work: WORK, attempt: { id: 8, httpStatus: 200 } as SyncAttemptRow, request: { spec: "publish.post" as FanslyWireId, params: {} as never },
      parsed: {}, response: { success: true }, observation: { id: 779, receivedAt: NOW }, fenced: false, page: {} as SyncPageRow,
    });
    expect(state.command).toMatchObject({ state: "unknown", stateReason: "answer_without_post_id", observationId: 779 });
  });
});

describe("writes yield to the page's urgent reads; only a story in its window is urgent", () => {
  it("are planned work that yields to urgent work, a story's urgent; never the requests class", () => {
    const background = FANSLY_RESOURCE_SPECS.find((spec) => spec.key === "publish.background")!;
    const urgent = FANSLY_RESOURCE_SPECS.find((spec) => spec.key === "publish.urgent")!;
    expect(background).toMatchObject({ class: "planned", kind: "goal", subject: "command", triggers: ["publication"], evidence: true, yieldsToUrgent: true });
    // Planned at their slot only: a plan derives the request from several reads.
    expect(background.planBeforeGate).toBeUndefined();
    expect(urgent).toMatchObject({ class: "urgent", kind: "goal", subject: "command", triggers: ["publication"], evidence: true });
    expect(urgent.yieldsToUrgent).toBeUndefined();
    for (const spec of [background, urgent]) {
      expect(spec.operations).toEqual(FANSLY_WRITE_OPERATIONS);
      // No owner lever and no API enqueue: only the publications producer.
      expect(spec.triggers).not.toContain("owner");
      expect(spec.triggers).not.toContain("api");
    }
    // The only planned keys that yield: the page's background writes.
    expect(yieldingToUrgent(createFanslyRegistry())).toEqual(["publish.background"]);
  });

  it("an urgent read takes every slot from a waiting write, the planned slot included; the write goes when none waits", async () => {
    const yielding = new Set(yieldingToUrgent(createFanslyRegistry()));
    // The actor's planned pick: a yielding key is left out while urgent work is runnable.
    const source = (have: { urgent?: string; planned?: { key: string; work: string } }): ClassWorkSource<string> => ({
      async pickInClass(workClass) {
        if (workClass === "urgent") return have.urgent ?? null;
        if (workClass !== "planned" || have.planned === undefined) return null;
        return have.urgent !== undefined && yielding.has(have.planned.key) ? null : have.planned.work;
      },
    });
    const write = { key: "publish.background", work: "write" };
    const poll = { key: "account.poll", work: "poll" };
    const page = { cyclePos: 0, pausedAll: false, pausedRequests: false, holdUntil: null };
    for (let cyclePos = 0; cyclePos < 10; cyclePos += 1) {
      expect(await pick(source({ urgent: "dialog lookup", planned: write }), { ...page, cyclePos }, NOW), String(cyclePos)).toMatchObject({ work: "dialog lookup", workClass: "urgent" });
    }
    // A planned read keeps its share of the cycle, as before.
    expect(await pick(source({ urgent: "dialog lookup", planned: poll }), { ...page, cyclePos: 9 }, NOW)).toMatchObject({ work: "poll" });
    // Nothing urgent: the write is served.
    expect(await pick(source({ planned: write }), page, NOW)).toMatchObject({ work: "write", workClass: "planned" });
    // A story in its window is urgent work itself.
    expect(await pick(source({ urgent: "story", planned: write }), { ...page, cyclePos: 9 }, NOW)).toMatchObject({ work: "story", workClass: "urgent" });
  });
});
