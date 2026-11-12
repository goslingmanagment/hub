import { classifyTransportFailure, redactSensitiveText, sanitizeError } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { fetchWithEgress } from "../egress/fetch.ts";
import { closeTelegramRequestOptions, friendlyTelegramError, resolveTelegramRequestOptions } from "../telegram.ts";

/**
 * Сообщения людям (package S): the one attempt of one message, through the
 * Telegram egress (the service proxy, as the owner's alerts). Never repeated
 * here or anywhere: Telegram has no idempotency key, so a request that may
 * have reached it and did not answer is `unknown`, and stays so. A refusal
 * Telegram answered is `failed`; a connection that never came up is `failed`
 * too (nothing reached Telegram). Tests pass a stub instead: no test talks to
 * Telegram.
 */

export interface PeopleTransportInput {
  token: string;
  chatId: string;
  /** A forum group's topic (`message_thread_id`); null — the chat itself. */
  topicId: number | null;
  text: string;
  /** The row's key, for the logs only: Telegram has nothing to carry it. */
  idempotencyKey: string;
}

export type PeopleTransportResult =
  | { status: "sent"; messageId: number | null }
  /** `refusal`: the person never wrote to the bot (it cannot start a conversation), or blocked it. */
  | { status: "failed"; error: string; refusal?: "never_wrote" | "blocked" }
  | { status: "unknown"; error: string };

/** Telegram's refusals that are the person's, not the bot's: the next press would be refused the same way. */
export function refusalOf(description: string | null): "never_wrote" | "blocked" | undefined {
  const raw = (description ?? "").toLowerCase();
  if (raw.includes("bot was blocked")) return "blocked";
  if (raw.includes("can't initiate") || raw.includes("chat not found")) return "never_wrote";
  return undefined;
}

export type PeopleTransport = (input: PeopleTransportInput) => Promise<PeopleTransportResult>;

const SEND_TIMEOUT_MS = 15_000;

export function telegramPeopleTransport(app: Pick<AppContext, "config" | "db" | "logger">): PeopleTransport {
  return async (input) => {
    let options: Awaited<ReturnType<typeof resolveTelegramRequestOptions>>;
    try {
      options = await resolveTelegramRequestOptions(app);
    } catch (error) {
      return { status: "failed", error: `no route to Telegram: ${sanitizeError(error, { format: "chain", maxChars: 300, truncation: "clip" }).message}` };
    }
    try {
      const response = await fetchWithEgress(fetch, options.dispatcher, `https://api.telegram.org/bot${input.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: input.chatId,
          ...(input.topicId === null ? {} : { message_thread_id: input.topicId }),
          text: input.text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        redirect: "error",
      });
      const body = await response.json().catch(() => null) as { ok?: boolean; description?: string; result?: { message_id?: number } } | null;
      if (response.ok && body?.ok === true) {
        return { status: "sent", messageId: typeof body.result?.message_id === "number" ? body.result.message_id : null };
      }
      // An answer that is not a success: Telegram did not take it (a 5xx may have, and is not known).
      const error = friendlyTelegramError(response.status, body?.description ?? null);
      if (response.status >= 500) return { status: "unknown", error };
      const refusal = refusalOf(body?.description ?? null);
      return refusal === undefined ? { status: "failed", error } : { status: "failed", error, refusal };
    } catch (error) {
      const described = redactSensitiveText(sanitizeError(error, { format: "chain", maxChars: 300, truncation: "clip" }).message);
      app.logger.warn({ component: "people-messages", idempotencyKey: input.idempotencyKey, failureKind: classifyTransportFailure(error) }, "people message: the attempt did not answer");
      return classifyTransportFailure(error) === "connect" ? { status: "failed", error: described } : { status: "unknown", error: described };
    } finally {
      await closeTelegramRequestOptions(options);
    }
  };
}
