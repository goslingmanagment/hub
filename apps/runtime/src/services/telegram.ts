import { setTimeout as delay } from "node:timers/promises";

import { findPageByLabel, getTelegramSettings, type TelegramSettingsRow } from "@agency_hub_core/db";
import {
  classifyTransportError,
  createProxyRequestDispatcher,
  decryptJsonWithKeyVersion,
  redactSensitiveText,
  resolveRetryDelayMs,
} from "@agency_hub_core/shared";
import type { Dispatcher } from "undici";

import type { AppContext } from "../bootstrap.ts";
import { resolveStoredProxyConfig } from "./page-context.ts";

export type TelegramSendResult =
  | {
    status: "skipped";
    reason: "unconfigured" | "disabled";
  }
  | {
    status: "sent";
    chatId: string;
    messageId: number | null;
  }
  | {
    status: "failed";
    error: string;
  };

export interface ResolvedTelegramCredentials {
  botToken: string;
  chatId: string;
}

const TELEGRAM_SEND_TIMEOUT_MS = 10_000;
const TELEGRAM_SEND_MAX_RETRIES = 2;
const TELEGRAM_DISCOVER_TIMEOUT_MS = 10_000;

type TelegramRequestInit = RequestInit & { dispatcher?: Dispatcher };

export interface TelegramRequestOptions {
  dispatcher?: Dispatcher;
}

