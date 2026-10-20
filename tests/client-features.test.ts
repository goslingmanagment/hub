import { describe, expect, it } from "vitest";

import {
  CLIENT_FEATURE_FLAG_NAMES,
  CLIENT_FEATURE_UNAVAILABLE_REASONS,
  CLIENT_HUB_CAPABILITY_NAMES,
  clientBootstrapResponseSchema,
} from "@agency_hub_core/contracts";
import { getDescriptor, loadConfig, platforms } from "@agency_hub_core/shared";

import {
  CLIENT_HEALTH_CAPABILITY,
  clientBootstrapCapabilities,
  SERVED_CLIENT_CAPABILITIES,
} from "../apps/runtime/src/services/client-capabilities.ts";
import {
  CLIENT_FEATURE_CODE_DEFAULTS,
  CLIENT_FEATURE_REQUIREMENTS,
  clientBootstrapFlags,
  clientFeatureExistsOn,
  clientFeatureNeedsOn,
  clientFeatureRequirementOn,
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
  CLIENT_BOOTSTRAP_CONFIG_KEYS,
  readClientSwitches,
  storedClientSwitchProblems,
} from "../apps/runtime/src/services/client-switches.ts";

const OF_PAGE: ClientFeaturePage = { label: "lora-of", platform: "onlyfans", platformAccountId: "100000001" };
const FANSLY_PAGE: ClientFeaturePage = { label: "lora-fansly", platform: "fansly", platformAccountId: null };
/** An OnlyFans page whose platform account id is not known. */
const UNBOUND_OF_PAGE: ClientFeaturePage = { label: "nova-of", platform: "onlyfans", platformAccountId: null };
/** A Fansly page whose platform account id is known (every Fansly page on prod has one). */
const BOUND_FANSLY_PAGE: ClientFeaturePage = { label: "lora-1", platform: "fansly", platformAccountId: "123456789012345678" };
/** Fansly's own flags (R20 HF-12, HF-2): its AI generations' and the extension's own panels there. */
const FANSLY_ONLY_FLAGS: readonly string[] = ["drafts", "voice", "notesFill", "notes", "vault", "registration"];
/**
 * What Fansly does not have (R20 HF-2): sending from the preview, ChatSpace's
 * navigation and socket tap, and the Spenders statistics. Every other flag is
 * on both platforms.
 */
const ONLYFANS_ONLY_FLAGS: readonly string[] = ["previewSend", "previewSendMarkAiGenerated", "navigation", "wsTap", "stats"];
const EVERY_CAPABILITY: readonly string[] = CLIENT_HUB_CAPABILITY_NAMES;
const NO_BINDINGS = {};
/** The hub lanes that serve a page (R20 HF-4б): none, or the voice notes. */
const NO_LANES: ReadonlySet<ClientFeatureLane> = new Set();
const VOICE_LANE: ReadonlySet<ClientFeatureLane> = new Set(["voice-notes"]);

function settings(input: Partial<ClientFeatureSettings>): ClientFeatureSettings {
  return { enabled: true, features: {}, hostBindings: NO_BINDINGS, ...input };
}

describe("chat-extension feature evaluation", () => {
  it("has one requirement row per known flag, asking only for known capabilities", () => {
    expect(Object.keys(CLIENT_FEATURE_REQUIREMENTS).sort()).toEqual([...CLIENT_FEATURE_FLAG_NAMES].sort());
    for (const [flag, requirement] of Object.entries(CLIENT_FEATURE_REQUIREMENTS)) {
      // A flag exists somewhere, and only on platforms the hub knows.
      expect(Object.keys(requirement).length, flag).toBeGreaterThan(0);
      for (const [platform, needs] of Object.entries(requirement)) {
        expect(platforms, flag).toContain(platform);
        for (const capability of needs.capabilities) {
          expect(CLIENT_HUB_CAPABILITY_NAMES, `${flag} on ${platform}`).toContain(capability);
        }
      }
    }
    for (const capability of SERVED_CLIENT_CAPABILITIES) {
      expect(CLIENT_HUB_CAPABILITY_NAMES).toContain(capability);
    }
  });

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

  it("answers only reasons from the published vocabulary", () => {
    const reasons = new Set<string>();
    for (const input of [
      CLIENT_FEATURE_CODE_DEFAULTS,
      settings({}),
      settings({ features: { "*": { recap: true, coach: true } } }),
    ]) {
      for (const page of [OF_PAGE, FANSLY_PAGE, UNBOUND_OF_PAGE]) {
        for (const result of Object.values(evaluateClientPageFeatures({ settings: input, page, served: [], lanes: NO_LANES }))) {
          if (result.reason !== undefined) reasons.add(result.reason);
        }
      }
    }
    // A feature its hub lane does not serve (R20 HF-4б).
    const voice = evaluateClientPageFeatures({
      settings: settings({ features: { "lora-1": { voice: true } } }),
      page: BOUND_FANSLY_PAGE,
      served: SERVED_CLIENT_CAPABILITIES,
      lanes: NO_LANES,
    }).voice;
    expect(voice).toEqual({ available: false, reason: "lane_off" });
    reasons.add(voice.reason!);
    reasons.add(clientVersionRefusal("1.0.0", undefined)!);
    for (const reason of reasons) {
      expect(CLIENT_FEATURE_UNAVAILABLE_REASONS).toContain(reason);
    }
  });
});

