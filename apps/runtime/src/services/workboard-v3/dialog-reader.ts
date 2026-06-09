import Anthropic from "@anthropic-ai/sdk";

import type { Wb3DialogVerdict } from "@agency_hub_core/db";

// Dialog Reads (PRD §9): one read of the conversation tail returns ALL signals
// at once — needs_reply, intent, temperature, readiness, gist. Labels enter the
// system as words and chips, never as scores. Designed from scratch; only the
// plumbing pattern (batching, injectable interface, temperature 0) follows the
// v2 closing classifier. Prompt caching is intentionally NOT used: the prompt
// is ~1–1.5K tokens, below Haiku 4.5's 4,096-token minimum cacheable prefix —
// bulk batching amortizes the prompt instead.

export interface DialogReadInput {
  id: string;
  /** Recent conversation, oldest→newest. The tail is the fan's newest message. */
  context: Array<{ role: "fan" | "creator"; text: string }>;
}

export interface DialogReadResult {
  id: string;
  verdict: Wb3DialogVerdict;
  /** False when this id was missing/unparseable and got the fail-open default. */
  parsed: boolean;
}

export interface DialogReader {
  readonly model: string;
  /** Read 10–20 dialogs in one call. Returns one verdict per input id. */
  readBatch(dialogs: DialogReadInput[]): Promise<{
    results: DialogReadResult[];
    inputTokens: number;
    outputTokens: number;
  }>;
}

const SYSTEM_PROMPT = [
  "You read short chat threads between a fan and an adult-content creator's chat team, and assess the FAN'S latest message(s) in the context of the lines above.",
  "The team sells paid content (PPV), subscriptions, customs, and tips. Return one structured verdict per thread so the team knows what state the dialog is in.",
  "For each thread return a JSON object with these fields:",
  '- "intent": exactly one of:',
  '  - "buy_signal": the fan is concretely moving toward paying NOW — accepts/asks for a specific paid thing just offered (a bare "yes"/"да"/"send it" right after a sales line), proactively asks to buy or asks a price ("how much?", "сколько стоит?", "do a custom for me"), or says they are about to tip/pay. Real purchase intent, NOT mere interest. When unsure it is NOT a buy_signal.',
  '  - "question": the fan asked something or expects info that is not itself a purchase.',
  '  - "complaint": the fan is upset, reports a problem, asks for a refund, or says content did not arrive.',
  '  - "stop_request": the fan explicitly asks to stop messaging them ("stop texting me", "leave me alone", "unsubscribe me", "не пиши мне больше"). A mere lack of interest is NOT a stop_request.',
  '  - "smalltalk": chatting, flirting, compliments, interest with no concrete purchase move. A greeting that OPENS a chat ("hi", "привет") is smalltalk, not closing.',
  '  - "closing": acknowledgement/thanks/goodbye/lone emoji that ENDS an exchange ("ok", "thanks", "gn", "спасибо", 😘).',
  '  - "cold": genuinely disengaged or shutting it down without a stop demand ("not interested", "no", "maybe later"), or solicitation/spam — another creator/bot blasting self-promo, share-4-share, or a role-reversed mass opener ("thanks for the follow! check my page"). Declining ONE purchase while staying friendly is smalltalk, not cold.',
  '- "needs_reply": true if the chatter should still respond; false ONLY for "closing", clear "cold" disengagement/spam, and "stop_request". A "buy_signal" ALWAYS needs a reply. When uncertain — true: a missed reply is worse than an extra one.',
  '- "temperature": the overall heat of the dialog right now: "hot" (actively engaged, money in the air), "warm" (responsive, friendly), "cool" (slow, distracted, short answers), "cold" (disengaged, hostile, or spam).',
  '- "readiness": how close the fan is to a purchase: "none", "curious" (asks about content), "considering" (discusses a specific item/price), "ready" (agreed or about to pay).',
  '- "gist": одна короткая фраза ПО-РУССКИ (до 10 слов) — суть того, что сейчас происходит в диалоге, например: "спрашивает цену кастома", "жалуется, что видео не пришло", "просто болтает о работе". Чаттеры читают по-русски.',
  "",
  "KEY RULE: interest, attraction, compliments are smalltalk, not buy_signal. The creator line before the tail decides an ambiguous \"yes\"/\"да\": buy_signal only if it answers a sales offer.",
  "",
  'Input is a JSON array of {"id":string,"messages":[{"role":"fan"|"creator","text":string}, ...]}.',
  'Respond with ONLY a compact JSON array of {"id":string,"intent":string,"needs_reply":boolean,"temperature":string,"readiness":string,"gist":string} — one object per input thread, no prose, no code fences.',
].join("\n");

