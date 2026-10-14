// How the released Fansly extension (fansly-chat 2.10.1, commit ff30d00)
// tells the model's welcome and mass messages from personal ones, restated
// from its source for the hub's reference tests (chat-extension R20 HF-7д),
// and one conversation with what that extension sends for it.
//
// Sources, by file of fansly-chat at ff30d00:
//  - src/shared/followers.ts: `normalizeWelcome`, `automationReason`,
//    `welcomeTexts` (the `/message/automated` definitions' texts);
//  - src/shared/greeting-context.ts: `AUTOMATED_MESSAGE_LABEL`,
//    `isAutomatedGreetingMessage` (only the model's message can be automatic),
//    `countPersonalMessages`;
//  - src/background/operations.ts (:2421-2484): Hi labels the automatic
//    messages of its transcript, the label first;
//  - src/shared/transcript.ts: `normalizeTranscript`, `formatTranscriptForKernel`,
//    `analyzePingSegment`, `fanSilenceDaysFromAnalysis`.

/** A message as Fansly's DM page serves it; a key may be missing. */
export interface ReleasedFanslyMessage {
  id: string;
  senderId: string;
  content?: string | null;
  type?: number;
  correlationId?: string | null;
  inReplyTo?: string | null;
}

/** `normalizeWelcome`. */
export function releasedNormalizeWelcome(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** `automationReason`, verbatim. */
export function releasedAutomationReason(
  message: ReleasedFanslyMessage,
  welcome: ReadonlySet<string>,
): "type-2" | "non-reply-correlation" | "welcome-text-match" | null {
  if (message.type === 2) return "type-2";
  if (message.correlationId && message.correlationId !== "0" && (!message.inReplyTo || message.inReplyTo === "0")) {
    return "non-reply-correlation";
  }
  const normalized = releasedNormalizeWelcome(message.content ?? "");
  return normalized && welcome.has(normalized) ? "welcome-text-match" : null;
}

/** `isAutomatedGreetingMessage`: the model's message only. */
export function releasedIsAutomated(
  message: ReleasedFanslyMessage,
  creatorId: string,
  welcome: ReadonlySet<string>,
): boolean {
  return message.senderId === creatorId && releasedAutomationReason(message, welcome) !== null;
}

/** `welcomeTexts` over a `/message/automated` response, then `normalizeWelcome`. */
export function releasedWelcomeSet(rows: ReadonlyArray<{ messageTemplate: { content: string | null } }>): Set<string> {
  return new Set(rows.flatMap((row) => {
    const content = row.messageTemplate.content;
    return content !== null && content.trim() ? [releasedNormalizeWelcome(content)] : [];
  }));
}

// ── One conversation, and what 2.10.1 sends for it ───────────────────────────

export const AUTOMATION_PAGE_REF = "700000000000000009";
export const AUTOMATION_FAN = "700000000000000001";
export const AUTOMATION_GROUP = "650000000000000001";
/** The clock of every reference below. */
export const AUTOMATION_NOW = "2026-10-13T12:00:00.000Z";
const NOW_MS = Date.parse(AUTOMATION_NOW);

/** Message `n` of the conversation: an 18-digit Fansly id, ordered by `n`. */
export const automationMessageId = (n: number) => String(800_000_000_000_000_000n + BigInt(n));

/** Fansly's `createdAt` (epoch seconds) of `days` before AUTOMATION_NOW at `hh:mm` UTC. */
export function automationAt(days: number, hh: number, mm: number): number {
  const date = new Date(NOW_MS - days * 86_400_000);
  date.setUTCHours(hh, mm, 0, 0);
  return date.getTime() / 1000;
}

/** A message with every key Fansly's DM page serves. */
function rest(n: number, createdAt: number, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: automationMessageId(n), groupId: AUTOMATION_GROUP, senderId: AUTOMATION_PAGE_REF, content: "", createdAt,
    attachments: [], inReplyTo: null, inReplyToRoot: null, type: 1, correlationId: "0", totalTipAmount: 0,
    ...fields,
  };
}

/** The page's `/message/automated` response (a bare array): two welcome texts
 *  and an automation with media only. */
export const AUTOMATION_DEFINITIONS = [
  {
    id: "660000000000000001", accountId: AUTOMATION_PAGE_REF, triggerType: 3, triggerMetadata: "", delay: 0, cooldown: 0,
    messageTemplate: {
      type: 1, content: "hey babe, welcome to my page 💕\nso glad you're here", attachments: [], senderId: AUTOMATION_PAGE_REF,
    },
  },
  {
    id: "660000000000000002", accountId: AUTOMATION_PAGE_REF, triggerType: 15,
    triggerMetadata: "{\"subscriptionTierId\":\"670000000000000001\"}", delay: 0, cooldown: 0,
    messageTemplate: { type: 1, content: "thanks for subscribing", attachments: [], senderId: AUTOMATION_PAGE_REF },
  },
  {
    id: "660000000000000003", accountId: AUTOMATION_PAGE_REF, triggerType: 3, triggerMetadata: "", delay: 0, cooldown: 0,
    messageTemplate: {
      type: 1, content: null, attachments: [{ contentType: 1, contentId: "680000000000000001" }],
      senderId: AUTOMATION_PAGE_REF,
    },
  },
];

