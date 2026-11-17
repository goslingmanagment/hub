import { describe, expect, it } from "vitest";

import { routeSchemas } from "@agency_hub_core/contracts";
import { buildJoinLink } from "@agency_hub_core/ui/teamAccess";
import { CONTENT_MANAGER_OPERATIONS, contentManagerRefusal } from "../apps/runtime/src/services/content-manager-operations.ts";

// A content manager's login opens ContentOps alone (products plan §4.1): no console, no Workboard. The table is the
// whole of what it may call; every other operation of the contract that takes a principal is refused to it, so an
// operation added later is closed until someone opens it.

const routes = Object.entries(routeSchemas as Record<string, { auth?: { kind?: string } }>);
const user = (role: string) => ({ authMethod: "session", user: { id: 1, username: "x", role }, assignedPageIds: [] }) as unknown as Parameters<typeof contentManagerRefusal>[1];

describe("a content manager's operations", () => {
  it("are operations of the contract that take a person's own sign-in", () => {
    const kinds = new Map(routes.map(([key, route]) => [key, route.auth?.kind]));
    for (const key of CONTENT_MANAGER_OPERATIONS) {
      expect(kinds.has(key), key).toBe(true);
      expect(["any", "any-session", "device-token"], key).toContain(kinds.get(key));
    }
  });

  it("refuse every other operation that takes a principal: the console's, Workboard's, the extension's", () => {
    const refused = routes
      .filter(([, route]) => route.auth?.kind !== "public" && route.auth?.kind !== "hmac")
      .map(([key]) => key)
      .filter((key) => !CONTENT_MANAGER_OPERATIONS.has(key));
    expect(refused.length).toBeGreaterThan(100);
    for (const key of refused) expect(contentManagerRefusal(key, user("content_manager"))?.statusCode, key).toBe(403);
    // Workboard's reads open to every session (fans moved there in #1307, the teams' reads): never a content manager's.
    const workboardReads = [
      "fanPages", "pageFanCard", "crossPageFanDetail", "spenderSeries", "pageFanTransactions", "crossPageFanTransactions",
      "pageFanWorkedWith", "teamShifts", "teamShiftReview", "teamShiftSales", "teamChatterStats", "teamChatterNumbers",
      "teamPeople", "teamRoles", "teamRoleSet", "mattersWaiting", "overview",
    ];
    const kinds = new Map(routes.map(([key, route]) => [key, route.auth?.kind]));
    for (const key of workboardReads) {
      expect(kinds.has(key), key).toBe(true);
      expect(contentManagerRefusal(key, user("content_manager"))?.statusCode, key).toBe(403);
    }
  });

  it("refuse a content manager only, never the owner, a team lead, a chatter or an agent", () => {
    for (const key of CONTENT_MANAGER_OPERATIONS) expect(contentManagerRefusal(key, user("content_manager")), key).toBeNull();
    for (const role of ["owner", "team_lead", "chatter"]) expect(contentManagerRefusal("teamShifts", user(role)), role).toBeNull();
    expect(contentManagerRefusal("teamShifts", { kind: "agent" } as unknown as Parameters<typeof contentManagerRefusal>[1])).toBeNull();
    expect(contentManagerRefusal("teamShifts", null)).toBeNull();
  });
});

describe("a content manager's link", () => {
  it("opens ContentOps' own page; every other login's opens Workboard's name", () => {
    expect(buildJoinLink("https://hub.gosling-agency.ru", "s3cret", "content_manager")).toBe("https://contentops.gosling-agency.ru/join#s3cret");
    expect(buildJoinLink("https://hub.gosling-agency.ru", "s3cret", "chatter")).toBe("https://workboard.gosling-agency.ru/join#s3cret");
  });
});
