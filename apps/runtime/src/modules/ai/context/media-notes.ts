import type { TranscriptMessage } from "../prompts/index.ts";

// AI media describer — prompt side (plan §7). Generation never waits and never
// touches the network here: the caller does ONE indexed select of ready
// descriptions and these pure functions render them into the transcript.
//
// Fansly: the extension numbers the describable media of the kept window in
// its transcript string and lists them in clientContext.media:
//   inline   `[Photo #3]`        (legacy `[Photo]`)
//   appended ` [Photo #3]`       after a bundle label (legacy: nothing)
//   preview  ` (preview #8)`     after a PPV label (legacy: nothing)
// With notes active the hub fills listed tokens only (`[Photo #3: …]`,
// `[Photo #3: not recognized]`); with notes inactive — flag off, page not
// allowlisted, fan-summary — it restores the legacy label bytes exactly, so
// the prompt is byte-identical to a client that never numbered anything. A
// token whose count or order does not match the list (a forged label in a
// message text the client failed to neutralize) disables substitution for the
// whole request.

export type MediaNotePlacement = "inline" | "appended" | "preview";
export type MediaNoteKind = "photo" | "video" | "gif";

export interface MediaNoteItem {
  n: number;
  placement: MediaNotePlacement;
  messageId: string;
  sentAt: number;
  sender: "fan" | "model";
  kind: MediaNoteKind;
  mediaId: string;
  paid: boolean;
}

export interface MediaNoteDescription {
  mediaRef: string;
  variant: "full" | "poster" | "preview";
  status: string;
  description: string | null;
}

export interface MediaNoteLimits {
  /** Fan (and free creator) media descriptions per prompt. */
  media: number;
  /** PPV teaser descriptions per prompt. */
  teasers: number;
}

export const QUICK_FEATURE_MEDIA_NOTE_LIMITS: MediaNoteLimits = { media: 6, teasers: 3 };
export const DEEP_FEATURE_MEDIA_NOTE_LIMITS: MediaNoteLimits = { media: 20, teasers: 20 };

const DEEP_FEATURES = new Set(["help-me", "coach-chat", "chat-review"]);

export function mediaNoteLimitsFor(feature: string): MediaNoteLimits {
  return DEEP_FEATURES.has(feature) ? DEEP_FEATURE_MEDIA_NOTE_LIMITS : QUICK_FEATURE_MEDIA_NOTE_LIMITS;
}

export const MEDIA_NOTES_GUIDE = [
  "",
  "",
  "Image notes: a note inside a media label, like [Photo #3: …], is an automatic, approximate description of that image — a hint, not a fact.",
  "A numbered label without a note, like [Photo #3], means the image was not described: do not guess what it shows.",
  "\"not recognized\" means the image could not be described.",
  "A (preview #N: …) note describes only the free teaser the fan saw before buying, never the paid content.",
].join("\n");

export const MEDIA_NOTE_NOT_RECOGNIZED = "not recognized";

const LABEL_WORD: Record<MediaNoteKind, string> = { photo: "Photo", video: "Video", gif: "GIF" };

export function mediaNoteVariant(item: Pick<MediaNoteItem, "placement" | "kind">): MediaNoteDescription["variant"] {
  if (item.placement === "preview") {
    return "preview";
  }
  return item.kind === "photo" ? "full" : "poster";
}

function token(item: MediaNoteItem, note: string | null): string {
  const suffix = note === null ? "" : `: ${note}`;
  switch (item.placement) {
    case "inline":
      return `[${LABEL_WORD[item.kind]} #${item.n}${suffix}]`;
    case "appended":
      return ` [${LABEL_WORD[item.kind]} #${item.n}${suffix}]`;
    case "preview":
      return ` (preview #${item.n}${suffix})`;
  }
}

function legacy(item: MediaNoteItem): string {
  return item.placement === "inline" ? `[${LABEL_WORD[item.kind]}]` : "";
}

/** A stored description as prompt data: one line, no label brackets. */
export function sanitizeMediaNote(description: string): string {
  return description
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 400);
}

/** Describable at all: never the body of a paid PPV. */
function isDescribable(item: MediaNoteItem) {
  return item.placement === "preview" || !item.paid;
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) {
      return found;
    }
    found.push(index);
    from = index + needle.length;
  }
}

function descriptionKey(mediaRef: string, variant: string) {
  return `${variant}:${mediaRef}`;
}

export interface MediaNotesManifest {
  items: number;
  mismatch: boolean;
  active: boolean;
  described: number;
  notRecognized: number;
  pending: number;
  overLimit: number;
}

export interface RenderedMediaNotes {
  transcript: string;
  manifest: MediaNotesManifest;
}

