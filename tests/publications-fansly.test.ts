import { describe, expect, it } from "vitest";

import type { FanslyWriteCommandRecord, FanslyWriteState, FanslyWriteStep } from "@agency_hub_core/db";

import {
  FANSLY_STEP_MAX_REFUSALS,
  FANSLY_UPLOAD_STATUS_FAST_READS,
  FANSLY_UPLOAD_STATUS_MAX_READS,
  fanslyCommandWindow,
  fanslyCreateChain,
  fanslyCreateNext,
  fanslyDispatchPlan,
  fanslyFollowUntil,
  fanslyUploadItems,
  fanslyParked,
  fanslyRetryNotBefore,
  fanslyUploadStatusGapMs,
  fanslyUploadWindow,
} from "../apps/runtime/src/services/publications-fansly.ts";
import type { ApprovedFormMedia } from "../apps/runtime/src/sync/fansly/publish/derive.ts";

// Wall posts on Fansly (plan PR 9): which requests a publication's create is,
// when it goes, and what its commands make of the publication — the post sent
// once, a lost answer of the post itself "unknown", anything before it that
// did not go "missed", Fansly's refusal "rejected".

const MIN = 60_000;
const NOW = new Date("2026-10-24T12:00:00Z");

const vault = (role: "media" | "preview", position: number): ApprovedFormMedia => ({
  role, position, source: "vault", mediaRef: `m${position}`, fileId: null, fileSha256: null, attachment: 0,
});

/** A chain of steps on the post's own attachment (item ''). */
const own = (steps: FanslyWriteStep[]) => steps.map((step) => ({ step, item: "" }));
const chainOf = (form: Parameters<typeof fanslyCreateChain>[0]) => fanslyCreateChain(form)?.map((link) => (link.item === "" ? link.step : `${link.step}@${link.item}`)) ?? null;

let nextId = 1;
function command(step: FanslyWriteStep, state: FanslyWriteState, extra: Partial<FanslyWriteCommandRecord> = {}): FanslyWriteCommandRecord {
  return {
    id: nextId++, pageId: 1, dispatchId: 1, publicationId: 1, step, item: "", priority: "background",
    notBefore: NOW, notAfter: null, state, stateReason: null, workId: null, attemptId: null, notSentCount: 0,
    request: null, requestFingerprint: null, result: null, httpStatus: null, observationId: null,
    createdAt: NOW, admittedAt: null, settledAt: null, ...extra,
  };
}

const next = (chain: FanslyWriteStep[], commands: FanslyWriteCommandRecord[], notAfter = new Date(NOW.getTime() + 60 * MIN)) =>
  fanslyCreateNext({ chain: own(chain), commands, now: NOW, notAfter });

