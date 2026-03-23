import { setTimeout as delay } from "node:timers/promises";

import { getTelegramSettings, type TelegramSettingsRow } from "@agency_hub_core/db";
import {
  classifyTransportError,
  decryptJsonWithKeyVersion,
  redactSensitiveText,
  resolveRetryDelayMs,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";

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

function buildTelegramSendMessageUrl(botToken: string) {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

function describeTelegramFailure(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function shouldRetryTelegramResponse(status: number) {
  return status === 429 || status >= 500;
}

export function resolveTelegramCredentials(
  app: Pick<AppContext, "config">,
  settings: TelegramSettingsRow,
): ResolvedTelegramCredentials | null {
  // DB credentials take priority over env vars
  if (settings.encryptedBotToken && settings.chatId) {
    try {
      const botToken = decryptJsonWithKeyVersion<string>(
        settings.encryptedBotToken,
        app.config.encryptionKeysByVersion,
      );
      return { botToken, chatId: settings.chatId };
    } catch {
      // decryption failed — fall through to env vars
    }
  }

  // Fall back to env vars
  if (app.config.telegramBotToken && app.config.telegramChatId) {
    return { botToken: app.config.telegramBotToken, chatId: app.config.telegramChatId };
  }

  return null;
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

  for (let attemptNumber = 1; attemptNumber <= TELEGRAM_SEND_MAX_RETRIES + 1; attemptNumber += 1) {
    try {
      const response = await fetch(buildTelegramSendMessageUrl(creds.botToken), {
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
      });
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

      const error = redactSensitiveText(
        body?.description ??
          `Telegram sendMessage failed with HTTP ${response.status}`,
      );
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

  return {
    status: "failed",
    error: "Telegram notification failed after exhausting retries",
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