describe("[R20 HF-12] the flags of Fansly's own AI generations", () => {
  const served = SERVED_CLIENT_CAPABILITIES;

  it("on a Fansly page: off with the master switch, flag_off without the page's row, available with it", () => {
    const evaluate = (input: ClientFeatureSettings, flag: "drafts" | "voice" | "notesFill") =>
      evaluateClientFeature({ settings: input, page: BOUND_FANSLY_PAGE, flag, served });
    for (const flag of ["drafts", "voice", "notesFill"] as const) {
      const row = settings({ features: { "lora-1": { [flag]: true } } });
      expect(evaluate({ ...row, enabled: false }, flag), flag).toEqual({ available: false, reason: "disabled" });
      expect(evaluate(settings({}), flag), flag).toEqual({ available: false, reason: "flag_off" });
      expect(evaluate(settings({ features: { "lora-1": { [flag]: false } } }), flag), flag)
        .toEqual({ available: false, reason: "flag_off" });
      // Another page's row does not reach this page.
      expect(evaluate(settings({ features: { "lora-2": { [flag]: true } } }), flag), flag)
        .toEqual({ available: false, reason: "flag_off" });
      expect(evaluate(row, flag), flag).toEqual({ available: true });
      // Nothing the hub must serve first for drafts and notesFill: the owner's
      // row alone decides. Voice needs the voice-note routes (R20 HF-4б).
      expect(evaluateClientFeature({ settings: row, page: BOUND_FANSLY_PAGE, flag, served: [] }), flag)
        .toEqual(flag === "voice" ? { available: false, reason: "hub_not_ready" } : { available: true });
    }
    // One flag does not open another.
    expect(evaluate(settings({ features: { "lora-1": { drafts: true } } }), "voice"))
      .toEqual({ available: false, reason: "flag_off" });
  });

  it("on an OnlyFans page they do not exist, whatever the owner's rows say", () => {
    const on = settings({ features: { "*": { drafts: true, voice: true, notesFill: true }, "lora-of": { drafts: true } } });
    for (const flag of ["drafts", "voice", "notesFill"] as const) {
      expect(evaluateClientFeature({ settings: on, page: OF_PAGE, flag, served }), flag)
        .toEqual({ available: false, reason: "platform_unsupported" });
    }
  });

  it("the owner's rows of lora-of and lora-vip-of (prod, 2026-10-13) evaluate as before; the new flags read platform_unsupported there", () => {
    // `chatExtensionFeatures` on prod, read only, 2026-10-13: the two pilot
    // pages, 13 flags each, no "*" row. Stored as is, untouched by HF-12.
    const pilotRow = {
      insertion: true, spenders: true, fanPanel: true, sound: true, wsTap: true, review: true, coach: true,
      recap: true, preview: true, stats: true, newcomers: true, freshText: true, splitAll: true,
    };
    const { switches, problems } = readClientSwitches({
      chatExtensionEnabled: true,
      chatExtensionFeatures: JSON.stringify({ "lora-vip-of": pilotRow, "lora-of": pilotRow }),
    });
    expect(problems).toEqual([]);
    const available = { available: true };
    const flagOff = { available: false, reason: "flag_off" };
    const unsupported = { available: false, reason: "platform_unsupported" };
    const pilotPages: ClientFeaturePage[] = [
      { label: "lora-of", platform: "onlyfans", platformAccountId: "100000001" },
      { label: "lora-vip-of", platform: "onlyfans", platformAccountId: "100000002" },
    ];
    // R20 HF-4б: whether the voice-notes lane serves changes nothing on OnlyFans.
    for (const [page, lanes] of pilotPages.flatMap((page) => [NO_LANES, VOICE_LANE].map((lanes) => [page, lanes] as const))) {
      expect(evaluateClientPageFeatures({ settings: switches.settings, page, served, lanes }), page.label).toEqual({
        // Before HF-12, unchanged.
        insertion: available,
        freshText: available,
        newcomers: available,
        spenders: available,
        stats: available,
        preview: available,
        previewSend: flagOff,
        previewSendMarkAiGenerated: flagOff,
        fanPanel: available,
        navigation: flagOff,
        wsTap: available,
        sound: available,
        coach: available,
        recap: available,
        review: available,
        splitAll: available,
        // HF-12: Fansly's own.
        drafts: unsupported,
        voice: unsupported,
        notesFill: unsupported,
        // HF-2: Fansly's own.
        notes: unsupported,
        vault: unsupported,
        registration: unsupported,
      });
    }
    // No top-level flag moves: the rows are per page.
    expect(Object.values(clientBootstrapFlags(switches.settings)).every((on) => on === false)).toBe(true);
  });
});

