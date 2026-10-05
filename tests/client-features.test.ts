import { describe, expect, it } from "vitest";

import {
  CLIENT_FEATURE_FLAG_NAMES,
  CLIENT_FEATURE_UNAVAILABLE_REASONS,
  CLIENT_HUB_CAPABILITY_NAMES,
  clientBootstrapResponseSchema,
} from "@agency_hub_core/contracts";
import { getDescriptor, loadConfig } from "@agency_hub_core/shared";

import {
  CLIENT_HEALTH_CAPABILITY,
  clientBootstrapCapabilities,
  SERVED_CLIENT_CAPABILITIES,
} from "../apps/runtime/src/services/client-capabilities.ts";
import {
  CLIENT_FEATURE_CODE_DEFAULTS,
  CLIENT_FEATURE_REQUIREMENTS,
  clientBootstrapFlags,
  clientVersionRefusal,
  evaluateClientFeature,
  evaluateClientPageFeatures,
  hostBindingFitsPlatform,
  type ClientFeaturePage,
  type ClientFeatureSettings,
} from "../apps/runtime/src/services/client-features.ts";
import { CLIENT_BOOTSTRAP_LIMITS } from "../apps/runtime/src/services/client-limits.ts";
import {
  CLIENT_BOOTSTRAP_CONFIG_KEYS,
  readClientSwitches,
  storedClientSwitchProblems,
} from "../apps/runtime/src/services/client-switches.ts";

const OF_PAGE: ClientFeaturePage = { label: "lora-of", platform: "onlyfans", platformAccountId: "100000001" };
const FANSLY_PAGE: ClientFeaturePage = { label: "lora-fansly", platform: "fansly", platformAccountId: null };
/** An OnlyFans page whose platform account id is not known. */
const UNBOUND_OF_PAGE: ClientFeaturePage = { label: "nova-of", platform: "onlyfans", platformAccountId: null };
const EVERY_CAPABILITY: readonly string[] = CLIENT_HUB_CAPABILITY_NAMES;
const NO_BINDINGS = {};

