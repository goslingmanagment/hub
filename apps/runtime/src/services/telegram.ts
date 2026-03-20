import { redactSensitiveText } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";

export type TelegramSendResult =
  | {
    status: "skipped";
    reason: "unconfigured";
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

function buildTelegramSendMessageUrl(botToken: string) {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

function describeTelegramFailure(error: unknown) {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function isTelegramConfigured(app: Pick<AppContext, "config">) {
  return app.config.telegramEnabled;
}

export async function sendTelegramMessage(
  app: Pick<AppContext, "config" | "logger">,
  input: {
    text: string;
  },
): Promise<TelegramSendResult> {
  if (!isTelegramConfigured(app)) {
    return {
      status: "skipped",
      reason: "unconfigured",
    };
  }

  try {
    const response = await fetch(buildTelegramSendMessageUrl(app.config.telegramBotToken!), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: app.config.telegramChatId,
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
        chatId: app.config.telegramChatId,
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
      chatId: app.config.telegramChatId!,
      messageId: typeof body.result?.message_id === "number" ? body.result.message_id : null,
    };
  } catch (error) {
    const described = describeTelegramFailure(error);
    app.logger.warn({
      chatId: app.config.telegramChatId,
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
  app: Pick<AppContext, "config" | "logger">,
  now = new Date(),
) {
  return sendTelegramMessage(app, {
    text: [
      "✅ Agency Hub Core Telegram test",
      `UTC: ${now.toISOString()}`,
    ].join("\n"),
  });
}