describe("the chain of a Fansly create (spec §5)", () => {
  it("one vault file becomes account media (with its preview), several one bundle (the contract §3), then the post or the story", () => {
    expect(chainOf({ kind: "fyp_post", media: [], extraAttachments: [] })).toEqual(["post"]);
    expect(chainOf({ kind: "subscriber_post", media: [vault("media", 0), vault("media", 1)], extraAttachments: [] })).toEqual(["account_media_bundle", "post"]);
    expect(chainOf({ kind: "paid_post", media: [vault("media", 0)], extraAttachments: [] })).toEqual(["account_media", "post"]);
    expect(chainOf({ kind: "paid_post", media: [vault("media", 0), vault("media", 1)], extraAttachments: [] })).toEqual(["account_media_bundle", "post"]);
    expect(chainOf({ kind: "paid_post", media: [vault("media", 0), vault("preview", 0)], extraAttachments: [] })).toEqual(["account_media", "post"]);
    expect(chainOf({ kind: "story", media: [vault("media", 0)], extraAttachments: [] })).toEqual(["account_media", "story"]);
  });

  it("each attachment with files is its own account media or bundle, in order, then the post (the contract §12.2)", () => {
    const at = (attachment: number, position: number): ApprovedFormMedia => ({ ...vault("media", position), attachment });
    const extras = [
      { attachment: 1, access: "paid" as const, tierRefs: [], priceMills: 9_000, subscribersOnly: false },
      { attachment: 2, access: "everyone" as const, tierRefs: [], priceMills: null, subscribersOnly: false },
    ];
    expect(chainOf({ kind: "fyp_post", media: [at(0, 0), at(1, 1), at(1, 2), at(2, 3)], extraAttachments: extras }))
      .toEqual(["account_media", "account_media_bundle@attachment:1", "account_media@attachment:2", "post"]);
    // A text post with one paid attachment: that attachment, then the post.
    expect(chainOf({ kind: "subscriber_post", media: [at(1, 0)], extraAttachments: extras.slice(0, 1) })).toEqual(["account_media@attachment:1", "post"]);
  });

  it("a new file goes up first, then the chain as for vault media (plan PR 8); a medium the form does not name whole has none", () => {
    const file: ApprovedFormMedia = { role: "media", position: 0, source: "file", mediaRef: null, fileId: 3, fileSha256: "a".repeat(64), attachment: 0 };
    const preview: ApprovedFormMedia = { ...file, role: "preview", fileId: 4 };
    expect(chainOf({ kind: "fyp_post", media: [file], extraAttachments: [] })).toEqual(["account_media", "post"]);
    expect(fanslyUploadItems({ media: [vault("media", 1), file, preview] })).toEqual(["media:0", "preview:0"]);
    expect(fanslyUploadItems({ media: [vault("media", 0)] })).toEqual([]);
    expect(fanslyUploadItems({ media: [{ ...file, fileSha256: null }] })).toBeNull();
    // Bytes the page's account already has go up no more — unless this dispatch began their upload.
    expect(fanslyUploadItems({ media: [file, preview] }, new Set(["a".repeat(64)]))).toEqual([]);
    expect(fanslyUploadItems({ media: [file, { ...preview, fileSha256: "b".repeat(64) }] }, new Set(["a".repeat(64)]))).toEqual(["preview:0"]);
    expect(fanslyUploadItems({ media: [file] }, new Set(["a".repeat(64)]), new Set(["media:0"]))).toEqual(["media:0"]);
    expect(fanslyCreateChain({ kind: "fyp_post", media: [{ ...file, fileId: null }], extraAttachments: [] })).toBeNull();
  });
});

describe("a vault album (0323, the contract §13)", () => {
  it("is its album made when the approval names none, then every file added in one request; at its time, within half a day", () => {
    expect(chainOf({ kind: "vault_album", media: [vault("media", 0), vault("media", 1)], extraAttachments: [], albumRef: null })).toEqual(["album_create", "album_media"]);
    expect(chainOf({ kind: "vault_album", media: [vault("media", 0)], extraAttachments: [], albumRef: "al9" })).toEqual(["album_media"]);
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);
    expect(fanslyDispatchPlan({ kind: "vault_album", publishAt: at(10), now: NOW })).toEqual({ action: "wait" });
    expect(fanslyDispatchPlan({ kind: "vault_album", publishAt: at(-3 * 60), now: NOW })).toEqual({ action: "send", mode: "vault" });
    expect(fanslyDispatchPlan({ kind: "vault_album", publishAt: at(-13 * 60), now: NOW })).toEqual({ action: "missed", reason: "window_passed" });
    expect(fanslyCommandWindow("vault", NOW)).toEqual({ notAfter: at(12 * 60), priority: "background" });
  });

  it("its media answered is the album as approved: published, with the album", () => {
    const created = command("album_create", "answered", { result: { albumId: "al1" } });
    expect(next(["album_create", "album_media"], [created, command("album_media", "answered", { result: { albumId: "al1", added: 3 } })]))
      .toEqual({ kind: "settle", to: "published", reason: null, platformPostRef: null, vaultAlbumRef: "al1" });
    // Its answer lost: a person decides.
    expect(next(["album_create", "album_media"], [created, command("album_media", "unknown", { stateReason: "no_answer:timeout" })]))
      .toMatchObject({ kind: "settle", to: "unknown" });
    // The album's create lost: its media never went.
    expect(next(["album_create", "album_media"], [command("album_create", "unknown", { stateReason: "no_answer:timeout" })]))
      .toMatchObject({ kind: "settle", to: "missed" });
  });
});

