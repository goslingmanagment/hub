import { describe, expect, it } from "vitest";
import { ofapiPublishingActionOptions, ofapiPublishingActionSchema, ofapiPublishingAdmissionIssue } from "../packages/contracts/src/ofapi-actions-publishing.ts";
import { ofapiPublishingRequest, ofapiPublishingResultConfirmed } from "../apps/runtime/src/services/ofapi-actions-publishing.ts";

const parse = (value: Record<string, unknown>) => ofapiPublishingActionSchema.parse({ pageId: 3, ...value });
const valid = (value: Record<string, unknown>) => ofapiPublishingActionSchema.safeParse({ pageId: 3, ...value }).success;
const request = (value: Record<string, unknown>, account = "acct_model") => ofapiPublishingRequest(parse(value), account);
const content = { text: "Today's publication", mediaFiles: ["123"] };
const campaign = { ...content, userIds: ["456"] };

describe("governed OFAPI publishing definitions", () => {
  it("keeps all 27 supported operations reachable through closed contracts", () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ action: "post_create", ...content }, "POST", "/posts"],
      [{ action: "post_update", postId: "7", ...content }, "PUT", "/posts/7"],
      [{ action: "post_delete", postId: "7" }, "DELETE", "/posts/7"],
      [{ action: "post_archive", postId: "7" }, "POST", "/posts/7/archive"],
      [{ action: "post_unarchive", postId: "7" }, "POST", "/posts/7/unarchive"],
      [{ action: "post_toggle_pin", postId: "7" }, "POST", "/posts/7/pin"],
      [{ action: "post_label_create", name: "Editorial" }, "POST", "/posts/labels"],
      [{ action: "post_comment_create", postId: "7", text: "Reply" }, "POST", "/posts/7/comments"],
      [{ action: "post_comment_delete", postId: "7", commentId: "8" }, "DELETE", "/posts/7/comments/8"],
      [{ action: "post_comment_pin", postId: "7", commentId: "8" }, "POST", "/posts/7/comments/8/pin"],
      [{ action: "post_comment_unpin", postId: "7", commentId: "8" }, "DELETE", "/posts/7/comments/8/pin"],
      [{ action: "post_comment_like", postId: "7", commentId: "8" }, "POST", "/posts/7/comments/8/like"],
      [{ action: "post_comment_unlike", postId: "7", commentId: "8" }, "DELETE", "/posts/7/comments/8/like"],
      [{ action: "story_create", mediaFiles: ["123"] }, "POST", "/stories"],
      [{ action: "story_delete", storyId: "7" }, "DELETE", "/stories/7"],
      [{ action: "story_mark_watched", storyId: "7" }, "POST", "/stories/7/mark-as-watched"],
      [{ action: "highlight_create", title: "Summer", coverStoryId: "7", storyIds: ["7", "8"] }, "POST", "/stories/highlights"],
      [{ action: "highlight_update", highlightId: "9", title: "Summer", coverStoryId: "7", storyIds: ["7", "8"] }, "PUT", "/stories/highlights/9"],
      [{ action: "highlight_delete", highlightId: "9" }, "DELETE", "/stories/highlights/9"],
      [{ action: "highlight_add_story", highlightId: "9", storyId: "7" }, "PATCH", "/stories/highlights/9/7"],
      [{ action: "highlight_remove_story", highlightId: "9", storyId: "7" }, "DELETE", "/stories/highlights/9/7"],
      [{ action: "campaign_create", ...campaign }, "POST", "/mass-messaging"],
      [{ action: "campaign_update", campaignId: "7", ...campaign }, "PUT", "/mass-messaging/7"],
      [{ action: "campaign_cancel", campaignId: "7" }, "DELETE", "/mass-messaging/7"],
      [{ action: "queue_list", publishDateStart: "2026-09-06", publishDateEnd: "2026-09-07", timezone: "UTC" }, "GET", "/queue"],
      [{ action: "queue_counts", publishDateStart: "2026-09-06", publishDateEnd: "2026-09-07", timezone: "UTC" }, "GET", "/queue/counts"],
      [{ action: "queue_publish", queueId: "7" }, "PUT", "/queue/7/publish"],
    ];
    expect(cases).toHaveLength(ofapiPublishingActionOptions.length);
    expect(new Set(cases.map(([c]) => c.action)).size).toBe(27);
    for (const [command, method, path] of cases) expect(request(command)).toMatchObject({ method, path: `/acct_model${path}`, estimatedCredits: 1 });
  });

  it("refuses arbitrary methods, resource path traversal and account overrides", () => {
    for (const postId of ["../users/3/subscribe", "7?force=true", "%2e%2e", "0", "-1", "1/2", "1.2", "01"])
      expect(valid({ action: "post_delete", postId })).toBe(false);
    expect(valid({ action: "post_delete", postId: "7", accountId: "acct_other" })).toBe(false);
    expect(valid({ action: "post_delete", postId: "7", method: "POST", body: {} })).toBe(false);
    expect(valid({ action: "users_subscribe", userId: "7" })).toBe(false);
    expect(valid({ action: "post_create", ...content, reuseProviderOperation: true })).toBe(false);
    expect(request({ action: "post_delete", postId: "7" }, "acct/a?b").path).toBe("/acct%2Fa%3Fb/posts/7");
  });

  it("keeps large vendor identifiers lossless and never sends kernel controls", () => {
    const huge = "9007199254740993";
    const result = request({ action: "campaign_update", campaignId: huge, ...campaign, userIds: [huge], mediaFiles: [huge, "ofapi_media_owned"], previews: [huge], reuseProviderOperation: false, priceCents: 697 });
    expect(result.path).toBe(`/acct_model/mass-messaging/${huge}`);
    expect(result.body).toEqual({ text: content.text, userIds: [huge], mediaFiles: [huge, "ofapi_media_owned"], previews: [huge], price: 6.97 });
    expect(request({ action: "post_update", postId: "7", text: "New caption" }).body).toEqual({ text: "New caption" });
  });

  it("does not pretend an accepted campaign or queued publish has finished delivering", () => {
    expect(request({ action: "campaign_create", ...campaign }).resultKind).toBe("queue");
    expect(request({ action: "campaign_update", campaignId: "7", ...campaign }).resultKind).toBe("queue");
    expect(request({ action: "queue_publish", queueId: "7" }).resultKind).toBe("queue");
    expect(request({ action: "post_create", ...content, scheduledDate: "2026-12-01T18:00:00Z" }).resultKind).toBe("queue");
    expect(request({ action: "post_update", postId: "7", ...content }).resultKind).toBe("ack");
  });

  it("requires explicit campaign targeting and bounded, noncontradictory selectors", () => {
    expect(valid({ action: "campaign_create", ...content })).toBe(false);
    expect(valid({ action: "campaign_create", ...content, userIds: [] })).toBe(false);
    expect(valid({ action: "campaign_create", ...content, subscribedWithinLastDays: 7 })).toBe(true);
    for (const extra of [{ subscribedWithinLastDays: 0 }, { subscribedWithinLastDays: 31 }, { userIds: ["456", "456"] }, { userLists: ["fans"], excludedLists: ["fans"] }, { userIds: Array.from({ length: 1001 }, (_, i) => String(i + 1)) }])
      expect(valid({ action: "campaign_create", ...campaign, ...extra })).toBe(false);
    for (const extra of [{ scheduledDate: "2026-12-01T18:00:00Z" }, { saveForLater: true }])
      expect(valid({ action: "campaign_create", ...campaign, subscribedWithinLastDays: 7, ...extra })).toBe(false);
    for (const extra of [{ excludedLists: ["fans"] }, { saveForLater: true }, { subscribedWithinLastDays: 7 }, { rfTag: ["12"] }])
      expect(valid({ action: "campaign_update", campaignId: "7", ...campaign, ...extra })).toBe(false);
  });

  it("validates PPV and previews before any paid request", () => {
    for (const priceCents of [1, 299, 20001, 6.97]) expect(valid({ action: "campaign_create", ...campaign, priceCents })).toBe(false);
    expect(valid({ action: "campaign_create", ...campaign, priceCents: 300, mediaFiles: [] })).toBe(false);
    expect(valid({ action: "campaign_create", ...campaign, previews: ["999"] })).toBe(false);
    expect(valid({ action: "campaign_create", ...campaign, mediaFiles: ["123", "123"] })).toBe(false);
    expect(valid({ action: "campaign_create", ...campaign, mediaFiles: ["https://untrusted.example/file.jpg"] })).toBe(false);
    expect(valid({ action: "campaign_create", ...campaign, mediaFiles: Array.from({ length: 51 }, (_, i) => String(i + 1)) })).toBe(false);
    expect(valid({ action: "post_update", ...content, postId: "7", priceCents: 350 })).toBe(false); // Vendor post update documents whole USD, unlike campaigns.
    expect(request({ action: "post_update", ...content, postId: "7", priceCents: 300 }).body).toMatchObject({ price: 3 });
    expect(valid({ action: "post_create", ...content, priceCents: 300 })).toBe(false); // No documented create price field.
  });

  it("preserves query-only comment fields rather than sending an ignored JSON body", () => {
    const result = request({ action: "post_comment_create", postId: "7", text: "A & B? #fun", answerTo: "9007199254740993", giphyId: "gif_123" });
    expect(result.query).toEqual({ text: "A & B? #fun", answerTo: "9007199254740993", giphyId: "gif_123" });
    expect(result.body).toBeUndefined();
    expect(request({ action: "highlight_add_story", highlightId: "7", storyId: "8" }).body).toEqual({ story_id: 8 });
  });

  it("checks dependent fundraising and quiz fields and encodes money through the shared codec", () => {
    const quiz = { action: "post_create", ...content, votingType: "quiz", votingOptions: ["Red", "Blue"], votingCorrectIndex: 0, fundRaisingTargetCents: 3000, fundRaisingTipsPresetCents: [500, 1000] };
    expect(request(quiz).body).toMatchObject({ votingCorrectIndex: 0, fundRaisingTargetAmount: 30, fundRaisingTipsPresets: [5, 10] });
    for (const extra of [{ votingCorrectIndex: 2 }, { votingType: "poll" }, { votingOptions: ["Red"] }, { votingOptions: ["Red", "Red"] }, { fundRaisingTargetCents: 1000, fundRaisingTipsPresetCents: [2000] }, { fundRaisingTipsPresetCents: undefined }])
      expect(valid({ ...quiz, ...extra })).toBe(false);
    expect(valid({ action: "post_create", ...content, votingDue: 3 })).toBe(false);
  });

  it("supports verified story overlay fields while rejecting unsupported editing and scheduling", () => {
    const overlay = { text: "New drop", fontFamily: "ShantellSans", fontWeight: 400, fontSize: 24, left: 25, top: 60, color: "#FFFFFF" };
    const result = request({ action: "story_create", mediaFiles: ["123"], texts: [overlay, { text: "@creator", type: "mention" }], questionText: "Ask me", questionLeft: 0, canvasWidth: 1080, canvasHeight: 1920 });
    expect(result.body).toEqual({ mediaFiles: [123], texts: [overlay, { text: "@creator", type: "mention" }], question: { text: "Ask me", left: 0 }, canvasWidth: 1080, canvasHeight: 1920 });
    expect(valid({ action: "story_update", storyId: "7", mediaFiles: ["123"] })).toBe(false);
    expect(valid({ action: "story_create", mediaFiles: ["123"], scheduledDate: "2026-12-01T18:00:00Z" })).toBe(false);
    expect(valid({ action: "story_create", mediaFiles: [] })).toBe(false);
    expect(valid({ action: "story_create", mediaFiles: ["123"], questionLeft: 0 })).toBe(false);
    for (const extra of [{ left: -1 }, { top: 101 }, { fontWeight: 700 }, { fontSize: 101 }, { color: "red" }, { type: "mention", text: "hello @creator" }, { providerField: "unknown" }])
      expect(valid({ action: "story_create", mediaFiles: ["123"], texts: [{ ...overlay, ...extra }] })).toBe(false);
  });

  it("keeps structural UTC/timezone validation separate from new-admission clock checks", () => {
    const past = parse({ action: "post_create", ...content, scheduledDate: "2026-09-05T12:00:00Z" });
    expect(ofapiPublishingAdmissionIssue(past, new Date("2026-09-06T12:00:00Z"))).toContain("future");
    expect(valid({ action: "post_create", ...content, scheduledDate: "2026-12-01T18:00:00" })).toBe(false);
    expect(valid({ action: "post_create", ...content, scheduledDate: "2026-12-01T18:00:00Z", saveForLater: true })).toBe(false);
    const queue = { action: "queue_list", publishDateStart: "2026-09-06", publishDateEnd: "2026-09-07", timezone: "Pacific/Auckland", types: ["chat", "post"], limit: 100 };
    expect(request(queue).query).toMatchObject({ "type[0]": "chat", "type[1]": "post", limit: "100" });
    expect(ofapiPublishingAdmissionIssue(parse(queue), new Date("2026-09-06T23:00:00Z"))).toContain("today");
    expect(ofapiPublishingAdmissionIssue(parse({ ...queue, timezone: "America/Los_Angeles" }), new Date("2026-09-06T23:00:00Z"))).toBeNull();
    for (const extra of [{ publishDateEnd: "2026-09-05" }, { publishDateEnd: "2028-09-06" }, { timezone: "../invalid" }, { limit: 101 }, { types: ["story"] }]) expect(valid({ ...queue, ...extra })).toBe(false);
  });

  it("requires operation-specific result evidence instead of accepting arbitrary successful HTTP bodies", () => {
    const confirmed = (command: Record<string, unknown>, status: number, body: unknown) => ofapiPublishingResultConfirmed(parse(command), status, body);
    const ack = { action: "post_delete", postId: "7" };
    expect(confirmed(ack, 200, { data: { success: true } })).toBe(true);
    for (const body of [null, undefined, "", [], {}, { data: {} }, { data: { success: "true" } }, { data: { success: false } }, { data: { success: true }, error: "Rejected" }, { data: { success: true, hasError: true } }]) expect(confirmed(ack, 200, body)).toBe(false);
    expect(confirmed(ack, 202, { data: { success: true } })).toBe(false);
    expect(confirmed({ action: "post_update", postId: "7", ...content }, 200, "")).toBe(true);
    for (const body of [null, undefined, {}, { data: { success: true } }, "unexpected"]) expect(confirmed({ action: "post_update", postId: "7", ...content }, 200, body)).toBe(false);
    expect(confirmed({ action: "post_update", postId: "7", ...content }, 204, "")).toBe(false);
    expect(confirmed({ action: "post_comment_create", postId: "7", text: "Reply" }, 201, { data: { id: 8, text: "Reply" } })).toBe(true);
    expect(confirmed({ action: "post_comment_create", postId: "7", text: "Reply" }, 200, { data: { id: 8, text: "Reply" } })).toBe(false);
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "../8", null]) expect(confirmed({ action: "post_create", ...content }, 200, { data: { id, responseType: "post" } })).toBe(false);
    expect(confirmed({ action: "post_create", ...content }, 200, { data: { id: "9007199254740993", responseType: "post" } })).toBe(true);
    expect(confirmed({ action: "post_label_create", name: "Chosen" }, 200, { data: { id: 9, name: "Other" } })).toBe(false);
  });

  it("checks campaign and highlight target identity while preserving asynchronous receipt semantics", () => {
    const update = parse({ action: "campaign_update", campaignId: "7", ...campaign });
    const receipt = { id: 7, isDone: false, isReady: true, hasError: false, isCanceled: false };
    expect(ofapiPublishingResultConfirmed(update, 200, { data: receipt })).toBe(true);
    for (const extra of [{ id: 8 }, { hasError: true }, { isCanceled: true }, { isDone: "false" }, { isReady: undefined }]) expect(ofapiPublishingResultConfirmed(update, 200, { data: { ...receipt, ...extra } })).toBe(false);
    const cancel = parse({ action: "campaign_cancel", campaignId: "7" });
    expect(ofapiPublishingResultConfirmed(cancel, 200, { data: { success: true, queue: { id: 7, isCanceled: true, hasError: false } } })).toBe(true);
    expect(ofapiPublishingResultConfirmed(cancel, 200, { data: { success: true, queue: { id: 8, isCanceled: true } } })).toBe(false);
    expect(ofapiPublishingResultConfirmed(cancel, 200, { data: { success: true } })).toBe(false);
    const publish = parse({ action: "queue_publish", queueId: "7" });
    expect(ofapiPublishingResultConfirmed(publish, 200, { data: { success: true } })).toBe(true); // Its documented receipt contains no resource ID.
    expect(ofapiPublishingResultConfirmed(publish, 200, { data: { id: 7 } })).toBe(false);
    const highlight = parse({ action: "highlight_update", highlightId: "7", title: "Summer", coverStoryId: "8", storyIds: ["8", "9"] });
    const resource = { id: 7, title: "Summer", coverStoryId: 8, storiesCount: 2 };
    expect(ofapiPublishingResultConfirmed(highlight, 200, { data: resource })).toBe(true);
    for (const extra of [{ id: 8 }, { title: "Old title" }, { coverStoryId: 9 }, { storiesCount: 1 }]) expect(ofapiPublishingResultConfirmed(highlight, 200, { data: { ...resource, ...extra } })).toBe(false);
    expect(ofapiPublishingResultConfirmed(parse({ action: "story_create", mediaFiles: ["123"] }), 200, { data: { id: 7, isReady: false, media: [] } })).toBe(true);
  });

  it("recognizes archive counters, comment state and queue reads without inventing a universal ACK", () => {
    const archive = parse({ action: "post_archive", postId: "7" });
    expect(ofapiPublishingResultConfirmed(archive, 200, { data: { labelStates: [{ id: "archived" }], counters: { postsCount: 1, archivedPostsCount: 1 } } })).toBe(true);
    expect(ofapiPublishingResultConfirmed(archive, 200, { data: { success: true } })).toBe(false);
    const like = parse({ action: "post_comment_like", postId: "7", commentId: "8" });
    expect(ofapiPublishingResultConfirmed(like, 200, { data: { success: true, isLiked: true, likesCount: 1 } })).toBe(true);
    expect(ofapiPublishingResultConfirmed(like, 200, { data: { success: true, isLiked: false, likesCount: 1 } })).toBe(false);
    const window = { publishDateStart: "2026-09-06", publishDateEnd: "2026-09-07", timezone: "UTC" };
    const list = parse({ action: "queue_list", ...window });
    expect(ofapiPublishingResultConfirmed(list, 200, { data: { syncInProcess: false, list: [] } })).toBe(true);
    expect(ofapiPublishingResultConfirmed(list, 200, { data: { syncInProcess: false, list: [{ id: 7, type: "story" }] } })).toBe(false);
    const counts = parse({ action: "queue_counts", ...window });
    expect(ofapiPublishingResultConfirmed(counts, 200, { data: { syncInProcess: false, list: { "2026-09-06": { post: 2, chat: 0 } } } })).toBe(true);
    expect(ofapiPublishingResultConfirmed(counts, 200, { data: { syncInProcess: false, list: { "2026-09-06": { post: -1 } } } })).toBe(false);
  });
});
