import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_TOKEN_PROFILES,
  clientConversationRecapsQuerySchema,
  clientConversationRecapsResponseSchema,
  clientPageFanParamsSchema,
  routeSchemas,
} from "@agency_hub_core/contracts";
import { usableFanSummaryPredicate, type UsableRecapBody } from "@agency_hub_core/db";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { CLIENT_FEATURE_REQUIREMENTS, evaluateClientFeature } from "../apps/runtime/src/services/client-features.ts";
import { toClientRecapBody } from "../apps/runtime/src/services/client-recaps.ts";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import * as sdk from "../packages/sdk/src/index.ts";

// chat-extension H-13: the shared recaps read (`clientConversationRecaps`).
// The route's behaviour over real rows is tests/client-recaps.integration.test.ts;
// this file holds the shapes and the one rule every recap reader shares.

/**
 * The response as the chat extension FROZE it (its contracts v1.0.0,
 * packages/contracts/src/hub/recaps.ts: `RecapBodySchema`, `SharedRecapsSchema`
 * with `boundedText(100)`, `IsoTimestampSchema`, `OpenTokenSchema`, `z.int()`),
 * restated in this repo's zod. Whatever the hub answers must parse here: a
 * response the client's schema refuses is a recap the chatter cannot open.
 */
const FROZEN_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const frozenRecapBody = z.object({
  generationRef: z.string().min(1).max(100),
  generatedAt: z.string().max(40).regex(FROZEN_ISO_TIMESTAMP),
  personaDefinitionId: z.string().nullable(),
  coverage: z.object({
    transcriptCoverage: z.string().min(1).max(64).nullable(),
    requestedCount: z.int().nullable(),
    keptCount: z.int().nullable(),
  }),
  text: z.string(),
});
const frozenSharedRecaps = z.object({
  full: frozenRecapBody.nullable(),
  short: frozenRecapBody.nullable(),
  fullSavedToProfile: z.boolean(),
});

const PERSONA = `v1:${"a".repeat(43)}`;

function storedRecap(over: Partial<UsableRecapBody> = {}): UsableRecapBody {
  return {
    generationRef: "0b0e7c0e-6f0a-4a43-9d5c-2f1d7c9d1a11",
    createdAt: new Date("2026-10-03T12:34:56.789Z"),
    completion: "Recap text",
    personaDefinitionId: PERSONA,
    transcriptCoverage: "full-history",
    requestedCount: 1500,
    keptCount: 1432,
    ...over,
  };
}

