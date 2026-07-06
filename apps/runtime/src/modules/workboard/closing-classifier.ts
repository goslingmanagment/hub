import { runGatewayCompletion, type GatewayInternalApp } from "../../services/ai-gateway-internal.ts";
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
  "The team sells paid content (PPV), subscriptions, and tips. Label what the fan's last message is DOING so the team knows how urgently to act. Be strict: interest is not the same as intent to buy.",
  "For each thread return a JSON object with these fields:",
  '- "state": exactly one of:',
  '  - "buy_signal": the fan is concretely moving toward paying NOW. Use ONLY when one of these holds:',
  '      (a) the fan accepts or asks for a specific paid thing the creator just offered — a bare "yes" / "sure" / "send it" / "да" / "давай" right after a sales line like "want me to send it?" or "unlock for $15?";',
  '      (b) the fan proactively asks to buy or asks a price ("how much?", "сколько стоит?", "can you send me...", "I want to buy...", "do a custom for me");',
  '      (c) the fan says they are about to tip/pay or just sent money.',
  "    Real purchase intent tied to a transaction — NOT mere interest. If you are unsure, it is NOT a buy_signal (use smalltalk).",
  '  - "question": the fan asked something or expects info that is not itself a purchase ("are you online?", "what is your name?", "do you do customs?" with no yes/price yet).',
  '  - "complaint": the fan is upset, reports a problem, asks for a refund, or says content did not arrive.',
  '  - "smalltalk": chatting, flirting, compliments, or expressing interest/attraction/curiosity with NO concrete request to buy — e.g. "I love your content", "you are so hot", "both, that is why I followed", "been a fan for years". Warm and still needs a reply, but it is NOT a buy_signal.',
  '  - "cold": the fan is genuinely disengaged or shutting it down ("not interested", "no", "stop", "leave me alone", "unfollow me", "maybe later", "busy"). BUT declining ONE purchase while staying friendly or asking to keep chatting ("no money, can we just chat?") is NOT cold — it still needs a reply (smalltalk).',
  '  - "closing": acknowledgement, thanks, goodbye, good-night, well-wish, or lone emoji that ENDS an exchange ("ok", "thanks", "gn", "спасибо", 😘). BUT a greeting that OPENS the chat ("hi", "hey", "hello", "привет", with or without a name) is NOT closing — it needs a reply (smalltalk/question).',
  '- "needs_reply": true if the chatter should still respond; false ONLY for "closing" (and clear "cold" declines where replying would be pushy). A "buy_signal" ALWAYS needs a reply. When uncertain, answer true — a missed reply is worse than an extra one.',
  '- "reason": 8 words or fewer, in the language of the conversation, naming what the fan did (anchor on the action, e.g. "accepted PPV offer", "asked price", "just a compliment").',
  "",
  "KEY RULE: interest, attraction, compliments, or why-they-followed are SMALLTALK, not buy_signal. buy_signal is reserved for a concrete move toward a purchase. The creator line before the tail decides an ambiguous \"yes\" / \"да\": buy_signal only if it answers a sales offer.",
  "",
  "SOLICITATION/SPAM: some \"fans\" are other creators or bots blasting their own opener, not engaging you. If the fan message is self-promotion (advertising their own page/content, links to their own posts), a share-4-share / \"sfs\" request, or a role-reversed mass-opener that talks like a creator to a subscriber (\"thanks for the follow!\", \"glad you subscribed\", \"check out my video, what's your name?\"), classify it as \"cold\" with needs_reply=false — it is not a real prospect. (A genuine new fan who simply greets and introduces themselves — \"hi, I'm Rey, nice to meet you\" — is NOT solicitation: that is smalltalk and needs a reply.)",
  "",
  "Examples (classify the fan tail in context):",
  '  creator: "want me to send you that new video? 💕" | fan: "yes please" => buy_signal (accepted offer)',
  '  fan: "how much for a custom?" => buy_signal (asked price)',
  '  creator: "do you prefer my chatting or my content?" | fan: "Both, that is why I followed both accounts" => smalltalk (interest, no purchase ask)',
  '  fan: "you are so gorgeous, love your page" => smalltalk (compliment)',
  '  fan: "are you online rn?" => question',
  '  fan: "I paid but never got the video" => complaint',
  '  creator: "want it for $20?" | fan: "nah too much" => cold (declined)',
  '  creator: "i can do a custom for $25 😏" | fan: "no money, i\'m a student… can we just chat?" => smalltalk (declined but wants to keep chatting — needs a reply, NOT cold)',
  '  creator: "hey, thanks for the follow! 🤍" | fan: "Hi Lora, I\'m Rey, nice to meet you" => smalltalk (genuine new fan opener — needs a reply, NOT closing)',
  '  fan: "Hey! I\'m Lilly🥰 thanks for the follow! what\'s your name? 👀" => cold (role-reversed bot/cross-promo opener — no reply)',
  '  fan: "Someone down for a share4share? https://fansly.com/post/123 xoxo" => cold (self-promo solicitation — no reply)',
  '  fan: "ok thanks babe" => closing',
  "",
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

/**
 * Stage 29: the classifier runs THROUGH the gateway's internal lane — same
 * model, same prompts byte-for-byte, same max_tokens/temperature as the
 * retired direct SDK call. Its spend now lands in the ledger under
 * "workboard-closing" (subject to the per-feature budget) and its content
 * joins the restricted class. Rollback = git revert (one release window).
 */
export function createGatewayClosingClassifier(
  app: GatewayInternalApp,
  opts: { model: string; providerOverride?: Parameters<typeof runGatewayCompletion>[1]["providerOverride"] },
): ClosingClassifier {
  const gatewayModel = opts.model.includes(":") ? opts.model : `anthropic:${opts.model}`;
  return {
    model: opts.model,
    async classifyBatch(messages) {
      const result = await runGatewayCompletion(app, {
        feature: "workboard-closing",
        model: gatewayModel,
        // Classification, not generation: pin temperature to 0 so a borderline
        // tail gets the SAME verdict every run (no buy_signal↔smalltalk
        // flapping) and the permanent per-message cache stays meaningful.
        maxTokens: 1536,
        temperature: 0,
        systemBlocks: [{ text: SYSTEM_PROMPT, cache: "none" }],
        userBlocks: [{ text: buildUserContent(messages), cache: "none" }],
        ...(opts.providerOverride ? { providerOverride: opts.providerOverride } : {}),
      });
      return {
        verdicts: parseVerdicts(result.text, messages),
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      };
    },
  };
}
