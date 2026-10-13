import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AI_HI_GREETING_REFUSAL_REASONS,
  AI_START_PROOF_AUTOMATED_IDS_MAX,
  AI_START_PROOF_PASS_PERSONAL_WINDOW,
  AI_START_PROOF_SOURCES,
  AI_STREAM_CAPABILITIES,
  CLIENT_HUB_CAPABILITY_NAMES,
  aiStartProofV1Schema,
  compareClientNumericIds,
  errorResponseSchema,
  routeSchemas,
  type AiStartProofV1,
  type AiStreamCapability,
} from "@agency_hub_core/contracts";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import {
  HI_GREETING_MAX_TRANSCRIPT,
  assertHiGreetingFreshness,
  assertHiStartProof,
  assertHiStartProofRequestShape,
  assertHiStartProofSent,
  hiStartProofDecides,
  judgeHiStartProof,
  parseAiStreamCapabilities,
  type AiContextMessageRef,
  type HiGreetingRefusalReason,
  type OperationFeature,
} from "../apps/runtime/src/modules/ai/index.ts";
import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import { BadRequestError, ProductGateError } from "../apps/runtime/src/services/errors.ts";
import * as sdk from "../packages/sdk/src/index.ts";

// chat-extension Project Unite R20, HF-5: Hi on Fansly by the client's proof of
// the conversation's start. The body's `startProof` is the client's own schema;
// where its fields may be sent and what the gate answers live in one fixture
// matrix shared with the client (tests/fixtures/ai-hi-start-proof-matrix.json,
// copied verbatim by chat-extension P6c2). The route, the stores and the
// released clients are in tests/client-ai-hi-start-proof.integration.test.ts.

interface Matrix {
  version: number;
  limit: number;
  proofs: {
    valid: Array<{ name: string; proof: unknown }>;
    invalid: Array<{ name: string; proof: unknown }>;
  };
  shapeCases: Array<{
    name: string;
    feature: OperationFeature;
    platform: "fansly" | "onlyfans";
    clientContext: boolean;
    capabilities: AiStreamCapability[];
    conversationRef: string;
    fields: { startProof?: AiStartProofV1; personalMessageCount?: number; fanAvatarUrl?: string };
    refusal: string | null;
  }>;
  gateCases: Array<{
    name: string;
    proof: AiStartProofV1 | null;
    window: string[];
    knownLiveIds: string[];
    verdict: HiGreetingRefusalReason | null;
  }>;
}

const matrix = JSON.parse(readFileSync(
  fileURLToPath(new URL("./fixtures/ai-hi-start-proof-matrix.json", import.meta.url)),
  "utf8",
)) as Matrix;

const bodySchema = routeSchemas.aiFeatureStream.body;
const GROUP = "700000000000000003";
const body = (extra: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(),
  pageLabel: "fs-page",
  platform: "fansly",
  conversationRef: GROUP,
  fanRef: "700000000000000002",
  ...extra,
});

