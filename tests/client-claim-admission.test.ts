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
 * The flag table as HF-2 makes it for this route: `newcomers` exists on Fansly
 * too. Only the existence of a flag on a platform is read here; the switches,
 * the capabilities and the full positive run on Fansly are HF-2's.
 */
const NEWCOMERS_AFTER_HF2: readonly Platform[] = ["onlyfans", "fansly"];
const newcomersOnFansly: ClientFlagExistsOn = (flag, platform) =>
  flag === "newcomers" ? NEWCOMERS_AFTER_HF2.includes(platform) : clientFeatureExistsOn(flag, platform);

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
    // Before HF-3 the status read and a native record existed where `previewSend` does: the same set.
    for (const platform of platforms) {
      expect(clientCustodyExistsOn(platform), platform).toBe(clientFeatureExistsOn("previewSend", platform));
    }
  });

  it("Fansly until HF-2: nothing exists there, every send is platform_unsupported, as before HF-3", () => {
    // The flag table this PR leaves as it was: `newcomers` and `previewSend` are OnlyFans only.
    expect(CLIENT_FEATURE_REQUIREMENTS.newcomers.platforms).toEqual(["onlyfans"]);
    expect(CLIENT_FEATURE_REQUIREMENTS.previewSend.platforms).toEqual(["onlyfans"]);
    expect(clientCustodyExistsOn("fansly")).toBe(false);
    for (const group of GROUPS) {
      expect(admitClientSend({ platform: "fansly", purpose: "greeting", group }), group).toEqual({
        admitted: false, feature: "newcomers", reason: "platform_unsupported",
      });
      expect(admitClientSend({ platform: "fansly", purpose: "preview-reply", group }), group).toEqual({
        admitted: false, feature: "previewSend", reason: "platform_unsupported",
      });
    }
  });

  it("Fansly once `newcomers` exists there: a greeting under `newcomers` without `previewSend`, AI or manual, 30 a minute; a reply never", () => {
    expect(clientCustodyExistsOn("fansly", newcomersOnFansly)).toBe(true);
    for (const group of GROUPS) {
      const admission = admitClientSend({ platform: "fansly", purpose: "greeting", group }, newcomersOnFansly);
      expect(admission, group).toEqual({
        admitted: true,
        rule: { flags: ["newcomers"], groups: ["generation", "manual"], rate: CLIENT_GREETING_SEND_RATE },
      });
      expect(admission.admitted && admission.rule.flags).not.toContain("previewSend");
      // A reply from the preview is no Fansly send: 409, even if `previewSend` came to exist there.
      const everything: ClientFlagExistsOn = () => true;
      for (const existsOn of [newcomersOnFansly, everything]) {
        expect(admitClientSend({ platform: "fansly", purpose: "preview-reply", group }, existsOn), group).toEqual({
          admitted: false, feature: "previewSend", reason: "platform_unsupported",
        });
      }
    }
    // OnlyFans reads the same under that table.
    expect(clientCustodyExistsOn("onlyfans", newcomersOnFansly)).toBe(true);
    expect(admitClientSend({ platform: "onlyfans", purpose: "greeting", group: "manual" }, newcomersOnFansly))
      .toMatchObject({ admitted: false, reason: "platform_unsupported" });
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