function buildTelegramApiUrl(botToken: string, method: string) {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

function describeTelegramFailure(error: unknown) {
  if (classifyTransportError(error) === "timeout") {
    return "Telegram API request timed out — configure a Telegram proxy page or retry later.";
  }
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function shouldRetryTelegramResponse(status: number) {
  return status === 429 || status >= 500;
}

/**
 * Maps raw Telegram API failures to operator-friendly, actionable text. Falls
 * back to the (redacted) raw description so we never hide an unexpected error.
 */
export function friendlyTelegramError(status: number, description: string | null): string {
  const raw = (description ?? "").toLowerCase();
  if (status === 401 || raw.includes("unauthorized")) {
    return "Invalid bot token — re-check the token from @BotFather.";
  }
  if (raw.includes("chat not found")) {
    return "Chat not found — send the bot a message first, then re-detect the Chat ID.";
  }
  if (raw.includes("bot was blocked")) {
    return "The bot was blocked by this chat — unblock it in Telegram and try again.";
  }
  if (raw.includes("can't initiate") || raw.includes("can't talk")) {
    return "Send the bot a message first — bots cannot start a conversation.";
  }
  if (raw.includes("not enough rights") || raw.includes("need administrator")) {
    return "The bot needs admin rights to post in this channel/group.";
  }
  if (raw.includes("chat_id is empty") || raw.includes("can't parse") || raw.includes("invalid")) {
    return "Invalid Chat ID — use a numeric id (e.g. 123456789 or -100…).";
  }
  return redactSensitiveText(description ?? `Telegram request failed with HTTP ${status}`);
}

export class TelegramDiscoveryError extends Error {}
export class TelegramProxyConfigError extends Error {}

export interface DiscoveredTelegramChat {
  id: string;
  type: string;
  title: string;
}

export interface TelegramDiscoveryResult {
  botUsername: string | null;
  chats: DiscoveredTelegramChat[];
}

interface TelegramChatPayload {
  id?: number;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

function describeTelegramChat(chat: TelegramChatPayload): string {
  if (chat.title) return chat.title;
  if (chat.username) return `@${chat.username}`;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  return String(chat.id ?? "");
}

function withTelegramRequestOptions(
  init: RequestInit,
  options: TelegramRequestOptions,
): TelegramRequestInit {
  if (!options.dispatcher) {
    return init;
  }

  return {
    ...init,
    dispatcher: options.dispatcher,
  };
}

export async function closeTelegramRequestOptions(options: TelegramRequestOptions) {
  await options.dispatcher?.close().catch(() => undefined);
}

export async function resolveTelegramRequestOptions(
  app: Pick<AppContext, "config" | "db">,
): Promise<TelegramRequestOptions> {
  const pageLabel = app.config.telegramProxyPageLabel;
  if (!pageLabel) {
    return {};
  }

  const stored = await findPageByLabel(app.db, pageLabel);
  if (!stored) {
    throw new TelegramProxyConfigError(`Telegram proxy page "${pageLabel}" was not found`);
  }
  if (!stored.proxy) {
    throw new TelegramProxyConfigError(`Telegram proxy page "${pageLabel}" has no proxy configured`);
  }

  try {
    const proxy = resolveStoredProxyConfig(app, stored.proxy);
    if (!proxy) {
      throw new Error("stored proxy resolved to empty config");
    }
    return {
      dispatcher: createProxyRequestDispatcher(proxy),
    };
  } catch (error) {
    throw new TelegramProxyConfigError(
      `Telegram proxy page "${pageLabel}" has invalid proxy config: ${redactSensitiveText(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  }
}

/**
 * Validates the token via `getMe` and lists the chats that have interacted with
 * the bot via `getUpdates`, so the operator can pick their Chat ID from a menu
 * instead of hand-copying it out of a raw `getUpdates` URL (which also leaks the
 * token into browser history). Calling `getUpdates` without an offset only peeks
 * pending updates — it does not consume them.
 */
export async function discoverTelegramChats(
  botToken: string,
  options: TelegramRequestOptions = {},
): Promise<TelegramDiscoveryResult> {
  let meResponse: Response;
  try {
    meResponse = await fetch(buildTelegramApiUrl(botToken, "getMe"), withTelegramRequestOptions({
      signal: AbortSignal.timeout(TELEGRAM_DISCOVER_TIMEOUT_MS),
    }, options));
  } catch (error) {
    throw new TelegramDiscoveryError(describeTelegramFailure(error));
  }
  const meBody = await meResponse.json().catch(() => null) as
    | { ok?: boolean; description?: string; result?: { username?: string } }
    | null;
  if (!meResponse.ok || meBody?.ok !== true) {
    throw new TelegramDiscoveryError(friendlyTelegramError(meResponse.status, meBody?.description ?? null));
  }
  const botUsername = meBody.result?.username ?? null;

  let updatesResponse: Response;
  try {
    updatesResponse = await fetch(buildTelegramApiUrl(botToken, "getUpdates"), withTelegramRequestOptions({
      signal: AbortSignal.timeout(TELEGRAM_DISCOVER_TIMEOUT_MS),
    }, options));
  } catch (error) {
    throw new TelegramDiscoveryError(describeTelegramFailure(error));
  }
  const updatesBody = await updatesResponse.json().catch(() => null) as
    | { ok?: boolean; description?: string; result?: Array<Record<string, { chat?: TelegramChatPayload }>> }
    | null;
  if (!updatesResponse.ok || updatesBody?.ok !== true) {
    throw new TelegramDiscoveryError(friendlyTelegramError(updatesResponse.status, updatesBody?.description ?? null));
  }

  const updates = Array.isArray(updatesBody.result) ? updatesBody.result : [];
  const byId = new Map<string, DiscoveredTelegramChat>();
  for (const update of updates) {
    const chat = update.message?.chat
      ?? update.edited_message?.chat
      ?? update.channel_post?.chat
      ?? update.my_chat_member?.chat
      ?? update.chat_member?.chat;
    if (!chat || typeof chat.id !== "number") continue;
    const id = String(chat.id);
    if (!byId.has(id)) {
      byId.set(id, { id, type: String(chat.type ?? "unknown"), title: describeTelegramChat(chat) });
    }
  }

  return { botUsername, chats: [...byId.values()] };
}

export type TelegramCredentialSource = "db" | "env" | "none";

export type TelegramConnectionStatus =
  | "not_configured"
  | "untested"
  | "connected"
  | "last_message_failed";

function resolveBotTokenWithSource(
  app: Pick<AppContext, "config">,
  settings: TelegramSettingsRow,
): { token: string | null; source: TelegramCredentialSource } {
  // Stored (DB) token wins over env, but only if it actually decrypts.
  if (settings.encryptedBotToken) {
    try {
      return {
        token: decryptJsonWithKeyVersion<string>(
          settings.encryptedBotToken,
          app.config.encryptionKeysByVersion,
        ),
        source: "db",
      };
    } catch {
      // decryption failed — fall back to env for this field
    }
  }
  if (app.config.telegramBotToken) {
    return { token: app.config.telegramBotToken, source: "env" };
  }
  return { token: null, source: "none" };
}

export function resolveTelegramBotToken(
  app: Pick<AppContext, "config">,
  settings: TelegramSettingsRow,
): string | null {
  return resolveBotTokenWithSource(app, settings).token;
}

/**
 * Per-field precedence: a stored token/chatId each independently wins over its
 * env counterpart. This mirrors how `buildNotificationsSettingsResponse` renders
 * the fields, so the UI and the actual send target can never silently disagree
 * (previously a DB chatId set without a DB token was shown in the UI but ignored
 * at send time, which kept using the env chatId).
 */
export function resolveTelegramCredentials(
  app: Pick<AppContext, "config">,
  settings: TelegramSettingsRow,
): ResolvedTelegramCredentials | null {
  const botToken = resolveTelegramBotToken(app, settings);
  const chatId = settings.chatId ?? app.config.telegramChatId ?? null;

  if (botToken && chatId) {
    return { botToken, chatId };
  }

  return null;
}

/**
 * Where each credential field is sourced from, for honest UI display. Reflects
 * where the value is stored (DB column set → "db", else env → "env", else
 * "none"); kept in lockstep with `resolveTelegramCredentials`'s precedence.
 */
export function resolveTelegramCredentialSources(
  app: Pick<AppContext, "config">,
  settings: TelegramSettingsRow,
): { botTokenSource: TelegramCredentialSource; chatIdSource: TelegramCredentialSource } {
  return {
    // Derive the token source from the same resolver that actually picks the
    // value, so a DB token that fails to decrypt is reported as "env" (the value
    // really in use), not a misleading "db".
    botTokenSource: resolveBotTokenWithSource(app, settings).source,
    chatIdSource: settings.chatId ? "db" : app.config.telegramChatId ? "env" : "none",
  };
}

/**
 * The connection status only trusts a *real* delivery (sent/failed) made after
 * the current credentials were saved. A stale success from a previous bot/chat,
 * or a `skipped` attempt (nothing was actually sent), never reads as "connected".
 */
export function deriveTelegramConnectionState<T extends { status: string; createdAt: Date }>(
  configured: boolean,
  credentialsUpdatedAt: Date,
  lastRealAttempt: T | null,
): { status: TelegramConnectionStatus; recentAttempt: T | null } {
  if (!configured) {
    return { status: "not_configured", recentAttempt: null };
  }
  const recentAttempt = lastRealAttempt && lastRealAttempt.createdAt >= credentialsUpdatedAt
    ? lastRealAttempt
    : null;
  const status: TelegramConnectionStatus = recentAttempt?.status === "sent"
    ? "connected"
    : recentAttempt?.status === "failed"
      ? "last_message_failed"
      : "untested";
  return { status, recentAttempt };
}

export async function sendTelegramMessage(
  app: Pick<AppContext, "config" | "logger" | "db">,
  input: {
    text: string;
    parseMode?: "HTML" | "MarkdownV2";
    credentials?: ResolvedTelegramCredentials;
  },
): Promise<TelegramSendResult> {
  const creds = input.credentials ?? resolveTelegramCredentials(
    app,
    await getTelegramSettings(app.db, {
      defaultReportHourUtc: app.config.telegramReportHourUtc,
    }),
  );

  if (!creds) {
    return {
      status: "skipped",
      reason: "unconfigured",
    };
  }

  let requestOptions: TelegramRequestOptions;
  try {
    requestOptions = await resolveTelegramRequestOptions(app);
  } catch (error) {
    const described = describeTelegramFailure(error);
    app.logger.warn({
      chatId: creds.chatId,
      error: described,
      err: error,
    }, "Telegram notification proxy configuration failed; continuing");
    return {
      status: "failed",
      error: described,
    };
  }

  try {
    for (let attemptNumber = 1; attemptNumber <= TELEGRAM_SEND_MAX_RETRIES + 1; attemptNumber += 1) {
      try {
        const response = await fetch(buildTelegramApiUrl(creds.botToken, "sendMessage"), withTelegramRequestOptions({
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            chat_id: creds.chatId,
            text: input.text,
            ...(input.parseMode && { parse_mode: input.parseMode }),
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS),
        }, requestOptions));
        const body = await response.json().catch(() => null) as
          | {
            ok?: boolean;
            description?: string;
            result?: {
              message_id?: number;
            };
          }
          | null;

        if (response.ok && body?.ok === true) {
          return {
            status: "sent",
            chatId: creds.chatId,
            messageId: typeof body.result?.message_id === "number" ? body.result.message_id : null,
          };
        }

        const error = friendlyTelegramError(response.status, body?.description ?? null);
        const canRetry = attemptNumber <= TELEGRAM_SEND_MAX_RETRIES
          && shouldRetryTelegramResponse(response.status);

        if (canRetry) {
          await delay(resolveRetryDelayMs(response.headers.get("retry-after"), attemptNumber));
          continue;
        }

        app.logger.warn({
          chatId: creds.chatId,
          httpStatus: response.status,
          error,
        }, "Telegram notification failed; continuing");
        return {
          status: "failed",
          error,
        };
      } catch (error) {
        const described = describeTelegramFailure(error);
        const canRetry = attemptNumber <= TELEGRAM_SEND_MAX_RETRIES
          && (classifyTransportError(error) === "timeout" || classifyTransportError(error) === "transport");

        if (canRetry) {
          await delay(resolveRetryDelayMs(null, attemptNumber));
          continue;
        }

        app.logger.warn({
          chatId: creds.chatId,
          error: described,
          err: error,
        }, "Telegram notification failed; continuing");
        return {
          status: "failed",
          error: described,
        };
      }
    }
  } finally {
    await closeTelegramRequestOptions(requestOptions);
  }

  return {
    status: "failed",
    error: "Telegram notification failed after exhausting retries",
  };
}

const TELEGRAM_PHOTO_TIMEOUT_MS = 30_000;

export async function sendTelegramPhoto(
  app: Pick<AppContext, "config" | "logger" | "db">,
  input: {
    photo: Buffer;
    caption?: string;
    parseMode?: "HTML" | "MarkdownV2";
    credentials?: ResolvedTelegramCredentials;
  },
): Promise<TelegramSendResult> {
  const creds = input.credentials ?? resolveTelegramCredentials(
    app,
    await getTelegramSettings(app.db, {
      defaultReportHourUtc: app.config.telegramReportHourUtc,
    }),
  );

  if (!creds) {
    return { status: "skipped", reason: "unconfigured" };
  }

  let requestOptions: TelegramRequestOptions;
  try {
    requestOptions = await resolveTelegramRequestOptions(app);
  } catch (error) {
    const described = describeTelegramFailure(error);
    app.logger.warn({
      chatId: creds.chatId,
      error: described,
      err: error,
    }, "Telegram notification proxy configuration failed; continuing");
    return {
      status: "failed",
      error: described,
    };
  }

  try {
    for (let attemptNumber = 1; attemptNumber <= TELEGRAM_SEND_MAX_RETRIES + 1; attemptNumber += 1) {
      try {
        const form = new FormData();
        form.set("chat_id", creds.chatId);
        if (input.caption) form.set("caption", input.caption);
        if (input.parseMode) form.set("parse_mode", input.parseMode);
        form.set("photo", new Blob([new Uint8Array(input.photo)], { type: "image/png" }), "report.png");

        const response = await fetch(buildTelegramApiUrl(creds.botToken, "sendPhoto"), withTelegramRequestOptions({
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(TELEGRAM_PHOTO_TIMEOUT_MS),
        }, requestOptions));
        const body = await response.json().catch(() => null) as
          | { ok?: boolean; description?: string; result?: { message_id?: number } }
          | null;

        if (response.ok && body?.ok === true) {
          return {
            status: "sent",
            chatId: creds.chatId,
            messageId: typeof body.result?.message_id === "number" ? body.result.message_id : null,
          };
        }

        const error = friendlyTelegramError(response.status, body?.description ?? null);
        const canRetry = attemptNumber <= TELEGRAM_SEND_MAX_RETRIES
          && shouldRetryTelegramResponse(response.status);
        if (canRetry) {
          await delay(resolveRetryDelayMs(response.headers.get("retry-after"), attemptNumber));
          continue;
        }

        app.logger.warn({ chatId: creds.chatId, httpStatus: response.status, error }, "Telegram photo failed; continuing");
        return { status: "failed", error };
      } catch (error) {
        const described = describeTelegramFailure(error);
        const canRetry = attemptNumber <= TELEGRAM_SEND_MAX_RETRIES
          && (classifyTransportError(error) === "timeout" || classifyTransportError(error) === "transport");
        if (canRetry) {
          await delay(resolveRetryDelayMs(null, attemptNumber));
          continue;
        }

        app.logger.warn({ chatId: creds.chatId, error: described, err: error }, "Telegram photo failed; continuing");
        return { status: "failed", error: described };
      }
    }
  } finally {
    await closeTelegramRequestOptions(requestOptions);
  }

  return {
    status: "failed",
    error: "Telegram photo failed after exhausting retries",
  };
}

export async function sendTelegramTestMessage(
  app: Pick<AppContext, "config" | "logger" | "db">,
  now = new Date(),
) {
  return sendTelegramMessage(app, {
    text: [
      "✅ Agency Hub Core Telegram test",
      `UTC: ${now.toISOString()}`,
    ].join("\n"),
  });
}
