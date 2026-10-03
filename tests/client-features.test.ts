import { describe, expect, it } from "vitest";

import {
  CLIENT_FEATURE_FLAG_NAMES,
  CLIENT_FEATURE_UNAVAILABLE_REASONS,
  CLIENT_HUB_CAPABILITY_NAMES,
} from "@agency_hub_core/contracts";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import {
  CLIENT_FEATURE_CODE_DEFAULTS,
  CLIENT_FEATURE_REQUIREMENTS,
  clientBootstrapFlags,
  evaluateClientFeature,
  evaluateClientPageFeatures,
  type ClientFeaturePage,
  type ClientFeatureSettings,
} from "../apps/runtime/src/services/client-features.ts";

const OF_PAGE: ClientFeaturePage = { label: "lora-of", platform: "onlyfans" };
const FANSLY_PAGE: ClientFeaturePage = { label: "lora-fansly", platform: "fansly" };
const EVERY_CAPABILITY: readonly string[] = CLIENT_HUB_CAPABILITY_NAMES;

describe("chat-extension feature evaluation", () => {
  it("has one requirement row per known flag, asking only for known capabilities", () => {
    expect(Object.keys(CLIENT_FEATURE_REQUIREMENTS).sort()).toEqual([...CLIENT_FEATURE_FLAG_NAMES].sort());
    for (const [flag, requirement] of Object.entries(CLIENT_FEATURE_REQUIREMENTS)) {
      for (const capability of requirement.capabilities) {
        expect(CLIENT_HUB_CAPABILITY_NAMES, flag).toContain(capability);
      }
    }
    for (const capability of SERVED_CLIENT_CAPABILITIES) {
      expect(CLIENT_HUB_CAPABILITY_NAMES).toContain(capability);
    }
  });

  it("with the code defaults every feature is off: disabled on OnlyFans, platform_unsupported on Fansly", () => {
    const served = SERVED_CLIENT_CAPABILITIES;
    const onlyFans = evaluateClientPageFeatures({ settings: CLIENT_FEATURE_CODE_DEFAULTS, page: OF_PAGE, served });
    const fansly = evaluateClientPageFeatures({ settings: CLIENT_FEATURE_CODE_DEFAULTS, page: FANSLY_PAGE, served });
    for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
      expect(onlyFans[flag], flag).toEqual({ available: false, reason: "disabled" });
      expect(fansly[flag], flag).toEqual({ available: false, reason: "platform_unsupported" });
    }
    expect(Object.values(clientBootstrapFlags(CLIENT_FEATURE_CODE_DEFAULTS))).toEqual(
      CLIENT_FEATURE_FLAG_NAMES.map(() => false),
    );
  });

  it("checks platform, master switch, the flag, then what the hub serves", () => {
    const on: ClientFeatureSettings = { enabled: true, features: { "*": { recap: true, coach: true } } };
    const evaluate = (settings: ClientFeatureSettings, page: ClientFeaturePage, served: readonly string[]) =>
      evaluateClientFeature({ settings, page, flag: "recap", served });

    expect(evaluate(on, FANSLY_PAGE, EVERY_CAPABILITY)).toEqual({ available: false, reason: "platform_unsupported" });
    expect(evaluate({ ...on, enabled: false }, OF_PAGE, EVERY_CAPABILITY)).toEqual({ available: false, reason: "disabled" });
    expect(evaluate({ enabled: true, features: {} }, OF_PAGE, EVERY_CAPABILITY)).toEqual({ available: false, reason: "flag_off" });
    expect(evaluate(on, OF_PAGE, ["shared-recaps-v1"])).toEqual({ available: false, reason: "hub_not_ready" });
    expect(evaluate(on, OF_PAGE, ["shared-recaps-v1", "recap-profile-v1"])).toEqual({ available: true });
    // A feature that needs nothing from the hub is available on the flag alone.
    expect(evaluateClientFeature({ settings: on, page: OF_PAGE, flag: "coach", served: [] })).toEqual({ available: true });
  });

  it("a page's own value wins over \"*\" both ways; unknown names are ignored", () => {
    const settings: ClientFeatureSettings = {
      enabled: true,
      features: {
        "*": { coach: true, review: false, someFutureFlag: true },
        "lora-of": { coach: false, review: true },
      },
    };
    const coach = (page: ClientFeaturePage) => evaluateClientFeature({ settings, page, flag: "coach", served: [] });
    const review = (page: ClientFeaturePage) => evaluateClientFeature({ settings, page, flag: "review", served: [] });
    const otherPage: ClientFeaturePage = { label: "lora-vip-of", platform: "onlyfans" };

    expect(coach(OF_PAGE)).toEqual({ available: false, reason: "flag_off" });
    expect(coach(otherPage)).toEqual({ available: true });
    expect(review(OF_PAGE)).toEqual({ available: true });
    expect(review(otherPage)).toEqual({ available: false, reason: "flag_off" });

    const flags = clientBootstrapFlags(settings);
    expect(flags.coach).toBe(true);
    expect(flags.review).toBe(false);
    expect(flags).not.toHaveProperty("someFutureFlag");
  });

  it("answers only reasons from the published vocabulary", () => {
    const reasons = new Set<string>();
    for (const settings of [CLIENT_FEATURE_CODE_DEFAULTS, { enabled: true, features: {} }, { enabled: true, features: { "*": { recap: true } } }]) {
      for (const page of [OF_PAGE, FANSLY_PAGE]) {
        for (const result of Object.values(evaluateClientPageFeatures({ settings, page, served: [] }))) {
          if (result.reason !== undefined) reasons.add(result.reason);
        }
      }
    }
    for (const reason of reasons) {
      expect(CLIENT_FEATURE_UNAVAILABLE_REASONS).toContain(reason);
    }
  });
});
