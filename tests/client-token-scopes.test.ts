import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLIENT_HEALTH_INGEST_KIND,
  CLIENT_TOKEN_PROFILE_NAMES,
  CLIENT_TOKEN_PROFILES,
  authIssueDeviceTokenWithPasswordBodySchema,
  authIssueDeviceTokenWithPasswordResponseSchema,
  clientTokenAllowlistApplies,
  operationsOutsideClientTokenProfile,
  routeSchemas,
  type RouteAuthPolicy,
} from "@agency_hub_core/contracts";
import { platforms, type Platform } from "@agency_hub_core/shared";

import { OPERATION_FEATURES } from "../apps/runtime/src/modules/ai/index.ts";
import { clientAiFeatureExistsOn, clientAiFeatureFlag } from "../apps/runtime/src/services/client-ai-switch.ts";
import { CLIENT_FEATURE_REQUIREMENTS, clientFeatureExistsOn } from "../apps/runtime/src/services/client-features.ts";
import {
  CLIENT_TOKEN_ROUTE_REFUSAL_MESSAGE,
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

  it("[R20 HF-4б] holds the voice-note routes, page-scoped; the released clients' page list stays off", () => {
    for (const key of ["voiceNoteCreate", "voiceNoteStatus", "voiceNoteAudio", "voiceNoteAllowance"]) {
      expect(operations, key).toContain(key);
      expect(schemas[key]!.auth, key).toEqual({ kind: "apiKey", scope: "page" });
      expect(paths[key]!.path, key).toMatch(/^\/api\/v1\/pages\/:pageLabel\/voice-notes(\/|$)/);
    }
    // `capabilities.voiceNotes` on GET /api/v1/pages is the released clients'
    // hint; the narrow token reads the bootstrap's `voice` instead.
    expect(operations).not.toContain("pages");
    expect(clientTokenRouteRefusal("pages", principal({ clientProfile: "chat-extension" }))).toBeInstanceOf(ForbiddenError);
  });

  it("captures only ai_acceptance, a journaled kind, and client_health, which is never journaled", () => {
    expect(clientTokenIngestKinds("chat-extension")).toEqual(["ai_acceptance", "client_health"]);
    // Every kind of the profile has a home: the journal's allowlist, or the
    // health intake (H-11b), which folds the report into rollups with no user.
    expect(EXTENSION.ingestKinds.filter((kind) => !INGEST_KIND_ALLOWLIST.has(kind))).toEqual([CLIENT_HEALTH_INGEST_KIND]);
  });

  it("finds the operations a frozen SDK calls that the profile refuses (the H-1a registry check)", () => {
    expect(operationsOutsideClientTokenProfile("chat-extension", ["me", "clientBootstrap"])).toEqual([]);
    expect(operationsOutsideClientTokenProfile("chat-extension", ["me", "pages", "aiPersonasList"]))
      .toEqual(["pages", "aiPersonasList"]);
    // The sign-in and health take no principal: no token is checked there.
    expect(operationsOutsideClientTokenProfile("chat-extension", ["authIssueDeviceTokenWithPassword", "health"]))
      .toEqual([]);
    expect(operationsOutsideClientTokenProfile("chat-extension", ["noSuchRoute"])).toEqual(["noSuchRoute"]);
  });

  // Critic 2 on H-1a: a registered chat-extension SDK must call nothing its
  // narrow token is refused, and the compat suite must sign it in narrow, or a
  // key missing from the list shows up first in prod. H-1a's registry
  // (apps/runtime/src/services/client-sdk-registry.ts) is not on this PR's
  // base; this arms itself the moment both are on main, in either merge order,
  // and fails the PR that lands second until the check holds. (H-1a's own
  // laneFor already refuses a chat-extension row that has no compat lane.)
  it("holds every registered chat-extension SDK inside the list, run with a narrow token", async () => {
    const registryFile = resolve("apps/runtime/src/services/client-sdk-registry.ts");
    if (!existsSync(registryFile)) return;
    const { CLIENT_SDK_REGISTRY } = await import(registryFile) as {
      CLIENT_SDK_REGISTRY: ReadonlyArray<{
        bundleSha256: string;
        clients: ReadonlyArray<{ name: string }>;
        operations: readonly string[];
      }>;
    };
    expect(Array.isArray(CLIENT_SDK_REGISTRY)).toBe(true);
    const rows = CLIENT_SDK_REGISTRY.filter((row) => row.clients.some((client) => client.name === "chat-extension"));
    for (const row of rows) {
      expect(operationsOutsideClientTokenProfile("chat-extension", row.operations), row.bundleSha256).toEqual([]);
    }
    if (rows.length > 0) {
      const compat = ["tests/client-sdk-compat.integration.test.ts", "tests/helpers/client-sdk-compat.ts"]
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");
      expect(compat, "the compat suite signs chat-extension rows in with client: \"chat-extension\"")
        .toMatch(/client:\s*["']chat-extension["']/);
    }
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
  const long = "9".repeat(65);

  it("is the profile's, with the version from the header as sent, or unknown", () => {
    expect(clientTokenIngestProducer("chat-extension", "chat-extension/1.4.2")).toBe("chat-extension@1.4.2");
    expect(clientTokenIngestProducer("chat-extension", "chat-extension/0.1.0-dev")).toBe("chat-extension@0.1.0-dev");
    expect(clientTokenIngestProducer("chat-extension", "chat-extension/ 1.2.3")).toBe("chat-extension@ 1.2.3");
    expect(clientTokenIngestProducer("chat-extension", `chat-extension/${long}`)).toBe(`chat-extension@${long}`);
    for (const header of [null, "", "chat-extension/", "chat-extension", "desktop/0.1.64", "harvest-0.1.64", "2.7.1",
      "x-chat-extension/1.0.0"]) {
      expect(clientTokenIngestProducer("chat-extension", header), String(header)).toBe("chat-extension@unknown");
    }
  });
});

describe("the narrow token's AI switch", () => {
  const flagsOn = (platform: Platform) =>
    Object.fromEntries(OPERATION_FEATURES.map((feature) => [feature, clientAiFeatureFlag(feature, platform)]));

  it("on OnlyFans puts Coach, Recap, Review, the voice script and the notes fill behind their own flags, every other feature behind the master switch", () => {
    // As before R20 HF-12, but the voice script and the notes fill: voice notes reach OnlyFans pages behind `voice`,
    // the notes (kept in OnlyMonster's fan notes) behind `notes` and `notesFill`, as on Fansly.
    expect(flagsOn("onlyfans")).toEqual({
      "fast-reply": null,
      "improve-draft": null,
      "help-me": null,
      "fan-summary": "recap",
      "chat-review": "review",
      "ping": null,
      "hi-greeting": null,
      "coach-chat": "coach",
      "voice-script": "voice",
      "fan-notes-fill": "notesFill",
    });
  });

  it("[R20 HF-12] on Fansly puts Reply, Fix, Hi and Ping behind drafts, the voice script behind voice, the notes fill behind notesFill", () => {
    expect(flagsOn("fansly")).toEqual({
      "fast-reply": "drafts",
      "improve-draft": "drafts",
      "help-me": null,
      "fan-summary": "recap",
      "chat-review": "review",
      "ping": "drafts",
      "hi-greeting": "drafts",
      "coach-chat": "coach",
      "voice-script": "voice",
      "fan-notes-fill": "notesFill",
    });
    // `drafts` exists on Fansly and Telegram (Reply and Fix there); `voice` and `notesFill` are on OnlyFans and Fansly.
    expect(Object.keys(CLIENT_FEATURE_REQUIREMENTS.drafts)).toEqual(["fansly", "telegram"]);
    for (const flag of ["voice", "notesFill"] as const) {
      expect(Object.keys(CLIENT_FEATURE_REQUIREMENTS[flag]).sort(), flag).toEqual(["fansly", "onlyfans"]);
    }
  });

  it("[R20 HF-2] Help is the extension's on OnlyFans only; every other feature exists on both, and on Fansly each waits for a flag", () => {
    // The owner removed Help from the extension's Fansly site: the narrow token's Help there is refused
    // `platform_unsupported` (the route, tests/client-ai-fansly-drafts.integration.test.ts).
    expect(clientAiFeatureExistsOn("help-me", "onlyfans")).toBe(true);
    expect(clientAiFeatureExistsOn("help-me", "fansly")).toBe(false);
    for (const feature of OPERATION_FEATURES.filter((name) => name !== "help-me")) {
      for (const platform of platforms) {
        expect(clientAiFeatureExistsOn(feature, platform), `${platform} ${feature}`).toBe(true);
      }
      // On Fansly no generation is left to the master switch alone, and its flag exists there.
      const flag = clientAiFeatureFlag(feature, "fansly");
      expect(flag, feature).not.toBeNull();
      expect(clientFeatureExistsOn(flag!, "fansly"), feature).toBe(true);
    }
    // Coach, Recap and Review keep their flags, which exist on Fansly since HF-2; Coach on Telegram too.
    expect(Object.keys(CLIENT_FEATURE_REQUIREMENTS.coach)).toEqual(["onlyfans", "fansly", "telegram"]);
    for (const flag of ["recap", "review"] as const) {
      expect(Object.keys(CLIENT_FEATURE_REQUIREMENTS[flag]), flag).toEqual(["onlyfans", "fansly"]);
    }
    // A feature the switch does not know is not its to refuse by platform (the feature route refuses it).
    for (const feature of ["constructor", "toString", "__proto__", "hasOwnProperty", "scan"]) {
      for (const platform of platforms) {
        expect(clientAiFeatureExistsOn(feature, platform), `${platform} ${feature}`).toBe(true);
      }
    }
  });

  it("names no flag for a feature it does not know, prototype names included", () => {
    for (const platform of platforms) {
      for (const feature of ["constructor", "toString", "__proto__", "hasOwnProperty", "scan"]) {
        expect(clientAiFeatureFlag(feature, platform), `${platform} ${feature}`).toBeNull();
      }
    }
  });
});
