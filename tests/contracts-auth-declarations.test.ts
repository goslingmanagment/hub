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

  it("keeps both follower blast-radius steps owner-session only", () => {
    expect(routeSchemas.adminFollowersReconcileOverridePreview.auth).toEqual({
      kind: "owner-session",
    });
    expect(routeSchemas.adminFollowersReconcileOverrideApply.auth).toEqual({
      kind: "owner-session",
    });
  });

  it("WP-S1's six serving routes are owner-session, page-scoped, and read-only", () => {
    // The three halves of the S1 access story, pinned together because each one
    // alone is insufficient: `owner-session` (not `session`, not `any`) is what
    // makes `/money/*` money-gated on the REST surface; `scope: "page"` is what
    // makes the middleware resolve page access before a handler runs; and GET
    // with no body is what makes "serving never authorizes capture" structural
    // rather than a promise in a comment.
    const s1Routes = [
      "statsTags",
      "statsCoverage",
      "statsHoldings",
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