describe("the predicate's name: hi-start-proof-v1", () => {
  it("is a stream capability, a bootstrap capability this hub serves, and parsed off the header", () => {
    expect(AI_STREAM_CAPABILITIES).toContain("hi-start-proof-v1");
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("hi-start-proof-v1");
    expect(SERVED_CLIENT_CAPABILITIES).toContain("hi-start-proof-v1");
    expect([...parseAiStreamCapabilities("context-v1, coverage-check-v1, hi-start-proof-v1")])
      .toEqual(["context-v1", "coverage-check-v1", "hi-start-proof-v1"]);
    // Every token together still fits the header's 256 characters.
    expect(AI_STREAM_CAPABILITIES.join(", ").length).toBeLessThan(256);
    expect(parseAiStreamCapabilities(AI_STREAM_CAPABILITIES.join(", ")).size).toBe(AI_STREAM_CAPABILITIES.length);
  });

  it("gives the client its limits and reasons through the SDK", () => {
    expect(AI_START_PROOF_SOURCES).toEqual(["tab-short-page", "pass-empty-page"]);
    expect(AI_START_PROOF_AUTOMATED_IDS_MAX).toBe(120);
    expect(AI_START_PROOF_PASS_PERSONAL_WINDOW).toBe(30);
    expect(AI_HI_GREETING_REFUSAL_REASONS).toEqual(["history_unproven", "too_many_personal"]);
    expect(sdk.AI_START_PROOF_SOURCES).toBe(AI_START_PROOF_SOURCES);
    expect(sdk.AI_START_PROOF_AUTOMATED_IDS_MAX).toBe(AI_START_PROOF_AUTOMATED_IDS_MAX);
    expect(sdk.AI_START_PROOF_PASS_PERSONAL_WINDOW).toBe(AI_START_PROOF_PASS_PERSONAL_WINDOW);
    expect(sdk.AI_HI_GREETING_REFUSAL_REASONS).toBe(AI_HI_GREETING_REFUSAL_REASONS);
    // The matrix names the same limit the gate reads.
    expect(matrix.version).toBe(1);
    expect(matrix.limit).toBe(HI_GREETING_MAX_TRANSCRIPT);
  });
});

describe("startProof v1: the client's own schema, field by field", () => {
  for (const one of matrix.proofs.valid) {
    it(`accepts: ${one.name}`, () => {
      const parsed = aiStartProofV1Schema.safeParse(one.proof);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(bodySchema.safeParse(body({ startProof: one.proof })).success).toBe(true);
    });
  }

  for (const one of matrix.proofs.invalid) {
    it(`refuses: ${one.name}`, () => {
      expect(aiStartProofV1Schema.safeParse(one.proof).success).toBe(false);
      expect(bodySchema.safeParse(body({ startProof: one.proof })).success).toBe(false);
    });
  }

  it("names exactly the client's fields, each required", () => {
    const proof = matrix.proofs.valid[0]!.proof as Record<string, unknown>;
    expect(Object.keys(proof).sort()).toEqual([
      "automatedIds", "coveredCount", "groupId", "personalCount", "source", "startWitnessId", "v",
    ]);
    for (const key of Object.keys(proof)) {
      const { [key]: _dropped, ...rest } = proof;
      expect(aiStartProofV1Schema.safeParse(rest).success, key).toBe(false);
    }
  });

  it("takes ids as canonical digit strings only: old 17-digit and coming 19-digit ones too", () => {
    const proof = matrix.proofs.valid[0]!.proof as Record<string, unknown>;
    for (const id of ["99999999999999999", "1000000000000000105", "9".repeat(30)]) {
      expect(aiStartProofV1Schema.safeParse({ ...proof, groupId: id }).success, id).toBe(true);
    }
    for (const id of ["", "0", "0700000000000000101", "9".repeat(31), "70x", " 701", 701, null]) {
      expect(aiStartProofV1Schema.safeParse({ ...proof, groupId: id }).success, String(id)).toBe(false);
      expect(aiStartProofV1Schema.safeParse({ ...proof, automatedIds: [id] }).success, String(id)).toBe(false);
    }
    // The witness alone may be null, and only for an empty history.
    expect(aiStartProofV1Schema.safeParse({ ...proof, startWitnessId: "0" }).success).toBe(false);
  });

  it("takes whole counts from zero up, with no cap of its own", () => {
    const proof = matrix.proofs.valid[1]!.proof as Record<string, unknown>;
    expect(aiStartProofV1Schema.safeParse({ ...proof, coveredCount: 250_000 }).success).toBe(true);
    for (const count of [-1, 1.5, "4", null]) {
      expect(aiStartProofV1Schema.safeParse({ ...proof, coveredCount: count }).success, String(count)).toBe(false);
      expect(aiStartProofV1Schema.safeParse({ ...proof, personalCount: count }).success, String(count)).toBe(false);
    }
  });

  it("orders ids as snowflakes: the shorter is the older, then the string", () => {
    expect(compareClientNumericIds("99999999999999999", "700000000000000101")).toBeLessThan(0);
    expect(compareClientNumericIds("1000000000000000105", "700000000000000101")).toBeGreaterThan(0);
    expect(compareClientNumericIds("700000000000000101", "700000000000000102")).toBeLessThan(0);
    expect(compareClientNumericIds("700000000000000101", "700000000000000101")).toBe(0);
    // Two neighbours a double cannot tell apart are two ids.
    expect(Number("900000000000000001")).toBe(Number("900000000000000002"));
    expect(compareClientNumericIds("900000000000000001", "900000000000000002")).toBeLessThan(0);
  });
});

