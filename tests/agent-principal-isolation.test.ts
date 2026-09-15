import { describe, expect, it } from "vitest";

import {
  agentScopeFor,
  auditCtx,
  createRequestAuth,
  pageScopeFor,
  platformRollupScopeFor,
} from "../apps/runtime/src/api/request-auth.ts";
import {
  canAccessPage,
  isAgentPrincipal,
  requireAgentPrincipal,
  requireApiKeyUser,
  requireDashboardUser,
  requireDeviceTokenUser,
  requireHumanPrincipal,
  requireOwner,
  requireSessionUser,
  type AgentAuthPrincipal,
  type HumanAuthPrincipal,
} from "../apps/runtime/src/services/auth.ts";

// Agent Read Plane slice 0b: the agent principal is a variant WITHOUT a human
// user, and every pre-agent surface refuses it. These pins are the piece-level
// half of the isolation suite; the end-to-end route half lands with slice A's
// operations (no agent route exists yet).

const agent: AgentAuthPrincipal = {
  kind: "agent",
  authMethod: "agent_key",
  agentKeyId: 3,
  keyName: "analyst",
  capabilities: ["read:messages", "read:money"],
  pageIds: [7, 9],
};

function humanOf(input: {
  authMethod: HumanAuthPrincipal["authMethod"];
  role: HumanAuthPrincipal["user"]["role"];
  assignedPageIds?: number[];
}): HumanAuthPrincipal {
  return {
    authMethod: input.authMethod,
    user: {
      id: 1,
      username: "dmitriy",
      role: input.role,
      mustChangePassword: false,
      assignedPages: [],
    },
    assignedPageIds: input.assignedPageIds ?? [],
  };
}

const owner = humanOf({ authMethod: "session", role: "owner" });
const chatter = humanOf({ authMethod: "device_token", role: "chatter", assignedPageIds: [7] });

describe("canAccessPage with an agent principal", () => {
  it("grants exactly the key's page ids", () => {
    expect(canAccessPage(agent, 7)).toBe(true);
    expect(canAccessPage(agent, 9)).toBe(true);
    expect(canAccessPage(agent, 8)).toBe(false);
  });

  it("never reaches the owner short-circuit", () => {
    // The key's creator is the owner; if the agent branch did not come first,
    // an owner-issued key would read every page and page_ids would be decor.
    const ungranted: AgentAuthPrincipal = { ...agent, pageIds: [] };
    expect(canAccessPage(ungranted, 7)).toBe(false);
    // Sanity: the same page is readable by the owner human.
    expect(canAccessPage(owner, 7)).toBe(true);
  });
});

describe("scope helpers", () => {
  it("resolves an agent to its grant, never to the unfiltered owner view", () => {
    expect(pageScopeFor(agent)).toEqual([7, 9]);
    // undefined means "no page filter at all" and must never come from a key.
    expect(pageScopeFor(agent)).not.toBeUndefined();
    expect(pageScopeFor({ ...agent, pageIds: [] })).toEqual([]);
    expect(pageScopeFor(owner)).toBeUndefined();
    expect(pageScopeFor(chatter)).toEqual([7]);
  });

  it("intersects the request with the grant and fails closed on empty", () => {
    expect(agentScopeFor(agent, [7, 8, 9])).toEqual([7, 9]);
    expect(agentScopeFor(agent, [8])).toEqual([]);
    expect(agentScopeFor(agent, [])).toEqual([]);
    // No requested list = the whole grant, still never "everything".
    expect(agentScopeFor(agent, undefined)).toEqual([7, 9]);
    expect(agentScopeFor({ ...agent, pageIds: [] }, [7])).toEqual([]);
  });

  it("leaves platformRollupScopeFor untouched for human bearers", () => {
    // Pinned because slice A handlers must reach for agentScopeFor instead:
    // this one returns the requested ids bare, on purpose (PR #43).
    expect(platformRollupScopeFor(chatter, [1, 2])).toEqual([1, 2]);
    expect(platformRollupScopeFor(owner, [1, 2])).toBeUndefined();
  });
});

describe("audit attribution", () => {
  it("files an agent action under its key, never under a user", () => {
    expect(auditCtx(agent)).toEqual({
      source: "agent_key",
      actorUserId: null,
      actorAgentKeyId: 3,
    });
    expect(auditCtx(owner)).toEqual({ source: "api", actorUserId: 1 });
  });
});

describe("principal guards", () => {
  it("recognizes the agent variant", () => {
    expect(isAgentPrincipal(agent)).toBe(true);
    expect(isAgentPrincipal(owner)).toBe(false);
    expect(isAgentPrincipal(chatter)).toBe(false);
  });

  it("refuses an agent key on every human-only guard", () => {
    // Called by name, not through a loop variable: these are assertion
    // functions, and TypeScript only honors an assertion at a direct call.
    expect(() => requireHumanPrincipal(agent)).toThrowError(/agent keys/i);
    expect(() => requireDashboardUser(agent)).toThrowError();
    expect(() => requireOwner(agent)).toThrowError();
    expect(() => requireSessionUser(agent)).toThrowError();
    expect(() => requireApiKeyUser(agent)).toThrowError();
    expect(() => requireDeviceTokenUser(agent)).toThrowError();
  });

  it("refuses every human principal on the agent guard", () => {
    for (const principal of [owner, chatter, humanOf({ authMethod: "device_token", role: "chatter" })]) {
      expect(() => requireAgentPrincipal(principal)).toThrowError(/agent key/i);
    }
    expect(() => requireAgentPrincipal(agent)).not.toThrow();
  });

  it("splits the request boundary in two: requirePrincipal is human-only", async () => {
    // The memoized request.auth short-circuits resolution, so this needs no DB.
    const auth = createRequestAuth({ config: {} } as never);
    const agentRequest = () => ({ auth: agent, headers: {}, cookies: {} });
    const humanRequest = () => ({ auth: chatter, headers: {}, cookies: {} });

    // In "log" policy mode the middleware verdict does not block, so this
    // boundary IS the isolation for every route that predates the agent plane.
    await expect(auth.requirePrincipal(agentRequest())).rejects.toThrowError(/agent keys/i);
    await expect(auth.requirePrincipal(humanRequest())).resolves.toEqual(chatter);

    await expect(auth.requireAgentKeyPrincipal(agentRequest())).resolves.toEqual(agent);
    await expect(auth.requireAgentKeyPrincipal(humanRequest())).rejects.toThrowError(/agent key/i);
  });

  it("lets the pre-agent methods through requireHumanPrincipal", () => {
    for (const principal of [
      owner,
      chatter,
      humanOf({ authMethod: "device_token", role: "team_lead" }),
    ]) {
      expect(() => requireHumanPrincipal(principal)).not.toThrow();
    }
  });
});
