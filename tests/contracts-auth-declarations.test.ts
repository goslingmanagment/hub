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

  it("keeps both follower blast-radius steps owner-session only", () => {
    expect(routeSchemas.adminFollowersReconcileOverridePreview.auth).toEqual({
      kind: "owner-session",
    });
    expect(routeSchemas.adminFollowersReconcileOverrideApply.auth).toEqual({
      kind: "owner-session",
    });
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
      // The Sync Engine's history-request create (same shape as hydration's).
      "agentHistoryRequestCreate",
      "agentHydrationRequestCreate",
      // The Sync Engine's "why waiting" of one page's work.
      "agentSyncWhy",
      "agentThreadMessages",
      // The chat extension's page routes (`/api/v1/client/pages/:pageLabel/…`):
      // `apiKey` + page scope, the page always in the path.
      "clientAiUsageDaily",
      "clientAudienceNew",
      "clientConversationFeed",
      "clientConversationRecaps",
      "clientFanClaim",
      "clientFanClaimStatus",
      "clientFanProfileFromGeneration",
      // The manual resolve of a held chat-extension send: a cabinet route
      // (`session` + page scope, owner and team leads), not a client's. It
      // sorts between the client's page routes; the two after it are theirs.
      "clientSendCustodyResolve",
      "clientSpenderAwaitingReply",
      "clientSpenderStats",
      // WP-S1 (endpoints-cover serving). All eight are `owner-session` +
      // `scope: "page"`, which is also what gates the two `/money/*` routes:
      // on the REST surface `owner-session` IS the money scope (the agent
      // plane's `read:money` capability guards the same data behind a
      // different principal). Widening any of them to a chatter or agent
      // principal is its own PR with its own gate — and would have to edit
      // both this list and the kind assertion below.
      "contentComments",
      "contentMedia",
      "createFanNote",
      "followerOutreachAttempt",
      "moneyPayouts",
      "moneyRevenueMix",
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
      "statsCoverage",
      "statsMedia",
      "statsTags",
      "statsTraffic",
      "upsertFanProfile",
      "voiceNoteAudio",
      "voiceNoteCreate",
      "voiceNoteStatus",
    ]);
  });

  it("WP-S1's eight serving routes are owner-session, page-scoped, and read-only", () => {
    // The three halves of the S1 access story, pinned together because each one
    // alone is insufficient: `owner-session` (not `session`, not `any`) is what
    // makes `/money/*` money-gated on the REST surface; `scope: "page"` is what
    // makes the middleware resolve page access before a handler runs; and GET
    // with no body is what makes "serving never authorizes capture" structural
    // rather than a promise in a comment.
    const s1Routes = [
      "statsTraffic",
      "statsMedia",
      "statsTags",
      "statsCoverage",
      "contentMedia",
      "contentComments",
      "moneyRevenueMix",
      "moneyPayouts",
    ] as const;
    for (const key of s1Routes) {
      const schema = routeSchemas[key] as {
        auth: { kind: string; scope?: string };
        body?: unknown;
        tags: readonly string[];
      };
      expect(schema.auth.kind, key).toBe("owner-session");
      expect(schema.auth.scope, key).toBe("page");
      // A body on a read route is how a "read" quietly becomes a command.
      expect(schema.body, key).toBeUndefined();
      expect(schema.tags, key).toContain("insights");
    }
  });
});