describe("[R20 HF-4б] voice: the voice-note routes and the voice-notes lane", () => {
  const served = SERVED_CLIENT_CAPABILITIES;
  const row = settings({ features: { "lora-1": { voice: true } } });
  const pageVoice = (input: ClientFeatureSettings, lanes: ReadonlySet<ClientFeatureLane>, page = BOUND_FANSLY_PAGE) =>
    evaluateClientPageFeatures({ settings: input, page, served, lanes }).voice;

  it("needs voice-notes-v1, which this hub serves, and runs on the voice-notes lane", () => {
    expect(CLIENT_FEATURE_REQUIREMENTS.voice).toEqual({
      fansly: { capabilities: ["voice-notes-v1"], lane: "voice-notes" },
    });
    expect(SERVED_CLIENT_CAPABILITIES).toContain("voice-notes-v1");
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("voice-notes-v1");
    expect(CLIENT_FEATURE_UNAVAILABLE_REASONS).toContain("lane_off");
    // No other flag runs on a lane.
    expect(Object.entries(CLIENT_FEATURE_REQUIREMENTS)
      .filter(([, requirement]) => Object.values(requirement).some((needs) => needs.lane !== undefined))
      .map(([flag]) => flag)).toEqual(["voice"]);
    // Without the capability the hub is not ready, whatever the owner's row says.
    expect(evaluateClientFeature({ settings: row, page: BOUND_FANSLY_PAGE, flag: "voice", served: [] }))
      .toEqual({ available: false, reason: "hub_not_ready" });
  });

  it("the page's features: available with the flag on a page the lane serves, lane_off on one it does not", () => {
    expect(pageVoice(row, VOICE_LANE)).toEqual({ available: true });
    expect(pageVoice(row, NO_LANES)).toEqual({ available: false, reason: "lane_off" });
    // The server's check of a call does not ask the lane: the lane's own admission answers there.
    expect(evaluateClientFeature({ settings: row, page: BOUND_FANSLY_PAGE, flag: "voice", served }))
      .toEqual({ available: true });
  });

  it("the lane is asked last: every other reason comes first, and the lane opens nothing by itself", () => {
    for (const lanes of [NO_LANES, VOICE_LANE]) {
      expect(pageVoice({ ...row, enabled: false }, lanes)).toEqual({ available: false, reason: "disabled" });
      expect(pageVoice(settings({}), lanes)).toEqual({ available: false, reason: "flag_off" });
      expect(pageVoice(settings({ features: { "lora-1": { voice: false } } }), lanes))
        .toEqual({ available: false, reason: "flag_off" });
      expect(pageVoice(settings({ features: { "lora-1": { drafts: true, notesFill: true } } }), lanes))
        .toEqual({ available: false, reason: "flag_off" });
      expect(pageVoice(settings({ features: { "lora-fansly": { voice: true } } }), lanes, FANSLY_PAGE))
        .toEqual({ available: false, reason: "binding_missing" });
      expect(pageVoice(settings({ features: { "*": { voice: true }, "lora-of": { voice: true } } }), lanes, OF_PAGE))
        .toEqual({ available: false, reason: "platform_unsupported" });
    }
    expect(evaluateClientPageFeatures({ settings: row, page: BOUND_FANSLY_PAGE, served: [], lanes: NO_LANES }).voice)
      .toEqual({ available: false, reason: "hub_not_ready" });
  });

  it("no other flag on any page reads the lane", () => {
    const everything = settings({
      features: { "*": Object.fromEntries(CLIENT_FEATURE_FLAG_NAMES.map((flag) => [flag, true])) },
    });
    for (const input of [CLIENT_FEATURE_CODE_DEFAULTS, settings({}), everything]) {
      for (const page of [OF_PAGE, FANSLY_PAGE, UNBOUND_OF_PAGE, BOUND_FANSLY_PAGE]) {
        const off = evaluateClientPageFeatures({ settings: input, page, served, lanes: NO_LANES });
        const on = evaluateClientPageFeatures({ settings: input, page, served, lanes: VOICE_LANE });
        for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
          // Each flag is the per-flag evaluation, the server's own, but for voice where its lane is off.
          expect(on[flag], `${page.label} ${flag}`)
            .toEqual(evaluateClientFeature({ settings: input, page, flag, served }));
          if (flag !== "voice") {
            expect(off[flag], `${page.label} ${flag}`).toEqual(on[flag]);
          }
        }
      }
    }
  });

  it("the owner's rows on prod (2026-10-13) give no page voice: nothing turns on at merge", () => {
    const pilotRow = {
      insertion: true, spenders: true, fanPanel: true, sound: true, wsTap: true, review: true, coach: true,
      recap: true, preview: true, stats: true, newcomers: true, freshText: true, splitAll: true,
    };
    const { switches } = readClientSwitches({
      chatExtensionEnabled: true,
      chatExtensionFeatures: JSON.stringify({ "lora-vip-of": pilotRow, "lora-of": pilotRow }),
    });
    expect(pageVoice(switches.settings, VOICE_LANE)).toEqual({ available: false, reason: "flag_off" });
    expect(pageVoice(switches.settings, VOICE_LANE, OF_PAGE)).toEqual({ available: false, reason: "platform_unsupported" });
  });
});

