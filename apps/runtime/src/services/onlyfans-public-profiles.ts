import { setTimeout as delay } from "node:timers/promises";

import {
  buildProxyEgressKey,
  normalizeProxyConfigWithMetadata,
  type ProxyConfig,
} from "@agency_hub_core/shared";

const ONLYFANS_PUBLIC_PROFILE_BASE_URL = "https://onlyfans.com";
const ONLYFANS_PUBLIC_PROFILE_TIMEOUT_MS = 25_000;
const ONLYFANS_PUBLIC_PROFILE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

export type OnlyFansPublicProfileResolveStatus =
  | "resolved"
  | "not_found"
  | "unavailable"
  | "failed"
  | "rate_limited";

export type OnlyFansPublicProfileResolveResult =
  | {
    status: "resolved";
    platformUserId: string;
    username: string | null;
    displayName: string | null;
  }
  | {
    status: Exclude<OnlyFansPublicProfileResolveStatus, "resolved">;
    platformUserId: string;
    error: string | null;
  };

export interface OnlyFansPublicProfileResolver {
  resolve(platformUserId: string): Promise<OnlyFansPublicProfileResolveResult>;
  close?(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown, options?: { stripHandlePrefix?: boolean }) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return options?.stripHandlePrefix ? trimmed.replace(/^@+/, "") : trimmed;
}

function classifyHttpStatus(status: number): Exclude<OnlyFansPublicProfileResolveStatus, "resolved"> {
  if (status === 404) {
    return "not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 401 || status === 403) {
    return "unavailable";
  }
  return "failed";
}

function parseProfilePayload(
  platformUserId: string,
  payload: unknown,
): OnlyFansPublicProfileResolveResult {
  if (!isRecord(payload)) {
    return {
      status: "failed",
      platformUserId,
      error: "Profile response was not an object",
    };
  }

  const responseId = typeof payload.id === "number" ? String(payload.id) : normalizeText(payload.id);
  if (responseId !== platformUserId) {
    return {
      status: "failed",
      platformUserId,
      error: "Profile response id did not match requested fan id",
    };
  }

  return {
    status: "resolved",
    platformUserId,
    username: normalizeText(payload.username, { stripHandlePrefix: true }),
    displayName: normalizeText(payload.name),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildPlaywrightProxy(proxy: ProxyConfig) {
  const normalized = normalizeProxyConfigWithMetadata(proxy);
  return {
    server: normalized.url,
    ...(normalized.username !== null && normalized.username !== undefined
      ? { username: normalized.username }
      : {}),
    ...(normalized.password !== null && normalized.password !== undefined
      ? { password: normalized.password }
      : {}),
  };
}

async function loadPlaywrightChromium() {
  const packageName = "playwright";
  const playwright = await import(packageName) as {
    chromium: {
      launch(options: Record<string, unknown>): Promise<unknown>;
    };
  };
  return playwright.chromium;
}

export class PlaywrightOnlyFansPublicProfileResolver implements OnlyFansPublicProfileResolver {
  private browserPromise: Promise<unknown> | null = null;
  private closed = false;
  private lastResolveStartedAt: number | null = null;

  constructor(
    private readonly input: {
      proxy: ProxyConfig;
      delayMs: number;
    },
  ) {}

  async resolve(platformUserId: string): Promise<OnlyFansPublicProfileResolveResult> {
    if (this.closed) {
      throw new Error("OnlyFans public profile resolver is already closed");
    }

    await this.waitForSpacing();
    this.lastResolveStartedAt = Date.now();

    const browser = await this.getBrowser() as {
      newContext(options: Record<string, unknown>): Promise<{
        route(pattern: string, handler: (route: {
          request(): { resourceType(): string };
          abort(): Promise<void>;
          continue(): Promise<void>;
        }) => Promise<void>): Promise<void>;
        newPage(): Promise<{
          waitForResponse(
            predicate: (response: { url(): string }) => boolean,
            options: { timeout: number },
          ): Promise<{
            status(): number;
            json(): Promise<unknown>;
          }>;
          goto(url: string, options: { waitUntil: string; timeout: number }): Promise<unknown>;
          close(): Promise<void>;
        }>;
        close(): Promise<void>;
      }>;
    };
    const context = await browser.newContext({
      userAgent: ONLYFANS_PUBLIC_PROFILE_USER_AGENT,
      storageState: { cookies: [], origins: [] },
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      serviceWorkers: "block",
      locale: "en-US",
      timezoneId: "UTC",
    });

    try {
      await context.route("**/*", async (route) => {
        const resourceType = route.request().resourceType();
        if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
          await route.abort();
          return;
        }

        await route.continue();
      });

      const page = await context.newPage();
      const apiPath = `/api2/v2/users/u${platformUserId}`;
      const apiResponsePromise = page.waitForResponse(
        (response) => response.url().includes(apiPath),
        { timeout: ONLYFANS_PUBLIC_PROFILE_TIMEOUT_MS },
      ).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));

      try {
        await page.goto(`${ONLYFANS_PUBLIC_PROFILE_BASE_URL}/u${platformUserId}`, {
          waitUntil: "domcontentloaded",
          timeout: ONLYFANS_PUBLIC_PROFILE_TIMEOUT_MS,
        });
        const response = await apiResponsePromise;
        if (response instanceof Error) {
          throw response;
        }
        const status = response.status();
        if (status !== 200) {
          return {
            status: classifyHttpStatus(status),
            platformUserId,
            error: `OnlyFans public profile request returned HTTP ${status}`,
          };
        }

        return parseProfilePayload(platformUserId, await response.json());
      } catch (error) {
        return {
          status: "failed",
          platformUserId,
          error: errorMessage(error),
        };
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  async close() {
    this.closed = true;
    const browser = await this.browserPromise?.catch(() => null) as { close?: () => Promise<void> } | null;
    await browser?.close?.();
    this.browserPromise = null;
  }

  private async waitForSpacing() {
    if (this.lastResolveStartedAt === null) {
      return;
    }

    const waitMs = this.input.delayMs - (Date.now() - this.lastResolveStartedAt);
    if (waitMs > 0) {
      await delay(waitMs);
    }
  }

  private getBrowser() {
    if (!this.browserPromise) {
      this.browserPromise = this.launchBrowser();
    }

    return this.browserPromise;
  }

  private async launchBrowser() {
    const chromium = await loadPlaywrightChromium();
    return chromium.launch({
      headless: true,
      proxy: buildPlaywrightProxy(this.input.proxy),
      args: [
        "--disable-quic",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-extensions",
        "--disable-sync",
      ],
    });
  }
}

export function createOnlyFansPublicProfileResolver(input: {
  proxy: ProxyConfig;
  delayMs: number;
}) {
  return new PlaywrightOnlyFansPublicProfileResolver(input);
}

export function getOnlyFansPublicProfileEgressKey(proxy: ProxyConfig) {
  return buildProxyEgressKey(proxy);
}