function settings(input: Partial<ClientFeatureSettings>): ClientFeatureSettings {
  return { enabled: true, features: {}, hostBindings: NO_BINDINGS, ...input };
}

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

  it("checks platform, master switch, the flag, the binding, then what the hub serves", () => {
    const on = settings({ features: { "*": { recap: true, coach: true } } });
    const evaluate = (input: ClientFeatureSettings, page: ClientFeaturePage, served: readonly string[]) =>
      evaluateClientFeature({ settings: input, page, flag: "recap", served });

    expect(evaluate(on, FANSLY_PAGE, EVERY_CAPABILITY)).toEqual({ available: false, reason: "platform_unsupported" });
    expect(evaluate({ ...on, enabled: false }, OF_PAGE, EVERY_CAPABILITY)).toEqual({ available: false, reason: "disabled" });
    expect(evaluate(settings({}), OF_PAGE, EVERY_CAPABILITY)).toEqual({ available: false, reason: "flag_off" });
    expect(evaluate(on, UNBOUND_OF_PAGE, EVERY_CAPABILITY)).toEqual({ available: false, reason: "binding_missing" });
    // A feature the hub does not serve yet: the owner's switch alone cannot turn it on.
    expect(evaluate(on, OF_PAGE, [])).toEqual({ available: false, reason: "hub_not_ready" });
    expect(evaluate(on, OF_PAGE, ["shared-recaps-v1"])).toEqual({ available: false, reason: "hub_not_ready" });
    expect(evaluate(on, OF_PAGE, ["shared-recaps-v1", "recap-profile-v1"])).toEqual({ available: true });
    // A feature that needs nothing from the hub is available on the flag alone.
    expect(evaluateClientFeature({ settings: on, page: OF_PAGE, flag: "coach", served: [] })).toEqual({ available: true });
  });

  it("an explicit owner binding makes a page without a platform account id bindable", () => {
    const coach = (input: ClientFeatureSettings) =>
      evaluateClientFeature({ settings: input, page: UNBOUND_OF_PAGE, flag: "coach", served: [] });
    const on = settings({ features: { "*": { coach: true } } });

    expect(coach(on)).toEqual({ available: false, reason: "binding_missing" });
    expect(coach({ ...on, hostBindings: { "onlymonster:36410": "nova-of" } })).toEqual({ available: true });
    // A binding to another page does not help this one.
    expect(coach({ ...on, hostBindings: { "onlymonster:36410": "lora-of" } }))
      .toEqual({ available: false, reason: "binding_missing" });
    // Nor does a binding from a host whose accounts are not OnlyFans accounts.
    expect(coach({ ...on, hostBindings: { "otherhost:36410": "nova-of" } }))
      .toEqual({ available: false, reason: "binding_missing" });
  });

  it("a host binding fits only a page of a platform the host holds accounts of", () => {
    expect(hostBindingFitsPlatform("onlymonster:36408", "onlyfans")).toBe(true);
    // An OnlyMonster account is an OnlyFans account, never a Fansly page.
    expect(hostBindingFitsPlatform("onlymonster:36408", "fansly")).toBe(false);
    // A host the hub does not know binds nothing, prototype names included.
    for (const host of ["otherhost:1", "constructor:1", "__proto__:1", "toString:1"]) {
      expect(hostBindingFitsPlatform(host, "onlyfans"), host).toBe(false);
    }
  });

  it("a page's own value wins over \"*\" both ways; unknown names are ignored", () => {
    const input = settings({
      features: {
        "*": { coach: true, review: false, someFutureFlag: true },
        "lora-of": { coach: false, review: true },
      },
    });
    const coach = (page: ClientFeaturePage) => evaluateClientFeature({ settings: input, page, flag: "coach", served: [] });
    const review = (page: ClientFeaturePage) => evaluateClientFeature({ settings: input, page, flag: "review", served: [] });
    const otherPage: ClientFeaturePage = { label: "lora-vip-of", platform: "onlyfans", platformAccountId: "100000002" };

    expect(coach(OF_PAGE)).toEqual({ available: false, reason: "flag_off" });
    expect(coach(otherPage)).toEqual({ available: true });
    expect(review(OF_PAGE)).toEqual({ available: true });
    expect(review(otherPage)).toEqual({ available: false, reason: "flag_off" });

    const flags = clientBootstrapFlags(input);
    expect(flags.coach).toBe(true);
    expect(flags.review).toBe(false);
    expect(flags).not.toHaveProperty("someFutureFlag");
    expect(clientBootstrapFlags({ ...input, enabled: false }).coach).toBe(false);
  });

  it("answers only reasons from the published vocabulary", () => {
    const reasons = new Set<string>();
    for (const input of [
      CLIENT_FEATURE_CODE_DEFAULTS,
      settings({}),
      settings({ features: { "*": { recap: true, coach: true } } }),
    ]) {
      for (const page of [OF_PAGE, FANSLY_PAGE, UNBOUND_OF_PAGE]) {
        for (const result of Object.values(evaluateClientPageFeatures({ settings: input, page, served: [] }))) {
          if (result.reason !== undefined) reasons.add(result.reason);
        }
      }
    }
    reasons.add(clientVersionRefusal("1.0.0", undefined)!);
    for (const reason of reasons) {
      expect(CLIENT_FEATURE_UNAVAILABLE_REASONS).toContain(reason);
    }
  });
});

describe("chat-extension version check (critic 6)", () => {
  it("passes chat-extension/<version> at or above the minimum", () => {
    expect(clientVersionRefusal("0.0.0", "chat-extension/0.0.0")).toBeNull();
    expect(clientVersionRefusal("1.4.0", "chat-extension/1.4.0")).toBeNull();
    expect(clientVersionRefusal("1.4.0", "chat-extension/1.4.1")).toBeNull();
    expect(clientVersionRefusal("1.4.0", "chat-extension/1.10.0")).toBeNull();
    expect(clientVersionRefusal("1.4.0", "chat-extension/2.0.0")).toBeNull();
  });

  it("refuses a lower version as client_outdated, comparing numerically", () => {
    expect(clientVersionRefusal("1.4.0", "chat-extension/1.3.9")).toBe("client_outdated");
    expect(clientVersionRefusal("1.10.0", "chat-extension/1.9.9")).toBe("client_outdated");
    expect(clientVersionRefusal("2.0.0", "chat-extension/1.99.99")).toBe("client_outdated");
  });

  it("refuses an unreadable version even with no minimum set", () => {
    for (const header of [
      undefined,
      "",
      "chat-extension/",
      "chat-extension/1.4",
      "chat-extension/1.4.0.1",
      "chat-extension/01.4.0",
      "chat-extension/1.4.0-beta",
      " chat-extension/1.4.0",
      "Chat-Extension/1.4.0",
      // Another client's version is not the extension's.
      "chatgoose-extension/2.7.1",
      "0.1.64",
      ["chat-extension/1.4.0", "chat-extension/1.4.0"],
    ]) {
      expect(clientVersionRefusal("0.0.0", header), JSON.stringify(header)).toBe("client_outdated");
    }
  });

  it("an unreadable minimum fails closed", () => {
    expect(clientVersionRefusal("latest", "chat-extension/9.9.9")).toBe("client_outdated");
  });
});

