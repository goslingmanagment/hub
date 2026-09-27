import {
  listAiMediaDescriptionsByRefs,
  listPageDmConversationsByPlatformConversationIds,
  upsertAiMediaDescriptionCandidate,
  type AiMediaPlatform,
} from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import {
  aiMediaNotesPolicyForPage,
  isAfterAiMediaDescribeBoundary,
  isAiMediaDescribeWindowOpen,
  type AiMediaDescribePagePolicy,
} from "../../../services/ai-media-describe/policy.ts";
import { loadEffectiveConfig } from "../../../services/effective-config.ts";
import {
  mediaNoteVariant,
  type MediaNoteDescription,
  type MediaNoteItem,
} from "./media-notes.ts";

// Generation-path glue for image notes. The synchronous part is ONE config
// read and ONE indexed select, no network and no writes. Asking for missing
// descriptions happens after, in the background, and never delays or fails a
// generation.

type NotesApp = Pick<AppContext, "db" | "config" | "logger">;

/** At most this many missing files are asked for per generation. */
const MAX_REQUESTS_PER_GENERATION = 30;

export interface MediaNotesGate {
  active: boolean;
  policy: AiMediaDescribePagePolicy | null;
}

export async function resolveMediaNotesGate(
  app: NotesApp,
  input: { pageLabel: string; usesImageNotes: boolean },
): Promise<MediaNotesGate> {
  if (!input.usesImageNotes) {
    return { active: false, policy: null };
  }
  try {
    const effective = await loadEffectiveConfig(app.db, app.config);
    const policy = aiMediaNotesPolicyForPage(effective, input.pageLabel);
    return { active: policy !== null, policy };
  } catch {
    // Fail to the legacy prompt, never to a failed generation.
    return { active: false, policy: null };
  }
}

export async function loadMediaNoteDescriptions(
  app: NotesApp,
  input: { pageId: number; platform: AiMediaPlatform; items: readonly MediaNoteItem[] },
): Promise<MediaNoteDescription[]> {
  if (input.items.length === 0) {
    return [];
  }
  try {
    return await listAiMediaDescriptionsByRefs(app.db, {
      pageId: input.pageId,
      platform: input.platform,
      mediaRefs: input.items.map((item) => item.mediaId),
    });
  } catch (error) {
    app.logger.warn({ pageId: input.pageId, err: error instanceof Error ? error.name : "error" }, "ai media notes lookup failed open");
    return [];
  }
}

/**
 * Fire-and-forget: files the window shows that have no description yet
 * become due (a new candidate, or a dormant one promoted). Only messages
 * strictly after the page's enable boundary, only while the describe window
 * is open, never a PPV body. The Fansly groupRef is checked against the hub's
 * capture before any link is written.
 */
export function requestMediaDescriptionsInBackground(
  app: NotesApp,
  input: {
    pageId: number;
    platform: AiMediaPlatform;
    policy: AiMediaDescribePagePolicy;
    conversationRef: string;
    fanRef: string | null;
    /** Fansly: the client-sent groupRef is checked against the captured thread. */
    verifyThread: boolean;
    items: readonly MediaNoteItem[];
    descriptions: readonly MediaNoteDescription[];
    now: Date;
  },
): void {
  if (!isAiMediaDescribeWindowOpen(input.policy, input.now)) {
    return;
  }
  // A dormant row (known, waiting for a generation) is exactly what this
  // generation must make due; every other known row is left alone.
  const known = new Set(input.descriptions
    .filter((row) => row.status !== "dormant")
    .map((row) => `${row.variant}:${row.mediaRef}`));
  const wanted = input.items
    .filter((item) => item.placement === "preview" || !item.paid)
    .filter((item) => isAfterAiMediaDescribeBoundary(input.policy, new Date(item.sentAt)))
    .filter((item) => !known.has(`${mediaNoteVariant(item)}:${item.mediaId}`))
    .slice(-MAX_REQUESTS_PER_GENERATION);
  if (wanted.length === 0) {
    return;
  }
  void (async () => {
    if (input.verifyThread) {
      const [thread] = await listPageDmConversationsByPlatformConversationIds(app.db, {
        platformAccountId: input.pageId,
        platformConversationIds: [input.conversationRef],
      });
      // A captured thread must belong to this fan; an uncaptured one (capture
      // lag) is accepted — the projector writes the canonical link later.
      if (thread && input.fanRef && thread.partnerPlatformUserId && thread.partnerPlatformUserId !== input.fanRef) {
        app.logger.warn({ pageId: input.pageId }, "ai media notes: groupRef does not match the fan; nothing requested");
        return;
      }
    }
    for (const item of wanted) {
      await upsertAiMediaDescriptionCandidate(app.db, {
        pageId: input.pageId,
        platform: input.platform,
        mediaRef: item.mediaId,
        variant: mediaNoteVariant(item),
        mediaKind: item.kind,
        senderRole: item.sender,
        fanPlatformUserId: item.sender === "fan" ? input.fanRef : null,
        // 'pending': a dormant row is promoted; a new row without a source is
        // resolved by the platform source adapter (or waits for capture).
        status: "pending",
        sourceObservationId: null,
        link: {
          messageRef: item.messageId,
          conversationRef: input.conversationRef,
          fanPlatformUserId: input.fanRef,
          senderRole: item.sender,
          messageAt: new Date(item.sentAt),
        },
        observedAt: input.now,
        now: input.now,
      });
    }
  })().catch((error: unknown) => {
    app.logger.warn({ pageId: input.pageId, err: error instanceof Error ? error.name : "error" }, "ai media notes: background request failed");
  });
}