describe("[R20 HF-8б] fresh text on a Fansly page", () => {
  const served = SERVED_CLIENT_CAPABILITIES;
  const evaluate = (input: ClientFeatureSettings, page: ClientFeaturePage = BOUND_FANSLY_PAGE, capabilities = served) =>
    evaluateClientFeature({ settings: input, page, flag: "freshText", served: capabilities });

  it("exists there: off with the master switch, flag_off without the page's row, available with it", () => {
    const row = settings({ features: { "lora-1": { freshText: true } } });
    expect(evaluate({ ...row, enabled: false })).toEqual({ available: false, reason: "disabled" });
    expect(evaluate(settings({}))).toEqual({ available: false, reason: "flag_off" });
    expect(evaluate(settings({ features: { "lora-1": { freshText: false } } })))
      .toEqual({ available: false, reason: "flag_off" });
    // An OnlyFans page's row does not reach the Fansly page, nor does another flag.
    expect(evaluate(settings({ features: { "lora-of": { freshText: true }, "lora-1": { drafts: true } } })))
      .toEqual({ available: false, reason: "flag_off" });
    expect(evaluate(row)).toEqual({ available: true });
    // The same capability as on OnlyFans: without it the hub is not ready.
    expect(evaluate(row, BOUND_FANSLY_PAGE, [])).toEqual({ available: false, reason: "hub_not_ready" });
    // Every Fansly page on prod has its account id; one without it cannot be bound.
    expect(evaluate(settings({ features: { "lora-fansly": { freshText: true } } }), FANSLY_PAGE))
      .toEqual({ available: false, reason: "binding_missing" });
  });

  it("OnlyFans pages read it exactly as before", () => {
    const row = settings({ features: { "lora-of": { freshText: true } } });
    expect(evaluate(row, OF_PAGE)).toEqual({ available: true });
    expect(evaluate(settings({}), OF_PAGE)).toEqual({ available: false, reason: "flag_off" });
    expect(evaluate({ ...row, enabled: false }, OF_PAGE)).toEqual({ available: false, reason: "disabled" });
    expect(evaluate(row, OF_PAGE, [])).toEqual({ available: false, reason: "hub_not_ready" });
  });

  it("the owner's rows on prod (2026-10-13) leave every Fansly page without it: nothing turns on at merge", () => {
    // `chatExtensionFeatures` on prod, read only, 2026-10-13: the two OnlyFans
    // pilot pages, no "*" row, no Fansly page.
    const pilotRow = {
      insertion: true, spenders: true, fanPanel: true, sound: true, wsTap: true, review: true, coach: true,
      recap: true, preview: true, stats: true, newcomers: true, freshText: true, splitAll: true,
    };
    const { switches } = readClientSwitches({
      chatExtensionEnabled: true,
      chatExtensionFeatures: JSON.stringify({ "lora-vip-of": pilotRow, "lora-of": pilotRow }),
    });
    expect(evaluate(switches.settings)).toEqual({ available: false, reason: "flag_off" });
    expect(evaluate(switches.settings, OF_PAGE)).toEqual({ available: true });
  });
});

