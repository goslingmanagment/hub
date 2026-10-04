import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as contracts from "@agency_hub_core/contracts";
import {
  CLIENT_GENERATION_NOT_ELIGIBLE_REASONS,
  CLIENT_TOKEN_PROFILES,
  clientFanProfileFromGenerationBodySchema,
  clientFanProfileFromGenerationResponseSchema,
  clientPageFanParamsSchema,
  errorResponseSchema,
  routeSchemas,
  upsertFanProfileBodySchema,
} from "@agency_hub_core/contracts";
import type { OwnGenerationForProfile } from "@agency_hub_core/db";

import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import {
  DOSSIER_BODY_MAX_CHARS,
  generationRefusalReason,
} from "../apps/runtime/src/services/client-profile-from-generation.ts";
import { GenerationNotEligibleError, GenerationNotReadyError } from "../apps/runtime/src/services/errors.ts";
import * as sdk from "../packages/sdk/src/index.ts";

// chat-extension H-5: the dossier save from a stored generation
// (`clientFanProfileFromGeneration`). The route's behaviour over real rows is
// tests/client-profile-from-generation.integration.test.ts; this file holds the
// shapes and the rule that names a refusal.

/**
 * The request and the response as the chat extension FROZE them (its contracts
 * v1.0.0, packages/contracts/src/hub/recaps.ts:
 * `ProfileFromGenerationRequestSchema` without the two path parameters, and
 * `ProfileFromGenerationResponseSchema`), restated in this repo's zod. The hub
 * must take every body the client's schema lets out, and answer only what the
 * client's schema reads.
 */
const FROZEN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FROZEN_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const frozenIsoTimestamp = z.string().max(40).regex(FROZEN_ISO_TIMESTAMP);
const frozenRequestBody = z.strictObject({
  generationRef: z.string().regex(FROZEN_UUID),
  clientRequestId: z.string().regex(FROZEN_UUID).optional(),
});
const frozenResponse = z.object({
  outcome: z.enum(["created", "existing"]),
  profile: z.object({
    version: z.int().gte(1),
    createdAt: frozenIsoTimestamp,
    sourceGeneratedAt: frozenIsoTimestamp.nullable(),
  }),
});

const GENERATION_REF = "0b0e7c0e-6f0a-4a43-9d5c-2f1d7c9d1a11";
const CLIENT_REQUEST_ID = "5d3c1c0a-7a7e-4c0b-9a55-0c8f6e1b2d33";

/** A stored generation the save accepts; `over` breaks it one way at a time. */
function generation(over: Partial<OwnGenerationForProfile> = {}): OwnGenerationForProfile {
  return {
    pageId: 1,
    conversationRef: "777000777",
    fanRef: null,
    createdAt: new Date("2026-10-03T12:34:56.789Z"),
    completion: "Recap text",
    usableFullSummary: true,
    feature: "fan-summary",
    summaryMode: "full",
    outcome: "completed",
    stopReason: "end_turn",
    blank: false,
    contextScoped: false,
    ...over,
  };
}

