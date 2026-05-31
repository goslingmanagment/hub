import Anthropic from "@anthropic-ai/sdk";

import type { ConversationState } from "./types.ts";

// L2 conversation classifier abstraction. The orchestration (cap, cache, cost
// accounting) depends only on this interface, so tests inject a fake and the real
// Haiku impl stays isolated + flag-gated. See docs/workboard-v2-priority-design.md §6.
//
// The classifier reads the FAN'S LAST message *in conversation context* (the last
// few messages with roles), not the tail in isolation — so "yes" after "want me to
// send the video?" is correctly a buy_signal, not a closing. It returns a semantic
// `state` that feeds BOTH the needs_reply detector and the urgency axis.

export interface ClosingContextMessage {
  role: "fan" | "creator";
  text: string;
}

export interface ClosingClassifierInput {
  id: string;
  /** Recent conversation, oldest→newest. The LAST entry is the fan's tail message. */
  context: ClosingContextMessage[];
}

export interface ClosingVerdict {
  id: string;
  needsReply: boolean;
  state: ConversationState;
  /** Short human-readable rationale (for the "Детектор ответа" panel). */
  reason: string;
}

export interface ClosingClassifier {
  readonly model: string;
  /** Classify up to ~15 conversations in one call. Returns one verdict per input id. */
  classifyBatch(messages: ClosingClassifierInput[]): Promise<{
    verdicts: ClosingVerdict[];
    inputTokens: number;
    outputTokens: number;
  }>;
}

const SYSTEM_PROMPT = [
  "You read short chat threads between a fan and an adult-content creator's chat team, and classify the FAN'S LAST message in the context of the lines above it.",
  "For each thread return a JSON object with these fields:",
  '- "state": exactly one of:',
  '  - "buy_signal": fan is interested, asking to buy, or saying yes to an offer/PPV/tip ("yes", "sure", "how much?", "send it", "да", "давай", "сколько стоит?").',
  '  - "question": fan asked something or expects info that is not itself a purchase.',
  '  - "complaint": fan is upset, reports a problem, asks for a refund, or says content did not arrive.',
  '  - "smalltalk": casual chatting with no clear ask, thread still open.',
  '  - "cold": fan is disengaged, dismissive, or declining ("not interested", "no", "stop", "maybe later", "busy").',
  '  - "closing": acknowledgement, thanks, goodbye, good-night, well-wish, or lone emoji that ends the exchange ("ok", "thanks", "gn", "спасибо", 😘).',
  '- "needs_reply": true if the chatter should still respond; false ONLY for "closing" (and clear "cold" declines where replying would be pushy). A "buy_signal" ALWAYS needs a reply. When uncertain, answer true — a missed reply is worse than an extra one.',
  '- "reason": 8 words or fewer, in the language of the conversation, explaining the call.',
  'Use the context: judge the LAST fan message, but read the creator line(s) before it (e.g. "yes" after "want me to send it?" is buy_signal, not closing).',
  'Input is a JSON array of {"id":string,"messages":[{"role":"fan"|"creator","text":string}, ...]}.',
  'Respond with ONLY a compact JSON array of {"id":string,"state":string,"needs_reply":boolean,"reason":string} — one object per input thread, no prose, no code fences.',
].join("\n");

const MAX_CONTENT_CHARS = 500;
const MAX_REASON_CHARS = 160;

const STATES: ReadonlySet<string> = new Set<ConversationState>([
  "question",
  "buy_signal",
  "smalltalk",
  "closing",
  "cold",
  "complaint",
]);

function coerceState(raw: unknown): ConversationState {
  return typeof raw === "string" && STATES.has(raw) ? (raw as ConversationState) : "smalltalk";
}

function buildUserContent(messages: ClosingClassifierInput[]): string {
  return JSON.stringify(
    messages.map((m) => ({
      id: m.id,
      messages: m.context.map((c) => ({ role: c.role, text: (c.text ?? "").slice(0, MAX_CONTENT_CHARS) })),
    })),
  );
}

function parseVerdicts(text: string, messages: ClosingClassifierInput[]): ClosingVerdict[] {
  const byId = new Map<string, { needsReply: boolean; state: ConversationState; reason: string }>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Array<{
        id?: unknown;
        state?: unknown;
        needs_reply?: unknown;
        reason?: unknown;
      }>;
      for (const row of parsed) {
        if (typeof row?.id === "string") {
          const state = coerceState(row.state);
          // Trust an explicit boolean; otherwise derive from the state (closing = no reply).
          const needsReply = typeof row.needs_reply === "boolean" ? row.needs_reply : state !== "closing";
          const reason = typeof row.reason === "string" ? row.reason.slice(0, MAX_REASON_CHARS) : "";
          byId.set(row.id, { needsReply, state, reason });
        }
      }
    } catch {
      // fall through — default everything to a safe needs_reply=true below
    }
  }
  // Default any missing/unparseable id to needs_reply=true with a neutral state (no urgency boost).
  return messages.map((m) => {
    const v = byId.get(m.id);
    return v
      ? { id: m.id, needsReply: v.needsReply, state: v.state, reason: v.reason }
      : { id: m.id, needsReply: true, state: "smalltalk" as ConversationState, reason: "" };
  });
}

export function createAnthropicClosingClassifier(opts: { apiKey: string; model: string }): ClosingClassifier {
  const client = new Anthropic({ apiKey: opts.apiKey });
  return {
    model: opts.model,
    async classifyBatch(messages) {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 1536,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(messages) }],
      });
      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      return {
        verdicts: parseVerdicts(text, messages),
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    },
  };
}

/** Build the classifier from config, or null when L2 is disabled / no key (safe default). */
export function maybeCreateClosingClassifier(config: {
  wbClosingLlmEnabled?: boolean;
  anthropicApiKey?: string | null;
  wbClosingLlmModel?: string;
}): ClosingClassifier | null {
  if (!config.wbClosingLlmEnabled || !config.anthropicApiKey) {
    return null;
  }
  return createAnthropicClosingClassifier({
    apiKey: config.anthropicApiKey,
    model: config.wbClosingLlmModel ?? "claude-haiku-4-5",
  });
}
