import { describe, expect, it } from "vitest";

import { CLIENT_SEND_PURPOSES, type ClientFeatureFlagName } from "@agency_hub_core/contracts";
import {
  CLIENT_GREETING_SEND_RATE,
  CLIENT_GREETING_SEND_RATE_LIMIT,
  CLIENT_PREVIEW_SEND_RATE,
  CLIENT_PREVIEW_SEND_RATE_LIMIT,
} from "@agency_hub_core/db";
import { platforms, type Platform } from "@agency_hub_core/shared";

import {
  CLIENT_SEND_ADMISSIONS,
  admitClientSend,
  clientClaimGroupKind,
  clientCustodyExistsOn,
  type ClientClaimGroupKind,
  type ClientFlagExistsOn,
} from "../apps/runtime/src/services/client-claim-admission.ts";
import { CLIENT_FEATURE_REQUIREMENTS, clientFeatureExistsOn } from "../apps/runtime/src/services/client-features.ts";

// chat-extension R20 HF-3: the greeting custody's admission by platform, the
// matrix `(platform, purpose, action)` of architecture §11.1, without a
// database. The routes' use of it is tests/client-claim-routes.integration.test.ts;
// the rules over a manual group, tests/client-claim-transition.test.ts and
// tests/client-claim.integration.test.ts.

const GROUPS: readonly ClientClaimGroupKind[] = ["generation", "manual"];

/**
 * The flag table as it was before R20 HF-2: `newcomers` on OnlyFans only. Only
 * the existence of a flag on a platform is read here; the switches, the
 * capabilities and the full run on Fansly through the routes are
 * tests/client-claim-routes.integration.test.ts.
 */
const NEWCOMERS_BEFORE_HF2: readonly Platform[] = ["onlyfans"];
const newcomersOnOnlyFansOnly: ClientFlagExistsOn = (flag, platform) =>
  flag === "newcomers" ? NEWCOMERS_BEFORE_HF2.includes(platform) : clientFeatureExistsOn(flag, platform);

