// Image notes on the Fansly transcript the hub loads itself (a request without
// clientContext: the chat-extension client). Regression №2 of the 2026-10-20
// audit: only the old Fansly extension's clientContext.media numbered a
// window's media, so a hub-loaded Fansly transcript never carried a note.
//
// The items are the ones the Fansly extension lists (fansly-chat
// src/shared/transcript.ts `describableSlots`, 2.13.0), over the hub's own
// stores, with the same ids the describer keeps its rows under (the
// accountMedia id; variant by media-notes.ts):
//  - a free photo or video: `inline` on its own `[Photo]` / `[Video]` label;
//  - a free bundle: each distinct photo or video member that is not paid,
//    `appended` after the bundle's label;
//  - a paid media with a teaser: `preview` after its PPV label (the media's
//    id; only the teaser is ever described). A paid bundle lists nothing.
// Paid or not: the attachment's permission rows as the media plane recorded
// them for the message, else the media's own (creator_media); a fan cannot
// price media. A model's attachment the hub cannot tell is left out, so a PPV
// body never becomes an item. The newest AI_FEATURE_CLIENT_MEDIA_MAX_ITEMS
// are numbered in transcript order, as the extension numbers them.

import { AI_FEATURE_CLIENT_MEDIA_MAX_ITEMS } from "@agency_hub_core/contracts";
import {
  readFanslyMediaNoteFacts,
  type FanslyMediaKindRow,
  type FanslyMediaKinds,
  type FanslyMediaNoteFactsRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import type { TranscriptMessage } from "../prompts/index.ts";
import {
  fanslyMediaCategory,
  type FanslyRecordedOffer,
  type FanslyTranscriptAttachment,
} from "./fansly-media.ts";
import { fanslyPpvOffer } from "./fansly-ppv.ts";
import type { LabelledMediaNoteItem, MediaNoteKind } from "./media-notes.ts";

/** One served message's attachments, as its media labels show them. */
export interface FanslyServedMessageMedia {
  /** The index in the message's labels of its first attachment's label. */
  labelOffset: number;
  attachments: readonly FanslyTranscriptAttachment[];
  /** What the media plane recorded of a stored row's attachments, by content
   *  ref; null when it recorded none (a socket message carries no money). */
  offers: ReadonlyMap<string, FanslyRecordedOffer> | null;
}

/** The media of a hub-loaded Fansly transcript (context/index.ts). */
export interface FanslyServedMedia {
  /** Message ref → its attachments; only messages with at least one. */
  messages: Map<string, FanslyServedMessageMedia>;
  kinds: FanslyMediaKinds;
}

type Sender = LabelledMediaNoteItem["sender"];
type Slot = Omit<LabelledMediaNoteItem, "n">;

const INLINE_LABEL: Record<"photo" | "video", string> = { photo: "[Photo]", video: "[Video]" };

function noteKind(media: FanslyMediaKindRow | null | undefined): Extract<MediaNoteKind, "photo" | "video"> | null {
  if (!media) {
    return null;
  }
  const category = fanslyMediaCategory(media);
  return category === "photo" || category === "video" ? category : null;
}

/** Paid by the first source that knows; null when none does for the model. */
function paidOf(
  permissionEntries: readonly unknown[] | undefined,
  sender: Sender,
): boolean | null {
  if (permissionEntries !== undefined) {
    return fanslyPpvOffer(permissionEntries) !== null;
  }
  return sender === "fan" ? false : null;
}

/** The media refs whose creator_media facts the listing reads: every single
 *  media, and the members of every bundle. */
export function fanslyMediaNoteRefs(served: FanslyServedMedia): string[] {
  const refs = new Set<string>();
  for (const entry of served.messages.values()) {
    for (const attachment of entry.attachments) {
      if (attachment.as === "media") {
        refs.add(attachment.ref);
      } else {
        for (const member of served.kinds.bundles.get(attachment.ref) ?? []) {
          refs.add(member.ref);
        }
      }
    }
  }
  return [...refs];
}

/** The window's describable Fansly media, numbered in transcript order. Pure. */
export function listFanslyMediaNoteItems(
  messages: readonly TranscriptMessage[],
  served: FanslyServedMedia,
  facts: ReadonlyMap<string, FanslyMediaNoteFactsRow>,
): LabelledMediaNoteItem[] {
  const slots: Slot[] = [];
  for (const message of messages) {
    const entry = served.messages.get(message.id);
    if (entry === undefined) {
      continue;
    }
    const sender: Sender = message.sender === "Fan" ? "fan" : "model";
    const base = { messageId: message.id, sentAt: message.createdAtMs, sender };
    entry.attachments.forEach((attachment, index) => {
      const labelIndex = entry.labelOffset + index;
      const label = message.labels[labelIndex];
      if (label === undefined) {
        return;
      }
      const offer = entry.offers?.get(attachment.ref);
      if (attachment.as === "bundle") {
        if (paidOf(offer?.permissionEntries, sender) !== false) {
          return;
        }
        const seen = new Set<string>();
        for (const member of served.kinds.bundles.get(attachment.ref) ?? []) {
          if (seen.has(member.ref)) {
            continue;
          }
          seen.add(member.ref);
          const kind = noteKind(member.media);
          const memberFacts = facts.get(member.ref);
          if (kind !== null && paidOf(memberFacts?.permissionEntries, sender) === false) {
            slots.push({ ...base, labelIndex, placement: "appended", kind, mediaId: member.ref, paid: false });
          }
        }
        return;
      }
      const mediaFacts = facts.get(attachment.ref);
      const kind = noteKind(attachment.media ?? served.kinds.media.get(attachment.ref) ?? mediaFacts);
      const paid = paidOf(offer?.permissionEntries ?? mediaFacts?.permissionEntries, sender);
      if (kind === null || paid === null) {
        return;
      }
      if (paid) {
        if (mediaFacts?.previewRef) {
          slots.push({ ...base, labelIndex, placement: "preview", kind, mediaId: attachment.ref, paid: true });
        }
      } else if (label === INLINE_LABEL[kind]) {
        slots.push({ ...base, labelIndex, placement: "inline", kind, mediaId: attachment.ref, paid: false });
      }
    });
  }
  return slots.slice(-AI_FEATURE_CLIENT_MEDIA_MAX_ITEMS).map((slot, index) => ({ ...slot, n: index + 1 }));
}

/**
 * The items of a hub-loaded Fansly transcript: one indexed read of
 * creator_media, then the pure listing. A failed read lists nothing: the
 * transcript serves without notes, never a failed generation.
 */
export async function loadFanslyMediaNoteItems(
  app: Pick<AppContext, "db" | "logger">,
  input: { pageId: number; messages: readonly TranscriptMessage[]; served: FanslyServedMedia },
): Promise<LabelledMediaNoteItem[]> {
  let facts: Map<string, FanslyMediaNoteFactsRow>;
  try {
    facts = await readFanslyMediaNoteFacts(app.db, { pageId: input.pageId, mediaRefs: fanslyMediaNoteRefs(input.served) });
  } catch (error) {
    app.logger.warn({ pageId: input.pageId, err: error instanceof Error ? error.name : "error" }, "ai media notes: Fansly media read failed open");
    return [];
  }
  return listFanslyMediaNoteItems(input.messages, input.served, facts);
}