describe("when a Fansly publication goes (spec §3.4–3.5)", () => {
  it("a post enters Fansly's schedule within 7 days; one sent now is not captured — a post closer than the lead is missed; a story at its time; late is missed", () => {
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(8 * 24 * 60), now: NOW })).toEqual({ action: "wait" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(3 * 24 * 60), now: NOW })).toEqual({ action: "send", mode: "scheduled" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(6), now: NOW })).toEqual({ action: "send", mode: "scheduled" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(5), now: NOW })).toEqual({ action: "missed", reason: "too_close_to_schedule" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(1), now: NOW })).toEqual({ action: "missed", reason: "too_close_to_schedule" });
    // Once a post sent now is verified: now when minutes away.
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(1), now: NOW, immediatePost: true })).toEqual({ action: "send", mode: "now" });
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(5), now: NOW })).toEqual({ action: "wait" });
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(-29), now: NOW })).toEqual({ action: "send", mode: "story" });
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(-31), now: NOW })).toEqual({ action: "missed", reason: "window_passed" });
    expect(fanslyDispatchPlan({ kind: "fyp_post", publishAt: at(-31), now: NOW })).toEqual({ action: "missed", reason: "window_passed" });
  });

  it("a scheduled post's requests end the schedule's lead (5 minutes) before its time; a story's are urgent until 30 minutes after", () => {
    const publishAt = new Date(NOW.getTime() + 60 * MIN);
    expect(fanslyCommandWindow("scheduled", publishAt)).toEqual({ notAfter: new Date(publishAt.getTime() - 5 * MIN), priority: "background" });
    expect(fanslyCommandWindow("now", publishAt)).toEqual({ notAfter: new Date(publishAt.getTime() + 30 * MIN), priority: "background" });
    expect(fanslyCommandWindow("story", publishAt)).toEqual({ notAfter: new Date(publishAt.getTime() + 30 * MIN), priority: "urgent" });
  });
});

describe("a create follows its commands (spec §4, §8.2)", () => {
  const chain: FanslyWriteStep[] = ["account_media", "post"];

  it("queues the first step, waits while one is in flight, then queues the next", () => {
    expect(next(chain, [])).toEqual({ kind: "enqueue", step: "account_media", item: "" });
    expect(next(chain, [command("account_media", "queued")])).toEqual({ kind: "in_flight" });
    expect(next(chain, [command("account_media", "sending")])).toEqual({ kind: "in_flight" });
    expect(next(chain, [command("account_media", "answered", { result: { accountMediaIds: ["a1"] } })])).toEqual({ kind: "enqueue", step: "post", item: "" });
  });

  it("the post answered with its id is scheduled; without one, unknown", () => {
    const media = command("account_media", "answered");
    expect(next(chain, [media, command("post", "answered", { result: { postId: "p9" } })]))
      .toEqual({ kind: "settle", to: "scheduled", reason: null, platformPostRef: "p9" });
    expect(next(chain, [media, command("post", "answered", { result: {} })]))
      .toMatchObject({ kind: "settle", to: "unknown", platformPostRef: null });
    expect(next(["account_media", "story"], [media, command("story", "answered", { result: { storyId: "s1" } })]))
      .toEqual({ kind: "settle", to: "scheduled", reason: null, platformPostRef: "s1" });
  });

  it("a lost answer of the post itself is unknown; of a step before it, the post never went: missed", () => {
    const media = command("account_media", "answered");
    expect(next(chain, [media, command("post", "unknown", { stateReason: "no_answer:timeout" })]))
      .toEqual({ kind: "settle", to: "unknown", reason: "post:no_answer:timeout", platformPostRef: null });
    expect(next(chain, [command("account_media", "unknown", { stateReason: "no_answer:timeout" })]))
      .toEqual({ kind: "settle", to: "missed", reason: "not_sent:account_media_unknown:no_answer:timeout", platformPostRef: null });
  });

  it("Fansly's refusal of any step is rejected, with the step and the status", () => {
    expect(next(chain, [command("account_media", "rejected", { stateReason: "fansly_http_400" })]))
      .toEqual({ kind: "settle", to: "rejected", reason: "account_media:fansly_http_400", platformPostRef: null });
    expect(next(chain, [command("account_media", "answered"), command("post", "rejected", { stateReason: "fansly_http_400" })]))
      .toEqual({ kind: "settle", to: "rejected", reason: "post:fansly_http_400", platformPostRef: null });
  });

  it("a step a switch held back is queued again inside its window; its window passed, missed", () => {
    const held = [command("account_media", "refused", { stateReason: "page_publishing_off" })];
    for (let index = 0; index < 5; index += 1) held.push(command("account_media", "refused", { stateReason: "publishing_off" }));
    // …a minute after its last refusal, not at the follow loop's next second.
    expect(next(chain, held)).toEqual({ kind: "enqueue", step: "account_media", item: "", notBefore: new Date(NOW.getTime() + MIN) });
    expect(next(chain, held, new Date(NOW.getTime() - 1))).toEqual({ kind: "settle", to: "missed", reason: "window_passed", platformPostRef: null });
    expect(next(chain, [command("account_media", "refused", { stateReason: "window_passed" })]))
      .toEqual({ kind: "settle", to: "missed", reason: "window_passed", platformPostRef: null });
  });

  it("a step refused for itself is given up after a few tries: never sent, missed", () => {
    const refused = Array.from({ length: FANSLY_STEP_MAX_REFUSALS - 1 }, () => command("post", "refused", { stateReason: "not_sent:not_sent:write_refused" }));
    const media = command("account_media", "answered");
    expect(next(chain, [media, ...refused])).toEqual({ kind: "enqueue", step: "post", item: "", notBefore: new Date(NOW.getTime() + MIN) });
    const more = [...refused, command("post", "refused", { stateReason: "audience_not_approved" })];
    expect(next(chain, [media, ...more])).toEqual({ kind: "settle", to: "missed", reason: "not_sent:post:audience_not_approved", platformPostRef: null });
  });
});