const MAX_CONTENT_CHARS = 500;
const MAX_GIST_CHARS = 160;

const INTENTS: ReadonlySet<string> = new Set([
  "buy_signal",
  "question",
  "complaint",
  "smalltalk",
  "closing",
  "stop_request",
  "cold",
]);
const TEMPERATURES: ReadonlySet<string> = new Set(["hot", "warm", "cool", "cold"]);
const READINESS: ReadonlySet<string> = new Set(["none", "curious", "considering", "ready"]);

/** Fail-open default: an extra row beats a lost fan; intents are never invented. */
export function wb3FailOpenVerdict(): Wb3DialogVerdict {
  return { needs_reply: true, intent: null, temperature: null, readiness: null, gist: null };
}

function buildUserContent(dialogs: DialogReadInput[]): string {
  return JSON.stringify(
    dialogs.map((d) => ({
      id: d.id,
      messages: d.context.map((m) => ({ role: m.role, text: (m.text ?? "").slice(0, MAX_CONTENT_CHARS) })),
    })),
  );
}

export function parseDialogReadResponse(
  text: string,
  dialogs: DialogReadInput[],
): DialogReadResult[] {
  const byId = new Map<string, Wb3DialogVerdict>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Array<Record<string, unknown>>;
      for (const row of parsed) {
        if (typeof row?.id !== "string") {
          continue;
        }
        const intent =
          typeof row.intent === "string" && INTENTS.has(row.intent)
            ? (row.intent as Wb3DialogVerdict["intent"])
            : null;
        const needsReply =
          typeof row.needs_reply === "boolean"
            ? row.needs_reply
            : intent !== "closing" && intent !== "stop_request" && intent !== "cold";
        byId.set(row.id, {
          needs_reply: needsReply,
          intent,
          temperature:
            typeof row.temperature === "string" && TEMPERATURES.has(row.temperature)
              ? (row.temperature as Wb3DialogVerdict["temperature"])
              : null,
          readiness:
            typeof row.readiness === "string" && READINESS.has(row.readiness)
              ? (row.readiness as Wb3DialogVerdict["readiness"])
              : null,
          gist: typeof row.gist === "string" ? row.gist.slice(0, MAX_GIST_CHARS) : null,
        });
      }
    } catch {
      // fall through — every id below gets the fail-open default
    }
  }
  return dialogs.map((d) => {
    const verdict = byId.get(d.id);
    return verdict
      ? { id: d.id, verdict, parsed: true }
      : { id: d.id, verdict: wb3FailOpenVerdict(), parsed: false };
  });
}

export function createAnthropicDialogReader(opts: { apiKey: string; model: string }): DialogReader {
  const client = new Anthropic({ apiKey: opts.apiKey });
  return {
    model: opts.model,
    async readBatch(dialogs) {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 2048,
        // Classification, not generation: temperature 0 keeps the permanent
        // (conversation, message) cache meaningful across reruns.
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserContent(dialogs) }],
      });
      const text = response.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      return {
        results: parseDialogReadResponse(text, dialogs),
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    },
  };
}

/** Build the reader from config, or null → L1-only mode (safe default). */
export function maybeCreateWb3DialogReader(config: {
  wb3DialogReadLlmEnabled?: boolean;
  anthropicApiKey?: string | null;
  wb3DialogReadModel?: string;
}): DialogReader | null {
  if (!config.wb3DialogReadLlmEnabled || !config.anthropicApiKey) {
    return null;
  }
  return createAnthropicDialogReader({
    apiKey: config.anthropicApiKey,
    model: config.wb3DialogReadModel ?? "claude-haiku-4-5",
  });
}
