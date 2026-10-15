import { describe, expect, it } from "vitest";

import {
  BROWSER_ENV_MAX_LANGUAGES,
  BROWSER_ENV_TAG_SYNTAX,
  BROWSER_ENV_ZONE_SYNTAX,
  browserEnvProblem,
  languagesForCountry,
  proposeBrowserEnv,
  PROPOSED_ACCURACY_M,
} from "@agency_hub_core/shared";

import { MAX_LANGUAGES, TAG_SYNTAX, validateEnv, ZONE_SYNTAX } from "../apps/page-browser/src/env/rules.ts";

// A page's browser environment proposed from where its proxy goes out
// (Project Browser, owner decision 2026-10-15), as antidetect browsers do:
// the exit's time zone, the country's languages, its coordinates — and the
// owner's edits checked by the operator's own rules before he saves them.

describe("the environment proposed from the proxy's exit", () => {
  it("the exit's zone and place, the country's languages with English after", () => {
    expect(proposeBrowserEnv({ countryCode: "DE", timeZone: "Europe/Berlin", latitude: 52.520_08, longitude: 13.404_954 })).toEqual({
      timeZone: "Europe/Berlin",
      languages: ["de-DE", "de", "en-US", "en"],
      geolocation: { latitude: 52.5201, longitude: 13.405, accuracyM: PROPOSED_ACCURACY_M },
    });
    expect(languagesForCountry("US")).toEqual(["en-US", "en"]);
    expect(languagesForCountry("gb")).toEqual(["en-GB", "en", "en-US"]);
    expect(languagesForCountry("NO")).toEqual(["nb-NO", "nb", "en-US", "en"]);
    expect(languagesForCountry("TW")).toEqual(["zh-TW", "zh", "en-US", "en"]);
    // A country not in the table, or none: English (US).
    expect(languagesForCountry("AQ")).toEqual(["en-US", "en"]);
    expect(languagesForCountry(null)).toEqual(["en-US", "en"]);
  });

  it("nothing proposed without a zone Chrome knows or a position: the owner fills them in", () => {
    expect(proposeBrowserEnv({ countryCode: "DE", timeZone: null, latitude: 52.5, longitude: 13.4 })).toBeNull();
    expect(proposeBrowserEnv({ countryCode: "DE", timeZone: "Mars/Olympus", latitude: 52.5, longitude: 13.4 })).toBeNull();
    expect(proposeBrowserEnv({ countryCode: "DE", timeZone: "Europe/Berlin", latitude: null, longitude: 13.4 })).toBeNull();
  });

  it("every proposal passes the operator's own check (env/rules.ts)", () => {
    for (const countryCode of ["US", "GB", "DE", "FR", "ES", "MX", "BR", "PT", "RU", "UA", "PL", "NL", "SE", "NO", "JP", "KR", "CN", "TW", "HK", "IL", "AE", "IN", "TR", "ZZ"]) {
      const env = proposeBrowserEnv({ countryCode, timeZone: "Europe/Amsterdam", latitude: 1.5, longitude: -2.25 });
      expect(env, countryCode).not.toBeNull();
      expect(() => validateEnv(env), countryCode).not.toThrow();
    }
  });

  it("the owner's edits are checked by the operator's syntax, in the owner's words", () => {
    expect(BROWSER_ENV_ZONE_SYNTAX).toBe(ZONE_SYNTAX);
    expect(BROWSER_ENV_TAG_SYNTAX).toBe(TAG_SYNTAX);
    expect(BROWSER_ENV_MAX_LANGUAGES).toBe(MAX_LANGUAGES);
    const env = { timeZone: "Europe/Berlin", languages: ["de-DE", "de"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 1000 } };
    expect(browserEnvProblem(env)).toBeNull();
    expect(browserEnvProblem({ ...env, timeZone: "+03:00" })).toMatch(/часового пояса/);
    expect(browserEnvProblem({ ...env, languages: ["de_DE"] })).toMatch(/не код языка/);
    expect(browserEnvProblem({ ...env, languages: ["de-de"] })).toMatch(/не код языка/);
    expect(browserEnvProblem({ ...env, languages: ["de", "de"] })).toMatch(/повторяется/);
    expect(browserEnvProblem({ ...env, geolocation: { ...env.geolocation, latitude: 91 } })).toMatch(/Широта/);
    expect(browserEnvProblem({ ...env, geolocation: { ...env.geolocation, accuracyM: 0 } })).toMatch(/Точность/);
  });
});
