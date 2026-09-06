import { ofapiPublishingActionSchema, type OfapiPublishingAction } from "../../../../packages/contracts/src/ofapi-actions-publishing.ts";
import { millsFromCents, millsToDollarsNumber } from "@agency_hub_core/shared";
import { ofapiWireId } from "./ofapi-command-composer.ts";
import type { OfapiActionRequest } from "./ofapi-actions-types.ts";

const usd = (cents: number) => millsToDollarsNumber(millsFromCents(cents));
const defined = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));

/** Account identity comes from the engine's page binding, never the submitted command. */
export function ofapiPublishingRequest(command: OfapiPublishingAction, accountId: string): OfapiActionRequest {
  const c = ofapiPublishingActionSchema.parse(command);
  const root = `/${encodeURIComponent(accountId)}`;
  const request = (method: OfapiActionRequest["method"], path: string, resultKind: OfapiActionRequest["resultKind"], body?: unknown): OfapiActionRequest => ({ method, path: `${root}${path}`, estimatedCredits: 1, resultKind, ...(body === undefined ? {} : { body }) });
  const resource = (value: string) => encodeURIComponent(value);
  const contentBody = (value: Record<string, unknown>) => {
    const { action: _action, pageId: _pageId, reuseProviderOperation: _reuse, priceCents, fundRaisingTargetCents, fundRaisingTipsPresetCents, ...body } = value;
    for (const field of ["mediaFiles", "previews", "labelIds", "rfTag", "rfPartner", "rfGuest", "userIds", "userLists", "excludedLists"]) {
      if (Array.isArray(body[field])) body[field] = (body[field] as string[]).map(ofapiWireId);
    }
    return defined({ ...body,
      ...(priceCents === undefined ? {} : { price: usd(priceCents as number) }),
      ...(fundRaisingTargetCents === undefined ? {} : { fundRaisingTargetAmount: usd(fundRaisingTargetCents as number) }),
      ...(fundRaisingTipsPresetCents === undefined ? {} : { fundRaisingTipsPresets: (fundRaisingTipsPresetCents as number[]).map(usd) }),
    });
  };
  switch (c.action) {
    case "post_create": return request("POST", "/posts", c.scheduledDate || c.saveForLater ? "queue" : "resource", contentBody(c));
    case "post_update": {
      const { postId, ...content } = c;
      return request("PUT", `/posts/${resource(postId)}`, "ack", contentBody(content));
    }
    case "post_delete": return request("DELETE", `/posts/${resource(c.postId)}`, "ack");
    case "post_archive": return request("POST", `/posts/${resource(c.postId)}/archive`, "ack");
    case "post_unarchive": return request("POST", `/posts/${resource(c.postId)}/unarchive`, "ack");
    // Provider exposes a toggle; neither the name nor result pretends to set a desired boolean.
    case "post_toggle_pin": return request("POST", `/posts/${resource(c.postId)}/pin`, "ack");
    case "post_label_create": return request("POST", "/posts/labels", "resource", { name: c.name });
    case "post_comment_create": return {
      ...request("POST", `/posts/${resource(c.postId)}/comments`, "resource"),
      query: { text: c.text, ...(c.answerTo ? { answerTo: c.answerTo } : {}), ...(c.giphyId ? { giphyId: c.giphyId } : {}) },
    };
    case "post_comment_delete": return request("DELETE", `/posts/${resource(c.postId)}/comments/${resource(c.commentId)}`, "ack");
    case "post_comment_pin": return request("POST", `/posts/${resource(c.postId)}/comments/${resource(c.commentId)}/pin`, "ack");
    case "post_comment_unpin": return request("DELETE", `/posts/${resource(c.postId)}/comments/${resource(c.commentId)}/pin`, "ack");
    case "post_comment_like": return request("POST", `/posts/${resource(c.postId)}/comments/${resource(c.commentId)}/like`, "ack");
    case "post_comment_unlike": return request("DELETE", `/posts/${resource(c.postId)}/comments/${resource(c.commentId)}/like`, "ack");
    case "story_create": return request("POST", "/stories", "resource", defined({
      mediaFiles: c.mediaFiles.map(ofapiWireId), texts: c.texts, canvasWidth: c.canvasWidth, canvasHeight: c.canvasHeight,
      question: c.questionText ? defined({ text: c.questionText, color: c.questionColor, left: c.questionLeft, top: c.questionTop, width: c.questionWidth, height: c.questionHeight }) : undefined,
    }));
    case "story_delete": return request("DELETE", `/stories/${resource(c.storyId)}`, "ack");
    case "story_mark_watched": return request("POST", `/stories/${resource(c.storyId)}/mark-as-watched`, "ack");
    case "highlight_create": return request("POST", "/stories/highlights", "resource", { title: c.title, coverStoryId: ofapiWireId(c.coverStoryId), storyIds: c.storyIds.map(ofapiWireId) });
    case "highlight_update": return request("PUT", `/stories/highlights/${resource(c.highlightId)}`, "resource", { title: c.title, coverStoryId: ofapiWireId(c.coverStoryId), storyIds: c.storyIds.map(ofapiWireId) });
    case "highlight_delete": return request("DELETE", `/stories/highlights/${resource(c.highlightId)}`, "ack");
    case "highlight_add_story": return request("PATCH", `/stories/highlights/${resource(c.highlightId)}/${resource(c.storyId)}`, "ack", { story_id: ofapiWireId(c.storyId) });
    case "highlight_remove_story": return request("DELETE", `/stories/highlights/${resource(c.highlightId)}/${resource(c.storyId)}`, "ack");
    case "campaign_create": return request("POST", "/mass-messaging", "queue", contentBody(c));
    case "campaign_update": {
      const { campaignId, ...content } = c;
      return request("PUT", `/mass-messaging/${resource(campaignId)}`, "queue", contentBody(content));
    }
    case "campaign_cancel": return request("DELETE", `/mass-messaging/${resource(c.campaignId)}`, "ack");
    case "queue_list": return {
      ...request("GET", "/queue", "read"),
      query: { publishDateStart: c.publishDateStart, publishDateEnd: c.publishDateEnd, timezone: c.timezone, ...(c.limit === undefined ? {} : { limit: String(c.limit) }), ...Object.fromEntries((c.types ?? []).map((type, i) => [`type[${i}]`, type])) },
    };
    case "queue_counts": return { ...request("GET", "/queue/counts", "read"), query: { publishDateStart: c.publishDateStart, publishDateEnd: c.publishDateEnd, timezone: c.timezone } };
    case "queue_publish": return request("PUT", `/queue/${resource(c.queueId)}/publish`, "queue");
  }
}

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const responseId = (value: unknown): string | null => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) ? value : null;
};
const count = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const errorEvidence = (value: Record<string, unknown> | null) => !value || value.success === false || value.hasError === true || (value.error !== undefined && value.error !== null && value.error !== false) || (value.errors !== undefined && value.errors !== null && (!Array.isArray(value.errors) || value.errors.length > 0));