describe("the greeting custody's admission by platform", () => {
  it("is the matrix of architecture §11.1, and nothing else", () => {
    expect(CLIENT_SEND_ADMISSIONS).toEqual({
      onlyfans: {
        greeting: { flags: ["previewSend", "newcomers"], groups: ["generation"], rate: CLIENT_PREVIEW_SEND_RATE },
        "preview-reply": { flags: ["previewSend"], groups: ["generation"], rate: CLIENT_PREVIEW_SEND_RATE },
      },
      fansly: {
        greeting: { flags: ["newcomers"], groups: ["generation", "manual"], rate: CLIENT_GREETING_SEND_RATE },
      },
    });
    // The rates: OnlyFans keeps its 6 sends from the preview, greetings and replies together; a
    // Fansly greeting has 30 a minute, above the old Fansly extension's peak of 29 (p99 21).
    expect(CLIENT_PREVIEW_SEND_RATE).toEqual({ limit: 6, purposes: ["greeting", "preview-reply"] });
    expect(CLIENT_PREVIEW_SEND_RATE_LIMIT).toBe(6);
    expect(CLIENT_GREETING_SEND_RATE).toEqual({ limit: 30, purposes: ["greeting"] });
    expect(CLIENT_GREETING_SEND_RATE_LIMIT).toBeGreaterThanOrEqual(30);
    // Every rule's purposes are counted in its own rate's scope.
    for (const [platform, rules] of Object.entries(CLIENT_SEND_ADMISSIONS)) {
      for (const [purpose, rule] of Object.entries(rules ?? {})) {
        expect(rule!.rate.purposes, `${platform} ${purpose}`).toContain(purpose);
      }
    }
  });

  it("OnlyFans is unchanged: both purposes, AI groups only, the same flags; a manual group is refused", () => {
    expect(clientCustodyExistsOn("onlyfans")).toBe(true);
    expect(admitClientSend({ platform: "onlyfans", purpose: "greeting", group: "generation" })).toEqual({
      admitted: true,
      rule: { flags: ["previewSend", "newcomers"], groups: ["generation"], rate: CLIENT_PREVIEW_SEND_RATE },
    });
    expect(admitClientSend({ platform: "onlyfans", purpose: "preview-reply", group: "generation" })).toEqual({
      admitted: true,
      rule: { flags: ["previewSend"], groups: ["generation"], rate: CLIENT_PREVIEW_SEND_RATE },
    });
    for (const purpose of CLIENT_SEND_PURPOSES) {
      expect(admitClientSend({ platform: "onlyfans", purpose, group: "manual" }), purpose).toEqual({
        admitted: false, feature: "manual-greeting-v1", reason: "platform_unsupported",
      });
    }
    // The custody exists there as it did before HF-3, when it was `previewSend`'s platform.
    expect(clientFeatureExistsOn("previewSend", "onlyfans")).toBe(true);
  });

  it("[R20 HF-2] Fansly: a greeting under `newcomers` without `previewSend`, AI or manual, 30 a minute; a reply never", () => {
    // The flag table as HF-2 makes it: `newcomers` on both, `previewSend` on OnlyFans only.
    expect(Object.keys(CLIENT_FEATURE_REQUIREMENTS.newcomers)).toEqual(["onlyfans", "fansly"]);
    expect(Object.keys(CLIENT_FEATURE_REQUIREMENTS.previewSend)).toEqual(["onlyfans"]);
    // The custody exists on Fansly through the regular admission: no stand-in table.
    expect(clientCustodyExistsOn("fansly")).toBe(true);
    for (const group of GROUPS) {
      const admission = admitClientSend({ platform: "fansly", purpose: "greeting", group });
      expect(admission, group).toEqual({
        admitted: true,
        rule: { flags: ["newcomers"], groups: ["generation", "manual"], rate: CLIENT_GREETING_SEND_RATE },
      });
      expect(admission.admitted && admission.rule.flags).not.toContain("previewSend");
      // A reply from the preview is no Fansly send: 409, even if `previewSend` came to exist there.
      const everything: ClientFlagExistsOn = () => true;
      for (const existsOn of [clientFeatureExistsOn, everything]) {
        expect(admitClientSend({ platform: "fansly", purpose: "preview-reply", group }, existsOn), group).toEqual({
          admitted: false, feature: "previewSend", reason: "platform_unsupported",
        });
      }
    }
    // OnlyFans reads the same under that table.
    expect(clientCustodyExistsOn("onlyfans")).toBe(true);
    expect(admitClientSend({ platform: "onlyfans", purpose: "greeting", group: "manual" }))
      .toMatchObject({ admitted: false, reason: "platform_unsupported" });
  });

  it("the custody follows the flag table: where `newcomers` did not exist, nothing on Fansly was admitted", () => {
    // The table before HF-2, read through the same admission: every Fansly send names the flag it waited for.
    expect(clientCustodyExistsOn("fansly", newcomersOnOnlyFansOnly)).toBe(false);
    expect(clientCustodyExistsOn("onlyfans", newcomersOnOnlyFansOnly)).toBe(true);
    for (const group of GROUPS) {
      expect(admitClientSend({ platform: "fansly", purpose: "greeting", group }, newcomersOnOnlyFansOnly), group).toEqual({
        admitted: false, feature: "newcomers", reason: "platform_unsupported",
      });
      expect(admitClientSend({ platform: "fansly", purpose: "preview-reply", group }, newcomersOnOnlyFansOnly), group).toEqual({
        admitted: false, feature: "previewSend", reason: "platform_unsupported",
      });
    }
  });

  it("a platform with no rule has no custody, and a refusal always names a flag or the manual group's capability", () => {
    const nowhere: ClientFlagExistsOn = () => false;
    for (const platform of platforms) {
      expect(clientCustodyExistsOn(platform, nowhere), platform).toBe(false);
    }
    const unknown = "myfans" as Platform;
    expect(clientCustodyExistsOn(unknown, () => true)).toBe(false);
    const named = new Set<string>();
    for (const platform of [...platforms, unknown]) {
      for (const purpose of CLIENT_SEND_PURPOSES) {
        for (const group of GROUPS) {
          const admission = admitClientSend({ platform, purpose, group });
          if (!admission.admitted) {
            expect(admission.reason).toBe("platform_unsupported");
            named.add(admission.feature);
          }
        }
      }
    }
    const flags = new Set<string>(Object.keys(CLIENT_FEATURE_REQUIREMENTS) as ClientFeatureFlagName[]);
    for (const feature of named) {
      expect(flags.has(feature) || feature === "manual-greeting-v1", feature).toBe(true);
    }
  });

  it("reads a group's kind from its shape", () => {
    expect(clientClaimGroupKind({ generationRef: "3c2b1a09-8f7e-4d6c-b5a4-fedcba987654", variant: 0, partCount: 1 }))
      .toBe("generation");
    expect(clientClaimGroupKind({ kind: "manual", textFingerprint: "a".repeat(64) })).toBe("manual");
  });
});
