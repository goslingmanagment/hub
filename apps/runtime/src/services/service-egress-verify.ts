import { getTelegramSettings } from "@agency_hub_core/db";
import {
  formatMaskedProxyUrl,
  formatObservedError,
  redactSensitiveText,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { fetchWithEgress } from "./egress/fetch.ts";
import { resolveEgress } from "./egress/resolver.ts";
import { resolveServiceEgressProxy } from "./egress/service-proxy.ts";
import { resolveTelegramBotToken } from "./telegram.ts";

const EXIT_IP_URL = "https://api.ipify.org?format=json";
const ELEVENLABS_SUBSCRIPTION_URL = "https://api.elevenlabs.io/v1/user/subscription";
const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_ERROR_MAX_CHARS = 512;

export type ServiceEgressConsumer = "elevenlabs" | "telegram";
export type ServiceEgressConsumerSelection = ServiceEgressConsumer | "all";

export interface ServiceEgressVerification {
  consumer: ServiceEgressConsumer;
  route: string;
  egressKey: string;
  exitIp: string;
}

export class ServiceEgressVerificationError extends Error {
  override name = "ServiceEgressVerificationError";
}

export async function verifyServiceEgress(
  app: AppContext,
  selection: ServiceEgressConsumerSelection,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<ServiceEgressVerification[]> {
  const consumers: ServiceEgressConsumer[] = selection === "all"
    ? ["elevenlabs", "telegram"]
    : [selection];
  const results: ServiceEgressVerification[] = [];

  for (const consumer of consumers) {
    results.push(await verifyConsumer(app, consumer, fetchImpl));
  }

  if (
    selection === "all"
    && results[0]?.egressKey !== results[1]?.egressKey
  ) {
    throw new ServiceEgressVerificationError(
      "Service consumers resolved different egress identities",
    );
  }

  return results;
}

async function verifyConsumer(
  app: AppContext,
  consumer: ServiceEgressConsumer,
  fetchImpl: typeof fetch,
): Promise<ServiceEgressVerification> {
  const egress = await resolveEgress(app, { kind: "vendor", vendor: consumer });
  try {
    if (!egress.dispatcher) {
      throw new Error(`${consumer} resolved without a dispatcher`);
    }

    const exitIp = await verifyExitIp(fetchImpl, egress.dispatcher);
    if (consumer === "elevenlabs") {
      await verifyElevenLabs(app, fetchImpl, egress.dispatcher);
    } else {
      await verifyTelegram(app, fetchImpl, egress.dispatcher);
    }

    const proxy = resolveServiceEgressProxy(app.config);
    return {
      consumer,
      route: proxy ? formatMaskedProxyUrl(proxy) : "legacy-page (deprecated)",
      egressKey: egress.egressKey,
      exitIp,
    };
  } catch (error) {
    throw new ServiceEgressVerificationError(
      `${consumer} verification failed: ${sanitizeVerificationError(app, error)}`,
    );
  } finally {
    await egress.close().catch(() => undefined);
  }
}

async function verifyExitIp(
  fetchImpl: typeof fetch,
  dispatcher: NonNullable<Awaited<ReturnType<typeof resolveEgress>>["dispatcher"]>,
) {
  const response = await fetchWithEgress(fetchImpl, dispatcher, EXIT_IP_URL, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(`exit-IP probe returned HTTP ${response.status}`);
  }
  const payload = await response.json() as { ip?: unknown };
  if (typeof payload.ip !== "string" || payload.ip.trim().length === 0) {
    throw new Error("exit-IP probe returned invalid JSON");
  }
  return payload.ip;
}

async function verifyElevenLabs(
  app: AppContext,
  fetchImpl: typeof fetch,
  dispatcher: NonNullable<Awaited<ReturnType<typeof resolveEgress>>["dispatcher"]>,
) {
  const apiKey = app.config.elevenLabsApiKey;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not configured");
  }

  const response = await fetchWithEgress(
    fetchImpl,
    dispatcher,
    ELEVENLABS_SUBSCRIPTION_URL,
    {
      method: "GET",
      headers: { "xi-api-key": apiKey },
      redirect: "error",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    },
  );
  if (response.status !== 200) {
    throw new Error(`ElevenLabs subscription probe returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ElevenLabs subscription probe returned invalid JSON");
  }
}

async function verifyTelegram(
  app: AppContext,
  fetchImpl: typeof fetch,
  dispatcher: NonNullable<Awaited<ReturnType<typeof resolveEgress>>["dispatcher"]>,
) {
  const settings = await getTelegramSettings(app.db, {
    defaultReportHourUtc: app.config.telegramReportHourUtc,
  });
  const botToken = resolveTelegramBotToken(app, settings);
  if (!botToken) {
    throw new Error("Telegram bot token is not configured");
  }

  const response = await fetchWithEgress(
    fetchImpl,
    dispatcher,
    `https://api.telegram.org/bot${botToken}/getMe`,
    {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    },
  );
  const payload = await response.json().catch(() => null) as { ok?: unknown } | null;
  if (response.status !== 200 || payload?.ok !== true) {
    throw new Error(`Telegram getMe probe returned HTTP ${response.status}`);
  }
}

function sanitizeVerificationError(app: AppContext, error: unknown) {
  let detail = redactSensitiveText(formatObservedError(error));
  const knownSecrets = [
    app.config.elevenLabsApiKey,
    app.config.telegramBotToken,
    app.config.serviceEgressProxyUsername,
    app.config.serviceEgressProxyPassword,
  ];
  for (const secret of knownSecrets) {
    if (secret) {
      detail = detail.replaceAll(secret, "[REDACTED]");
    }
  }
  return detail.slice(0, VERIFY_ERROR_MAX_CHARS);
}
