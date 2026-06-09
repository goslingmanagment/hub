import Anthropic from "@anthropic-ai/sdk";

import type { Wb3Dossier } from "@agency_hub_core/db";

// The dossier (PRD §9): cold context for reactivation — what was discussed,
// what worked, how the last dialog ended. Built from the entire stored history
// via the Message Batches API (−50%), bulk 3–5 dialogs per request. Money is
// deliberately NOT part of the dossier — LTV/breakdown come from transactions.

export interface DossierDialog {
  /** fan id, echoed back by the model as the dialog id. */
  id: string;
  messages: Array<{ role: "fan" | "creator"; text: string }>;
}

export interface DossierBatchResultItem {
  customId: string;
  /** null when the request errored inside the batch. */
  text: string | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Thin injectable wrapper over the Message Batches API so tests can fake the
 * round-trip. One request = one bulk prompt with 3–5 dialogs.
 */
export interface DossierBatchClient {
  readonly model: string;
  createBatch(requests: Array<{ customId: string; dialogs: DossierDialog[] }>): Promise<string>;
  /** Poll: in_progress until the batch ends; then one item per request. */
  getBatchResults(
    batchId: string,
  ): Promise<{ status: "in_progress" } | { status: "ended"; items: DossierBatchResultItem[] }>;
}

const SYSTEM_PROMPT = [
  "You read full chat histories between fans and an adult-content creator's chat team, and build a short reactivation dossier per dialog for the (Russian-speaking) chat team.",
  "Do NOT include money amounts, prices, or purchase totals — those live elsewhere. Focus on who the fan is and how to restart the conversation.",
  "For each dialog return a JSON object:",
  '- "id": the dialog id, echoed exactly.',
  '- "gist": одна фраза ПО-РУССКИИ (до 25 слов): кто этот фан, что его интересует, ключевые факты ("увлекается фитнесом, дважды просил кастомы, женат, часовой пояс US-East").',
  '- "interests": array of 1–6 short lowercase tags (e.g. ["fitness", "customs", "roleplay"]); [] if unknown.',
  '- "hooks": array of 0–4 short Russian phrases — concrete re-engagement angles tied to the dialog ("спрашивал про новый кастом в мае", "упоминал день рождения"). Only real hooks from the text; never invent.',
  '- "ending": how the LAST exchange ended — exactly one of "warm" (friendly, promised to return), "neutral", "sour" (annoyed, disappointed, felt pushed), "refused" (explicitly declined further offers/contact).',
  '- "ending_note": короткая фраза ПО-РУССКИ о финале ("тепло попрощался, обещал вернуться после зарплаты"); null if nothing notable.',
  '- "language": the fan\'s language as a lowercase ISO 639-1 code ("en", "ru", ...).',
  "",
  'Input is a JSON array of {"id":string,"messages":[{"role":"fan"|"creator","text":string}, ...]} (oldest→newest).',
  'Respond with ONLY a compact JSON array of {"id","gist","interests","hooks","ending","ending_note","language"} — one object per input dialog, no prose, no code fences.',
].join("\n");

const MAX_MESSAGE_CHARS = 1000;
const MAX_DIALOG_CHARS = 60_000;
const MAX_GIST_CHARS = 300;
const ENDINGS: ReadonlySet<string> = new Set(["warm", "neutral", "sour", "refused"]);

export function buildDossierUserContent(dialogs: DossierDialog[]): string {
  return JSON.stringify(
    dialogs.map((d) => {
      let budget = MAX_DIALOG_CHARS;
      // Keep the NEWEST messages when a dialog exceeds the budget — the ending matters most.
      const kept: Array<{ role: "fan" | "creator"; text: string }> = [];
      for (let i = d.messages.length - 1; i >= 0; i -= 1) {
        const text = (d.messages[i]!.text ?? "").slice(0, MAX_MESSAGE_CHARS);
        if (budget - text.length < 0) {
          break;
        }
        budget -= text.length;
        kept.push({ role: d.messages[i]!.role, text });
      }
      kept.reverse();
      return { id: d.id, messages: kept };
    }),
  );
}

function coerceStringArray(raw: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxChars));
}

/** Parses one bulk response; ids missing from the output are simply skipped. */
export function parseDossierResponse(text: string): Map<string, Wb3Dossier> {
  const byId = new Map<string, Wb3Dossier>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) {
    return byId;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Array<Record<string, unknown>>;
    for (const row of parsed) {
      if (typeof row?.id !== "string") {
        continue;
      }
      byId.set(row.id, {
        gist: typeof row.gist === "string" ? row.gist.slice(0, MAX_GIST_CHARS) : null,
        interests: coerceStringArray(row.interests, 6, 40),
        hooks: coerceStringArray(row.hooks, 4, 160),
        ending:
          typeof row.ending === "string" && ENDINGS.has(row.ending)
            ? (row.ending as Wb3Dossier["ending"])
            : null,
        ending_note:
          typeof row.ending_note === "string" ? row.ending_note.slice(0, MAX_GIST_CHARS) : null,
        language: typeof row.language === "string" ? row.language.slice(0, 8) : null,
      });
    }
  } catch {
    // unparseable bulk → skipped; the nightly rebuild pass retries those fans
  }
  return byId;
}

export function createAnthropicDossierBatchClient(opts: {
  apiKey: string;
  model: string;
}): DossierBatchClient {
  const client = new Anthropic({ apiKey: opts.apiKey });
  return {
    model: opts.model,
    async createBatch(requests) {
      const batch = await client.messages.batches.create({
        requests: requests.map((request) => ({
          custom_id: request.customId,
          params: {
            model: opts.model,
            max_tokens: 2048,
            temperature: 0,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: buildDossierUserContent(request.dialogs) }],
          },
        })),
      });
      return batch.id;
    },
    async getBatchResults(batchId) {
      const batch = await client.messages.batches.retrieve(batchId);
      if (batch.processing_status !== "ended") {
        return { status: "in_progress" };
      }
      const items: DossierBatchResultItem[] = [];
      for await (const entry of await client.messages.batches.results(batchId)) {
        if (entry.result.type === "succeeded") {
          const message = entry.result.message;
          items.push({
            customId: entry.custom_id,
            text: message.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
            inputTokens: message.usage?.input_tokens ?? 0,
            outputTokens: message.usage?.output_tokens ?? 0,
          });
        } else {
          items.push({ customId: entry.custom_id, text: null, inputTokens: 0, outputTokens: 0 });
        }
      }
      return { status: "ended", items };
    },
  };
}

/** Build the batch client from config, or null → transactions_only-only mode. */
export function maybeCreateWb3DossierBatchClient(config: {
  wb3DossierLlmEnabled?: boolean;
  anthropicApiKey?: string | null;
  wb3DossierModel?: string;
}): DossierBatchClient | null {
  if (!config.wb3DossierLlmEnabled || !config.anthropicApiKey) {
    return null;
  }
  return createAnthropicDossierBatchClient({
    apiKey: config.anthropicApiKey,
    model: config.wb3DossierModel ?? "claude-haiku-4-5",
  });
}