describe("the other two body fields", () => {
  it("takes the count and the avatar at the top level, beside or without a proof", () => {
    const proof = matrix.proofs.valid[0]!.proof;
    const avatar = "https://cdn3.fansly.com/avatar.jpg";
    expect(bodySchema.safeParse(body({ startProof: proof, personalMessageCount: 2, fanAvatarUrl: avatar })).success).toBe(true);
    expect(bodySchema.safeParse(body({ personalMessageCount: 0 })).success).toBe(true);
    expect(bodySchema.safeParse(body({ fanAvatarUrl: avatar })).success).toBe(true);
    // A released client that knows none of them stays valid.
    expect(bodySchema.safeParse(body()).success).toBe(true);
  });

  it("holds the top-level avatar to the rule of clientContext.fanAvatarUrl", () => {
    const clientContext = { transcript: "Fan: hi", messageCount: 1, fanDisplayName: "Alex" };
    for (const fanAvatarUrl of [
      "http://cdn3.fansly.com/x",
      "https://cdn3.fansly.com.evil.test/x",
      "https://a:b@cdn3.fansly.com/x",
      "https://127.0.0.1/x",
      `https://cdn3.fansly.com/${"a".repeat(4096)}`,
      "",
    ]) {
      expect(bodySchema.safeParse(body({ fanAvatarUrl })).success, fanAvatarUrl.slice(0, 40)).toBe(false);
      expect(bodySchema.safeParse(body({ clientContext: { ...clientContext, fanAvatarUrl } })).success).toBe(false);
    }
    for (const fanAvatarUrl of ["https://cdn3.fansly.com/avatar.jpg", "https://d-1.fansly.com/a?b=c"]) {
      expect(bodySchema.safeParse(body({ fanAvatarUrl })).success, fanAvatarUrl).toBe(true);
      expect(bodySchema.safeParse(body({ clientContext: { ...clientContext, fanAvatarUrl } })).success).toBe(true);
    }
  });

  it("refuses a count that is not a whole number from zero up", () => {
    for (const personalMessageCount of [-1, 1.5, "2", null]) {
      expect(bodySchema.safeParse(body({ personalMessageCount })).success, String(personalMessageCount)).toBe(false);
    }
  });
});

describe("where the fields may be sent (400 with a machine reason elsewhere)", () => {
  const ON_FANSLY = { fansly: true, onlyfans: false } as const;
  const check = (one: Matrix["shapeCases"][number]) => () => assertHiStartProofRequestShape({
    feature: one.feature,
    isFanslyRequest: ON_FANSLY[one.platform],
    hasClientContext: one.clientContext,
    capabilities: new Set(one.capabilities),
    body: { conversationRef: one.conversationRef, ...one.fields },
  });

  for (const one of matrix.shapeCases) {
    it(`${one.refusal ?? "passes"}: ${one.name}`, () => {
      // Every case is a body the schema itself accepts: the refusal is the service's.
      expect(bodySchema.safeParse(body({ conversationRef: one.conversationRef, ...one.fields })).success).toBe(true);
      if (one.refusal === null) {
        expect(check(one)).not.toThrow();
        return;
      }
      try {
        check(one)();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestError);
        expect((error as BadRequestError).statusCode).toBe(400);
        expect((error as BadRequestError).code).toBe("bad_request");
        expect((error as BadRequestError).reason).toBe(one.refusal);
      }
    });
  }

  it("covers every reason", () => {
    expect(new Set(matrix.shapeCases.map((one) => one.refusal))).toEqual(
      new Set([null, "start_proof_not_allowed", "capability_required", "start_proof_mismatch"]),
    );
  });

  it("names the fields that were sent, and reads an absent capability set as none", () => {
    const proof = matrix.proofs.valid[0]!.proof as AiStartProofV1;
    expect(() => assertHiStartProofRequestShape({
      feature: "fast-reply",
      isFanslyRequest: true,
      hasClientContext: false,
      capabilities: new Set(["hi-start-proof-v1"]),
      body: { conversationRef: GROUP, startProof: proof, fanAvatarUrl: "https://cdn3.fansly.com/a.jpg" },
    })).toThrow("fast-reply does not accept startProof, fanAvatarUrl");
    expect(() => assertHiStartProofRequestShape({
      feature: "hi-greeting",
      isFanslyRequest: true,
      hasClientContext: false,
      capabilities: undefined,
      body: { conversationRef: GROUP, personalMessageCount: 1 },
    })).toThrow("personalMessageCount require the hi-start-proof-v1 capability");
  });
});

