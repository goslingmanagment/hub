import { describe, expect, it } from "vitest";

import type { Database, FanslyWriteCommandRecord, FanslyWriteFileFacts, SyncAttemptRow, SyncPageRow, SyncWorkRow } from "@agency_hub_core/db";
import { describeFanslyWrite, type FanslyWireId } from "@agency_hub_core/fansly";

import type { OutcomeDecision } from "../apps/runtime/src/sync/engine/errors.ts";
import type { CaptureOutcomeInput, PlanContext, RequestPlan, StepPlan } from "../apps/runtime/src/sync/engine/resource.ts";
import { yieldingToUrgent } from "../apps/runtime/src/sync/engine/resource.ts";
import { pick, type ClassWorkSource } from "../apps/runtime/src/sync/engine/scheduler.ts";
import { createFanslyRegistry, FANSLY_RESOURCE_SPECS } from "../apps/runtime/src/sync/fansly/registry.ts";
import { journalWriteAnswer, readWriteAnswer } from "../apps/runtime/src/sync/fansly/publish/answers.ts";
import { FANSLY_WRITE_OPERATIONS, nextWriteStep, writeAnswerVerdict, writeOutcomeDecision } from "../apps/runtime/src/sync/fansly/publish/commands.ts";
import { deriveFanslyWrite, FANSLY_SCHEDULE_LEAD_MS, FANSLY_WITHDRAW_LEAD_MS, fanslyPartRange, parseApprovedForm, postWallIds, type ApprovedForm, type WriteDeriveInput } from "../apps/runtime/src/sync/fansly/publish/derive.ts";
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
    tierRefs: ["t3"],
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
/** The page: its mandatory "Posts" wall, its tiers' names. */
const PAGE = { mainWallRefs: ["w0"], tierNames: new Map([["t3", "Gold"], ["t9", "Silver"]]) };

