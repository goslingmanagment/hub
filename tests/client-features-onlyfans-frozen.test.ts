import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CLIENT_FEATURE_FLAG_NAMES, CLIENT_SEND_PURPOSES } from "@agency_hub_core/contracts";

import { OPERATION_FEATURES } from "../apps/runtime/src/modules/ai/index.ts";
import { clientAiFeatureFlag } from "../apps/runtime/src/services/client-ai-switch.ts";
import { admitClientSend, clientCustodyExistsOn } from "../apps/runtime/src/services/client-claim-admission.ts";
import {
  clientBootstrapFlags,
  clientFeatureExistsOn,
  evaluateClientPageFeatures,
  type ClientFeatureLane,
  type ClientFeaturePage,
  type ClientFeatureSettings,
} from "../apps/runtime/src/services/client-features.ts";

// chat-extension R20 HF-2: OnlyFans byte for byte. Every answer the hub's
// admission gives about an OnlyFans page — the bootstrap's page `features` and
// top-level `flags`, the server's check of every flagged route (the same
// evaluation), the greeting custody's admission and the narrow token's AI
// switch — over a matrix of the owner's switches, pages, served capabilities
// and lanes, serialized and hashed.
//
// The digest below was computed by this very enumeration on hub origin/main
// 8b73ab9fc (before HF-2), with only the flags that existed there. HF-2 adds
// Fansly to the requirement table, three Fansly flags and the rule that a
// Fansly page does not take the owner's "*" row: none of it may move one
// OnlyFans answer while the master is on. HF-15 intentionally changes the
// master-off answers: every flag now reads `disabled`, regardless of platform.
// The master-on subset digest was captured on 736cdb6b6389 before that fix;
// the original mixed digest was 5b86eef5596215b316a15af1ac938a9e09c37a957ff89ee8993e8e4d5ae7e8bc.
// The flags HF-2 adds remain `platform_unsupported` while the master is on
// (asserted apart, below the digest).
//
// The inputs are literals, not the hub's live lists, so a later PR that
// serves a new capability does not move this proof.

/** The flags of hub origin/main 8b73ab9fc, in its order. */
const FLAGS_BEFORE_HF2 = [
  "insertion", "freshText", "newcomers", "spenders", "stats", "preview", "previewSend",
  "previewSendMarkAiGenerated", "fanPanel", "navigation", "wsTap", "sound",
  "coach", "recap", "review", "splitAll",
  "drafts", "voice", "notesFill",
] as const;
/** The flags HF-2 adds: Fansly's own. */
const FLAGS_OF_HF2 = ["notes", "vault", "registration"] as const;
/** What hub origin/main 8b73ab9fc served (SERVED_CLIENT_CAPABILITIES), in its order. */
const SERVED_BEFORE_HF2 = [
  "context-v1", "live-text-v1", "shared-recaps-v1", "recap-profile-v1", "split-all-v1", "ai-usage-v1",
  "spenders-stats-v1", "awaiting-reply-v1", "archive-feed-v1", "preview-send-custody-v1", "audience-new-v1",
  "manual-greeting-v1", "coverage-check-v1", "conversation-recaps-v1", "hi-start-proof-v1", "voice-notes-v1",
] as const;

const PAGES: readonly ClientFeaturePage[] = [
  { label: "lora-of", platform: "onlyfans", platformAccountId: "100000001" },
  { label: "lora-vip-of", platform: "onlyfans", platformAccountId: "100000002" },
  // No platform account id: bindable only by an owner's host binding.
  { label: "nova-of", platform: "onlyfans", platformAccountId: null },
];

const every = (flags: readonly string[], on: boolean) => Object.fromEntries(flags.map((flag) => [flag, on]));
/** `chatExtensionFeatures` on prod, read only, 2026-10-13 and 2026-10-14: the two pilot pages, 13 flags each, no "*" row. */
const PILOT_ROW = {
  insertion: true, spenders: true, fanPanel: true, sound: true, wsTap: true, review: true, coach: true,
  recap: true, preview: true, stats: true, newcomers: true, freshText: true, splitAll: true,
};
const ALL_NAMES = [...FLAGS_BEFORE_HF2, ...FLAGS_OF_HF2];

const FEATURE_ROWS: ReadonlyArray<Record<string, Record<string, boolean>>> = [
  {},
  { "*": every(ALL_NAMES, true) },
  { "*": every(ALL_NAMES, false) },
  { "*": every(ALL_NAMES, true), "lora-of": every(ALL_NAMES, false) },
  { "lora-of": every(ALL_NAMES, true) },
  { "nova-of": every(ALL_NAMES, true), "*": { coach: true } },
  { "lora-vip-of": PILOT_ROW, "lora-of": PILOT_ROW },
  { "*": { coach: true, review: false, someFutureFlag: true }, "lora-of": { review: true, drafts: true, notes: true } },
  // Fansly's flags, set everywhere: they reach no OnlyFans page.
  { "*": every(["drafts", "voice", "notesFill", ...FLAGS_OF_HF2], true), "lora-fansly": every(ALL_NAMES, true) },
];
const HOST_BINDINGS: ReadonlyArray<Record<string, string>> = [
  {},
  { "onlymonster:36410": "nova-of" },
  { "onlymonster:36410": "lora-of" },
  { "otherhost:36410": "nova-of" },
];
const SERVED: ReadonlyArray<readonly string[]> = [
  SERVED_BEFORE_HF2,
  [],
  ...SERVED_BEFORE_HF2.map((missing) => SERVED_BEFORE_HF2.filter((capability) => capability !== missing)),
];
const LANES: ReadonlyArray<ReadonlySet<ClientFeatureLane>> = [new Set(), new Set(["voice-notes"])];