/**
 * A DM page of ten messages, oldest first: a welcome sent by an automation
 * (a correlation, answering nothing), a `type` 2 mass send, a welcome text
 * sent without a correlation, a mass send after the fan went quiet, a fan's
 * message carrying a correlation, and personal replies with and without one.
 */
export const AUTOMATION_REST_MESSAGES = [
  rest(1, automationAt(20, 10, 0), {
    content: "hey babe, welcome to my page 💕\nso glad you're here", correlationId: "500000000000000001",
  }),
  rest(2, automationAt(19, 9, 0), { senderId: AUTOMATION_FAN, content: "hi! thanks 😊" }),
  rest(3, automationAt(19, 9, 5), { content: "of course! what brought you here?", inReplyTo: automationMessageId(2) }),
  rest(4, automationAt(18, 20, 0), {
    content: "🔥 new set just dropped, check my wall", type: 2, correlationId: "500000000000000002",
  }),
  rest(5, automationAt(15, 21, 0), { senderId: AUTOMATION_FAN, content: "you're so hot" }),
  rest(6, automationAt(15, 21, 2), {
    content: "aww thank you babe", correlationId: "500000000000000003", inReplyTo: automationMessageId(5),
  }),
  rest(7, automationAt(12, 18, 0), {
    senderId: AUTOMATION_FAN, content: "what are you up to this weekend?", correlationId: "500000000000000004",
  }),
  rest(8, automationAt(11, 10, 0), { content: "thanks  for subscribing " }),
  rest(9, automationAt(3, 15, 0), { content: "missing you 💋 come say hi", correlationId: "500000000000000005" }),
  rest(10, automationAt(1, 9, 0), { content: "hope you have a good week 💕" }),
];

/** Two socket messages after it, as the socket serves them: a mass send
 *  (a correlation and no `inReplyTo` key) and a personal one (no
 *  `correlationId` key). On its REST page 2.10.1 reads them with every key. */
export const AUTOMATION_SOCKET_MESSAGES = [
  {
    id: automationMessageId(11), groupId: AUTOMATION_GROUP, senderId: AUTOMATION_PAGE_REF,
    content: "flash sale 50% off today only", createdAt: automationAt(0, 6, 0), attachments: [], type: 1,
    correlationId: "500000000000000006",
  },
  {
    id: automationMessageId(12), groupId: AUTOMATION_GROUP, senderId: AUTOMATION_PAGE_REF,
    content: "good morning babe ☀️", createdAt: automationAt(0, 7, 0), attachments: [], inReplyTo: null, type: 1,
  },
];

/**
 * What 2.10.1 sends for Hi on the page of all twelve messages (the socket
 * ones as its REST page serves them), produced by running its own code
 * (`normalizeTranscript`, the Hi labelling of operations.ts,
 * `formatTranscriptForKernel`; TZ=UTC, the hub's clock) over this very data,
 * with AUTOMATION_DEFINITIONS as its welcome definitions.
 *
 * One line is not the hub's: 2.10.1 shows the text of a message whose `type`
 * is not 1 as `[System message]` (normalizeTranscript, every feature), and
 * the hub shows the text. That is how a message reads, not whether it is
 * automatic, and it is not this change's (prod 2026-10-13: no Fansly message
 * of `type` 2 in the archive or the socket overlay).
 */
export const RELEASED_HI_LINES = [
  "[10:00] Model: [Automatic / mass message] hey babe, welcome to my page 💕",
  "so glad you're here",
  "[09:00] Fan: hi! thanks 😊",
  "[09:05] Model: of course! what brought you here?",
  "[20:00] Model: [Automatic / mass message] [System message]",
  "[21:00] Fan: you're so hot",
  "[21:02] Model: aww thank you babe",
  "[18:00] Fan: what are you up to this weekend?",
  "[10:00] Model: [Automatic / mass message] thanks  for subscribing",
  "[15:00] Model: [Automatic / mass message] missing you 💋 come say hi",
  "[09:00] Model: hope you have a good week 💕",
  "[06:00] Model: [Automatic / mass message] flash sale 50% off today only",
  "[07:00] Model: good morning babe ☀️",
];
/** Its personal count and automatic messages for the same window. */
export const RELEASED_HI_PERSONAL_COUNT = 7;
export const RELEASED_HI_AUTOMATED_IDS = [1, 4, 8, 9, 11].map(automationMessageId);

/** The `[System message]` line of RELEASED_HI_LINES as the hub reads it. */
export const HUB_TYPE_TWO_LINE = "[20:00] Model: [Automatic / mass message] 🔥 new set just dropped, check my wall";

/** What 2.10.1 computes for Ping on the REST page alone (`analyzePingSegment`,
 *  `fanSilenceDaysFromAnalysis` at AUTOMATION_NOW), by its own code. */
export const RELEASED_PING = { segment: "segment-a", fanSilenceDays: 11 } as const;