describe("a create only waiting for its time holds no page", () => {
  it("is parked while every live request is queued for later, never while one is due or on the wire", () => {
    const later = new Date(NOW.getTime() + 30 * MIN);
    expect(fanslyParked([command("account_media", "queued", { notBefore: later })], NOW)).toBe(true);
    expect(fanslyParked([command("upload_status", "answered"), command("account_media", "queued", { notBefore: later })], NOW)).toBe(true);
    expect(fanslyParked([command("account_media", "queued", { notBefore: NOW })], NOW)).toBe(false);
    expect(fanslyParked([command("account_media", "sending", { notBefore: later })], NOW)).toBe(false);
    expect(fanslyParked([command("account_media", "answered")], NOW)).toBe(false);
  });

  it("one waiting seconds for its next read or a retry still holds its page; only one waiting for its own time lets it go", () => {
    const read = [command("upload_status", "queued", { item: "media:0/poll:1", notBefore: new Date(NOW.getTime() + 5_000) })];
    const storyAt = new Date(NOW.getTime() + 30 * MIN);
    expect(fanslyParked(read, NOW, storyAt)).toBe(false);
    expect(fanslyParked([command("account_media", "queued", { notBefore: storyAt })], NOW, storyAt)).toBe(true);
    // A vault album or a post whose time came: it is never waiting for it.
    expect(fanslyParked(read, NOW, new Date(NOW.getTime() - MIN))).toBe(false);
  });
});

describe("the minute's job follows its creates each second (a step goes as soon as the one before answered)", () => {
  it("its loop ends just before the next minute, when the next job begins", () => {
    expect(fanslyFollowUntil(new Date("2026-10-31T19:54:03.200Z"))).toEqual(new Date("2026-10-31T19:54:55Z"));
    expect(fanslyFollowUntil(new Date("2026-10-31T19:54:00Z"))).toEqual(new Date("2026-10-31T19:54:55Z"));
  });

  it("a refused step goes again a minute after its refusal, as when the job ran once a minute — its few tries take minutes, not seconds", () => {
    const refusedAt = new Date(NOW.getTime() - 10_000);
    const refused = command("post", "refused", { stateReason: "not_sent:not_sent:write_refused", settledAt: refusedAt });
    expect(fanslyRetryNotBefore([refused], NOW)).toEqual(new Date(refusedAt.getTime() + MIN));
    expect(next(["post"], [refused])).toEqual({ kind: "enqueue", step: "post", item: "", notBefore: new Date(refusedAt.getTime() + MIN) });
    // That minute over: at once.
    expect(fanslyRetryNotBefore([refused], new Date(refusedAt.getTime() + MIN))).toBeNull();
    expect(fanslyRetryNotBefore([command("post", "answered")], NOW)).toBeNull();
  });

  it("an upload is read at the site's pace first, then once a minute: a long video still has about half an hour", () => {
    expect(fanslyUploadStatusGapMs(0)).toBe(5_000);
    expect(fanslyUploadStatusGapMs(FANSLY_UPLOAD_STATUS_FAST_READS - 1)).toBe(5_000);
    expect(fanslyUploadStatusGapMs(FANSLY_UPLOAD_STATUS_FAST_READS)).toBe(MIN);
    let total = 0;
    for (let index = 0; index < FANSLY_UPLOAD_STATUS_MAX_READS; index += 1) total += fanslyUploadStatusGapMs(index);
    expect(total).toBeGreaterThanOrEqual(30 * MIN);
  });
});