describe("dossier-from-generation contract", () => {
  it("declares a device-token POST with page scope, the page and the fan in the path, and every status it answers", () => {
    const route = routeSchemas.clientFanProfileFromGeneration as {
      auth: { kind: string; scope?: string };
      tags: readonly string[];
      querystring?: unknown;
      response: Record<number, unknown>;
    };
    expect(route.auth).toEqual({ kind: "apiKey", scope: "page" });
    expect(route.tags).toEqual(["client"]);
    expect(route.querystring).toBeUndefined();
    expect(Object.keys(route.response).sort()).toEqual(["200", "400", "401", "403", "404", "409"]);
    expect(sdk.kernelOperations.clientFanProfileFromGeneration).toEqual({
      method: "POST",
      path: "/api/v1/client/pages/:pageLabel/fans/:fanRef/profile/from-generation",
    });
    // The fan is the one numeric id shape of every client route.
    expect(routeSchemas.clientFanProfileFromGeneration.params).toBe(clientPageFanParamsSchema);
  });

  it("takes every body the client's frozen schema lets out", () => {
    const bodies = [
      { generationRef: GENERATION_REF },
      { generationRef: GENERATION_REF, clientRequestId: CLIENT_REQUEST_ID },
      // The client's id form is any 8-4-4-4-12 hex, in any case: wider than an RFC UUID.
      { generationRef: "11111111-1111-1111-1111-111111111111", clientRequestId: "22222222-2222-2222-2222-222222222222" },
      { generationRef: GENERATION_REF.toUpperCase(), clientRequestId: CLIENT_REQUEST_ID.toUpperCase() },
    ];
    for (const body of bodies) {
      expect(frozenRequestBody.safeParse(body).success, JSON.stringify(body)).toBe(true);
      expect(clientFanProfileFromGenerationBodySchema.parse(body), JSON.stringify(body)).toEqual(body);
    }
  });

  it("is strict: the text, the fan, the page and the time are never the client's to send", () => {
    for (const body of [
      {},
      { generationRef: "" },
      { generationRef: "g".repeat(101) },
      { generationRef: 42 },
      { generationRef: GENERATION_REF, clientRequestId: "" },
      { generationRef: GENERATION_REF, clientRequestId: "not-a-request-id" },
      { generationRef: GENERATION_REF, clientRequestId: `${CLIENT_REQUEST_ID}0` },
      { generationRef: GENERATION_REF, clientRequestId: null },
      // What the older write takes from the client. Here the hub reads all of it from its own record.
      { generationRef: GENERATION_REF, body: "a dossier the client wrote" },
      { generationRef: GENERATION_REF, generatedAtMs: 1 },
      { generationRef: GENERATION_REF, fanRef: "777000888" },
      { generationRef: GENERATION_REF, pageLabel: "mia-of" },
      { generationRef: GENERATION_REF, userId: 1 },
    ]) {
      expect(clientFanProfileFromGenerationBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
    // A stored ref is any text up to 100 characters; the hub answers 404 for one it does not hold.
    expect(clientFanProfileFromGenerationBodySchema.safeParse({ generationRef: "g".repeat(100) }).success).toBe(true);
  });

  it("answers a response the client's frozen schema reads, and an installed SDK keeps reading", () => {
    const answers = [
      { outcome: "created", profile: { version: 1, createdAt: "2026-10-03T12:35:00.123Z", sourceGeneratedAt: "2026-10-03T12:34:56.789Z" } },
      // A version an older client wrote without its generation time.
      { outcome: "existing", profile: { version: 7, createdAt: "2026-10-03T12:35:00.000Z", sourceGeneratedAt: null } },
    ];
    for (const answer of answers) {
      expect(clientFanProfileFromGenerationResponseSchema.parse(answer)).toEqual(answer);
      expect(frozenResponse.parse(answer)).toEqual(answer);
    }
    // Not strict: a key a later hub adds is stripped, never a failed parse.
    const later = clientFanProfileFromGenerationResponseSchema.parse({
      ...answers[0],
      laterKey: 1,
      profile: { ...answers[0]!.profile, body: "never sent", laterKey: 1 },
    });
    expect(later).toEqual(answers[0]);
    // Both outcomes are the whole vocabulary, and the profile's three keys are the contract.
    for (const broken of [
      { ...answers[0], outcome: "saved" },
      { outcome: "created" },
      { outcome: "created", profile: { version: 0, createdAt: "2026-10-03T12:35:00.123Z", sourceGeneratedAt: null } },
      { outcome: "created", profile: { version: 1, createdAt: "2026-10-03T12:35:00.123Z" } },
    ]) {
      expect(clientFanProfileFromGenerationResponseSchema.safeParse(broken).success, JSON.stringify(broken)).toBe(false);
      expect(frozenResponse.safeParse(broken).success, JSON.stringify(broken)).toBe(false);
    }
  });

  it("serves the capability, lists the route for the narrow token and exports the reasons through the SDK", () => {
    expect(SERVED_CLIENT_CAPABILITIES).toContain("recap-profile-v1");
    expect(CLIENT_TOKEN_PROFILES["chat-extension"].operations).toContain("clientFanProfileFromGeneration");
    // The older write is the full token's alone: the extension saves by reference only.
    expect(CLIENT_TOKEN_PROFILES["chat-extension"].operations).not.toContain("upsertFanProfile");
    expect(contracts.CLIENT_GENERATION_NOT_ELIGIBLE_REASONS).toEqual([
      "not_full_summary", "not_completed", "stop_reason_missing", "output_exhausted", "empty",
      "context_scope", "too_long", "superseded",
    ]);
    expect(sdk.CLIENT_GENERATION_NOT_ELIGIBLE_REASONS).toBe(contracts.CLIENT_GENERATION_NOT_ELIGIBLE_REASONS);
    // Every reason travels as an open token of the error body.
    for (const reason of CLIENT_GENERATION_NOT_ELIGIBLE_REASONS) {
      expect(contracts.clientOpenToken.safeParse(reason).success, reason).toBe(true);
    }
  });

  it("the two refusals are 409 with their own codes; only the ineligible one carries a reason", () => {
    const notReady = new GenerationNotReadyError();
    expect([notReady.statusCode, notReady.code]).toEqual([409, "generation_not_ready"]);
    expect(notReady).not.toHaveProperty("reason");
    const notEligible = new GenerationNotEligibleError("output_exhausted");
    expect([notEligible.statusCode, notEligible.code, notEligible.reason]).toEqual([409, "generation_not_eligible", "output_exhausted"]);
    expect(errorResponseSchema.safeParse({
      error: notEligible.code,
      message: notEligible.message,
      statusCode: notEligible.statusCode,
      reason: notEligible.reason,
    }).success).toBe(true);
  });
});

describe("generationRefusalReason", () => {
  /** A generation the database's predicate refused, with the fact that made it so. */
  const refused = (over: Partial<OwnGenerationForProfile>) => generation({ usableFullSummary: false, ...over });

  it("accepts a usable full recap, up to the longest body a dossier may have", () => {
    expect(generationRefusalReason(generation())).toBeNull();
    // The cap is the older write's: one length for every writer of a dossier.
    expect(DOSSIER_BODY_MAX_CHARS).toBe(50_000);
    expect(upsertFanProfileBodySchema.safeParse({ body: "x".repeat(DOSSIER_BODY_MAX_CHARS) }).success).toBe(true);
    expect(upsertFanProfileBodySchema.safeParse({ body: "x".repeat(DOSSIER_BODY_MAX_CHARS + 1) }).success).toBe(false);
    expect(generationRefusalReason(generation({ completion: "x".repeat(DOSSIER_BODY_MAX_CHARS) }))).toBeNull();
    expect(generationRefusalReason(generation({ completion: "x".repeat(DOSSIER_BODY_MAX_CHARS + 1) }))).toBe("too_long");
  });

  it("names one reason per condition of the usable-recap predicate", () => {
    const cases: Array<[Partial<OwnGenerationForProfile>, string]> = [
      [{ feature: "chat-review" }, "not_full_summary"],
      [{ feature: "coach-chat", summaryMode: null }, "not_full_summary"],
      [{ summaryMode: "short" }, "not_full_summary"],
      // A row that predates the mode.
      [{ summaryMode: null }, "not_full_summary"],
      [{ outcome: "failed" }, "not_completed"],
      [{ outcome: "cancelled" }, "not_completed"],
      [{ outcome: null }, "not_completed"],
      [{ stopReason: null }, "stop_reason_missing"],
      [{ stopReason: "max_tokens" }, "output_exhausted"],
      [{ stopReason: "length" }, "output_exhausted"],
      [{ blank: true, completion: " \n" }, "empty"],
      [{ contextScoped: true }, "context_scope"],
    ];
    for (const [fact, reason] of cases) {
      expect(generationRefusalReason(refused(fact)), JSON.stringify(fact)).toBe(reason);
      expect(CLIENT_GENERATION_NOT_ELIGIBLE_REASONS, reason).toContain(reason);
    }
  });

  it("asks what the generation is first, then how it ended, then what it holds", () => {
    // A failed short recap of another feature's kind is, first of all, not a full recap.
    expect(generationRefusalReason(refused({ summaryMode: "short", outcome: "failed", stopReason: null, blank: true })))
      .toBe("not_full_summary");
    expect(generationRefusalReason(refused({ outcome: "failed", stopReason: null, blank: true }))).toBe("not_completed");
    expect(generationRefusalReason(refused({ stopReason: null, blank: true, contextScoped: true }))).toBe("stop_reason_missing");
    expect(generationRefusalReason(refused({ stopReason: "max_tokens", blank: true, contextScoped: true }))).toBe("output_exhausted");
    expect(generationRefusalReason(refused({ blank: true, contextScoped: true }))).toBe("empty");
    // The length is asked only of a generation that is otherwise a usable full recap.
    expect(generationRefusalReason(refused({ contextScoped: true, completion: "x".repeat(DOSSIER_BODY_MAX_CHARS + 1) })))
      .toBe("context_scope");
  });

  it("the database's verdict decides: facts that look fine never overrule a refusal", () => {
    // The predicate gained a condition this list does not name: still refused, loudly.
    expect(() => generationRefusalReason(refused({}))).toThrow(/cannot name/);
    // And facts that look bad never refuse what the predicate accepted.
    expect(generationRefusalReason(generation({ stopReason: "max_tokens", contextScoped: true }))).toBeNull();
  });
});