describe("shared recaps contract", () => {
  it("declares a device-token GET with page scope, the page and the fan in the path, and every status it answers", () => {
    const route = routeSchemas.clientConversationRecaps as {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      body?: unknown;
      response: Record<number, unknown>;
    };
    expect(route.auth).toEqual({ kind: "apiKey", scope: "page" });
    expect(route.tags).toEqual(["client"]);
    expect(route.body).toBeUndefined();
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    expect(sdk.kernelOperations.clientConversationRecaps).toEqual({
      method: "GET",
      path: "/api/v1/client/pages/:pageLabel/conversations/:fanRef/recaps",
    });
  });

  it("takes the fan as the one numeric id shape and a strict query with a bounded persona id", () => {
    expect(clientPageFanParamsSchema.safeParse({ pageLabel: "lora-of", fanRef: "777000777" }).success).toBe(true);
    for (const fanRef of ["0777", "group-777", "", "7".repeat(31)]) {
      expect(clientPageFanParamsSchema.safeParse({ pageLabel: "lora-of", fanRef }).success, fanRef).toBe(false);
    }

    expect(clientConversationRecapsQuerySchema.parse({})).toEqual({});
    expect(clientConversationRecapsQuerySchema.parse({ personaDefinitionId: PERSONA })).toEqual({ personaDefinitionId: PERSONA });
    for (const query of [
      { personaDefinitionId: "p".repeat(15) },
      { personaDefinitionId: "p".repeat(101) },
      { personaDefinitionId: "" },
      // The page and the fan are the path's; a second way to name them is refused.
      { pageLabel: "mia-of" },
      { fanRef: "777000888" },
      { conversationRef: "777000888" },
      { userId: "1" },
    ]) {
      expect(clientConversationRecapsQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
    }
  });

  it("answers a response an installed SDK keeps reading: not strict, open coverage token, nullable provenance", () => {
    const slot = toClientRecapBody(storedRecap());
    const parsed = clientConversationRecapsResponseSchema.parse({
      full: { ...slot, coverage: { ...slot.coverage, transcriptCoverage: "some-later-coverage", laterKey: 1 }, laterKey: 1 },
      short: null,
      fullSavedToProfile: true,
      laterKey: { x: 1 },
    });
    // A key a later hub adds is stripped, never a failed parse.
    expect(JSON.stringify(parsed)).not.toContain("laterKey");
    expect(parsed.full?.coverage.transcriptCoverage).toBe("some-later-coverage");
    expect(clientConversationRecapsResponseSchema.safeParse({ full: null, short: null, fullSavedToProfile: false }).success).toBe(true);
    // The three keys are the contract: a response without one is refused.
    expect(clientConversationRecapsResponseSchema.safeParse({ full: null, short: null }).success).toBe(false);
  });

  it("shapes a stored recap exactly as the client froze it", () => {
    const body = toClientRecapBody(storedRecap());
    expect(body).toEqual({
      generationRef: "0b0e7c0e-6f0a-4a43-9d5c-2f1d7c9d1a11",
      generatedAt: "2026-10-03T12:34:56.789Z",
      personaDefinitionId: PERSONA,
      coverage: { transcriptCoverage: "full-history", requestedCount: 1500, keptCount: 1432 },
      text: "Recap text",
    });
    const response = { full: body, short: null, fullSavedToProfile: false };
    expect(frozenSharedRecaps.parse(response)).toEqual(response);
    expect(clientConversationRecapsResponseSchema.parse(response)).toEqual(response);
  });

  it("reads provenance the gateway did not write in the wire's shape as not recorded, never as a body the client refuses", () => {
    // `params` is JSON: nothing in the database holds these four values to a type.
    const odd: unknown[] = [
      undefined, null, "", "x".repeat(65), 0, -3, 12.5, Number.NaN, 2 ** 53, "1500", true, [], {}, { kind: "window" },
    ];
    for (const value of odd) {
      const body = toClientRecapBody(storedRecap({
        personaDefinitionId: value,
        transcriptCoverage: value,
        requestedCount: value,
        keptCount: value,
      }));
      const label = JSON.stringify(value) ?? String(value);
      expect(frozenRecapBody.safeParse(body).success, label).toBe(true);
      expect(clientConversationRecapsResponseSchema.shape.full.safeParse(body).success, label).toBe(true);
      // A string is a persona id as stored; a token keeps the open token's bounds.
      expect(body.personaDefinitionId, label).toBe(typeof value === "string" ? value : null);
      expect(body.coverage.transcriptCoverage, label).toBe(value === "1500" ? "1500" : null);
      const integer = typeof value === "number" && Number.isSafeInteger(value) ? value : null;
      expect([body.coverage.requestedCount, body.coverage.keptCount], label).toEqual([integer, integer]);
    }
    // The bounds themselves pass.
    expect(toClientRecapBody(storedRecap({ transcriptCoverage: "x".repeat(64) })).coverage.transcriptCoverage).toHaveLength(64);
    expect(toClientRecapBody(storedRecap({ transcriptCoverage: "window" })).coverage.transcriptCoverage).toBe("window");
  });

  it("exports the known coverage values through the SDK and puts the route on the narrow token's list", () => {
    expect(contracts.CLIENT_RECAP_TRANSCRIPT_COVERAGES).toEqual(["full-history", "window"]);
    expect(sdk.CLIENT_RECAP_TRANSCRIPT_COVERAGES).toBe(contracts.CLIENT_RECAP_TRANSCRIPT_COVERAGES);
    expect(CLIENT_TOKEN_PROFILES["chat-extension"].operations).toContain("clientConversationRecaps");
  });

  it("is served, with the dossier save (H-5): Recap is available where the owner switched it on, and only there", () => {
    expect(CLIENT_FEATURE_REQUIREMENTS.recap.capabilities).toEqual(["shared-recaps-v1", "recap-profile-v1"]);
    expect(SERVED_CLIENT_CAPABILITIES).toEqual(expect.arrayContaining(["shared-recaps-v1", "recap-profile-v1"]));
    const page = { label: "lora-of", platform: "onlyfans", platformAccountId: "100000001" } as const;
    const recap = (settings: Parameters<typeof evaluateClientFeature>[0]["settings"]) => evaluateClientFeature({
      settings,
      page,
      flag: "recap",
      served: SERVED_CLIENT_CAPABILITIES,
    });
    expect(recap({ enabled: true, features: { "*": { recap: true } }, hostBindings: {} })).toEqual({ available: true });
    // Still inert at rest: the master switch and the flag are the owner's.
    expect(recap({ enabled: false, features: { "*": { recap: true } }, hostBindings: {} }))
      .toEqual({ available: false, reason: "disabled" });
    expect(recap({ enabled: true, features: {}, hostBindings: {} })).toEqual({ available: false, reason: "flag_off" });
  });
});

describe("usableFanSummaryPredicate", () => {
  const render = (mode: "full" | "short") => new PgDialect().sqlToQuery(usableFanSummaryPredicate(mode));

  it("is one parenthesised condition: a completed, non-exhausted, non-empty fan-summary of the mode with no contextScope", () => {
    const { sql, params } = render("full");
    const column = (name: string) => `"ai_generation_content"."${name}"`;
    expect(sql).toBe(
      `(${column("feature")} = $1`
      + ` and ${column("params")} ->> 'summaryMode' = $2`
      + ` and ${column("params")} ->> 'outcome' = 'completed'`
      + ` and ${column("params")} ->> 'stopReason' is not null`
      + ` and ${column("params")} ->> 'stopReason' not in ('max_tokens', 'length')`
      + ` and btrim(${column("completion")}, $3) <> ''`
      + ` and ${column("params")} ->> 'contextScope' is null)`,
    );
    expect(params.slice(0, 2)).toEqual(["fan-summary", "full"]);
    expect(render("short").params.slice(0, 2)).toEqual(["fan-summary", "short"]);
    expect(render("short").sql).toBe(sql);
  });
});