describe("[R20 HF-2] Fansly in the feature admission by platform", () => {
  const served = SERVED_CLIENT_CAPABILITIES;
  const FANSLY_FLAGS = CLIENT_FEATURE_FLAG_NAMES.filter((flag) => !ONLYFANS_ONLY_FLAGS.includes(flag));
  const row = (flags: readonly string[], on = true) => Object.fromEntries(flags.map((flag) => [flag, on]));
  const everyFlag = row(CLIENT_FEATURE_FLAG_NAMES);
  const pageFeatures = (input: ClientFeatureSettings, page: ClientFeaturePage = BOUND_FANSLY_PAGE, capabilities = served) =>
    evaluateClientPageFeatures({ settings: input, page, served: capabilities, lanes: VOICE_LANE });

  it("the table is the architecture's (§1.4, §11.1): what exists on each platform, and what it needs there", () => {
    const nothing = { capabilities: [] };
    expect(CLIENT_FEATURE_REQUIREMENTS).toEqual({
      insertion: { onlyfans: nothing, fansly: nothing },
      navigation: { onlyfans: nothing },
      wsTap: { onlyfans: nothing },
      sound: { onlyfans: nothing, fansly: nothing },
      fanPanel: { onlyfans: nothing, fansly: nothing },
      previewSendMarkAiGenerated: { onlyfans: nothing },
      spenders: { onlyfans: nothing, fansly: nothing },
      review: { onlyfans: nothing, fansly: nothing },
      coach: { onlyfans: nothing, fansly: nothing },
      freshText: { onlyfans: { capabilities: ["live-text-v1"] }, fansly: { capabilities: ["live-text-v1"] } },
      splitAll: { onlyfans: { capabilities: ["split-all-v1"] }, fansly: { capabilities: ["split-all-v1"] } },
      // A Fansly chat is a group apart from its fan: the reads by conversation (HF-10).
      recap: {
        onlyfans: { capabilities: ["shared-recaps-v1", "recap-profile-v1"] },
        fansly: { capabilities: ["shared-recaps-v1", "recap-profile-v1", "conversation-recaps-v1"] },
      },
      preview: {
        onlyfans: { capabilities: ["archive-feed-v1"] },
        fansly: { capabilities: ["archive-feed-v1", "conversation-recaps-v1"] },
      },
      stats: { onlyfans: { capabilities: ["spenders-stats-v1", "awaiting-reply-v1"] } },
      // Fansly's «Новые»: the custody and a manual greeting, without the hub's list of new subscribers.
      newcomers: {
        onlyfans: { capabilities: ["audience-new-v1", "preview-send-custody-v1"] },
        fansly: { capabilities: ["preview-send-custody-v1", "manual-greeting-v1"] },
      },
      previewSend: { onlyfans: { capabilities: ["preview-send-custody-v1"] } },
      drafts: { fansly: nothing },
      voice: { fansly: { capabilities: ["voice-notes-v1"], lane: "voice-notes" } },
      notesFill: { fansly: nothing },
      notes: { fansly: nothing },
      vault: { fansly: nothing },
      registration: { fansly: nothing },
    });
    // The three flags HF-2 adds are known names, at the end of the list: no older key moves.
    expect(CLIENT_FEATURE_FLAG_NAMES.slice(-3)).toEqual(["notes", "vault", "registration"]);
    for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
      expect(clientFeatureExistsOn(flag, "onlyfans"), flag).toBe(!FANSLY_ONLY_FLAGS.includes(flag));
      expect(clientFeatureExistsOn(flag, "fansly"), flag).toBe(!ONLYFANS_ONLY_FLAGS.includes(flag));
      for (const platform of platforms) {
        expect(clientFeatureRequirementOn(flag, platform), `${flag} on ${platform}`)
          .toEqual(CLIENT_FEATURE_REQUIREMENTS[flag][platform]);
      }
    }
    // Everything a Fansly feature needs is served: the page's own row decides from here on.
    for (const flag of FANSLY_FLAGS) {
      for (const capability of clientFeatureRequirementOn(flag, "fansly")!.capabilities) {
        expect(served, `${flag} needs ${capability}`).toContain(capability);
      }
    }
    // A name of the prototype is no platform.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(clientFeatureRequirementOn("coach", name as never), name).toBeUndefined();
      expect(clientFeatureExistsOn("coach", name as never), name).toBe(false);
    }
  });

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
    // OnlyFans, as before: the list and the custody; a manual greeting is not its.
    expect(newcomers(OF_PAGE, "audience-new-v1")).toEqual({ available: false, reason: "hub_not_ready" });
    expect(newcomers(OF_PAGE, "preview-send-custody-v1")).toEqual({ available: false, reason: "hub_not_ready" });
    expect(newcomers(OF_PAGE, "manual-greeting-v1")).toEqual({ available: true });
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

  it("the owner's rows on prod (read only, 2026-10-14) leave every Fansly page off: nothing turns on at merge", () => {
    // `chatExtensionFeatures` on prod: the two OnlyFans pilot pages, 13 flags
    // each, no "*" row and no Fansly page. The six active Fansly pages of prod,
    // each with its platform account id.
    const pilotRow = {
      insertion: true, spenders: true, fanPanel: true, sound: true, wsTap: true, review: true, coach: true,
      recap: true, preview: true, stats: true, newcomers: true, freshText: true, splitAll: true,
    };
    const { switches, problems } = readClientSwitches({
      chatExtensionEnabled: true,
      chatExtensionFeatures: JSON.stringify({ "lora-vip-of": pilotRow, "lora-of": pilotRow }),
    });
    expect(problems).toEqual([]);
    for (const label of ["ari-1", "lilly-1", "lilly-2", "lora-1", "lora-2", "lora-3"]) {
      const page: ClientFeaturePage = { label, platform: "fansly", platformAccountId: "123456789012345678" };
      const features = pageFeatures(switches.settings, page);
      expect(Object.values(features).some((availability) => availability.available), label).toBe(false);
      for (const flag of CLIENT_FEATURE_FLAG_NAMES) {
        expect(features[flag], `${label} ${flag}`).toEqual({
          available: false,
          reason: ONLYFANS_ONLY_FLAGS.includes(flag) ? "platform_unsupported" : "flag_off",
        });
      }
    }
    // Had the owner kept a "*" row for the OnlyFans pilot, it would reach no Fansly page either.
    const withStar = readClientSwitches({
      chatExtensionEnabled: true,
      chatExtensionFeatures: JSON.stringify({ "*": pilotRow }),
    }).switches;
    expect(Object.values(pageFeatures(withStar.settings)).some((availability) => availability.available)).toBe(false);
    expect(pageFeatures(withStar.settings, OF_PAGE).coach).toEqual({ available: true });
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

  it("the bootstrap revision covers the five switches, the retired fresh-text mode, the depth, the health switch and the voice lane's two", () => {
    expect(CLIENT_BOOTSTRAP_CONFIG_KEYS).toEqual([
      "chatExtensionEnabled",
      "chatExtensionFeatures",
      "chatExtensionMinVersion",
      "chatExtensionHostBindings",
      "chatExtensionPreviewSendReceiptProfiles",
      "aiLiveTextContextMode",
      "aiTranscriptDeepMaxRows",
      "chatExtensionHealthIngestEnabled",
      // R20 HF-4б: the bootstrap's `voice` reads the voice-notes lane.
      "voiceNotesEnabled",
      "voiceNotesPageAllowlist",
    ]);
    for (const key of ["voiceNotesEnabled", "voiceNotesPageAllowlist"]) {
      expect(getDescriptor(key)?.runtimeApply, key).toBe("live");
    }
    for (const key of CLIENT_BOOTSTRAP_CONFIG_KEYS.slice(0, 5)) {
      const descriptor = getDescriptor(key);
      expect(descriptor?.editability, key).toBe("editable");
      expect(descriptor?.runtimeApply, key).toBe("live");
      expect(descriptor?.subsystem, key).toBe("Core");
    }
  });
});
