import { describe, expect, it } from "vitest";

import type { AppConfig } from "@agency_hub_core/shared";
import {
  applyBootOverrides,
  FANSLY_PAUSE_MAX_MS,
  FANSLY_PAUSE_MIN_MS,
  loadConfig,
  resolveEffectiveConfig,
  validateConfigOverride,
} from "@agency_hub_core/shared";

describe("validateConfigOverride", () => {
  describe("reject mode (the Fansly pause)", () => {
    it("accepts the bounds and in-range values unchanged", () => {
      expect(validateConfigOverride("fanslyDefaultDelayMs", FANSLY_PAUSE_MIN_MS)).toEqual({ ok: true, value: 2000 });
      expect(validateConfigOverride("fanslyDefaultDelayMs", 2500)).toEqual({ ok: true, value: 2500 });
      expect(validateConfigOverride("fanslyDefaultDelayMs", FANSLY_PAUSE_MAX_MS)).toEqual({ ok: true, value: 60_000 });
    });

    it("rejects a value below 2000 ms with the owner-rule message instead of clamping it", () => {
      for (const value of [0, 1, 1500, FANSLY_PAUSE_MIN_MS - 1]) {
        expect(validateConfigOverride("fanslyDefaultDelayMs", value), String(value)).toEqual({
          ok: false,
          error: "Пауза между запросами Fansly не может быть меньше 2000 мс: правило владельца — "
            + "не чаще одного запроса страницы раз в 2 с. Ниже — только правкой кода.",
        });
      }
    });

    it("rejects a value above 60000 ms as a likely typo", () => {
      for (const value of [FANSLY_PAUSE_MAX_MS + 1, 250_000]) {
        expect(validateConfigOverride("fanslyDefaultDelayMs", value), String(value)).toEqual({
          ok: false,
          error: "Пауза больше 60000 мс похожа на опечатку. Допустимо от 2000 до 60000 мс.",
        });
      }
    });
  });

  it("rejects a 'never' (secret/infra) key", () => {
    // databaseUrl is editability 'never' (secret).
    expect(validateConfigOverride("databaseUrl", "postgres://x").ok).toBe(false);
    // trustProxy is editability 'never'.
    expect(validateConfigOverride("trustProxy", "true").ok).toBe(false);
  });
});

describe("resolveEffectiveConfig", () => {
  it("never emits secret/never values (no raw secret can leak through it)", () => {
    const resolved = resolveEffectiveConfig(
      { databaseUrl: "postgres://secret", sessionTtlDays: 30 } as unknown as AppConfig,
      new Map(),
    );
    expect(resolved.values.databaseUrl).toBeUndefined();
    expect(resolved.values.trustProxy).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain("secret");
  });
});

describe("applyBootOverrides", () => {
  it("turns the AI gateway on from its stored row and passes over retired keys' rows", () => {
    const env = loadConfig({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    }, { loadDotEnv: false });
    expect(env.chatMuseAiGatewayEnabled).toBe(false);
    const applied = applyBootOverrides(env, new Map<string, { value: unknown }>([
      ["chatMuseAiGatewayEnabled", { value: true }],
      ["ofapiDmSyncEnabled", { value: true }],
    ]));
    expect(applied.config.chatMuseAiGatewayEnabled).toBe(true);
    expect(applied.skipped).toEqual([]);
  });
});
