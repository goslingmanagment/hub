import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { aiFeatureStreamBodySchema } from "@agency_hub_core/contracts";

import {
  FANSLY_FAN_BIO_MAX_CHARS,
  FANSLY_FAN_NAME_FALLBACK,
  FANSLY_FAN_NAME_MAX_CHARS,
  FEATURE_POLICIES,
  buildPrompt,
  fanslyFanIdentity,
  type FanslyFanRecord,
  type OperationFeature,
} from "../apps/runtime/src/modules/ai/index.ts";
import {
  releasedCustomName,
  releasedFanContext,
  type ReleasedFanslyAccount,
} from "./helpers/fansly-chat-fan-profile.ts";

// chat-extension R20 HF-7б: the fan's identity the hub forms for a Fansly
// generation it loads the context of, against what the released Fansly
// extension (fansly-chat 2.10.1) sends in `clientContext` for the same
// account. The stores and the route are in
// tests/client-ai-fansly-fan-profile.integration.test.ts; here are the rules.

const FEATURES = Object.keys(FEATURE_POLICIES) as OperationFeature[];

/** What the hub holds for an account once it is hydrated: the names as
 * served, the custom-name note's text as the page's saved name, the profile
 * text trimmed (sync/fansly/lib/fan-hydration.ts). */
function hubRecord(account: ReleasedFanslyAccount): FanslyFanRecord {
  return {
    username: account.username ?? null,
    displayName: account.displayName ?? null,
    savedName: releasedCustomName(account),
    about: account.about?.trim() ? account.about.trim() : null,
  };
}

/** The hub's values in the shape the released client sends: absent, not undefined. */
function hubContext(feature: OperationFeature, record: FanslyFanRecord | null) {
  const identity = fanslyFanIdentity({ feature, includesFanBio: FEATURE_POLICIES[feature].includesFanBio, record });
  return {
    fanDisplayName: identity.fanDisplayName,
    ...(identity.fanUsername !== undefined ? { fanUsername: identity.fanUsername } : {}),
    ...(identity.fanCustomName !== undefined ? { fanCustomName: identity.fanCustomName } : {}),
    ...(identity.fanBio !== undefined ? { fanBio: identity.fanBio } : {}),
  };
}

const customName = (note: string | null) => ({ contentType: 12002, note });
/** The notes panel's own blob: never a name. */
const crmNote = { contentType: 12000, note: "{\"age\":\"31\",\"job\":\"welder\"}" };

const ACCOUNTS: Array<[name: string, account: ReleasedFanslyAccount]> = [
  ["username, display name, saved name and bio", {
    id: "1", username: "mike_runs", displayName: "Mike", about: "marathoner from Austin", notes: [crmNote, customName("Mike VIP")],
  }],
  ["username alone", { id: "2", username: "quiet_guy", displayName: null }],
  ["an empty display name", { id: "3", username: "quiet_guy", displayName: "" }],
  ["a display name of spaces", { id: "4", username: "quiet_guy", displayName: "   " }],
  ["display name alone", { id: "5", username: null, displayName: "Only Display" }],
  ["a username of spaces", { id: "6", username: "  ", displayName: "Only Display" }],
  ["no name at all", { id: "7", username: null, displayName: null, about: "still has a bio" }],
  ["names and texts to trim", {
    id: "8", username: " spaced_user ", displayName: " Spaced Name ", about: "\n  trims too \n", notes: [customName("  Trimmed  ")],
  }],
  ["the display name equal to the username", { id: "9", username: "same", displayName: "same" }],
  ["an emptied saved name", { id: "10", username: "renamed_back", displayName: "Renamed", notes: [customName("   ")] }],
  ["a note without text", { id: "11", username: "no_text", displayName: null, notes: [customName(null)] }],
  ["the notes panel's blob alone", { id: "12", username: "crm_only", displayName: null, notes: [crmNote] }],
  ["an empty bio", { id: "13", username: "no_bio", displayName: "No Bio", about: "   " }],
  ["a bio and a name with markup", {
    id: "14", username: "tags", displayName: "<b>Tags</b>", about: "5 < 6 & \"quotes\"", notes: [customName("Tom & Jerry")],
  }],
];