function pick(record: Record<string, unknown>, keys: readonly string[]): unknown[] {
  return keys.map((key) => [key, record[key]]);
}

/** Every OnlyFans answer of the matrix, one line each, in a fixed order. */
function onlyFansAnswers(masterStates: readonly boolean[]): string[] {
  const lines: string[] = [];
  for (const enabled of masterStates) {
    for (const features of FEATURE_ROWS) {
      for (const hostBindings of HOST_BINDINGS) {
        const settings: ClientFeatureSettings = { enabled, features, hostBindings };
        lines.push(JSON.stringify(["flags", enabled, features, hostBindings, pick(clientBootstrapFlags(settings), FLAGS_BEFORE_HF2)]));
        for (const page of PAGES) {
          for (const served of SERVED) {
            for (const lanes of LANES) {
              const answer = evaluateClientPageFeatures({ settings, page, served, lanes });
              lines.push(JSON.stringify(["page", enabled, features, hostBindings, page, served, [...lanes], pick(answer, FLAGS_BEFORE_HF2)]));
            }
          }
        }
      }
    }
  }
  for (const flag of FLAGS_BEFORE_HF2) {
    lines.push(JSON.stringify(["exists", flag, clientFeatureExistsOn(flag, "onlyfans")]));
  }
  lines.push(JSON.stringify(["custody", clientCustodyExistsOn("onlyfans")]));
  for (const purpose of CLIENT_SEND_PURPOSES) {
    for (const group of ["generation", "manual"] as const) {
      lines.push(JSON.stringify(["send", purpose, group, admitClientSend({ platform: "onlyfans", purpose, group })]));
    }
  }
  for (const feature of [...OPERATION_FEATURES, "scan", "compare", "constructor"]) {
    lines.push(JSON.stringify(["ai", feature, clientAiFeatureFlag(feature, "onlyfans")]));
  }
  return lines;
}

describe("[R20 HF-2] OnlyFans byte for byte", () => {
  it("[R20 HF-15] master-on answers retain their pre-fix digest", () => {
    const lines = onlyFansAnswers([true]);
    const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
    expect(lines).toHaveLength(3961);
    expect(digest).toBe("f894f458261dd166488e3905f07499a3a82eced5cf0fe28211498fc1377028a1");
  });

  it("[R20 HF-15] master off: every flag on both platforms is disabled across the matrix", () => {
    const disabled = Object.fromEntries(CLIENT_FEATURE_FLAG_NAMES.map((flag) => [flag, { available: false, reason: "disabled" }]));
    const off = Object.fromEntries(CLIENT_FEATURE_FLAG_NAMES.map((flag) => [flag, false]));
    for (const features of FEATURE_ROWS) {
      for (const hostBindings of HOST_BINDINGS) {
        const settings: ClientFeatureSettings = { enabled: false, features, hostBindings };
        expect(clientBootstrapFlags(settings)).toEqual(off);
        for (const source of PAGES) {
          for (const platform of ["onlyfans", "fansly"] as const) {
            const page = { ...source, platform };
            for (const served of SERVED) {
              for (const lanes of LANES) {
                expect(evaluateClientPageFeatures({ settings, page, served, lanes })).toEqual(disabled);
              }
            }
          }
        }
      }
    }
  });

  it("what HF-2 adds to an OnlyFans answer: three keys after the older ones, disabled with master off and otherwise platform_unsupported", () => {
    const keys = [...FLAGS_BEFORE_HF2, ...FLAGS_OF_HF2];
    for (const enabled of [true, false]) {
      for (const features of FEATURE_ROWS) {
        for (const hostBindings of HOST_BINDINGS) {
          const settings: ClientFeatureSettings = { enabled, features, hostBindings };
          // The top-level flags: the "*" row, in the list's order.
          const flags = clientBootstrapFlags(settings);
          expect(Object.keys(flags)).toEqual(keys);
          for (const flag of FLAGS_OF_HF2) {
            expect(flags[flag], flag).toBe(enabled && features["*"]?.[flag] === true);
          }
          for (const page of PAGES) {
            for (const served of [SERVED_BEFORE_HF2, []]) {
              const answer = evaluateClientPageFeatures({ settings, page, served, lanes: LANES[1]! });
              // The older keys keep their places: the new ones follow them.
              expect(Object.keys(answer)).toEqual(keys);
              for (const flag of FLAGS_OF_HF2) {
                expect(answer[flag], `${page.label} ${flag}`).toEqual({ available: false, reason: enabled ? "platform_unsupported" : "disabled" });
              }
            }
          }
        }
      }
    }
    for (const flag of FLAGS_OF_HF2) {
      expect(clientFeatureExistsOn(flag, "onlyfans"), flag).toBe(false);
    }
  });
});