describe("chat-extension switches from the effective config", () => {
  it("rest off: the environment defaults are every switch off", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      APP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    } as unknown as NodeJS.ProcessEnv, { loadDotEnv: false });
    const { switches, problems } = readClientSwitches(config);

    expect(problems).toEqual([]);
    expect(switches).toEqual({
      settings: { enabled: false, features: {}, hostBindings: {} },
      minVersion: "0.0.0",
      receiptProfiles: [],
      healthIngestEnabled: false,
    });
    // A config without the keys at all (an older process shape) reads the same.
    expect(readClientSwitches({}).switches).toEqual(switches);
  });

  it("reads the owner's values", () => {
    const profile = { id: "om-2026-10", adapterVersion: "1.0.0", modules: { send: "sha256:ab12" } };
    const { switches, problems } = readClientSwitches({
      chatExtensionEnabled: true,
      chatExtensionFeatures: JSON.stringify({ "*": { coach: true }, "lora-of": { coach: false, futureFlag: true } }),
      chatExtensionMinVersion: " 1.4.0 ",
      chatExtensionHostBindings: JSON.stringify({ "onlymonster:36408": "lora-vip-of" }),
      chatExtensionPreviewSendReceiptProfiles: JSON.stringify([profile]),
    });

    expect(problems).toEqual([]);
    expect(switches).toEqual({
      settings: {
        enabled: true,
        features: { "*": { coach: true }, "lora-of": { coach: false, futureFlag: true } },
        hostBindings: { "onlymonster:36408": "lora-vip-of" },
      },
      minVersion: "1.4.0",
      receiptProfiles: [profile],
      healthIngestEnabled: false,
    });
    // The receipt profiles are exactly what the bootstrap's limits carry.
    expect(clientBootstrapResponseSchema.shape.limits.parse({
      ...CLIENT_BOOTSTRAP_LIMITS,
      previewSendReceiptProfiles: switches.receiptProfiles,
    }).previewSendReceiptProfiles).toEqual([profile]);
  });

  it("a broken value turns the whole extension off and is reported, never half-read", () => {
    const broken = [
      { chatExtensionFeatures: "{\"*\": {\"coach\": true}" },
      { chatExtensionFeatures: "{\"*\": {\"coach\": \"yes\"}}" },
      { chatExtensionMinVersion: "1.4" },
      { chatExtensionHostBindings: "[\"lora-of\"]" },
      { chatExtensionPreviewSendReceiptProfiles: "{}" },
    ];
    for (const value of broken) {
      const { switches, problems } = readClientSwitches({
        chatExtensionEnabled: true,
        chatExtensionFeatures: JSON.stringify({ "*": { coach: true } }),
        ...value,
      });
      const [key] = Object.keys(value);
      expect(problems.map((problem) => problem.key), key).toEqual([key]);
      expect(switches.settings.enabled, key).toBe(false);
      expect(evaluateClientFeature({ settings: switches.settings, page: OF_PAGE, flag: "coach", served: [] }), key)
        .toEqual({ available: false, reason: "disabled" });
    }
  });

  it("a stored override that no longer validates turns the extension off, never falls back to the environment", () => {
    const overrides = new Map<string, { value: unknown }>([
      ["chatExtensionEnabled", { value: true }],
      // Written past the write check (a hand-made SQL fix, a stricter parser later).
      ["chatExtensionMinVersion", { value: "1.4" }],
      // Another subsystem's broken row is not the switches' concern.
      ["sessionTtlDays", { value: "thirty" }],
    ]);
    const stored = storedClientSwitchProblems(overrides);
    expect(stored).toEqual([{ key: "chatExtensionMinVersion", error: expect.stringMatching(/^the stored override is refused: chatExtensionMinVersion: the value must read MAJOR\.MINOR\.PATCH/) }]);

    // The live overlay skipped the bad row, so the effective config carries a
    // readable environment minimum: it must not be served in its place.
    const { switches, problems } = readClientSwitches({
      chatExtensionEnabled: true,
      chatExtensionFeatures: JSON.stringify({ "*": { coach: true } }),
      chatExtensionMinVersion: "1.3.0",
    }, stored);
    expect(problems).toEqual(stored);
    expect(switches.settings.enabled).toBe(false);
    expect(switches.minVersion).toBe("0.0.0");
    expect(evaluateClientFeature({ settings: switches.settings, page: OF_PAGE, flag: "coach", served: [] }))
      .toEqual({ available: false, reason: "disabled" });

    // A broken stored master switch cannot let the environment's `true` through either.
    const master = storedClientSwitchProblems(new Map([["chatExtensionEnabled", { value: "yes" }]]));
    expect(master.map((problem) => problem.key)).toEqual(["chatExtensionEnabled"]);
    expect(readClientSwitches({ chatExtensionEnabled: true }, master).switches.settings.enabled).toBe(false);

    // Every valid stored switch is no problem.
    expect(storedClientSwitchProblems(new Map<string, { value: unknown }>([
      ["chatExtensionEnabled", { value: false }],
      ["chatExtensionFeatures", { value: "{}" }],
      ["chatExtensionMinVersion", { value: "1.4.0" }],
      ["chatExtensionHostBindings", { value: "{\"onlymonster:36408\": \"lora-vip-of\"}" }],
      ["chatExtensionPreviewSendReceiptProfiles", { value: "[]" }],
    ]))).toEqual([]);
  });

  it("keeps health reports only with the health switch on and the extension as a whole on", () => {
    const health = (config: Parameters<typeof readClientSwitches>[0], stored?: Parameters<typeof readClientSwitches>[1]) =>
      readClientSwitches(config, stored).switches.healthIngestEnabled;

    expect(health({ chatExtensionEnabled: true, chatExtensionHealthIngestEnabled: true })).toBe(true);
    // The master switch off turns everything off, the health intake too.
    expect(health({ chatExtensionEnabled: false, chatExtensionHealthIngestEnabled: true })).toBe(false);
    expect(health({ chatExtensionHealthIngestEnabled: true })).toBe(false);
    expect(health({ chatExtensionEnabled: true })).toBe(false);
    expect(health({ chatExtensionEnabled: true, chatExtensionHealthIngestEnabled: false })).toBe(false);
    // An unreadable switch turns the extension off as a whole: nothing is kept.
    expect(health({ chatExtensionEnabled: true, chatExtensionHealthIngestEnabled: true, chatExtensionMinVersion: "1.4" }))
      .toBe(false);
    expect(health(
      { chatExtensionEnabled: true, chatExtensionHealthIngestEnabled: true },
      storedClientSwitchProblems(new Map([["chatExtensionEnabled", { value: "yes" }]])),
    )).toBe(false);

    // The bootstrap lists the capability exactly then, after the standing ones.
    expect(clientBootstrapCapabilities({ healthIngestEnabled: false })).toEqual([...SERVED_CLIENT_CAPABILITIES]);
    expect(clientBootstrapCapabilities({ healthIngestEnabled: true }))
      .toEqual([...SERVED_CLIENT_CAPABILITIES, "client-health-perf-v1"]);
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain(CLIENT_HEALTH_CAPABILITY);

    const descriptor = getDescriptor("chatExtensionHealthIngestEnabled");
    expect(descriptor).toMatchObject({
      envName: "CHAT_EXTENSION_HEALTH_INGEST_ENABLED",
      kind: "boolean",
      default: "false",
      editability: "editable",
      runtimeApply: "live",
      subsystem: "Core",
    });
  });

  it("the bootstrap revision covers the five switches, the health switch and the two settings later PRs add", () => {
    expect(CLIENT_BOOTSTRAP_CONFIG_KEYS).toEqual([
      "chatExtensionEnabled",
      "chatExtensionFeatures",
      "chatExtensionMinVersion",
      "chatExtensionHostBindings",
      "chatExtensionPreviewSendReceiptProfiles",
      "aiLiveTextContextMode",
      "aiTranscriptDeepMaxRows",
      "chatExtensionHealthIngestEnabled",
    ]);
    for (const key of CLIENT_BOOTSTRAP_CONFIG_KEYS.slice(0, 5)) {
      const descriptor = getDescriptor(key);
      expect(descriptor?.editability, key).toBe("editable");
      expect(descriptor?.runtimeApply, key).toBe("live");
      expect(descriptor?.subsystem, key).toBe("Core");
    }
  });
});