describe("the fan's identity on Fansly, by the released extension's rules", () => {
  it("[AI-146] every feature gets the fields the released client sends for the same account", () => {
    for (const [name, account] of ACCOUNTS) {
      for (const feature of FEATURES) {
        expect(hubContext(feature, hubRecord(account)), `${feature}: ${name}`).toEqual(releasedFanContext(feature, account));
      }
    }
  });

  it("[AI-146] the name is the username, else the display name, else \"fan\"", () => {
    const of = (username: string | null, displayName: string | null) =>
      fanslyFanIdentity({ feature: "ping", includesFanBio: true, record: { username, displayName, savedName: null, about: null } });
    expect(of("mike_runs", "Mike")).toMatchObject({ fanDisplayName: "mike_runs", nameSource: "username" });
    expect(of(null, "Mike")).toMatchObject({ fanDisplayName: "Mike", nameSource: "display_name" });
    expect(of(" ", "")).toMatchObject({ fanDisplayName: FANSLY_FAN_NAME_FALLBACK, nameSource: "fallback" });
    // The username is the name; no feature but Hi names it a second time.
    expect(of("mike_runs", "Mike").fanUsername).toBeUndefined();
  });

  it("[AI-034] Hi turns the pair round: display name first, the username beside it", () => {
    const of = (username: string | null, displayName: string | null) =>
      fanslyFanIdentity({ feature: "hi-greeting", includesFanBio: true, record: { username, displayName, savedName: "Mike VIP", about: "runs" } });
    expect(of("mike_runs", "Mike")).toEqual({
      fanDisplayName: "Mike", nameSource: "display_name", fanUsername: "mike_runs", fanCustomName: "Mike VIP", fanBio: "runs",
    });
    expect(of("mike_runs", null)).toMatchObject({ fanDisplayName: "mike_runs", nameSource: "username", fanUsername: "mike_runs" });
    expect(of(null, null)).toMatchObject({ fanDisplayName: FANSLY_FAN_NAME_FALLBACK, nameSource: "fallback", fanUsername: undefined });
  });

  it("a fan the hub holds no account of is the released client's failed account read", () => {
    for (const feature of FEATURES) {
      expect(hubContext(feature, null), feature).toEqual(releasedFanContext(feature, undefined));
      expect(hubContext(feature, null), feature).toEqual({ fanDisplayName: "fan" });
    }
  });

  it("the bio goes only to the features whose policy includes it", () => {
    const record = { username: "mike_runs", displayName: "Mike", savedName: null, about: "marathoner" };
    const withBio = FEATURES.filter((feature) =>
      fanslyFanIdentity({ feature, includesFanBio: FEATURE_POLICIES[feature].includesFanBio, record }).fanBio !== undefined);
    expect(withBio.sort()).toEqual(["coach-chat", "fan-notes-fill", "help-me", "hi-greeting", "ping"]);
  });

  it("values are cut to the bounds the contract puts on the same clientContext fields, never through a surrogate pair", () => {
    const long = (length: number) => "n".repeat(length);
    const identity = fanslyFanIdentity({
      feature: "hi-greeting",
      includesFanBio: true,
      record: {
        username: long(FANSLY_FAN_NAME_MAX_CHARS + 50),
        displayName: `${long(FANSLY_FAN_NAME_MAX_CHARS - 1)}😊tail`,
        savedName: long(FANSLY_FAN_NAME_MAX_CHARS + 1),
        about: long(FANSLY_FAN_BIO_MAX_CHARS + 1),
      },
    });
    expect(identity.fanUsername).toHaveLength(FANSLY_FAN_NAME_MAX_CHARS);
    // The emoji would straddle the bound: it goes whole.
    expect(identity.fanDisplayName).toBe(long(FANSLY_FAN_NAME_MAX_CHARS - 1));
    expect(identity.fanCustomName).toHaveLength(FANSLY_FAN_NAME_MAX_CHARS);
    expect(identity.fanBio).toHaveLength(FANSLY_FAN_BIO_MAX_CHARS);

    // The bounds are the contract's own: a client may send exactly this much.
    const body = (clientContext: Record<string, unknown>) => ({
      clientRequestId: randomUUID(),
      pageLabel: "page",
      platform: "fansly",
      conversationRef: "1",
      clientContext: { transcript: "Fan: hi", messageCount: 1, fanDisplayName: "fan", ...clientContext },
    });
    for (const field of ["fanDisplayName", "fanUsername", "fanCustomName"]) {
      expect(aiFeatureStreamBodySchema.safeParse(body({ [field]: long(FANSLY_FAN_NAME_MAX_CHARS) })).success, field).toBe(true);
      expect(aiFeatureStreamBodySchema.safeParse(body({ [field]: long(FANSLY_FAN_NAME_MAX_CHARS + 1) })).success, field).toBe(false);
    }
    expect(aiFeatureStreamBodySchema.safeParse(body({ fanBio: long(FANSLY_FAN_BIO_MAX_CHARS) })).success).toBe(true);
    expect(aiFeatureStreamBodySchema.safeParse(body({ fanBio: long(FANSLY_FAN_BIO_MAX_CHARS + 1) })).success).toBe(false);
  });

  it("[AI-034] [AI-146] the prompt reads the same from the hub's values and from the released client's", () => {
    const personality = { id: "p", name: "Model", content: "Be warm.", updatedAt: 1 };
    for (const [name, account] of ACCOUNTS) {
      for (const feature of ["hi-greeting", "ping", "help-me", "coach-chat", "fan-notes-fill"] as const) {
        const base = {
          feature,
          platform: "fansly" as const,
          personality,
          transcript: "[10:00] Fan: hey",
          fanSpendingData: "",
          fanSubscriptionData: "",
          ...(feature === "ping" ? { pingSegment: "segment-a" as const, fanSilenceDays: 12 } : {}),
          ...(feature === "coach-chat" ? { chatterQuestion: "what next?" } : {}),
          ...(feature === "fan-notes-fill" ? { noteFields: ["Name"] } : {}),
        };
        const fromHub = buildPrompt({ ...base, ...hubContext(feature, hubRecord(account)) });
        const fromClient = buildPrompt({ ...base, ...releasedFanContext(feature, account) });
        expect(fromHub, `${feature}: ${name}`).toEqual(fromClient);
      }
    }
  });
});