describe("a new file's upload comes first (plan PR 8, the contract §2)", () => {
  const chain = own(["account_media", "post"]);
  const at = (step: FanslyWriteStep, item: string, state: FanslyWriteState, extra: Partial<FanslyWriteCommandRecord> = {}) => command(step, state, { item, ...extra });
  const created = (item = "media:0", parts = 2) => at("upload_create", item, "answered", { result: { uploadId: "u1", partSize: 20_971_520, partCount: parts } });
  const upload = (commands: FanslyWriteCommandRecord[], uploads = ["media:0"]) =>
    fanslyCreateNext({ chain, commands, now: NOW, notAfter: new Date(NOW.getTime() + 60 * MIN), uploads, uploadNotAfter: new Date(NOW.getTime() + 60 * MIN) });
  const steps = (next: ReturnType<typeof upload>) => (next.kind === "enqueue_uploads" ? next.items.map((item) => `${item.step}:${item.item}`) : next);

  it("its create, every part at once (each goes after the one before), its completion, then reads until done; then the chain", () => {
    expect(steps(upload([]))).toEqual(["upload_create:media:0"]);
    expect(upload([at("upload_create", "media:0", "sending")])).toEqual({ kind: "in_flight" });
    expect(steps(upload([created()]))).toEqual(["upload_part:media:0/part:0", "upload_part:media:0/part:1"]);
    const parts = [created(), at("upload_part", "media:0/part:0", "answered"), at("upload_part", "media:0/part:1", "queued")];
    expect(upload(parts)).toEqual({ kind: "in_flight" });
    parts[2] = at("upload_part", "media:0/part:1", "answered");
    expect(steps(upload(parts))).toEqual(["upload_complete:media:0"]);
    const completed = [...parts, at("upload_complete", "media:0", "answered", { settledAt: NOW })];
    const first = upload(completed);
    expect(steps(first)).toEqual(["upload_status:media:0/poll:0"]);
    // No faster than the site's own reads.
    expect(first.kind === "enqueue_uploads" && first.items[0]!.notBefore!.getTime()).toBe(NOW.getTime() + 5_000);
    expect(steps(upload([...completed, at("upload_status", "media:0/poll:0", "answered", { result: { status: 5, done: false }, settledAt: NOW })]))).toEqual(["upload_status:media:0/poll:1"]);
    const done = [...completed, at("upload_status", "media:0/poll:0", "answered", { result: { status: 6, mediaId: "m1", done: true } })];
    expect(upload(done)).toEqual({ kind: "enqueue", step: "account_media", item: "" });
  });

  it("a lost completion is read by its upload's id, never sent again; a lost read is read again, up to a limit", () => {
    const lost = [created("media:0", 1), at("upload_part", "media:0/part:0", "answered"), at("upload_complete", "media:0", "unknown", { stateReason: "no_answer:timeout" })];
    expect(steps(upload(lost))).toEqual(["upload_status:media:0/poll:0"]);
    const reads = Array.from({ length: FANSLY_UPLOAD_STATUS_MAX_READS }, (_, index) => at("upload_status", `media:0/poll:${index}`, index % 2 === 0 ? "unknown" : "answered", { result: { status: 4, done: false } }));
    expect(upload([...lost, ...reads])).toEqual({ kind: "settle", to: "missed", reason: "not_sent:upload_complete_unknown:no_answer:timeout", platformPostRef: null });
    const answered = [created("media:0", 1), at("upload_part", "media:0/part:0", "answered"), at("upload_complete", "media:0", "answered")];
    expect(upload([...answered, ...reads])).toEqual({ kind: "settle", to: "missed", reason: "not_sent:upload_processing_not_done", platformPostRef: null });
  });

  it("a completion Fansly answered 500 — bytes the account already has (the contract §12.7) — ends at the first read that is not done", () => {
    const refused = [created("media:0", 1), at("upload_part", "media:0/part:0", "answered"), at("upload_complete", "media:0", "unknown", { stateReason: "answer_server_error:500", httpStatus: 500 })];
    expect(steps(upload(refused))).toEqual(["upload_status:media:0/poll:0"]);
    // A lost read says nothing: read again.
    expect(steps(upload([...refused, at("upload_status", "media:0/poll:0", "unknown", { stateReason: "no_answer:timeout" })]))).toEqual(["upload_status:media:0/poll:1"]);
    expect(upload([...refused, at("upload_status", "media:0/poll:0", "answered", { result: { status: 3, done: false } })]))
      .toEqual({ kind: "settle", to: "missed", reason: "not_sent:upload_complete_500", platformPostRef: null });
    // Done after all: the media it is.
    expect(upload([...refused, at("upload_status", "media:0/poll:0", "answered", { result: { status: 6, mediaId: "m1", done: true } })]))
      .toEqual({ kind: "enqueue", step: "account_media", item: "" });
  });

  it("a file still processing after the fast reads is read once a minute; a refused read goes again a minute later", () => {
    const completed = [created("media:0", 1), at("upload_part", "media:0/part:0", "answered"), at("upload_complete", "media:0", "answered", { settledAt: NOW })];
    const reads = Array.from({ length: FANSLY_UPLOAD_STATUS_FAST_READS }, (_, index) => at("upload_status", `media:0/poll:${index}`, "answered", { result: { status: 5, done: false }, settledAt: NOW }));
    const slow = upload([...completed, ...reads]);
    expect(steps(slow)).toEqual([`upload_status:media:0/poll:${FANSLY_UPLOAD_STATUS_FAST_READS}`]);
    expect(slow.kind === "enqueue_uploads" && slow.items[0]!.notBefore!.getTime()).toBe(NOW.getTime() + MIN);
    const refused = upload([...completed, at("upload_status", "media:0/poll:0", "refused", { stateReason: "not_sent:not_sent:write_refused", settledAt: NOW })]);
    expect(refused.kind === "enqueue_uploads" && refused.items[0]!.notBefore!.getTime()).toBe(NOW.getTime() + MIN);
  });

  it("a part sent once: one lost or refused by the storage is the upload that failed — the post never left", () => {
    expect(upload([created(), at("upload_part", "media:0/part:0", "unknown", { stateReason: "no_answer:timeout" })]))
      .toEqual({ kind: "settle", to: "missed", reason: "not_sent:upload_part_unknown:no_answer:timeout", platformPostRef: null });
    expect(upload([created(), at("upload_part", "media:0/part:0", "rejected", { stateReason: "fansly_http_403" })]))
      .toEqual({ kind: "settle", to: "rejected", reason: "upload_part:fansly_http_403", platformPostRef: null });
    // No upload id to read it by: a lost create never went on.
    expect(upload([at("upload_create", "media:0", "unknown", { stateReason: "no_answer:timeout" })]))
      .toEqual({ kind: "settle", to: "missed", reason: "not_sent:upload_create_unknown:no_answer:timeout", platformPostRef: null });
  });

  it("files go up one after another; the next one's create once the one before completed, while it is processed", () => {
    const two = ["media:0", "preview:0"];
    expect(steps(upload([created()], two))).toEqual(["upload_part:media:0/part:0", "upload_part:media:0/part:1"]);
    const completed = [created("media:0", 1), at("upload_part", "media:0/part:0", "answered"), at("upload_complete", "media:0", "answered", { settledAt: NOW })];
    expect(steps(upload(completed, two))).toEqual(["upload_status:media:0/poll:0", "upload_create:preview:0"]);
  });

  it("a story's files go up before its time, never in its window: its dispatch begins two hours ahead; its upload's requests end at its time", () => {
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(150), now: NOW, uploads: true })).toEqual({ action: "wait" });
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(110), now: NOW, uploads: true })).toEqual({ action: "send", mode: "story" });
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(-1), now: NOW, uploads: true })).toEqual({ action: "missed", reason: "window_passed" });
    expect(fanslyDispatchPlan({ kind: "story", publishAt: at(110), now: NOW })).toEqual({ action: "wait" });
    const publishAt = at(60);
    expect(fanslyUploadWindow("story", publishAt)).toEqual({ notAfter: publishAt, priority: "background" });
    expect(fanslyUploadWindow("scheduled", publishAt)).toEqual({ notAfter: new Date(publishAt.getTime() - 5 * MIN), priority: "background" });
  });
});
