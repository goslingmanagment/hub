import {
  findPageById,
  hasRecentAiGenerationInConversation,
  upsertAiMediaDescriptionCandidate,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import {
  aiMediaNotesPolicyForPage,
  isAfterAiMediaDescribeBoundary,
  isAiMediaDescribeWindowOpen,
} from "./policy.ts";

// OnlyFans candidates for the AI media describer (plan §5). The webhook
// handler only writes candidate rows; the describe loop (within a second) or
// the minutely sweep does the work. Runs right after the webhook's media
// locators are recorded (free Expires URLs, ~23 h):
//   - messages.received: the fan's photos / video posters — due now in a chat
//     with an AI generation in 7 days, dormant otherwise;
//   - messages.sent: the PPV teasers (`previews[]`) — due now, because the
//     free link expires before ~40% of teasers reach a generation.
// Never a PPV body. Only pages with a describer policy, only messages after
// its `since`. Fail-open: never affects the webhook settle.

const LIVE_CHAT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function idText(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[0-9]{1,30}$/.test(value) ? value : null;
}

function kindOf(type: unknown): "photo" | "video" | "gif" | null {
  return type === "photo" || type === "video" || type === "gif" ? type : null;
}

export async function recordOnlyFansMediaCandidates(
  app: AppContext,
  input: { envelope: { event: string; payload: unknown }; pageId: number; observedAt: Date; eventId: number },
): Promise<number> {
  const event = input.envelope.event;
  if (event !== "messages.received" && event !== "messages.sent") return 0;
  try {
    const effective = await loadEffectiveConfig(app.db, app.config);
    const page = await findPageById(app.db, input.pageId);
    const policy = page ? aiMediaNotesPolicyForPage(effective, page.page.label) : null;
    if (!policy || !isAiMediaDescribeWindowOpen(policy, input.observedAt)) return 0;
    const payload = asRecord(input.envelope.payload);
    const messageId = idText(payload?.id);
    const createdAt = typeof payload?.createdAt === "string" ? new Date(payload.createdAt) : null;
    const messageAt = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : input.observedAt;
    if (!payload || !messageId || !isAfterAiMediaDescribeBoundary(policy, messageAt)) return 0;
    const media = (Array.isArray(payload.media) ? payload.media : []).map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== null);
    let written = 0;

    if (event === "messages.received") {
      const fanId = idText(asRecord(payload.fromUser)?.id);
      if (!fanId) return 0;
      const live = effective.aiMediaDescribeLiveChatOnly === false || await hasRecentAiGenerationInConversation(app.db, {
        pageId: input.pageId, conversationRefs: [fanId], since: new Date(Date.now() - LIVE_CHAT_WINDOW_MS),
      });
      for (const item of media) {
        const mediaId = idText(item.id);
        const kind = kindOf(item.type);
        if (!mediaId || !kind) continue;
        const result = await upsertAiMediaDescriptionCandidate(app.db, {
          pageId: input.pageId, platform: "onlyfans", mediaRef: mediaId,
          variant: kind === "photo" ? "full" : "poster", mediaKind: kind, senderRole: "fan",
          fanPlatformUserId: fanId, status: live ? "pending" : "dormant", sourceObservationId: input.eventId,
          link: { messageRef: messageId, conversationRef: fanId, fanPlatformUserId: fanId, senderRole: "fan", messageAt },
          observedAt: input.observedAt,
        });
        if (result.status === "applied") written += 1;
      }
      return written;
    }

    // messages.sent: only the free teasers of a PPV, never its body.
    const fanId = idText(asRecord(payload.toUser)?.id);
    const previews = new Set((Array.isArray(payload.previews) ? payload.previews : [])
      .map((entry) => idText(entry) ?? idText(asRecord(entry)?.id))
      .filter((id): id is string => id !== null));
    if (!fanId || previews.size === 0) return 0;
    for (const item of media) {
      const mediaId = idText(item.id);
      const kind = kindOf(item.type);
      if (!mediaId || !kind || !previews.has(mediaId)) continue;
      const result = await upsertAiMediaDescriptionCandidate(app.db, {
        pageId: input.pageId, platform: "onlyfans", mediaRef: mediaId, variant: "preview", mediaKind: kind,
        senderRole: "model", fanPlatformUserId: null, status: "pending", sourceObservationId: input.eventId,
        link: { messageRef: messageId, conversationRef: fanId, fanPlatformUserId: fanId, senderRole: "model", messageAt },
        observedAt: input.observedAt,
      });
      if (result.status === "applied") written += 1;
    }
    return written;
  } catch (error) {
    app.logger.warn({ eventId: input.eventId, err: error instanceof Error ? error.name : "error" },
      "AI media describer OnlyFans candidate write failed; continuing");
    return 0;
  }
}
