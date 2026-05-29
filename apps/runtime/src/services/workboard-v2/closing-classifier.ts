import Anthropic from "@anthropic-ai/sdk";

// L2 closing-message classifier abstraction. The orchestration (cap, cache, cost
// accounting) depends only on this interface, so tests inject a fake and the real
// Haiku impl stays isolated + flag-gated. See docs/workboard-v2-priority-design.md §6.

export interface ClosingClassifierInput {
  id: string;
  content: string;
}

export interface ClosingVerdict {
  id: string;
  needsReply: boolean;
}

export interface ClosingClassifier {
  readonly model: string;
  /** Classify up to ~20 tail messages in one call. Returns one verdict per input id. */
  classifyBatch(messages: ClosingClassifierInput[]): Promise<{
    verdicts: ClosingVerdict[];
    inputTokens: number;
    outputTokens: number;
  }>;
}

const SYSTEM_PROMPT = [
  "You decide whether a fan's most recent direct message to an adult-content creator's chat team still needs a reply.",
  'Answer needs_reply=false ONLY for conversation-CLOSING messages: acknowledgements, thanks, goodbyes, good-night, well-wishes, lone emoji/reactions, or content-free fillers ("ok", "lol", "ty", "gn", "np", "спасибо", "пока", "ага", 😘, 👍).',
  'Answer needs_reply=true for anything that invites or expects a response: questions, requests, openers ("hi", "you up?", "when?"), opinions, or a continuation of the topic.',
  "When uncertain, answer true (a missed reply is worse than an extra one).",
  "Input is a JSON array of messages. Respond with ONLY a compact JSON array of {\"id\": string, \"needs_reply\": boolean} — one object per input message, no prose, no code fences.",
].join("\n");

const MAX_CONTENT_CHARS = 500;

function buildUserContent(messages: ClosingClassifierInput[]): string {
  return JSON.stringify(messages.map((m) => ({ id: m.id, text: (m.content ?? "").slice(0, MAX_CONTENT_CHARS) })));
}

function parseVerdicts(text: string, messages: ClosingClassifierInput[]): ClosingVerdict[] {
  const byId = new Map<string, boolean>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Array<{ id?: unknown; needs_reply?: unknown }>;
      for (const row of parsed) {
        if (typeof row?.id === "string") {
          byId.set(row.id, row.needs_reply !== false);
        }
      }
    } catch {
      // fall through — default everything to needs_reply=true below
    }
  }
  // Default any missing/unparseable id to true (safe).
  return messages.map((m) => ({ id: m.id, needsReply: byId.has(m.id) ? byId.get(m.id)! : true }));
}

export function createAnthropicClosingClassifier(opts: { apiKey: string; model: string }): ClosingClassifier {
  const client = new Anthropic({ apiKey: opts.apiKey });
  return {
    model: opts.model,
    async classifyBatch(messages) {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 1024,
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