/**
 * Confirms the documented receipt shape, not asynchronous delivery/readiness.
 * An unexpected successful HTTP response is indeterminate and must not be retried.
 */
export function ofapiPublishingResultConfirmed(command: OfapiPublishingAction, status: number, body: unknown): boolean {
  if (command.action === "post_update") return status === 200 && body === "";
  if (status !== (command.action === "post_comment_create" ? 201 : 200)) return false;
  const envelope = object(body), data = object(envelope?.data);
  if (errorEvidence(envelope) || errorEvidence(data)) return false;
  const result = data!;
  const id = responseId(result.id);
  switch (command.action) {
    case "post_create": return id !== null && result.responseType === "post";
    case "post_comment_create": return id !== null && typeof result.text === "string";
    case "post_label_create": return id !== null && result.name === command.name;
    case "story_create": return id !== null && typeof result.isReady === "boolean" && Array.isArray(result.media);
    case "highlight_create":
    case "highlight_update": return id !== null && (command.action !== "highlight_update" || id === command.highlightId) && result.title === command.title && responseId(result.coverStoryId) === command.coverStoryId && result.storiesCount === command.storyIds.length;
    case "campaign_create":
    case "campaign_update": return id !== null && (command.action !== "campaign_update" || id === command.campaignId) && typeof result.isDone === "boolean" && typeof result.isReady === "boolean" && result.hasError === false && result.isCanceled === false;
    case "campaign_cancel": {
      const queue = object(result.queue);
      return result.success === true && !errorEvidence(queue) && responseId(queue?.id) === command.campaignId && queue?.isCanceled === true;
    }
    case "post_archive":
    case "post_unarchive": {
      const counters = object(result.counters);
      return Array.isArray(result.labelStates) && result.labelStates.some(value => object(value)?.id === "archived") && count(counters?.postsCount) && count(counters?.archivedPostsCount);
    }
    case "post_comment_like": return result.success === true && result.isLiked === true && count(result.likesCount);
    case "post_comment_unlike": return result.success === true && result.isLiked === false && count(result.likesCount);
    case "queue_list": return typeof result.syncInProcess === "boolean" && Array.isArray(result.list) && result.list.every(value => {
      const item = object(value);
      return item !== null && responseId(item.id) !== null && (item.type === "chat" || item.type === "post");
    });
    case "queue_counts": {
      const days = object(result.list);
      return typeof result.syncInProcess === "boolean" && days !== null && Object.entries(days).every(([date, value]) => {
        const counters = object(value);
        return /^\d{4}-\d{2}-\d{2}$/.test(date) && counters !== null && Object.entries(counters).every(([type, value]) => (type === "chat" || type === "post") && count(value));
      });
    }
    case "post_delete":
    case "post_toggle_pin":
    case "post_comment_delete":
    case "post_comment_pin":
    case "post_comment_unpin":
    case "story_delete":
    case "story_mark_watched":
    case "highlight_delete":
    case "highlight_add_story":
    case "highlight_remove_story":
    case "queue_publish": return result.success === true;
  }
}