describe("the lane: Hi on Fansly, the hub's own transcript, hi-start-proof-v1 advertised", () => {
  const lane = { feature: "hi-greeting" as OperationFeature, isFanslyRequest: true, hasClientContext: false };
  const advertised = new Set<AiStreamCapability>(["hi-start-proof-v1"]);

  it("is all four at once", () => {
    expect(hiStartProofDecides({ ...lane, capabilities: advertised })).toBe(true);
    expect(hiStartProofDecides({ ...lane, capabilities: new Set(AI_STREAM_CAPABILITIES) })).toBe(true);
    // Not advertised: the released clients and the new client against an older rule.
    expect(hiStartProofDecides({ ...lane, capabilities: undefined })).toBe(false);
    expect(hiStartProofDecides({ ...lane, capabilities: new Set() })).toBe(false);
    expect(hiStartProofDecides({ ...lane, capabilities: new Set(["context-v1", "coverage-check-v1"]) })).toBe(false);
    // The released Fansly extension sends its own transcript.
    expect(hiStartProofDecides({ ...lane, hasClientContext: true, capabilities: advertised })).toBe(false);
    // OnlyFans, whatever the caller advertises.
    expect(hiStartProofDecides({ ...lane, isFanslyRequest: false, capabilities: advertised })).toBe(false);
    for (const feature of ["fast-reply", "improve-draft", "ping", "coach-chat", "fan-summary", "voice-script"] as const) {
      expect(hiStartProofDecides({ ...lane, feature, capabilities: advertised }), feature).toBe(false);
    }
  });
});

describe("the gate (shared matrix)", () => {
  for (const one of matrix.gateCases) {
    it(`${one.verdict ?? "admitted"}: ${one.name}`, () => {
      if (one.proof !== null) {
        expect(aiStartProofV1Schema.safeParse(one.proof).success, "the case's proof is a body the hub accepts").toBe(true);
      }
      expect(judgeHiStartProof({
        proof: one.proof ?? undefined,
        windowIds: one.window,
        knownLiveIds: one.knownLiveIds,
      })).toBe(one.verdict);
    });
  }

  it("covers both reasons and the admission, and names only known reasons", () => {
    expect(new Set(matrix.gateCases.map((one) => one.verdict))).toEqual(new Set([null, ...AI_HI_GREETING_REFUSAL_REASONS]));
  });

  it("counts by the proof alone: the size of the hub's transcript is not the gate", () => {
    const ids = Array.from({ length: 60 }, (_, n) => String(700_000_000_000_000_201n + BigInt(n)));
    const proof: AiStartProofV1 = {
      v: 1, source: "tab-short-page", groupId: GROUP, startWitnessId: ids[0]!, coveredCount: 60, personalCount: 0, automatedIds: ids,
    };
    // 60 messages the hub holds, none personal: every other lane's gate refuses them.
    expect(() => assertHiGreetingFreshness({}, 60)).toThrow("at most 10 messages");
    expect(judgeHiStartProof({ proof, windowIds: ids, knownLiveIds: ids })).toBeNull();
    // And two messages the hub holds admit nothing without a proof.
    expect(() => assertHiGreetingFreshness({}, 2)).not.toThrow();
    expect(judgeHiStartProof({ proof: undefined, windowIds: ids.slice(0, 2), knownLiveIds: ids.slice(0, 2) })).toBe("history_unproven");
  });

  it("holds the limit at exactly 10 for both sources", () => {
    for (const source of AI_START_PROOF_SOURCES) {
      const proof = (personalCount: number): AiStartProofV1 => ({
        v: 1, source, groupId: GROUP, startWitnessId: "700000000000000201", coveredCount: 25, personalCount, automatedIds: [],
      });
      expect(judgeHiStartProof({ proof: proof(HI_GREETING_MAX_TRANSCRIPT), windowIds: [], knownLiveIds: [] }), source).toBeNull();
      expect(judgeHiStartProof({ proof: proof(HI_GREETING_MAX_TRANSCRIPT + 1), windowIds: [], knownLiveIds: [] }), source)
        .toBe("too_many_personal");
    }
  });
});

