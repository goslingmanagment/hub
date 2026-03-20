import { getTelegramSettings, type TelegramSettingsRow } from "@agency_hub_core/db";
import { decryptJson, redactSensitiveText } from "@agency_hub_core/shared";

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

function buildTelegramSendMessageUrl(botToken: string) {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

function describeTelegramFailure(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

export function resolveTelegramCredentials(
  app: Pick<AppContext, "config">,
  settings: TelegramSettingsRow,
): ResolvedTelegramCredentials | null {
  // DB credentials take priority over env vars
  if (settings.encryptedBotToken && settings.chatId) {
    try {
      const botToken = decryptJson<string>(settings.encryptedBotToken, app.config.encryptionKey);
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

  try {
    const response = await fetch(buildTelegramSendMessageUrl(creds.botToken), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: creds.chatId,
        text: input.text,
        disable_web_page_preview: true,
      }),
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

    if (!response.ok || body?.ok !== true) {
      const error = redactSensitiveText(
        body?.description ??
          `Telegram sendMessage failed with HTTP ${response.status}`,
      );
      app.logger.warn({
        chatId: creds.chatId,
        httpStatus: response.status,
        error,
      }, "Telegram notification failed; continuing");
      return {
        status: "failed",
        error,
      };
    }

    return {
      status: "sent",
      chatId: creds.chatId,
      messageId: typeof body.result?.message_id === "number" ? body.result.message_id : null,
    };
  } catch (error) {
    const described = describeTelegramFailure(error);
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
