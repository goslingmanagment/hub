import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CLIENT_TOKEN_PROFILE_NAMES,
  CLIENT_TOKEN_PROFILES,
  authIssueDeviceTokenWithPasswordBodySchema,
  authIssueDeviceTokenWithPasswordResponseSchema,
  isClientTokenProfile,
  operationsOutsideClientTokenProfile,
  routeSchemas,
  type RouteAuthPolicy,
} from "@agency_hub_core/contracts";

import { clientAiFeatureFlag } from "../apps/runtime/src/services/client-ai-switch.ts";
import {
  CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE,
  clientTokenAllowlistApplies,
  clientTokenIngestKinds,
  clientTokenIngestProducer,
  clientTokenRouteRefusal,
} from "../apps/runtime/src/services/client-token-profile.ts";
import type { AuthPrincipal, HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { ForbiddenError } from "../apps/runtime/src/services/errors.ts";
import { INGEST_KIND_ALLOWLIST } from "../apps/runtime/src/services/ingest-observations.ts";
import { kernelOperations } from "../packages/sdk/src/operations.ts";

// chat-extension H-3: the narrow device token's allowlist. The integration
// half (every route walked by a narrow and a full token in both enforcement
// modes) is tests/device-token-client-profile.integration.test.ts.

const EXTENSION = CLIENT_TOKEN_PROFILES["chat-extension"];
const operations: readonly string[] = EXTENSION.operations;
const schemas = routeSchemas as unknown as Record<string, { auth?: RouteAuthPolicy }>;
const paths = kernelOperations as unknown as Record<string, { method: string; path: string }>;

function principal(overrides: Partial<HumanAuthPrincipal> = {}): HumanAuthPrincipal {
  return {
    authMethod: "device_token",
    user: { id: 7, username: "chatter", role: "chatter" } as HumanAuthPrincipal["user"],
    assignedPageIds: [1],
    deviceTokenId: 11,
    ...overrides,
  };
}

describe("CLIENT_TOKEN_PROFILES[\"chat-extension\"]", () => {
  it("names only routes that exist, once each", () => {
    expect(operations.filter((key) => !(key in schemas))).toEqual([]);
    expect(new Set(operations).size).toBe(operations.length);
  });

  it("holds no cookie-session, agent, activation or monitoring route", () => {
    const refusedKinds = new Set(["owner-session", "session", "any-session", "agentKey", "pending-device-token", "monitoring"]);
    expect(operations.filter((key) => refusedKinds.has(schemas[key]!.auth!.kind))).toEqual([]);
  });

  it("reaches no OFAPI route and no event stream", () => {
    const reached = operations.map((key) => paths[key]?.path);
    expect(reached.every((path) => typeof path === "string")).toBe(true);
    expect(reached.filter((path) => path!.startsWith("/api/v1/ofapi") || path!.startsWith("/api/v1/events"))).toEqual([]);
  });

  it("never lists the persona texts, the raw gateway, Fansly outreach or the top spenders", () => {
    for (const key of [
      "aiPersonasList",
      "aiPersonaUpsert",
      "aiPersonaArchive",
      "aiGatewayStream",
      "followerOutreachAttempt",
      "pageTopSpenders",
      "eventsStream",
      "eventsSnapshot",
      "eventsV2Stream",
      "eventsV2Snapshot",
      "eventsV2Facts",
    ]) {
      expect(key in schemas, key).toBe(true);
      expect(operations, key).not.toContain(key);
    }
  });

  it("captures only ai_acceptance, a kind the capture lane already journals", () => {
    expect(clientTokenIngestKinds("chat-extension")).toEqual(["ai_acceptance"]);
    expect(EXTENSION.ingestKinds.every((kind) => INGEST_KIND_ALLOWLIST.has(kind))).toBe(true);
  });

  it("finds the operations a frozen SDK calls that the profile refuses (the H-1a registry check)", () => {
    expect(operationsOutsideClientTokenProfile("chat-extension", ["me", "clientBootstrap"])).toEqual([]);
    expect(operationsOutsideClientTokenProfile("chat-extension", ["me", "pages", "aiPersonasList"]))
      .toEqual(["pages", "aiPersonasList"]);
  });

  it("is the one profile name, as the sign-in body and the database spell it", () => {
    expect(CLIENT_TOKEN_PROFILE_NAMES).toEqual(["chat-extension"]);
    expect(isClientTokenProfile("chat-extension")).toBe(true);
    for (const value of ["desktop", "toString", "constructor", "", null, undefined, 1]) {
      expect(isClientTokenProfile(value), String(value)).toBe(false);
    }
    const sql = readFileSync("packages/db/migrations/0236_device_token_client_profile.sql", "utf8");
    const check = /client_profile in \(([^)]*)\)/.exec(sql)?.[1];
    expect(check?.split(",").map((value) => value.trim().replace(/^'|'$/g, ""))).toEqual([...CLIENT_TOKEN_PROFILE_NAMES]);
  });
});

