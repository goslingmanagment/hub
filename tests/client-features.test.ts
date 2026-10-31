import { describe, expect, it } from "vitest";

import {
  CLIENT_FEATURE_FLAG_NAMES,
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
  clientBootstrapFlags,
  clientFeatureNeedsOn,
  clientStarRowReaches,
  clientVersionRefusal,
  evaluateClientFeature,
  evaluateClientPageFeatures,
  hostBindingFitsPlatform,
  type ClientFeatureLane,
  type ClientFeaturePage,
  type ClientFeatureSettings,
} from "../apps/runtime/src/services/client-features.ts";
import { CLIENT_BOOTSTRAP_LIMITS } from "../apps/runtime/src/services/client-limits.ts";
import {
  readClientSwitches,
  storedClientSwitchProblems,
} from "../apps/runtime/src/services/client-switches.ts";

const OF_PAGE: ClientFeaturePage = { label: "lora-of", platform: "onlyfans", platformAccountId: "100000001" };
const FANSLY_PAGE: ClientFeaturePage = { label: "lora-fansly", platform: "fansly", platformAccountId: null };
/** An OnlyFans page whose platform account id is not known. */
const UNBOUND_OF_PAGE: ClientFeaturePage = { label: "nova-of", platform: "onlyfans", platformAccountId: null };
/** A Fansly page whose platform account id is known (every Fansly page on prod has one). */
const BOUND_FANSLY_PAGE: ClientFeaturePage = { label: "lora-1", platform: "fansly", platformAccountId: "123456789012345678" };
/** Fansly's own flags (R20 HF-12, HF-2): its AI generations' and the extension's own panels there. `voice`, `notes` and `notesFill` are on both. */
const FANSLY_ONLY_FLAGS: readonly string[] = ["drafts", "vault", "registration"];
/**
 * What Fansly does not have (R20 HF-2): sending from the preview, ChatSpace's
 * navigation and socket tap, and «Онлайн»'s probe of OnlyMonster. Every other
 * flag is on both platforms.
 */
const ONLYFANS_ONLY_FLAGS: readonly string[] = ["previewSend", "previewSendMarkAiGenerated", "navigation", "wsTap", "onlineProbe", "ofFeed", "ofPoll"];
const EVERY_CAPABILITY: readonly string[] = CLIENT_HUB_CAPABILITY_NAMES;
const NO_BINDINGS = {};
const VOICE_LANE: ReadonlySet<ClientFeatureLane> = new Set(["voice-notes"]);

function settings(input: Partial<ClientFeatureSettings>): ClientFeatureSettings {
  return { enabled: true, features: {}, hostBindings: NO_BINDINGS, ...input };
}

