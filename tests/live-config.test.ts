import { describe, expect, it } from "vitest";

import {
  assertLiveEditableConfigKey,
  buildLiveConfigAuditNote,
  parseLiveConfigCliValue,
  validateLiveConfigPatches,
} from "../apps/runtime/src/services/live-config.ts";
import { BadRequestError } from "../apps/runtime/src/services/errors.ts";

// The pure half of the live config write path shared by PATCH /api/v1/admin/config and
// the audited CLI (`config set|clear|get`). The DB half is covered by
// admin-config-update-api.integration.test.ts and cli-config.integration.test.ts.

function rejection(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestError);
    return (error as Error).message;
  }
  throw new Error("expected a rejection");
}

describe("validateLiveConfigPatches", () => {
  it("returns the validated value and keeps the optimistic lock only when given", () => {
    expect(validateLiveConfigPatches([{ key: "fanslyDefaultDelayMs", value: 2000 }])).toEqual([
      { key: "fanslyDefaultDelayMs", value: 2000 },
    ]);
    expect(validateLiveConfigPatches([{ key: "fanslyDefaultDelayMs", value: 2500, expectedVersion: 3 }])).toEqual([
      { key: "fanslyDefaultDelayMs", value: 2500, expectedVersion: 3 },
    ]);
  });

  it("rejects the whole patch with the owner-rule message for a Fansly pause below 2000 ms", () => {
    expect(rejection(() => validateLiveConfigPatches([
      { key: "healthSyncLightMaxAgeMinutes", value: 14 },
      { key: "fanslyDefaultDelayMs", value: 1500 },
    ]))).toBe(
      "Пауза между запросами Fansly не может быть меньше 2000 мс: правило владельца — "
        + "не чаще одного запроса страницы раз в 2 с. Ниже — только правкой кода.",
    );
    expect(rejection(() => validateLiveConfigPatches([{ key: "fanslyDefaultDelayMs", value: 60_001 }])))
      .toBe("Пауза больше 60000 мс похожа на опечатку. Допустимо от 2000 до 60000 мс.");
  });

  it("still clamps a clamp-mode key", () => {
    expect(validateLiveConfigPatches([{ key: "healthSyncLightMaxAgeMinutes", value: -5 }])).toEqual([
      { key: "healthSyncLightMaxAgeMinutes", value: 1 },
    ]);
  });

  it("rejects a duplicate key, a non-live key and an unknown key", () => {
    expect(rejection(() => validateLiveConfigPatches([
      { key: "fanslyDefaultDelayMs", value: 2000 },
      { key: "fanslyDefaultDelayMs", value: 2500 },
    ]))).toBe("A patch may not set the same key twice");
    // Editable but not wired live: the runtime would not apply it without a restart.
    expect(rejection(() => validateLiveConfigPatches([{ key: "fanslyDmMessagesDelayMs", value: 7500 }])))
      .toBe("Config key is not runtime-editable: fanslyDmMessagesDelayMs");
    expect(rejection(() => validateLiveConfigPatches([{ key: "databaseUrl", value: "postgres://x" }])))
      .toBe("Config key is not runtime-editable: databaseUrl");
    expect(rejection(() => assertLiveEditableConfigKey("noSuchKey")))
      .toBe("Config key is not runtime-editable: noSuchKey");
  });

  it("pins the transition hook of a staged-mode key", () => {
    const [patch] = validateLiveConfigPatches([{ key: "captureCasReadMode", value: "serve" }]);
    expect(patch).toMatchObject({ key: "captureCasReadMode", value: "serve" });
    const hook = (patch as { validateTransition?: (current: string | null) => string | null }).validateTransition;
    expect(hook).toBeTypeOf("function");
    expect(hook!(null)).toContain("one mode at a time");
  });
});

describe("buildLiveConfigAuditNote", () => {
  it("folds the registry cost warning of the Fansly pause into the audit note", () => {
    expect(buildLiveConfigAuditNote(["fanslyDefaultDelayMs"], "[cli] plan step 5")).toBe(
      "[cli] plan step 5 [cost-warnings] fanslyDefaultDelayMs: "
        + "Lowering reduces politeness against Fansly's unofficial API; raises ban/throttle risk.",
    );
  });

  it("keeps the note as is for a key without a cost warning", () => {
    expect(buildLiveConfigAuditNote(["accountLinksEnabled"], "why")).toBe("why");
    expect(buildLiveConfigAuditNote(["accountLinksEnabled"], undefined)).toBeUndefined();
  });
});

describe("parseLiveConfigCliValue", () => {
  it("parses by the descriptor kind and leaves anything else for the validator to reject", () => {
    expect(parseLiveConfigCliValue("fanslyDefaultDelayMs", "2000")).toBe(2000);
    expect(parseLiveConfigCliValue("fanslyDefaultDelayMs", " 2500 ")).toBe(2500);
    expect(parseLiveConfigCliValue("fanslyDefaultDelayMs", "2000.5")).toBe(2000.5);
    expect(parseLiveConfigCliValue("fanslyDefaultDelayMs", "2s")).toBe("2s");
    expect(parseLiveConfigCliValue("fanslyDefaultDelayMs", "")).toBe("");
    expect(parseLiveConfigCliValue("accountLinksEnabled", "true")).toBe(true);
    expect(parseLiveConfigCliValue("accountLinksEnabled", "false")).toBe(false);
    expect(parseLiveConfigCliValue("accountLinksEnabled", "yes")).toBe("yes");
    expect(parseLiveConfigCliValue("fanslyDmHeadCatchupPageAllowlist", "lora-1")).toBe("lora-1");
    expect(parseLiveConfigCliValue("noSuchKey", "1")).toBe("1");
  });

  it("feeds the same validator, so a CLI typo gets the console's message", () => {
    expect(rejection(() => validateLiveConfigPatches([
      { key: "fanslyDefaultDelayMs", value: parseLiveConfigCliValue("fanslyDefaultDelayMs", "2s") },
    ]))).toBe("fanslyDefaultDelayMs expects a finite number");
    expect(rejection(() => validateLiveConfigPatches([
      { key: "fanslyDefaultDelayMs", value: parseLiveConfigCliValue("fanslyDefaultDelayMs", "1999") },
    ]))).toContain("не может быть меньше 2000 мс");
  });
});
