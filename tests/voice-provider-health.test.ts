import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@agency_hub_core/db";

import type * as IncidentsModule from "../apps/runtime/src/services/notification-incidents.ts";

type LatchCall = (app: unknown, input: Record<string, unknown>) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  open: vi.fn<LatchCall>(async () => true),
  resolve: vi.fn<LatchCall>(async () => undefined),
  loadEffectiveConfig: vi.fn(),
  resolveEgress: vi.fn(),
  recordVoiceProviderHealthCheck: vi.fn(async () => undefined),
  insertOpsMetricSamples: vi.fn(async () => undefined),
}));

vi.mock("../apps/runtime/src/services/notification-incidents.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof IncidentsModule>()),
  openCriticalNotificationIncident: mocks.open,
  resolveCriticalNotificationIncident: mocks.resolve,
}));
vi.mock("../apps/runtime/src/services/effective-config.ts", () => ({
  loadEffectiveConfig: mocks.loadEffectiveConfig,
}));
vi.mock("../apps/runtime/src/services/egress/resolver.ts", () => ({
  resolveEgress: mocks.resolveEgress,
}));
vi.mock("@agency_hub_core/db", async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  recordVoiceProviderHealthCheck: mocks.recordVoiceProviderHealthCheck,
  insertOpsMetricSamples: mocks.insertOpsMetricSamples,
}));

import type {
  VoiceAccountReading,
  VoiceAccountSubscription,
  VoiceTtsProvider,
} from "../apps/runtime/src/services/voice-elevenlabs-provider.ts";
import {
  reportVoiceProviderRenderRefusal,
  reportVoiceProviderRenderServed,
  runVoiceProviderHealthCheck,
  voiceCharacterThresholds,
} from "../apps/runtime/src/services/voice-provider-health.ts";

// The ElevenLabs account check and the render-time page: which latch opens,
// which resolves, and when nothing may move. The incident layer is mocked —
// its once-per-transition paging is its own tested law; this pins what the
// check and a refused render ask of it.

const KEY = "elevenlabs:key";
const REFUSED = "elevenlabs:refused";
const SUBSCRIPTION = "elevenlabs:subscription";
const OUT = "elevenlabs:characters_out";
const LOW = "elevenlabs:characters_low";
const NOW = new Date("2026-10-23T00:07:00.000Z");

/** Production today: 2 000 a day for all pages, 600-character scripts. */
const PRODUCTION_CONFIG = {
  voiceNotesEnabled: true,
  voiceNotesGlobalDailyCharBudget: 2_000,
  voiceNotesScriptMaxChars: 600,
};

function subscription(overrides: Partial<VoiceAccountSubscription> = {}): VoiceAccountReading {
  return {
    ok: true,
    subscription: {
      tier: "creator",
      status: "active",
      characterCount: 1_134,
      characterLimit: 131_000,
      nextResetAt: new Date("2026-10-29T02:17:49.000Z"),
      ...overrides,
    },
  };
}

function refused(input: Omit<Extract<VoiceAccountReading, { ok: false }>, "ok">): VoiceAccountReading {
  return { ok: false, ...input };
}

const close = vi.fn(async () => undefined);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function appWith(readAccount?: (input: { signal: AbortSignal }) => Promise<VoiceAccountReading>) {
  const provider: VoiceTtsProvider = {
    synthesize: vi.fn(),
    ...(readAccount ? { readAccount } : {}),
  };
  return {
    db: {},
    config: {},
    logger,
    voiceTtsProvider: provider,
  } as unknown as Parameters<typeof runVoiceProviderHealthCheck>[0];
}

function opened() {
  return mocks.open.mock.calls.map(([, input]) => (input as { subKey: string }).subKey);
}

function resolved() {
  return mocks.resolve.mock.calls.map(([, input]) => (input as { subKey: string }).subKey);
}

function openedWith(subKey: string) {
  const call = mocks.open.mock.calls.find(([, input]) => (input as { subKey: string }).subKey === subKey);
  return call?.[1] as { kind: string; errorCode: string; errorSummary: string; occurredAt: Date } | undefined;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockClear();
  }
  close.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  mocks.loadEffectiveConfig.mockResolvedValue(PRODUCTION_CONFIG);
  mocks.resolveEgress.mockResolvedValue({
    dispatcher: {},
    egressKey: "service:test",
    pace: async () => 0,
    close,
  });
});

describe("voiceCharacterThresholds", () => {
  it("is three days of the global budget, at most a quarter of the plan, never under one voice note", () => {
    expect(voiceCharacterThresholds({ scriptMaxChars: 600, globalDailyCharBudget: 2_000, characterLimit: 131_000 }))
      .toEqual({ outChars: 600, lowChars: 6_000 });
    expect(voiceCharacterThresholds({ scriptMaxChars: 600, globalDailyCharBudget: 20_000, characterLimit: 131_000 }))
      .toEqual({ outChars: 600, lowChars: 32_750 });
    expect(voiceCharacterThresholds({ scriptMaxChars: 600, globalDailyCharBudget: 100, characterLimit: 131_000 }))
      .toEqual({ outChars: 600, lowChars: 600 });
  });
});