describe("the password sign-in body and its echo", () => {
  const base = { username: "chatter", password: "secret", label: "Firefox · macOS · ChatSpace", mode: "active" as const };

  it("accepts a known client on an active sign-in only", () => {
    expect(authIssueDeviceTokenWithPasswordBodySchema.parse({ ...base, client: "chat-extension" }).client)
      .toBe("chat-extension");
    expect(authIssueDeviceTokenWithPasswordBodySchema.parse(base).client).toBeUndefined();
    expect(authIssueDeviceTokenWithPasswordBodySchema.safeParse({ ...base, client: "desktop" }).success).toBe(false);
    const pending = authIssueDeviceTokenWithPasswordBodySchema.safeParse({ ...base, mode: "pending", client: "chat-extension" });
    expect(pending.success).toBe(false);
    expect(pending.error?.issues.map((issue) => issue.path)).toEqual([["client"]]);
  });

  it("offers exactly the profiles the hub knows", () => {
    const client = authIssueDeviceTokenWithPasswordBodySchema.shape.client.unwrap();
    expect(client.options).toEqual([...CLIENT_TOKEN_PROFILE_NAMES]);
  });

  it("echoes the profile as an open string: null, absent (an older hub) or a later name all parse", () => {
    const issued = {
      mode: "active", token: "t", id: 1, label: "l", keyPrefix: "p", expiresAt: "2026-10-03T00:00:00.000Z",
    };
    for (const client of [null, "chat-extension", "some-later-client"]) {
      expect(authIssueDeviceTokenWithPasswordResponseSchema.parse({ ...issued, client })).toMatchObject({ client });
    }
    expect(authIssueDeviceTokenWithPasswordResponseSchema.parse(issued)).not.toHaveProperty("client");
  });
});

describe("the route guard", () => {
  it("applies to every kind that takes a principal", () => {
    const kinds: Array<[RouteAuthPolicy["kind"], boolean]> = [
      ["public", false], ["hmac", false], ["pending-device-token", false],
      ["monitoring", true], ["session", true], ["any-session", true], ["owner-session", true],
      ["apiKey", true], ["device-token", true], ["agentKey", true], ["any", true],
    ];
    for (const [kind, applies] of kinds) {
      expect(clientTokenAllowlistApplies({ kind } as RouteAuthPolicy), kind).toBe(applies);
    }
  });

  it("refuses a narrow token outside its list with a reason-less 403, and nobody else", () => {
    const narrow = principal({ clientProfile: "chat-extension" });
    expect(clientTokenRouteRefusal("clientBootstrap", narrow)).toBeNull();
    expect(clientTokenRouteRefusal("ingestObservations", narrow)).toBeNull();
    const refusal = clientTokenRouteRefusal("pages", narrow);
    expect(refusal).toBeInstanceOf(ForbiddenError);
    expect(refusal).toMatchObject({ statusCode: 403, code: "forbidden", message: CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE });
    expect(refusal).not.toHaveProperty("reason");

    const agent: AuthPrincipal = {
      kind: "agent", authMethod: "agent_key", agentKeyId: 1, keyName: "k", capabilities: [], pageIds: [],
    };
    for (const other of [principal(), principal({ authMethod: "session", authSessionId: 3 }), agent, null]) {
      expect(clientTokenRouteRefusal("pages", other)).toBeNull();
      expect(clientTokenRouteRefusal("adminListUsers", other)).toBeNull();
    }
  });
});

describe("the narrow token's capture producer", () => {
  it("is the profile's, with the version from the header or unknown", () => {
    expect(clientTokenIngestProducer("chat-extension", "chat-extension/1.4.2")).toBe("chat-extension@1.4.2");
    expect(clientTokenIngestProducer("chat-extension", "chat-extension/0.1.0-dev")).toBe("chat-extension@0.1.0-dev");
    for (const header of [null, "", "chat-extension/", "chat-extension/ ", "desktop/0.1.64", "harvest-0.1.64", "2.7.1",
      `chat-extension/${"9".repeat(65)}`]) {
      expect(clientTokenIngestProducer("chat-extension", header), String(header)).toBe("chat-extension@unknown");
    }
  });
});

describe("the narrow token's AI switch", () => {
  it("puts Coach, Recap and Review behind their own flags, every other feature behind the master switch", () => {
    expect(clientAiFeatureFlag("coach-chat")).toBe("coach");
    expect(clientAiFeatureFlag("fan-summary")).toBe("recap");
    expect(clientAiFeatureFlag("chat-review")).toBe("review");
    for (const feature of ["fast-reply", "improve-draft", "hi-greeting", "ping", "constructor", "toString"]) {
      expect(clientAiFeatureFlag(feature), feature).toBeNull();
    }
  });
});

describe("migration 0236 and the SDK surface", () => {
  it("adds the column, its check and the immutability trigger, nothing else", () => {
    const sql = readFileSync("packages/db/migrations/0236_device_token_client_profile.sql", "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .replace(/\$\$[\s\S]*?\$\$/g, () => "$$…$$");
    const statements = sql.split(/;\s*(?:\n|$)/).map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(statements).toEqual([
      "alter table device_tokens add column client_profile text check (client_profile is null or client_profile in ('chat-extension'))",
      "create or replace function device_tokens_client_profile_immutable() returns trigger language plpgsql as $$…$$",
      "create trigger device_tokens_client_profile_immutable before update of client_profile on device_tokens for each row execute function device_tokens_client_profile_immutable()",
    ]);
  });

  it("is rollback-compatible", () => {
    const deploy = readFileSync("scripts/deploy-production.sh", "utf8");
    expect(deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0])
      .toContain('"0236_device_token_client_profile.sql"');
  });

  it("re-exports the profiles from the generated @kernel/sdk", () => {
    const sdkIndex = readFileSync("packages/sdk/src/index.ts", "utf8");
    expect(sdkIndex).toContain("  CLIENT_TOKEN_PROFILES,");
    expect(sdkIndex).toContain("  type ClientTokenProfile,");
  });
});