function deriveInput(overrides: Partial<WriteDeriveInput> = {}): WriteDeriveInput {
  return {
    command: command(),
    dispatch: { kind: "create", mode: "scheduled", revisionId: 33 },
    form: form(),
    publication: { status: "submitting", platformPostRef: null },
    files: new Map([[5, FILE]]),
    page: PAGE,
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
    // A published post's delete is a withdrawal too (0312).
    const remove = { ...cancel, step: "post_delete" as const };
    expect(writeGuard(remove)).toEqual({ kind: "go" });
    expect(writeGuard({ ...remove, page: { enabled: false, autostopReason: "login_lost" } })).toEqual({ kind: "refuse", reason: "page_stopped:login_lost" });
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

  const STORAGE = "fansly-upload.s3.eu-central-1.amazonaws.com";
  /** An upload's create of the approved 2 048 bytes, in parts of 1 024 (the contract §2). */
  const created = (facts: Record<string, unknown> = { fileSha256: SHA_A }) => done("upload_create", "media:0", {
    uploadId: "u1", partSize: 1_024, partCount: 2, uploadType: 1, partUrlsSealed: "sealed",
    parts: [{ index: 0, host: STORAGE, path: "/acc/u1" }, { index: 1, host: STORAGE, path: "/acc/u1" }],
  }, facts, 80);

  it("an upload's part: its range of the approved bytes, its storage host and path, the sha256 read from disk (PR 8)", () => {
    const part = (index: number, partBytes: NonNullable<WriteDeriveInput["partBytes"]> | null, commands = [created()]) =>
      deriveFanslyWrite(deriveInput({ command: command({ step: "upload_part", item: `media:0/part:${index}` }), commands, partBytes }));
    expect(fanslyPartRange({ command: command({ step: "upload_part", item: "media:0/part:1" }), form: form(), files: new Map([[5, FILE]]), commands: [created()] }))
      .toEqual({ ok: true, fileId: 5, byteOffset: 1_024, byteLength: 1_024 });
    expect(part(1, { fileId: 5, byteOffset: 1_024, byteLength: 1_024, sha256: SHA_B })).toMatchObject({
      ok: true,
      request: { spec: "publish.upload_part", params: { uploadCommandId: 80, partIndex: 1, host: STORAGE, path: "/acc/u1", fileId: 5, byteOffset: 1_024, byteLength: 1_024, partSha256: SHA_B } },
      write: { method: "PUT", host: "storage", pathAndQuery: `//${STORAGE}/acc/u1` },
      facts: { from: [80], fileSha256: SHA_A },
    });
    // Never bytes of another range, never unread; a part past the upload's.
    expect(part(1, { fileId: 5, byteOffset: 0, byteLength: 1_024, sha256: SHA_B })).toEqual({ ok: false, reason: "part_bytes_of_another_range" });
    expect(part(1, null)).toEqual({ ok: false, reason: "part_bytes_unread" });
    expect(part(2, null)).toEqual({ ok: false, reason: "part_not_in_upload" });
    // Parts that do not cover the file, an upload of other bytes, a file changed.
    const short = { ...created(), result: { ...created().result, partCount: 1 } };
    expect(part(0, null, [short])).toEqual({ ok: false, reason: "parts_do_not_cover_file" });
    expect(part(0, null, [created({ fileSha256: SHA_B })])).toEqual({ ok: false, reason: "upload_of_other_bytes" });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "upload_part", item: "media:0/part:0" }), commands: [created()], files: new Map([[5, { ...FILE, contentSha256: SHA_B }]]) })))
      .toEqual({ ok: false, reason: "file_changed" });
  });

  it("completes an upload with each part's own ETag, from its answered command (the contract §2)", () => {
    const complete = () => deriveFanslyWrite(deriveInput({ command: command({ step: "upload_complete", item: "media:0" }), commands }));
    let commands: FanslyWriteCommandRecord[] = [created(), done("upload_part", "media:0/part:0", { eTag: '"e0"' }, {}, 81)];
    expect(complete()).toEqual({ ok: false, reason: "upload_parts_not_recorded" });
    commands = [...commands, done("upload_part", "media:0/part:1", { eTag: '"e1"' }, {}, 82)];
    const completed = complete();
    expect(completed).toMatchObject({ ok: true, request: { spec: "publish.upload_complete", params: { uploadId: "u1", uploadType: 1, partSize: 1_024, parts: [{ index: 0, eTag: '"e0"' }, { index: 1, eTag: '"e1"' }] } }, facts: { from: [80, 81, 82] } });
    if (!completed.ok) throw new Error("unreachable");
    expect(JSON.parse(completed.write.body)).toEqual({ id: "u1", type: 1, partSize: 1_024, status: 0, parts: [{ index: 0, eTag: '"e0"' }, { index: 1, eTag: '"e1"' }], waitForComplete: 0 });
  });

  it("reads the upload by its id once its completion went — answered or lost; its media is the one a read found done", () => {
    const read = (commands: FanslyWriteCommandRecord[]) => deriveFanslyWrite(deriveInput({ command: command({ step: "upload_status", item: "media:0/poll:0" }), commands }));
    expect(read([created()])).toEqual({ ok: false, reason: "upload_not_completed" });
    const lost = command({ id: 83, step: "upload_complete", item: "media:0", state: "unknown", attemptId: 83, requestFingerprint: "f".repeat(64), admittedAt: NOW, settledAt: NOW });
    const status = read([created(), lost]);
    expect(status).toMatchObject({ ok: true, request: { spec: "publish.upload_status", params: { uploadId: "u1" } }, write: { method: "GET", host: "upload", pathAndQuery: "/api/v1/media/upload/u1?ngsw-bypass=true", body: "" } });
    // The media: from a read that found it done, never from the completion.
    const accountMedia = (commands: FanslyWriteCommandRecord[]) => deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), commands }));
    const answered = done("upload_complete", "media:0", { mediaId: "m-early", status: 3 }, {}, 84);
    expect(accountMedia([created(), answered])).toEqual({ ok: false, reason: "media_not_ready" });
    expect(accountMedia([created(), answered, done("upload_status", "media:0/poll:0", { status: 5, mediaId: null, done: false }, {}, 85)])).toEqual({ ok: false, reason: "media_not_ready" });
    expect(accountMedia([created(), answered, done("upload_status", "media:0/poll:1", { status: 6, mediaId: "m9", done: true }, {}, 86)]))
      .toMatchObject({ ok: true, request: { params: { media: [{ mediaId: "m9", previewId: null }] } }, facts: { from: [80, 86] } });
  });

  it("takes who sees it and the price from the approval", () => {
    const vault = [{ role: "media", position: 0, source: "vault", mediaRef: "m1", fileId: null, fileSha256: null }];
    const subscribers = deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: form({ media: vault }) }));
    expect(subscribers).toMatchObject({ ok: true, request: { params: { media: [{ mediaId: "m1", previewId: null }], audience: { kind: "subscribers", tiers: [{ id: "t3", name: "Gold" }], priceMills: null } } } });
    // Every tier; a story the subscribers too (the site's default, the contract §7).
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: form({ media: vault, tierRefs: [] }) })))
      .toMatchObject({ ok: true, request: { params: { audience: { kind: "subscribers", tiers: [], priceMills: null } } } });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: form({ kind: "story", media: vault, tierRefs: [], wallRefs: [] }) })))
      .toMatchObject({ ok: true, request: { params: { audience: { kind: "subscribers", tiers: [], priceMills: null } } } });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: form({ kind: "fyp_post", media: vault, tierRefs: [] }) })))
      .toMatchObject({ ok: true, request: { params: { audience: { kind: "everyone" } } } });
    // Several tiers, any of them (the contract §3, captured 2026-10-25); with a
    // price, whoever else pays it too. A tier whose name Hub does not hold is not guessed.
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: form({ media: vault, tierRefs: ["t9", "t3"] }) })))
      .toMatchObject({ ok: true, request: { params: { audience: { kind: "subscribers", tiers: [{ id: "t3", name: "Gold" }, { id: "t9", name: "Silver" }], priceMills: null } } } });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: form({ media: vault, tierRefs: [], priceMills: "5000" }) })))
      .toMatchObject({ ok: true, request: { params: { audience: { kind: "subscribers", tiers: [], priceMills: 5_000 } } } });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: form({ kind: "paid_post", media: vault, tierRefs: ["t3"], priceMills: "5000" }) })))
      .toEqual({ ok: false, reason: "audience_not_in_approval" });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: form({ media: vault, tierRefs: ["t4"] }) })))
      .toEqual({ ok: false, reason: "tier_name_unknown" });
    const paid = deriveFanslyWrite(deriveInput({
      command: command({ step: "account_media" }),
      form: form({ kind: "paid_post", priceMills: "7500", tierRefs: [], media: vault }),
    }));
    expect(paid).toMatchObject({ ok: true, request: { params: { audience: { kind: "price", priceMills: 7_500 } } } });
    // A media not uploaded yet is not guessed.
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }) }))).toEqual({ ok: false, reason: "media_not_ready" });
  });

  it("never attaches an upload of other bytes than the approved ones", () => {
    const other = done("upload_create", "media:0", { uploadId: "u1", partSize: 1_024, uploadType: 1 }, { fileSha256: SHA_B }, 91);
    const processed = done("upload_status", "media:0/poll:0", { status: 6, mediaId: "m9", done: true }, {}, 92);
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), commands: [other, processed] })))
      .toEqual({ ok: false, reason: "upload_of_other_bytes" });
    const right = { ...other, request: { ...other.request!, facts: { fileSha256: SHA_A } } };
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), commands: [right, processed] })))
      .toMatchObject({ ok: true, request: { params: { media: [{ mediaId: "m9", previewId: null }] } }, facts: { from: [91, 92] } });
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
    // A post sent now is not captured (the contract §10): never; nor one
    // whose time is closer than the schedule's lead. A FYP post carries its flag.
    expect(deriveFanslyWrite(deriveInput({ commands: [accountMedia], dispatch: { kind: "create", mode: "now", revisionId: 33 } })))
      .toEqual({ ok: false, reason: "immediate_post_unverified" });
    expect(deriveFanslyWrite(deriveInput({ commands: [accountMedia], now: new Date(PUBLISH_AT.getTime() - FANSLY_SCHEDULE_LEAD_MS + 1) })))
      .toEqual({ ok: false, reason: "too_close_to_schedule" });
    expect(deriveFanslyWrite(deriveInput({ commands: [accountMedia], form: form({ kind: "fyp_post", tierRefs: [] }) })))
      .toMatchObject({ ok: true, request: { params: { fyp: true } } });
    expect(deriveFanslyWrite(deriveInput())).toEqual({ ok: false, reason: "account_media_missing" });
  });

  it("names the post's walls as the site does (the contract §4): the chosen ones without the Posts wall; none other chosen, the Posts wall", () => {
    const accountMedia = done("account_media", "", { accountMediaIds: ["am1"] });
    const walls = (wallRefs: string[], page = PAGE) => {
      const post = deriveFanslyWrite(deriveInput({ commands: [accountMedia], form: form({ wallRefs }), page }));
      return post.ok ? (post.request.params as unknown as { wallIds: string[] }).wallIds : post.reason;
    };
    expect(walls(["w2", "w0", "w1"])).toEqual(["w1", "w2"]);
    expect(walls(["w0"])).toEqual(["w0"]);
    expect(walls([])).toEqual(["w0"]);
    expect(walls([], { ...PAGE, mainWallRefs: [] })).toBe("walls_missing");
    expect(postWallIds(["w1"], { mainWallRefs: [] })).toEqual(["w1"]);
  });

  it("puts several files in one bundle, each with its own preview (the contract §3); one file is account media with its preview", () => {
    const vault = (role: "media" | "preview", position: number, ref: string) => ({ role, position, source: "vault", mediaRef: ref, fileId: null, fileSha256: null });
    const paid = form({ kind: "paid_post", priceMills: "5000", tierRefs: [], media: [vault("media", 0, "m1"), vault("media", 1, "m2"), vault("preview", 0, "p1")] });
    expect(deriveFanslyWrite(deriveInput({ form: paid }))).toEqual({ ok: false, reason: "bundle_missing" });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media_bundle" }), form: paid })))
      .toMatchObject({ ok: true, request: { params: { media: [{ mediaId: "m1", previewId: "p1" }, { mediaId: "m2", previewId: null }], audience: { kind: "price", priceMills: 5_000 } } } });
    const bundle = done("account_media_bundle", "", { bundleId: "b1" }, {}, 94);
    expect(deriveFanslyWrite(deriveInput({ form: paid, commands: [bundle] })))
      .toMatchObject({ ok: true, request: { params: { attachments: [{ contentId: "b1", contentType: 2, pos: 0 }] } } });
    // Several files of any post go as a bundle; one file never does.
    const two = form({ media: [vault("media", 0, "m1"), vault("media", 1, "m2")] });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media_bundle" }), form: two })))
      .toMatchObject({ ok: true, request: { params: { audience: { kind: "subscribers", tiers: [{ id: "t3", name: "Gold" }], priceMills: null } } } });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: two }))).toEqual({ ok: false, reason: "several_files_are_a_bundle" });
    const single = form({ kind: "paid_post", priceMills: "3000", tierRefs: [], media: [vault("media", 0, "m1"), vault("preview", 0, "p1")] });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media_bundle" }), form: single }))).toEqual({ ok: false, reason: "bundle_of_one_file" });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: single })))
      .toMatchObject({ ok: true, request: { params: { media: [{ mediaId: "m1", previewId: "p1" }], audience: { kind: "price", priceMills: 3_000 } } } });
    // A preview is a file's own: one without its file is refused.
    const stray = form({ kind: "paid_post", priceMills: "3000", tierRefs: [], media: [vault("media", 0, "m1"), vault("preview", 1, "p1")] });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "account_media" }), form: stray }))).toEqual({ ok: false, reason: "preview_without_its_file" });
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

  it("deletes only a published post, under the id it holds now, with no body; never a story, never from another dispatch", () => {
    const deletion = { kind: "delete" as const, mode: "delete", revisionId: 33 };
    const remove = command({ step: "post_delete" });
    const published = { status: "published", platformPostRef: "970265084783775744" };
    const derived = deriveFanslyWrite(deriveInput({ command: remove, dispatch: deletion, publication: published }));
    expect(derived).toMatchObject({ ok: true, request: { spec: "publish.post_delete", params: { postId: "970265084783775744" } } });
    if (!derived.ok) throw new Error("derived");
    expect(derived.write).toEqual(describeFanslyWrite("publish.post_delete", { postId: "970265084783775744" }));
    expect(derived.write.body).toBe("");
    expect(derived.facts.fingerprint).toBe(derived.write.fingerprint);
    // Not out on the wall: nothing to delete (still scheduled, gone, unknown).
    for (const status of ["scheduled", "submitting", "withdrawn", "unknown"]) {
      expect(deriveFanslyWrite(deriveInput({ command: remove, dispatch: deletion, publication: { ...published, status } })), status).toEqual({ ok: false, reason: "not_published" });
    }
    expect(deriveFanslyWrite(deriveInput({ command: remove, dispatch: deletion, publication: { status: "published", platformPostRef: null } }))).toEqual({ ok: false, reason: "no_platform_post" });
    expect(deriveFanslyWrite(deriveInput({ command: remove, dispatch: deletion, publication: published, form: form({ kind: "story" }) }))).toEqual({ ok: false, reason: "story_is_no_post" });
    // Only under a delete dispatch, and a delete dispatch sends nothing else.
    expect(deriveFanslyWrite(deriveInput({ command: remove, publication: published }))).toEqual({ ok: false, reason: "step_not_of_dispatch" });
    expect(deriveFanslyWrite(deriveInput({ command: remove, dispatch: { kind: "withdraw", mode: "withdraw", revisionId: 33 }, publication: published }))).toEqual({ ok: false, reason: "step_not_of_dispatch" });
    expect(deriveFanslyWrite(deriveInput({ dispatch: deletion }))).toEqual({ ok: false, reason: "step_not_of_dispatch" });
    expect(deriveFanslyWrite(deriveInput({ command: command({ step: "post_cancel" }), dispatch: deletion, publication: published }))).toEqual({ ok: false, reason: "step_not_of_dispatch" });
  });

  it("refuses an approval of another publication and a form it cannot read whole", () => {
    expect(deriveFanslyWrite(deriveInput({ form: { ...form(), publicationId: 42 } }))).toEqual({ ok: false, reason: "approval_of_other_publication" });
    expect(parseApprovedForm({ v: 2 })).toBeNull();
    expect(parseApprovedForm({ ...{ v: 1, publicationId: 41, kind: "paid_post", text: "", publishAt: PUBLISH_AT.toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], media: [] }, priceMills: "7.5" })).toBeNull();
  });
});

