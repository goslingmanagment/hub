import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { OFAPI_MIRROR_BUDGET_DEFAULTS } from "@agency_hub_core/shared";

const root = resolve(import.meta.dirname, "..");
const templates = [".env.example", ".env.docker.example", ".env.production.example"];

describe("retention defaults in env templates", () => {
  for (const template of templates) {
    it(`${template} keeps the fact-bearing OFAPI journal effectively forever`, () => {
      const text = readFileSync(resolve(root, template), "utf8");
      expect(text).toMatch(/^OFAPI_EVENT_RETENTION_DAYS=36500$/m);
      expect(text).not.toMatch(/^ONLYMONSTER_BASE_URL=/m);
    });
  }
});

describe("mirror budget defaults in env templates", () => {
  const expected = {
    OFAPI_MIRROR_GLOBAL_DAILY_CREDIT_BUDGET:
      OFAPI_MIRROR_BUDGET_DEFAULTS.globalDailyCreditBudget,
    OFAPI_MIRROR_PRINCIPAL_DAILY_CALL_CAP:
      OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCallCap,
    OFAPI_MIRROR_PRINCIPAL_DAILY_CREDIT_CAP:
      OFAPI_MIRROR_BUDGET_DEFAULTS.principalDailyCreditCap,
  };

  for (const template of [".env.example", ".env.production.example"]) {
    it(`${template} matches the runtime mirror budget defaults`, () => {
      const text = readFileSync(resolve(root, template), "utf8");
      for (const [envName, value] of Object.entries(expected)) {
        expect(text).toMatch(new RegExp(`^${envName}=${value}$`, "m"));
      }
    });
  }
});