describe("runVoiceProviderHealthCheck", () => {
  it("resolves every latch it can see on a healthy account, opens none, and closes its egress", async () => {
    const result = await runVoiceProviderHealthCheck(appWith(async () => subscription()), { now: NOW });

    expect(result).toMatchObject({ skipped: null, state: "healthy", charactersLeft: 129_866 });
    expect(opened()).toEqual([]);
    expect(resolved()).toEqual([KEY, SUBSCRIPTION, OUT, LOW]);
    // `refused` is the render's to close, never the check's.
    expect(resolved()).not.toContain(REFUSED);
    for (const [, input] of mocks.resolve.mock.calls) {
      expect(input).toMatchObject({ kind: "ai_provider_billing", platformAccountId: null, recoveredAt: NOW });
    }
    expect(mocks.recordVoiceProviderHealthCheck).toHaveBeenCalledWith({}, {
      state: "healthy",
      checkedAt: NOW,
      httpStatus: null,
      reading: {
        tier: "creator",
        subscriptionStatus: "active",
        characterCount: 1_134,
        characterLimit: 131_000,
        nextResetAt: new Date("2026-10-29T02:17:49.000Z"),
        lowThresholdChars: 6_000,
      },
    });
    expect(mocks.insertOpsMetricSamples).toHaveBeenCalledWith({}, [
      { metric: "vendor_elevenlabs_characters_used", quantile: "p95", valueMs: 1_134, sampledAt: NOW },
      { metric: "vendor_elevenlabs_characters_limit", quantile: "p95", valueMs: 131_000, sampledAt: NOW },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("pages characters running low once they are under three days of the budget", async () => {
    const result = await runVoiceProviderHealthCheck(
      appWith(async () => subscription({ characterCount: 125_200 })),
      { now: NOW },
    );

    expect(result).toMatchObject({ state: "characters_low", charactersLeft: 5_800 });
    expect(opened()).toEqual([LOW]);
    expect(resolved()).toEqual([KEY, SUBSCRIPTION, OUT]);
    expect(openedWith(LOW)).toMatchObject({
      kind: "ai_provider_billing",
      errorCode: "characters_low",
      errorSummary: "5,800 of 131,000 characters left (alert under 6,000); resets 2026-10-29 02:17 UTC.",
      occurredAt: NOW,
    });
  });

  it("pages out of characters as well when less than one voice note is left", async () => {
    const result = await runVoiceProviderHealthCheck(
      appWith(async () => subscription({ characterCount: 130_700 })),
      { now: NOW },
    );

    expect(result).toMatchObject({ state: "characters_out", charactersLeft: 300 });
    expect(opened()).toEqual([OUT, LOW]);
    expect(openedWith(OUT)?.errorSummary).toBe(
      "300 of 131,000 characters left, less than one voice note (600); resets 2026-10-29 02:17 UTC. "
        + "Top up or upgrade in ElevenLabs.",
    );
  });

  it("reads a count past the limit as nothing left", async () => {
    const result = await runVoiceProviderHealthCheck(
      appWith(async () => subscription({ characterCount: 140_000 })),
      { now: NOW },
    );

    expect(result).toMatchObject({ state: "characters_out", charactersLeft: 0 });
    expect(opened()).toEqual([OUT, LOW]);
  });

  it.each(["past_due", "incomplete", "free", "free_disabled"])("pages a %s subscription", async (status) => {
    const result = await runVoiceProviderHealthCheck(appWith(async () => subscription({ status })), { now: NOW });

    expect(result).toMatchObject({ state: "subscription_inactive" });
    expect(opened()).toEqual([SUBSCRIPTION]);
    expect(openedWith(SUBSCRIPTION)).toMatchObject({ errorCode: status });
    expect(openedWith(SUBSCRIPTION)?.errorSummary).toContain(`ElevenLabs subscription is ${status} (creator)`);
  });

  it("takes a trialing subscription as serving", async () => {
    await runVoiceProviderHealthCheck(appWith(async () => subscription({ status: "trialing" })), { now: NOW });

    expect(opened()).toEqual([]);
    expect(resolved()).toContain(SUBSCRIPTION);
  });

  it("pages a rejected key and leaves what it could not read untouched", async () => {
    const result = await runVoiceProviderHealthCheck(appWith(async () => refused({
      httpStatus: 401,
      failureKind: "http_4xx",
      refusal: "key_rejected",
      reason: "invalid_api_key",
    })), { now: NOW });

    expect(result).toMatchObject({ skipped: null, state: "key_rejected", httpStatus: 401 });
    expect(opened()).toEqual([KEY]);
    expect(resolved()).toEqual([]);
    expect(openedWith(KEY)).toMatchObject({
      errorCode: "invalid_api_key",
      errorSummary: "ElevenLabs answered the account check with HTTP 401 invalid_api_key: the key in "
        + "ELEVENLABS_API_KEY is not accepted. Replace it on the server and restart the runtime.",
    });
    expect(mocks.recordVoiceProviderHealthCheck).toHaveBeenCalledWith({}, {
      state: "key_rejected",
      checkedAt: NOW,
      httpStatus: 401,
      reading: null,
    });
    expect(mocks.insertOpsMetricSamples).not.toHaveBeenCalled();
  });

  it.each([
    ["no answer (network, egress, timeout)", 0, "timeout"],
    ["ElevenLabs down", 503, "http_5xx"],
    ["a rate limit", 429, "http_4xx"],
    ["an answer that is not a subscription", 200, "invalid_response"],
  ] as const)("moves no latch when the check itself fails: %s", async (_name, httpStatus, failureKind) => {
    const result = await runVoiceProviderHealthCheck(appWith(async () => refused({
      httpStatus,
      failureKind,
      refusal: null,
      reason: null,
    })), { now: NOW });

    expect(result).toMatchObject({ state: "check_failed", httpStatus });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.recordVoiceProviderHealthCheck).toHaveBeenCalledWith({}, {
      state: "check_failed",
      checkedAt: NOW,
      httpStatus,
      reading: null,
    });
    // Counts and codes only.
    expect(logger.warn).toHaveBeenCalledWith({
      component: "voice_provider_health",
      state: "check_failed",
      failureKind,
      providerStatus: httpStatus,
      reason: null,
    }, expect.any(String));
  });

  it("moves no latch when the egress cannot be resolved", async () => {
    mocks.resolveEgress.mockRejectedValueOnce(new Error("ElevenLabs egress requires the service proxy"));
    const readAccount = vi.fn(async () => subscription());

    const result = await runVoiceProviderHealthCheck(appWith(readAccount), { now: NOW });

    expect(result).toMatchObject({ state: "check_failed", httpStatus: 0 });
    expect(readAccount).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("moves no latch when the key may not read the account (no user_read)", async () => {
    const result = await runVoiceProviderHealthCheck(appWith(async () => refused({
      httpStatus: 401,
      failureKind: "http_4xx",
      refusal: "account_refused",
      reason: "missing_permissions",
    })), { now: NOW });

    expect(result).toMatchObject({ state: "unreadable", httpStatus: 401 });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("reads nothing and moves nothing while voice notes are off or without a provider", async () => {
    mocks.loadEffectiveConfig.mockResolvedValue({ ...PRODUCTION_CONFIG, voiceNotesEnabled: false });
    const readAccount = vi.fn(async () => subscription({ characterCount: 131_000 }));

    expect(await runVoiceProviderHealthCheck(appWith(readAccount), { now: NOW })).toEqual({ skipped: "disabled" });
    expect(await runVoiceProviderHealthCheck(appWith(), { now: NOW })).toEqual({ skipped: "no_provider" });

    expect(readAccount).not.toHaveBeenCalled();
    expect(mocks.resolveEgress).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.recordVoiceProviderHealthCheck).not.toHaveBeenCalled();
  });
});

describe("a render ElevenLabs refuses for the account", () => {
  it.each([
    ["out_of_characters", "quota_exceeded", OUT, "no characters left. Top up or upgrade in ElevenLabs, or wait for the reset."],
    ["key_rejected", "invalid_api_key", KEY, "the key in ELEVENLABS_API_KEY is not accepted. Replace it on the server and restart the runtime."],
    ["subscription_inactive", "paid_plan_required", SUBSCRIPTION, "the ElevenLabs plan does not allow it. Renew or upgrade the plan in ElevenLabs."],
    ["account_refused", "missing_permissions", REFUSED, "the key lacks a permission (text_to_speech) or ElevenLabs blocked the account. The next voice note that renders closes this."],
  ] as const)("pages %s at once, through the check's own latch", async (refusal, reason, subKey, action) => {
    const at = new Date("2026-10-23T00:20:00.000Z");
    await reportVoiceProviderRenderRefusal({ db: {} as never, logger }, {
      refusal,
      httpStatus: 401,
      reason,
      occurredAt: at,
    });

    expect(opened()).toEqual([subKey]);
    expect(resolved()).toEqual([]);
    expect(openedWith(subKey)).toMatchObject({
      kind: "ai_provider_billing",
      errorCode: reason,
      errorSummary: `A voice note was refused with HTTP 401 ${reason}: ${action}`,
      occurredAt: at,
    });
  });

  it("is closed for `refused` — and only `refused` — by the next voice note that renders", async () => {
    const at = new Date("2026-10-23T01:00:00.000Z");
    await reportVoiceProviderRenderServed({ db: {} as never, logger }, at);

    expect(resolved()).toEqual([REFUSED]);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recoveredAt: at }));
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