describe("the answer the apply reads (journaled first)", () => {
  it("takes the ids the next steps need, and calls an answer without them unknown", () => {
    // The contract's answers: a post by its postId, a bundle by
    // accountMediaBundles[0].id, account media an array, a cancel the list.
    expect(readWriteAnswer("post", { postId: "p1", accountId: "a1", postTemplate: "{}" }, {})).toEqual({ ok: true, result: { postId: "p1" } });
    expect(readWriteAnswer("post", { id: "p1" }, {})).toEqual({ ok: false, reason: "answer_without_post_id" });
    expect(readWriteAnswer("post", { success: true }, {})).toEqual({ ok: false, reason: "answer_without_post_id" });
    expect(readWriteAnswer("account_media_bundle", { accountMediaBundles: [{ id: "b1" }], accountMedia: [{ id: "a" }] }, {})).toEqual({ ok: true, result: { bundleId: "b1" } });
    expect(readWriteAnswer("account_media_bundle", { id: "b1" }, {})).toEqual({ ok: false, reason: "answer_without_bundle_id" });
    expect(readWriteAnswer("story", { id: "s1", accountId: "a1", contentType: 1, contentId: "am1" }, {})).toEqual({ ok: true, result: { storyId: "s1" } });
    expect(readWriteAnswer("post_cancel", { scheduledPosts: [{ postId: "p1", status: 3 }] }, { postId: "p1" })).toEqual({ ok: true, result: { cancelled: true, listedStatus: 3 } });
    // A delete answers `response: null` (the contract §5): the read after decides.
    expect(readWriteAnswer("post_delete", null, { postId: "p1" })).toEqual({ ok: true, result: { deleted: true, postId: "p1", answer: "null" } });
    expect(readWriteAnswer("account_media", [{ id: "a" }], { media: [{ mediaId: "m1", previewId: null }] })).toEqual({ ok: true, result: { accountMediaIds: ["a"] } });
    expect(readWriteAnswer("account_media", [{ id: "a" }], { media: [{ mediaId: "m1", previewId: null }, { mediaId: "m2", previewId: null }] })).toEqual({ ok: false, reason: "answer_count_differs" });
    // An upload's create (the contract §2): its parts' host and path in the
    // result, their signed URLs apart (sealed by the apply), never in the journal.
    const s3 = "https://fansly-upload.s3.eu-central-1.amazonaws.com/acc/u1";
    const served = { id: "u1", type: 2, partSize: 20_971_520, status: 2, parts: [{ index: 1, uploadUrl: `${s3}?partNumber=2&X-Amz-Signature=sig2` }, { index: 0, uploadUrl: `${s3}?partNumber=1&X-Amz-Signature=sig1` }] };
    const upload = readWriteAnswer("upload_create", served, {});
    expect(upload).toEqual({
      ok: true,
      result: { uploadId: "u1", partSize: 20_971_520, partCount: 2, uploadType: 2, parts: [{ index: 0, host: "fansly-upload.s3.eu-central-1.amazonaws.com", path: "/acc/u1" }, { index: 1, host: "fansly-upload.s3.eu-central-1.amazonaws.com", path: "/acc/u1" }] },
      secret: { urls: [`${s3}?partNumber=1&X-Amz-Signature=sig1`, `${s3}?partNumber=2&X-Amz-Signature=sig2`] },
    });
    expect(JSON.stringify((upload as { result: unknown }).result)).not.toContain("Signature");
    expect(JSON.stringify(journalWriteAnswer(served))).not.toContain("Signature");
    expect(journalWriteAnswer(served)).toMatchObject({ parts: [{ index: 1, uploadUrl: s3 }, { index: 0, uploadUrl: s3 }] });
    // Unsigned (a journal's copy), a gap in the parts, a host no part goes to, a part over the limit: no upload Hub can carry on.
    expect(readWriteAnswer("upload_create", journalWriteAnswer(served), {})).toEqual({ ok: false, reason: "answer_parts_unsigned_or_unordered" });
    expect(readWriteAnswer("upload_create", { ...served, parts: [served.parts[0]] }, {})).toEqual({ ok: false, reason: "answer_parts_unsigned_or_unordered" });
    expect(readWriteAnswer("upload_create", { ...served, parts: [{ index: 0, uploadUrl: "https://apiv3.fansly.com/x?s=1" }] }, {})).toEqual({ ok: false, reason: "answer_parts_unsigned_or_unordered" });
    expect(readWriteAnswer("upload_create", { ...served, partSize: 65 * 1024 * 1024 }, {})).toEqual({ ok: false, reason: "answer_part_size_over_limit" });
    // A part's receipt needs its ETag; the upload is done at status 6 with its media.
    expect(readWriteAnswer("upload_part", { status: 200, eTag: '"e1"' }, {})).toEqual({ ok: true, result: { eTag: '"e1"' } });
    expect(readWriteAnswer("upload_part", { status: 200, eTag: null }, {})).toEqual({ ok: false, reason: "receipt_without_etag" });
    expect(readWriteAnswer("upload_complete", { status: 3, mediaId: null }, {})).toEqual({ ok: true, result: { mediaId: null, status: 3 } });
    expect(readWriteAnswer("upload_status", { status: 5, mediaId: null }, {})).toEqual({ ok: true, result: { status: 5, mediaId: null, done: false } });
    expect(readWriteAnswer("upload_status", { status: 6, mediaId: "m1", media: { id: "m1" } }, {})).toEqual({ ok: true, result: { status: 6, mediaId: "m1", done: true } });
    expect(readWriteAnswer("upload_status", { status: 6, media: { id: "m2" } }, {})).toEqual({ ok: true, result: { status: 6, mediaId: "m2", done: true } });
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
        page: PAGE,
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
    readPartSha256: async () => SHA_B,
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

describe("the module: a published post's delete (0312)", () => {
  function deleteStore(state: FakeState): WriteModuleStore {
    return {
      ...fakeStore(state),
      async readDeriveContext(): Promise<WriteDeriveContext> {
        return {
          ok: true,
          dispatch: { kind: "delete", mode: "delete", revisionId: 33 },
          form: form(),
          publication: { status: state.publication.status, platformPostRef: "970265084783775744" },
          files: new Map([[5, FILE]]),
          page: PAGE,
          commands: [],
        };
      },
    };
  }
  const deleting = () => fresh({ command: command({ step: "post_delete" }), publication: { status: "published", approvedRevisionId: 33 } });

  it("goes under withdraw with publishing off, without a schedule read, admitted only while the post is published", async () => {
    const asked: string[] = [];
    const state = deleting();
    const module = fanslyWriteModule(deleteStore(state));
    const off = { read: async () => ({ publishingEnabled: false }) as never };
    state.page = { enabled: false, autostopReason: null };
    const plan = await module.plan(WORK, planContext({ settings: off, transportWrites: (permission) => (asked.push(permission), permission === "withdraw") }));
    expect(asked).toEqual(["withdraw"]);
    expect(plan).toMatchObject({ kind: "request", request: { spec: "publish.post_delete", params: { postId: "970265084783775744" } } });
    // Withdrawn meanwhile (or gone unknown): the admission refuses, nothing goes.
    state.publication = { status: "withdrawn", approvedRevisionId: 33 };
    await expect(admitOnce(module, plan, 8)).rejects.toBeInstanceOf(WriteAdmissionRefusedError);
    expect(state.admitted).toBe(0);
    // A refused admission is remembered: that command is never planned again.
    expect(await module.plan(WORK, planContext({ settings: off, transportWrites: () => true }))).toMatchObject({ kind: "local" });
    // A fresh delete of a still-published post goes once.
    const again = deleting();
    const second = fanslyWriteModule(deleteStore(again));
    again.page = { enabled: false, autostopReason: null };
    await admitOnce(second, await second.plan(WORK, planContext({ settings: off, transportWrites: (permission) => permission === "withdraw" })), 8);
    expect(again.admitted).toBe(1);
    expect(again.command.request).toMatchObject({ spec: "publish.post_delete", body: "", pathAndQuery: "/api/v1/post/970265084783775744/delete?ngsw-bypass=true" });
    expect(await second.confirmWrite!(db, WORK, { attemptId: 8, writeFingerprint: again.command.requestFingerprint!, settings: off })).toBeNull();
    again.page = { enabled: false, autostopReason: "fansly_http_429" };
    expect(await second.confirmWrite!(db, WORK, { attemptId: 8, writeFingerprint: again.command.requestFingerprint!, settings: off })).toBe("page_stopped:fansly_http_429");
  });

  it("a lost answer is unknown and the delete is never planned again", async () => {
    const state = deleting();
    const module = fanslyWriteModule(deleteStore(state));
    await admitOnce(module, await module.plan(WORK, planContext()), 8);
    state.attempts.set(8, { id: 8, outcome: "timeout", applyState: "none", errorClass: "transport" } as never);
    await runLocal(module, await module.plan(WORK, planContext()));
    expect(state.command).toMatchObject({ state: "unknown", stateReason: "no_answer:timeout" });
    for (let i = 0; i < 2; i += 1) expect(await module.plan(WORK, planContext())).toMatchObject({ kind: "done" });
    expect(state.admitted).toBe(1);
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
      parsed: { postId: "p5" }, response: { postId: "p5" }, observation: { id: 778, receivedAt: NOW }, fenced: false, page: {} as SyncPageRow,
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

describe("the module: an upload's requests (wall posts PR 8, the contract §2)", () => {
  const STORAGE = "fansly-upload.s3.eu-central-1.amazonaws.com";
  const created = done("upload_create", "media:0", {
    uploadId: "u1", partSize: 1_024, partCount: 2, uploadType: 1, partUrlsSealed: "sealed",
    parts: [{ index: 0, host: STORAGE, path: "/acc/u1" }, { index: 1, host: STORAGE, path: "/acc/u1" }],
  }, { fileSha256: SHA_A }, 80);
  const rig = (step: FanslyWriteCommandRecord["step"], item: string, commands: FanslyWriteCommandRecord[]) => {
    const state = fresh({ command: command({ step, item }) });
    const store: WriteModuleStore = {
      ...fakeStore(state),
      async readDeriveContext() {
        return { ok: true, dispatch: { kind: "create", mode: "scheduled", revisionId: 33 }, form: form(), publication: { status: "submitting", platformPostRef: null }, files: new Map([[5, FILE]]), page: PAGE, commands };
      },
    };
    return { state, module: fanslyWriteModule(store) };
  };
  const partRow = (index: number, state: FanslyWriteCommandRecord["state"], id: number) =>
    command({ id, step: "upload_part", item: `media:0/part:${index}`, state, ...(state === "queued" ? {} : { attemptId: id, requestFingerprint: "f".repeat(64), admittedAt: NOW, settledAt: state === "sending" ? null : NOW }) });

  it("a part goes only after the part before it was answered, of the bytes read from disk; after a part that failed, never", async () => {
    expect(await rig("upload_part", "media:0/part:1", [created, partRow(0, "sending", 81)]).module.plan(WORK, planContext())).toMatchObject({ kind: "wait", reason: "dependency" });
    expect(await rig("upload_part", "media:0/part:1", [created, partRow(0, "unknown", 81)]).module.plan(WORK, planContext()))
      .toMatchObject({ kind: "local", detail: { action: "refuse", reason: "previous_part_not_answered" } });
    const answered = { ...partRow(0, "answered", 81), result: { eTag: '"e0"' } };
    const { state, module } = rig("upload_part", "media:0/part:1", [created, answered]);
    const plan = await module.plan(WORK, planContext());
    expect(plan).toMatchObject({ kind: "request", request: { spec: "publish.upload_part", params: { partIndex: 1, byteOffset: 1_024, byteLength: 1_024, partSha256: SHA_B } } });
    // Its fingerprint is the one its transport builds: recorded before the send.
    await admitOnce(module, plan, 9);
    expect(state.command).toMatchObject({ state: "sending", request: { method: "PUT", host: "storage", pathAndQuery: `//${STORAGE}/acc/u1`, body: "" } });
  });

  it("the create's signed part URLs are sealed on its command — never in the clear; with no box to seal them, unknown", async () => {
    const served = { id: "u1", type: 1, partSize: 1_024, status: 2, parts: [{ index: 0, uploadUrl: `https://${STORAGE}/acc/u1?partNumber=1&X-Amz-Signature=s1` }, { index: 1, uploadUrl: `https://${STORAGE}/acc/u1?partNumber=2&X-Amz-Signature=s2` }] };
    const apply = async (secrets: { seal(value: unknown): string } | null) => {
      const { state, module } = rig("upload_create", "media:0", []);
      state.command = { ...state.command, state: "sending", attemptId: 8 };
      await module.apply(db, {
        pageId: 7, now: NOW, ownRef: null, work: WORK, attempt: { id: 8, httpStatus: 200 } as SyncAttemptRow, request: { spec: "publish.upload_create" as FanslyWireId, params: {} as never },
        parsed: served, response: served, observation: { id: 900, receivedAt: NOW }, fenced: false, page: {} as SyncPageRow, secrets,
      });
      return state.command;
    };
    const sealed = await apply({ seal: (value) => `box:${Buffer.from(JSON.stringify(value)).toString("base64")}` });
    expect(sealed).toMatchObject({ state: "answered", result: { uploadId: "u1", partCount: 2, partUrlsSealed: expect.stringMatching(/^box:/) } });
    expect(JSON.stringify(sealed.result)).not.toContain("Signature");
    expect(JSON.parse(Buffer.from(String(sealed.result!.partUrlsSealed).slice(4), "base64").toString())).toEqual({ urls: [served.parts[0]!.uploadUrl, served.parts[1]!.uploadUrl] });
    expect(await apply(null)).toMatchObject({ state: "unknown", stateReason: "part_urls_not_sealed", result: null });
    // The journal keeps no signature.
    expect(JSON.stringify(fanslyWriteModule(fakeStore(fresh())).journal!(served))).not.toContain("Signature");
  });

  it("a part's answer is the storage's receipt, read from memory: answered with its ETag, else unknown", async () => {
    const receipt = async (eTag: string | null) => {
      const { state, module } = rig("upload_part", "media:0/part:0", [created]);
      state.command = { ...state.command, state: "sending", attemptId: 8 };
      await module.applyAnswer!(db, {
        pageId: 7, now: NOW, ownRef: null, work: WORK, attempt: { id: 8, httpStatus: 200 } as SyncAttemptRow, request: { spec: "publish.upload_part" as FanslyWireId, params: {} as never },
        parsed: { status: 200, eTag }, fenced: false, page: {} as SyncPageRow, generation: 1n, secrets: null,
      });
      return state.command;
    };
    expect(await receipt('"e0"')).toMatchObject({ state: "answered", result: { eTag: '"e0"' }, observationId: null });
    expect(await receipt(null)).toMatchObject({ state: "unknown", stateReason: "receipt_without_etag" });
  });

  it("the upload's status read is a GET: admitted without a write's fingerprint, its request line recorded", async () => {
    const lost = command({ id: 83, step: "upload_complete", item: "media:0", state: "unknown", attemptId: 83, requestFingerprint: "f".repeat(64), admittedAt: NOW, settledAt: NOW });
    const { state, module } = rig("upload_status", "media:0/poll:0", [created, lost]);
    const plan = await module.plan(WORK, planContext());
    if (plan.kind !== "request") throw new Error(`expected a request, got ${plan.kind}`);
    await expect(module.onAdmit!(db, WORK, plan.request, { attemptId: 9, writeFingerprint: "f".repeat(64) })).rejects.toBeInstanceOf(WriteAdmissionRefusedError);
    await module.onAdmit!(db, WORK, plan.request, { attemptId: 9, writeFingerprint: null });
    expect(state.command).toMatchObject({ state: "sending", request: { method: "GET", host: "upload", pathAndQuery: "/api/v1/media/upload/u1?ngsw-bypass=true" } });
  });
});