describe("chat-extension feature evaluation", () => {
  it("with the code defaults every feature on every platform reads disabled", () => {
    const served = SERVED_CLIENT_CAPABILITIES;
    const onlyFans = evaluateClientPageFeatures({ settings: CLIENT_FEATURE_CODE_DEFAULTS, page: OF_PAGE, served, lanes: VOICE_LANE });
    const fansly = evaluateClientPageFeatures({ settings: CLIENT_FEATURE_CODE_DEFAULTS, page: FANSLY_PAGE, served, lanes: VOICE_LANE });
    for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
      expect(onlyFans[flag], flag).toEqual({ available: false, reason: "disabled" });
      expect(fansly[flag], flag).toEqual({ available: false, reason: "disabled" });
    }
    expect(Object.values(clientBootstrapFlags(CLIENT_FEATURE_CODE_DEFAULTS))).toEqual(
      CLIENT_FEATURE_FLAG_NAMES.map(() => false),
    );
  });

  it("checks master switch, platform, the flag, the binding, then what the hub serves", () => {
    const on = settings({ features: { "*": { recap: true, coach: true } } });
    const evaluate = (input: ClientFeatureSettings, page: ClientFeaturePage, served: readonly string[]) =>
      evaluateClientFeature({ settings: input, page, flag: "recap", served });

    // The master first: an unsupported feature reads disabled too while it is off.
    for (const input of [on, { ...on, enabled: false }, settings({ features: { "lora-1": { previewSend: true } } })]) {
      expect(evaluateClientFeature({ settings: input, page: BOUND_FANSLY_PAGE, flag: "previewSend", served: EVERY_CAPABILITY }))
        .toEqual({ available: false, reason: input.enabled ? "platform_unsupported" : "disabled" });
    }
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
});

describe("[R20 HF-2] Fansly in the feature admission by platform", () => {
  const served = SERVED_CLIENT_CAPABILITIES;
  const FANSLY_FLAGS = CLIENT_FEATURE_FLAG_NAMES.filter((flag) => !ONLYFANS_ONLY_FLAGS.includes(flag));
  const row = (flags: readonly string[], on = true) => Object.fromEntries(flags.map((flag) => [flag, on]));
  const everyFlag = row(CLIENT_FEATURE_FLAG_NAMES);
  const pageFeatures = (input: ClientFeatureSettings, page: ClientFeaturePage = BOUND_FANSLY_PAGE, capabilities = served) =>
    evaluateClientPageFeatures({ settings: input, page, served: capabilities, lanes: VOICE_LANE });

  it("a Fansly page without its row reads flag_off; with its row every Fansly feature is available", () => {
    // No row at all, and rows of other pages (an OnlyFans page's, another Fansly page's).
    for (const features of [{}, { "lora-of": everyFlag }, { "lora-2": everyFlag }, { "lora-of": everyFlag, "lora-2": everyFlag }]) {
      const off = pageFeatures(settings({ features }));
      for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
        expect(off[flag], flag).toEqual({
          available: false,
          reason: ONLYFANS_ONLY_FLAGS.includes(flag) ? "platform_unsupported" : "flag_off",
        });
      }
    }
    const on = pageFeatures(settings({ features: { "lora-1": everyFlag } }));
    for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
      expect(on[flag], flag).toEqual(
        ONLYFANS_ONLY_FLAGS.includes(flag) ? { available: false, reason: "platform_unsupported" } : { available: true },
      );
    }
    // Each flag by its own row, and one flag opens no other.
    for (const flag of FANSLY_FLAGS) {
      const one = pageFeatures(settings({ features: { "lora-1": { [flag]: true } } }));
      expect(Object.entries(one).filter(([, availability]) => availability.available).map(([name]) => name), flag)
        .toEqual([flag]);
    }
    // The master switch is global: off, the page's row turns nothing on.
    const disabled = pageFeatures(settings({ enabled: false, features: { "lora-1": everyFlag } }));
    for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
      expect(disabled[flag], flag).toEqual({ available: false, reason: "disabled" });
    }
  });

  it("the owner's \"*\" row turns nothing on for a Fansly page, and turns nothing off there either", () => {
    expect(clientStarRowReaches("onlyfans")).toBe(true);
    expect(clientStarRowReaches("fansly")).toBe(false);
    expect(clientStarRowReaches("constructor" as never)).toBe(false);

    const star = settings({ features: { "*": everyFlag } });
    const fansly = pageFeatures(star);
    for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
      expect(fansly[flag], flag).toEqual({
        available: false,
        reason: ONLYFANS_ONLY_FLAGS.includes(flag) ? "platform_unsupported" : "flag_off",
      });
    }
    // The same row is every OnlyFans page's, as it always was.
    const onlyFans = pageFeatures(star, OF_PAGE);
    for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
      expect(onlyFans[flag], flag).toEqual(
        FANSLY_ONLY_FLAGS.includes(flag) ? { available: false, reason: "platform_unsupported" } : { available: true },
      );
    }
    // The page's own row decides alone: on over a "*" that says off, off under a "*" that says on.
    const ownOn = pageFeatures(settings({ features: { "*": row(CLIENT_FEATURE_FLAG_NAMES, false), "lora-1": everyFlag } }));
    const ownOff = pageFeatures(settings({ features: { "*": everyFlag, "lora-1": row(CLIENT_FEATURE_FLAG_NAMES, false) } }));
    for (const flag of FANSLY_FLAGS) {
      expect(ownOn[flag], flag).toEqual({ available: true });
      expect(ownOff[flag], flag).toEqual({ available: false, reason: "flag_off" });
    }
    // The top-level flags stay the "*" row, as before: they are no Fansly page's.
    expect(clientBootstrapFlags(star)).toEqual(everyFlag);
    expect(Object.values(clientBootstrapFlags(settings({ features: { "lora-1": everyFlag } }))).every((on) => on === false))
      .toBe(true);
  });

  it("Recap and the preview on Fansly need the reads by conversation; OnlyFans does not", () => {
    const without = served.filter((capability) => capability !== "conversation-recaps-v1");
    const fansly = pageFeatures(settings({ features: { "lora-1": everyFlag } }), BOUND_FANSLY_PAGE, without);
    expect(fansly.recap).toEqual({ available: false, reason: "hub_not_ready" });
    expect(fansly.preview).toEqual({ available: false, reason: "hub_not_ready" });
    // Nothing else on the page waits for it.
    for (const flag of FANSLY_FLAGS.filter((name) => name !== "recap" && name !== "preview")) {
      expect(fansly[flag], flag).toEqual({ available: true });
    }
    const onlyFans = pageFeatures(settings({ features: { "lora-of": everyFlag } }), OF_PAGE, without);
    expect(onlyFans.recap).toEqual({ available: true });
    expect(onlyFans.preview).toEqual({ available: true });
    // The capabilities Recap and the preview always needed are needed on Fansly too.
    for (const [flag, missing] of [["recap", "shared-recaps-v1"], ["recap", "recap-profile-v1"], ["preview", "archive-feed-v1"]] as const) {
      const lacking = served.filter((capability) => capability !== missing);
      expect(pageFeatures(settings({ features: { "lora-1": everyFlag } }), BOUND_FANSLY_PAGE, lacking)[flag], missing)
        .toEqual({ available: false, reason: "hub_not_ready" });
    }
  });

  it("«Новые» on Fansly need the custody and the manual greeting, never the hub's list of new subscribers", () => {
    const newcomers = (page: ClientFeaturePage, missing: string) => evaluateClientFeature({
      settings: settings({ features: { [page.label]: { newcomers: true } } }),
      page,
      flag: "newcomers",
      served: served.filter((capability) => capability !== missing),
    });
    expect(newcomers(BOUND_FANSLY_PAGE, "audience-new-v1")).toEqual({ available: true });
    expect(newcomers(BOUND_FANSLY_PAGE, "manual-greeting-v1")).toEqual({ available: false, reason: "hub_not_ready" });
    expect(newcomers(BOUND_FANSLY_PAGE, "preview-send-custody-v1")).toEqual({ available: false, reason: "hub_not_ready" });
    // OnlyFans: the list, the custody and, since the audit of 2026-10-20 (row 1), the manual group.
    expect(newcomers(OF_PAGE, "audience-new-v1")).toEqual({ available: false, reason: "hub_not_ready" });
    expect(newcomers(OF_PAGE, "preview-send-custody-v1")).toEqual({ available: false, reason: "hub_not_ready" });
    expect(newcomers(OF_PAGE, "manual-greeting-v1")).toEqual({ available: false, reason: "hub_not_ready" });
    expect(clientFeatureNeedsOn("newcomers", "manual-greeting-v1", "onlyfans")).toBe(true);
    expect(clientFeatureNeedsOn("previewSend", "manual-greeting-v1", "onlyfans")).toBe(true);
    // The list of new subscribers is a part of `newcomers` on OnlyFans alone: the route asks this.
    expect(clientFeatureNeedsOn("newcomers", "audience-new-v1", "onlyfans")).toBe(true);
    expect(clientFeatureNeedsOn("newcomers", "audience-new-v1", "fansly")).toBe(false);
    expect(clientFeatureNeedsOn("newcomers", "manual-greeting-v1", "fansly")).toBe(true);
    // Where the feature does not exist it needs nothing.
    expect(clientFeatureNeedsOn("previewSend", "preview-send-custody-v1", "fansly")).toBe(false);
    expect(clientFeatureNeedsOn("drafts", "audience-new-v1", "onlyfans")).toBe(false);
  });

  it("a Fansly page is bound by its account id alone: an OnlyMonster binding is no Fansly page's", () => {
    const on = { "lora-fansly": everyFlag };
    for (const hostBindings of [{}, { "onlymonster:36410": "lora-fansly" }]) {
      const unbound = pageFeatures(settings({ features: on, hostBindings }), FANSLY_PAGE);
      for (const flag of FANSLY_FLAGS) {
        expect(unbound[flag], flag).toEqual({ available: false, reason: "binding_missing" });
      }
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
      liveImagesEnabled: true,
      draftMediaEnabled: true,
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
      liveImagesEnabled: true,
      draftMediaEnabled: true,
    });
    // The receipt profiles are exactly what the bootstrap's limits carry.
    expect(clientBootstrapResponseSchema.shape.limits.parse({
      ...CLIENT_BOOTSTRAP_LIMITS,
      previewSendReceiptProfiles: switches.receiptProfiles,
    }).previewSendReceiptProfiles).toEqual([profile]);
  });

  it("a broken value falls back to its resting value alone and is reported; the extension stays on", () => {
    const base = {
      chatExtensionEnabled: true,
      chatExtensionFeatures: JSON.stringify({ "*": { coach: true } }),
      chatExtensionMinVersion: "1.3.0",
    };
    const broken = [
      { chatExtensionFeatures: "{\"*\": {\"coach\": true}" },
      { chatExtensionFeatures: "{\"*\": {\"coach\": \"yes\"}}" },
      { chatExtensionMinVersion: "1.4" },
      { chatExtensionHostBindings: "[\"lora-of\"]" },
      { chatExtensionPreviewSendReceiptProfiles: "{}" },
    ];
    for (const value of broken) {
      const { switches, problems } = readClientSwitches({ ...base, ...value });
      const [key] = Object.keys(value);
      expect(problems.map((problem) => problem.key), key).toEqual([key]);
      expect(switches.settings.enabled, key).toBe(true);
    }
    // A broken flag list turns the flags off, not the extension.
    const flags = readClientSwitches({ ...base, chatExtensionFeatures: "{\"*\": {\"coach\": true}" }).switches;
    expect(flags.settings.features).toEqual({});
    expect(evaluateClientFeature({ settings: flags.settings, page: OF_PAGE, flag: "coach", served: [] }))
      .toEqual({ available: false, reason: "flag_off" });
    // A broken minimum admits every version; the flags stand.
    const minimum = readClientSwitches({ ...base, chatExtensionMinVersion: "1.4" }).switches;
    expect(minimum.minVersion).toBe("0.0.0");
    expect(minimum.settings.features).toEqual({ "*": { coach: true } });
    // Broken receipt profiles turn sending from the preview off, nothing else.
    const profiles = readClientSwitches({ ...base, chatExtensionPreviewSendReceiptProfiles: "{}" }).switches;
    expect(profiles.receiptProfiles).toEqual([]);
    expect(profiles.minVersion).toBe("1.3.0");
  });

  it("a stored override that no longer validates takes its resting value, never the environment's", () => {
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
    expect(switches.settings.enabled).toBe(true);
    expect(switches.minVersion).toBe("0.0.0");

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

  it("keeps health reports only with the health switch on and the master switch on", () => {
    const health = (config: Parameters<typeof readClientSwitches>[0], stored?: Parameters<typeof readClientSwitches>[1]) =>
      readClientSwitches(config, stored).switches.healthIngestEnabled;

    expect(health({ chatExtensionEnabled: true, chatExtensionHealthIngestEnabled: true })).toBe(true);
    // The master switch off turns everything off, the health intake too.
    expect(health({ chatExtensionEnabled: false, chatExtensionHealthIngestEnabled: true })).toBe(false);
    expect(health({ chatExtensionHealthIngestEnabled: true })).toBe(false);
    expect(health({ chatExtensionEnabled: true })).toBe(false);
    expect(health({ chatExtensionEnabled: true, chatExtensionHealthIngestEnabled: false })).toBe(false);
    // Another switch unreadable does not stop the health intake.
    expect(health({ chatExtensionEnabled: true, chatExtensionHealthIngestEnabled: true, chatExtensionMinVersion: "1.4" }))
      .toBe(true);
    expect(health(
      { chatExtensionEnabled: true, chatExtensionHealthIngestEnabled: true },
      storedClientSwitchProblems(new Map([["chatExtensionEnabled", { value: "yes" }]])),
    )).toBe(false);

    // The bootstrap lists the capability exactly then, after the standing ones.
    expect(clientBootstrapCapabilities({ healthIngestEnabled: false })).toEqual([...SERVED_CLIENT_CAPABILITIES]);
    expect(clientBootstrapCapabilities({ healthIngestEnabled: true }))
      .toEqual([...SERVED_CLIENT_CAPABILITIES, "client-health-perf-v1"]);
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain(CLIENT_HEALTH_CAPABILITY);
    // The live images follow the owner's own switch, on unless switched off.
    expect(clientBootstrapCapabilities({ healthIngestEnabled: false, liveImagesEnabled: true }))
      .toEqual([...SERVED_CLIENT_CAPABILITIES, "live-images-v1"]);
    expect(readClientSwitches({ aiLiveImagesEnabled: false }).switches.liveImagesEnabled).toBe(false);
    // The draft media follow theirs, on unless switched off.
    expect(clientBootstrapCapabilities({ healthIngestEnabled: false, liveImagesEnabled: true, draftMediaEnabled: true }))
      .toEqual([...SERVED_CLIENT_CAPABILITIES, "live-images-v1", "draft-media-v1"]);
    expect(readClientSwitches({ aiDraftMediaEnabled: false }).switches.draftMediaEnabled).toBe(false);

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
});