describe("the gate on a served transcript", () => {
  const msg = (n: number) => String(700_000_000_000_000_200n + BigInt(n));
  const window = (ids: readonly string[]): AiContextMessageRef[] => ids.map((messageRef, index) => ({
    messageRef,
    occurredAt: new Date(1_000 * (index + 1)),
    isFromFan: index % 2 === 0,
  }));
  /** The one read the gate makes: the archive's oldest live message. */
  const appWith = (oldestArchived: string | null, seen: { statements: number } = { statements: 0 }) => ({
    db: {
      execute: async () => {
        seen.statements += 1;
        return { rows: oldestArchived === null ? [] : [{ message_ref: oldestArchived }] };
      },
    },
  }) as unknown as Pick<AppContext, "db">;
  const proof = (overrides: Partial<AiStartProofV1> = {}): AiStartProofV1 => ({
    v: 1, source: "tab-short-page", groupId: GROUP, startWitnessId: msg(5), coveredCount: 4, personalCount: 2, automatedIds: [msg(6)],
    ...overrides,
  });
  const gate = (input: {
    proof?: AiStartProofV1;
    oldestArchived?: string | null;
    served?: string[];
    source?: "archive" | "live_union";
    coverageWindow?: string[];
    seen?: { statements: number };
  }) => assertHiStartProof(appWith(input.oldestArchived ?? null, input.seen), {
    pageId: 7,
    conversationRef: GROUP,
    proof: input.proof,
    coverageCheck: input.coverageWindow === undefined
      ? undefined
      : { window: input.coverageWindow.map((id) => ({ id, dir: "fan" as const })), deletedIds: [] },
    served: { source: input.source ?? "archive", window: window(input.served ?? []), archiveHead: null },
  });
  const refusal = async (run: Promise<unknown>) => {
    try {
      await run;
    } catch (error) {
      expect(error).toBeInstanceOf(ProductGateError);
      const gateError = error as ProductGateError;
      expect(gateError.code).toBe("gate_hi_greeting_limit");
      expect(gateError.statusCode).toBe(400);
      return { reason: gateError.reason, message: gateError.message };
    }
    return expect.unreachable();
  };

  it("admits a proof the hub's history does not contradict, and leaves counts only in the manifest", async () => {
    expect(await gate({ proof: proof(), oldestArchived: msg(5), served: [msg(5), msg(6), msg(7), msg(8)] }))
      .toEqual({ source: "tab-short-page", coveredCount: 4, personalCount: 2, automatedCount: 1 });
    // The hub holds nothing of the chat yet (the usual new chat).
    expect(await gate({ proof: proof() })).toMatchObject({ personalCount: 2 });
    // An empty chat.
    expect(await gate({ proof: proof({ source: "pass-empty-page", startWitnessId: null, coveredCount: 0, personalCount: 0, automatedIds: [] }) }))
      .toEqual({ source: "pass-empty-page", coveredCount: 0, personalCount: 0, automatedCount: 0 });
  });

  it("refuses without a proof before it reads anything", async () => {
    // The feature service asks this before any context loads.
    expect(() => assertHiStartProofSent(proof())).not.toThrow();
    try {
      assertHiStartProofSent(undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProductGateError);
      expect((error as ProductGateError).code).toBe("gate_hi_greeting_limit");
      expect((error as ProductGateError).reason).toBe("history_unproven");
    }
    const seen = { statements: 0 };
    expect(await refusal(gate({ seen, served: [msg(1), msg(2)] }))).toEqual({
      reason: "history_unproven",
      message: "hi-greeting is only available for conversations whose start is proven",
    });
    expect(seen.statements).toBe(0);
  });

  it("refuses a start the hub's history contradicts: the archive's oldest message, or a served one", async () => {
    // Older than the window the transcript served: only the archive read sees it.
    expect((await refusal(gate({ proof: proof(), oldestArchived: msg(1), served: [msg(7), msg(8)] }))).reason).toBe("history_unproven");
    // A socket message the archive does not hold yet: only the served transcript sees it.
    expect((await refusal(gate({ proof: proof(), oldestArchived: null, served: [msg(4), msg(5)], source: "live_union" }))).reason)
      .toBe("history_unproven");
    // The request's own window.
    expect((await refusal(gate({ proof: proof(), coverageWindow: [msg(4), msg(5)] }))).reason).toBe("history_unproven");
    // An empty history against a message the hub holds.
    const empty = proof({ startWitnessId: null, coveredCount: 0, personalCount: 0, automatedIds: [] });
    expect((await refusal(gate({ proof: empty, oldestArchived: msg(1) }))).reason).toBe("history_unproven");
    expect((await refusal(gate({ proof: empty, served: [msg(1)] }))).reason).toBe("history_unproven");
  });

  it("refuses 11 personal messages in the released clients' words", async () => {
    expect(await refusal(gate({ proof: proof({ coveredCount: 12, personalCount: 11, automatedIds: [] }), oldestArchived: msg(5) }))).toEqual({
      reason: "too_many_personal",
      message: "hi-greeting is only available for conversations with at most 10 personal messages",
    });
    // The same words the released Fansly extension is refused in, without a reason.
    try {
      assertHiGreetingFreshness({
        clientContext: {
          transcript: "Fan: hi", messageCount: 12, fanDisplayName: "Alex", fanSpendingData: "", fanSubscriptionData: "", personalMessageCount: 11,
        },
      }, 12);
      expect.unreachable();
    } catch (error) {
      expect((error as ProductGateError).message).toBe("hi-greeting is only available for conversations with at most 10 personal messages");
      expect((error as ProductGateError).reason).toBeNull();
    }
  });

  it("does not swallow a failed read: the request fails, it is never admitted on a guess", async () => {
    const failing = { db: { execute: async () => { throw new Error("db down"); } } } as unknown as Pick<AppContext, "db">;
    await expect(assertHiStartProof(failing, {
      pageId: 7, conversationRef: GROUP, proof: proof(), coverageCheck: undefined,
      served: { source: "archive", window: [], archiveHead: null },
    })).rejects.toThrow("db down");
  });
});

describe("the refusal's envelope", () => {
  it("is the documented error shape with its reason, and every other gate keeps none", () => {
    const refused = new ProductGateError("no", "gate_hi_greeting_limit", { reason: "history_unproven" });
    expect(errorResponseSchema.safeParse({
      error: refused.code, message: refused.message, statusCode: refused.statusCode, reason: refused.reason,
    }).success).toBe(true);
    expect(new ProductGateError("no", "gate_min_messages").reason).toBeNull();
    expect(new ProductGateError("no", "gate_hi_greeting_limit").reason).toBeNull();
  });
});
