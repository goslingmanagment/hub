import { describe, expect, it } from "vitest";

import { routeAuthPolicySchema, routeSchemas } from "@agency_hub_core/contracts";

// Kernel Stage 19 CI gate: every route contract must carry a declarative `auth`
// block. This is the linter-independent guard — a new routeSchemas entry without
// one fails here, so "who can call this" can never silently regress to unknown.

function collectUndeclaredRoutes(entries: Record<string, unknown>): string[] {
  const undeclared: string[] = [];
  for (const [key, schema] of Object.entries(entries)) {
    const auth = (schema as { auth?: unknown }).auth;
    if (!auth || !routeAuthPolicySchema.safeParse(auth).success) {
      undeclared.push(key);
    }
  }
  return undeclared;
}

describe("route auth declarations", () => {
  it("every routeSchemas entry declares a valid auth policy", () => {
    expect(collectUndeclaredRoutes(routeSchemas)).toEqual([]);
  });

  it("the gate itself rejects an entry without auth (self-test)", () => {
    expect(collectUndeclaredRoutes({
      sneakyNewRoute: { tags: ["system"], summary: "No auth block" },
    })).toEqual(["sneakyNewRoute"]);
    expect(collectUndeclaredRoutes({
      typoedKind: { auth: { kind: "sessionn" } },
    })).toEqual(["typoedKind"]);
    expect(collectUndeclaredRoutes({
      extraProp: { auth: { kind: "session", pages: "all" } },
    })).toEqual(["extraProp"]);
  });

  it("page scope is declared only where a :pageLabel path param can carry it", () => {
    // The middleware resolves scope:"page" from params.pageLabel; declaring it on
    // a route without that param would silently skip the check. The path lives in
    // server.ts, not the schema, so pin the reviewed set here instead.
    const pageScoped = Object.entries(routeSchemas)
      .filter(([, schema]) => (schema as { auth?: { scope?: string } }).auth?.scope === "page")
      .map(([key]) => key)
      .sort();
    expect(pageScoped).toEqual([
      // Agent Read Plane: the three page-scoped agent operations (slice A's two
      // plus slice C's hydration create). They sort to the front, which is why
      // the list starts here now. #12 is NOT page-scoped: its path carries a
      // uuid, so the middleware cannot resolve a scope and the handler checks
      // the grant itself.
      "agentDatasetQuery",
      "agentHydrationRequestCreate",
      "agentThreadMessages",
      "createFanNote",
      "pageConversationMessages",
      "pageConversationPreview",
      "pageConversationProfile",
      "pageDeletedFans",
      "pageFanDetail",
      "pageFanProfile",
      "pageFanProfileVersion",
      "pageFanProfileVersions",
      "pageFanTransactions",
      "pageFans",
      "pageFollowers",
      "pageFollowersDaily",
      "pageMessagesBlock",
      "pageRevenue",
      "pageRevenueDaily",
      "pageSpenderAutoListDetail",
      "pageSpenderAutoLists",
      "pageSubscribers",
      "pageSubscribersDaily",
      "pageSyncBlocks",
      "pageTopSpenders",
      "pageTransactions",
      "upsertFanProfile",
      "voiceNoteAudio",
      "voiceNoteCreate",
      "voiceNoteStatus",
      "workboardV2",
      "workboardV2Ai",
      "workboardV2AiClassify",
      "workboardV2AiSettings",
      "workboardV2Claim",
      "workboardV2Contact",
      "workboardV2Lists",
      "workboardV2Recompute",
      "workboardV2Snooze",
      "workboardV2Unclaim",
      "workboardV2UndoContact",
      "workboardV2Unsnooze",
    ]);
  });

  it("the retired workboard v1 routes stay gone (Stage 23 Task 5)", () => {
    // Registration is contract-driven: no routeSchemas entry, no route — the
    // v1 paths 404. The dashboard moved to the v2 module routes in the same
    // deploy (last-consumer-migrates, target §14).
    for (const retired of ["workboard", "workboardPresence", "workboardSnooze", "workboardUnsnooze"]) {
      expect(routeSchemas).not.toHaveProperty(retired);
    }
  });
});