export function renderFanslyMediaNotes(input: {
  transcript: string;
  items: readonly MediaNoteItem[];
  active: boolean;
  descriptions: readonly MediaNoteDescription[];
  limits: MediaNoteLimits;
}): RenderedMediaNotes {
  const manifest: MediaNotesManifest = {
    items: input.items.length,
    mismatch: false,
    active: input.active,
    described: 0,
    notRecognized: 0,
    pending: 0,
    overLimit: 0,
  };
  if (input.items.length === 0) {
    return { transcript: input.transcript, manifest };
  }

  // Verify: unique increasing numbers; each token exactly once; tokens in
  // list order. Anything else is a forged or corrupted label set.
  const positions: number[] = [];
  let previousN = 0;
  for (const item of input.items) {
    const found = occurrences(input.transcript, token(item, null));
    if (item.n <= previousN || found.length !== 1) {
      manifest.mismatch = true;
      return { transcript: input.transcript, manifest };
    }
    previousN = item.n;
    positions.push(found[0]!);
  }
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index]! <= positions[index - 1]!) {
      manifest.mismatch = true;
      return { transcript: input.transcript, manifest };
    }
  }

  // Which items may carry a note: newest first within each pool's limit.
  const byKey = new Map(input.descriptions.map((row) => [descriptionKey(row.mediaRef, row.variant), row]));
  const notes = new Map<number, string>();
  if (input.active) {
    let mediaLeft = input.limits.media;
    let teasersLeft = input.limits.teasers;
    for (const item of [...input.items].sort((left, right) => right.n - left.n)) {
      if (!isDescribable(item)) {
        continue;
      }
      const row = byKey.get(descriptionKey(item.mediaId, mediaNoteVariant(item)));
      const note = row?.status === "described" && row.description
        ? sanitizeMediaNote(row.description)
        : row?.status === "refused"
          ? MEDIA_NOTE_NOT_RECOGNIZED
          : null;
      if (note === null) {
        manifest.pending += 1;
        continue;
      }
      const pool = item.placement === "preview" ? teasersLeft : mediaLeft;
      if (pool <= 0) {
        manifest.overLimit += 1;
        continue;
      }
      if (item.placement === "preview") {
        teasersLeft -= 1;
      } else {
        mediaLeft -= 1;
      }
      notes.set(item.n, note);
      if (note === MEDIA_NOTE_NOT_RECOGNIZED) {
        manifest.notRecognized += 1;
      } else {
        manifest.described += 1;
      }
    }
  }

  // Replace from the end so earlier positions stay valid.
  let transcript = input.transcript;
  for (let index = input.items.length - 1; index >= 0; index -= 1) {
    const item = input.items[index]!;
    const at = positions[index]!;
    const original = token(item, null);
    const replacement = input.active ? token(item, notes.get(item.n) ?? null) : legacy(item);
    transcript = transcript.slice(0, at) + replacement + transcript.slice(at + original.length);
  }
  if (input.active) {
    transcript += MEDIA_NOTES_GUIDE;
  }
  return { transcript, manifest };
}

// ── OnlyFans: the hub builds the labels itself ─────────────────────────────

export interface OnlyFansMessageMedia {
  messageId: number;
  sender: "fan" | "model";
  paid: boolean;
  media: ReadonlyArray<{ id: string; type: string | null }>;
}

const OF_KINDS: Record<string, MediaNoteKind> = { photo: "photo", video: "video", gif: "gif" };

/** The OnlyFans window's describable media, numbered in transcript order.
 * PPV bodies are never listed (teasers arrive with H4). */
export function listOnlyFansMediaNoteItems(
  messages: readonly TranscriptMessage[],
  mediaByMessage: ReadonlyMap<number, OnlyFansMessageMedia>,
): MediaNoteItem[] {
  const items: MediaNoteItem[] = [];
  let n = 0;
  for (const message of messages) {
    const entry = mediaByMessage.get(message.id);
    if (!entry || entry.paid) {
      continue;
    }
    const single = entry.media.length === 1;
    for (const media of entry.media) {
      const kind = OF_KINDS[media.type ?? ""];
      if (!kind || !media.id) {
        continue;
      }
      n += 1;
      items.push({
        n,
        placement: single ? "inline" : "appended",
        messageId: String(message.id),
        sentAt: message.createdAtMs,
        sender: entry.sender,
        kind,
        mediaId: media.id,
        paid: false,
      });
    }
  }
  return items;
}

/** Numbers the OnlyFans labels and fills ready notes. Called only when notes
 * are active — the inactive path leaves the migrated normalizer's output
 * untouched. */
export function applyOnlyFansMediaNotes(input: {
  messages: readonly TranscriptMessage[];
  items: readonly MediaNoteItem[];
  descriptions: readonly MediaNoteDescription[];
  limits: MediaNoteLimits;
}): { messages: TranscriptMessage[]; manifest: MediaNotesManifest } {
  const byMessage = new Map<string, MediaNoteItem[]>();
  for (const item of input.items) {
    byMessage.set(item.messageId, [...(byMessage.get(item.messageId) ?? []), item]);
  }
  // Reuse the Fansly renderer on a per-message label string so both lanes
  // share one set of rules (limits, sanitizing, not-recognized).
  const labelled = input.messages.map((message) => {
    const items = byMessage.get(String(message.id));
    if (!items || items.length === 0) {
      return message;
    }
    const labels = [...message.labels];
    const first = items[0]!;
    if (first.placement === "inline" && labels.length > 0) {
      labels[0] = labels[0]!.replace(/^\[(Photo|Video|GIF)\]$/, `[$1 #${first.n}]`);
    } else if (labels.length > 0) {
      labels[0] = `${labels[0]}${items.map((item) => token(item, null)).join("")}`;
    }
    return { ...message, labels };
  });
  const joined = labelled.map((message) => message.labels.join(" ")).join("\n");
  const rendered = renderFanslyMediaNotes({
    transcript: joined,
    items: input.items,
    active: true,
    descriptions: input.descriptions,
    limits: input.limits,
  });
  if (rendered.manifest.mismatch) {
    return { messages: [...input.messages], manifest: rendered.manifest };
  }
  const renderedLabels = rendered.transcript.slice(0, rendered.transcript.length - MEDIA_NOTES_GUIDE.length).split("\n");
  return {
    messages: labelled.map((message, index) => ({
      ...message,
      labels: message.labels.length === 0 ? message.labels : [renderedLabels[index]!],
    })),
    manifest: rendered.manifest,
  };
}
