import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  AI_CONTEXT_LIVE_STATUSES,
  AI_CONTEXT_SOURCES,
  AI_FAN_LANGUAGE_EVIDENCE,
  AI_KNOWN_FAN_MESSAGE_IDS_MAX,
  AI_KNOWN_FAN_MESSAGE_STATES,
  CLIENT_COVERAGE_LEVELS,
  aiFeatureContextFrameSchema,
  aiFeatureStreamFrameSchema,
  aiGatewayStreamFrameSchema,
  routeSchemas,
  streamAiFeature,
  streamAiGateway,
} from "@agency_hub_core/contracts";
import { OFAPI_CAPTURE_PROOF_POLICY_VERSION, type OfapiMessageCoverageServingState } from "@agency_hub_core/db";

import {
  buildAiContextFrameBody,
  fanLanguageEvidenceOf,
  resolveKnownFanMessages,
  servedWindowOf,
  type TranscriptMessage,
  type TranscriptServedSnapshot,
} from "../apps/runtime/src/modules/ai/index.ts";
import { classifyClientCoverage } from "../apps/runtime/src/services/client-coverage.ts";
import * as sdk from "../packages/sdk/src/index.ts";

// chat-extension H-4b: the `context_v1` frame of the AI feature stream and the
// `knownFanMessageIds` body field, as the client froze them
// (chat-extension packages/contracts/src/hub/ai.ts, ContextFrameSchema).

const GENERATION = "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f";

function frame(overrides: Record<string, unknown> = {}) {
  return {
    type: "context_v1",
    generationRef: GENERATION,
    source: "union",
    servedHead: { messageRef: "9005", occurredAt: "2026-10-04T05:56:00.000Z", isFromFan: false },
    archiveHead: { messageRef: "9003", occurredAt: "2026-10-04T05:46:00.000Z", isFromFan: true },
    window: { requested: 100, served: 4 },
    coverage: "complete",
    knownFanMessages: [{ id: "9003", state: "included" }, { id: "9004", state: "absent" }],
    live: { status: "not_sent", accepted: 0, rejected: 0 },
    fanLanguageEvidence: "latin",
    ...overrides,
  };
}

function message(id: number, sender: "Fan" | "Model", text: string, createdAtMs = id): TranscriptMessage {
  return { id, createdAtMs, sender, text, labels: [] };
}

function sseFetch(frames: unknown[]): typeof fetch {
  const body = frames.map((data) => `event: ai\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return (async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })) as unknown as typeof fetch;
}

describe("context_v1 frame contract", () => {
  it("is a feature-lane frame only: the raw gateway still refuses it", () => {
    expect(aiFeatureStreamFrameSchema.safeParse(frame()).success).toBe(true);
    expect(aiGatewayStreamFrameSchema.safeParse(frame()).success).toBe(false);
  });

  it("is not strict: a key a later hub adds is dropped, not a failed stream", () => {
    const parsed = aiFeatureStreamFrameSchema.parse(frame({ futureKey: { any: 1 }, live: {
      status: "not_sent", accepted: 0, rejected: 0, futureCount: 3,
    } }));
    expect(parsed).not.toHaveProperty("futureKey");
    // The frames that existed before stay strict.
    expect(aiFeatureStreamFrameSchema.safeParse({ type: "done", stopReason: null, extra: true }).success).toBe(false);
  });

  it("carries open tokens: a value this build does not know still parses", () => {
    const parsed = aiFeatureContextFrameSchema.parse(frame({
      source: "future_reader",
      coverage: "future_level",
      knownFanMessages: [{ id: "9003", state: "future_state" }],
      live: { status: "future_status", accepted: 0, rejected: 0 },
      fanLanguageEvidence: "future_script",
    }));
    expect(parsed.source).toBe("future_reader");
    for (const empty of [{ source: "" }, { coverage: "" }, { fanLanguageEvidence: "x".repeat(65) }]) {
      expect(aiFeatureContextFrameSchema.safeParse(frame(empty)).success, JSON.stringify(empty)).toBe(false);
    }
  });

  it("requires what the client reads and lets the optional parts be absent", () => {
    const minimal = frame({ servedHead: null });
    delete (minimal as Record<string, unknown>).archiveHead;
    delete (minimal as Record<string, unknown>).knownFanMessages;
    delete (minimal as Record<string, unknown>).fanLanguageEvidence;
    expect(aiFeatureContextFrameSchema.safeParse(minimal).success).toBe(true);
    expect(aiFeatureContextFrameSchema.safeParse(frame({ archiveHead: null })).success).toBe(true);
    expect(aiFeatureContextFrameSchema.safeParse(frame({
      servedHead: { messageRef: "9005", occurredAt: null, isFromFan: false },
    })).success).toBe(true);
    for (const required of ["generationRef", "source", "servedHead", "window", "coverage", "live"]) {
      const broken = frame();
      delete (broken as Record<string, unknown>)[required];
      expect(aiFeatureContextFrameSchema.safeParse(broken).success, required).toBe(false);
    }
    expect(aiFeatureContextFrameSchema.safeParse(frame({ generationRef: "not-a-uuid" })).success).toBe(false);
    expect(aiFeatureContextFrameSchema.safeParse(frame({ window: { requested: -1, served: 0 } })).success).toBe(false);
    expect(aiFeatureContextFrameSchema.safeParse(frame({
      knownFanMessages: Array.from({ length: AI_KNOWN_FAN_MESSAGE_IDS_MAX + 1 }, (_, n) => ({ id: String(n + 1), state: "absent" })),
    })).success).toBe(false);
  });

  it("names the known values the client froze", () => {
    // chat-extension packages/contracts/src/ops.ts: CONTEXT_SOURCES,
    // COVERAGE_LEVELS, KNOWN_FAN_MESSAGE_STATES, LIVE_TEXT_STATUSES;
    // hub/ai.ts FAN_LANGUAGE_EVIDENCE; limits.ts SEND_LIMITS.knownFanMessagesMax.
    expect(AI_CONTEXT_SOURCES).toEqual(["archive", "union", "live_union"]);
    expect(CLIENT_COVERAGE_LEVELS).toEqual(["complete", "partial", "unknown"]);
    expect(AI_KNOWN_FAN_MESSAGE_STATES).toEqual(["included", "absent", "deleted", "unknown"]);
    expect(AI_CONTEXT_LIVE_STATUSES).toEqual(["not_sent", "disabled", "shadow", "served", "rejected"]);
    expect(AI_FAN_LANGUAGE_EVIDENCE).toEqual(["latin", "cyrillic", "mixed", "unknown"]);
    expect(AI_KNOWN_FAN_MESSAGE_IDS_MAX).toBe(10);
  });

  it("re-exports the frame's known values from the generated SDK (the client cannot reach contracts)", () => {
    for (const name of [
      "AI_CONTEXT_LIVE_STATUSES",
      "AI_CONTEXT_SOURCES",
      "AI_FAN_LANGUAGE_EVIDENCE",
      "AI_KNOWN_FAN_MESSAGE_IDS_MAX",
      "AI_KNOWN_FAN_MESSAGE_STATES",
      "CLIENT_COVERAGE_LEVELS",
    ] as const) {
      expect(sdk[name], name).toBeDefined();
      expect(sdk[name], name).toBe(contracts[name]);
    }
  });
});

describe("context_v1 through the SDK stream helpers", () => {
  it("streamAiFeature hands the frame to the caller, future keys dropped", async () => {
    const frames: unknown[] = [];
    await streamAiFeature(
      { baseUrl: "http://hub", fetch: sseFetch([frame({ futureKey: true })]) },
      { feature: "fast-reply", body: {} as never, capabilities: ["context-v1"], onFrame: (value) => frames.push(value) },
    ).done;
    expect(frames).toEqual([frame()]);
  });

  it("streamAiGateway stays strict against it", async () => {
    const handle = streamAiGateway(
      { baseUrl: "http://hub", fetch: sseFetch([frame()]) },
      { body: {} as never, onFrame: () => undefined },
    );
    await expect(handle.done).rejects.toMatchObject({ code: "frame_validation_failed" });
  });
});

describe("knownFanMessageIds body field", () => {
  const schema = routeSchemas.aiFeatureStream.body;
  const body = (knownFanMessageIds?: unknown) => ({
    clientRequestId: randomUUID(),
    pageLabel: "lora-of",
    platform: "onlyfans",
    conversationRef: "518588958",
    ...(knownFanMessageIds === undefined ? {} : { knownFanMessageIds }),
  });

  it("takes one to ten canonical ids, each once", () => {
    expect(schema.safeParse(body()).success).toBe(true);
    expect(schema.safeParse(body(["9003"])).success).toBe(true);
    expect(schema.safeParse(body(Array.from({ length: 10 }, (_, n) => String(n + 1)))).success).toBe(true);
    expect(schema.safeParse(body(["9".repeat(30)])).success).toBe(true);
  });

  it("refuses an empty list, an eleventh id, a repeat and any non-canonical id", () => {
    expect(schema.safeParse(body([])).success).toBe(false);
    expect(schema.safeParse(body(Array.from({ length: 11 }, (_, n) => String(n + 1)))).success).toBe(false);
    expect(schema.safeParse(body(["9003", "9003"])).success).toBe(false);
    for (const id of ["", "0", "09003", "9".repeat(31), "90x3", " 9003", 9003]) {
      expect(schema.safeParse(body([id])).success, String(id)).toBe(false);
    }
    // The former single-id spelling of the plan is not a field.
    expect(schema.safeParse({ ...body(), knownFanMessageId: "9003" }).success).toBe(false);
  });
});

describe("served window", () => {
  it("names each transcript message by the ref its store keeps", () => {
    const at = new Date("2026-10-04T05:00:00.000Z");
    const rows = [
      { messageRef: "9003", occurredAt: at },
      // A second row of the same message never renames it: first wins.
      { messageRef: "9003.0", occurredAt: at },
      // Rows the transcript cannot shape are not candidates.
      { messageRef: "9002", occurredAt: null },
      { messageRef: "not-a-number", occurredAt: at },
      { messageRef: "9001", occurredAt: at },
    ];
    const window = servedWindowOf(rows, [message(9001, "Fan", "hey", 1000), message(9003, "Model", "hi", 2000)]);
    expect(window).toEqual([
      { messageRef: "9001", occurredAt: new Date(1000), isFromFan: true },
      { messageRef: "9003", occurredAt: new Date(2000), isFromFan: false },
    ]);
  });
});

describe("fan language evidence", () => {
  const fan = (text: string, id = 1) => message(id, "Fan", text);

  it("reads the script of the fan's letters, not the model's", () => {
    expect(fanLanguageEvidenceOf([fan("hey babe, how are you?")])).toBe("latin");
    expect(fanLanguageEvidenceOf([fan("привет, как дела?")])).toBe("cyrillic");
    expect(fanLanguageEvidenceOf([fan("hello"), message(2, "Model", "привет, как дела, мой хороший?")])).toBe("latin");
  });

  it("treats a little of the other script as noise and a real share as mixed", () => {
    expect(fanLanguageEvidenceOf([fan("привет, как твои дела сегодня? ok")])).toBe("cyrillic");
    expect(fanLanguageEvidenceOf([fan("привет как дела", 1), fan("hello how are you", 2)])).toBe("mixed");
  });

  it("is unknown without fan text in Latin or Cyrillic", () => {
    expect(fanLanguageEvidenceOf([])).toBe("unknown");
    expect(fanLanguageEvidenceOf([message(1, "Model", "hello")])).toBe("unknown");
    expect(fanLanguageEvidenceOf([fan("🔥🔥 123 !!!"), fan("   ", 2)])).toBe("unknown");
    expect(fanLanguageEvidenceOf([fan("こんにちは、元気ですか ok")])).toBe("unknown");
  });

  it("reads only the fan's latest twenty text messages", () => {
    const old = Array.from({ length: 30 }, (_, n) => fan("давно это было, очень давно", n + 1));
    const recent = Array.from({ length: 20 }, (_, n) => fan("now I write in English only", n + 100));
    expect(fanLanguageEvidenceOf([...old, ...recent])).toBe("latin");
    // Label-only fan messages (a tip, a photo) are not text and do not use up the twenty.
    const labels = Array.from({ length: 20 }, (_, n) => fan("", n + 200));
    expect(fanLanguageEvidenceOf([...old, ...labels])).toBe("cyrillic");
  });
});

describe("known fan message answers", () => {
  const window = [
    { messageRef: "9001", occurredAt: new Date(1000), isFromFan: true },
    { messageRef: "9002", occurredAt: new Date(2000), isFromFan: false },
  ];

  it("answers every id once, in the client's order", () => {
    const stores = new Map([["8001", "deleted"], ["8002", "present"], ["8003", "absent"]] as const);
    expect(resolveKnownFanMessages({ ids: ["8003", "9001", "8001", "8002", "9002", "7000"], window, stores })).toEqual([
      { id: "8003", state: "absent" },
      // In the served window as a fan message.
      { id: "9001", state: "included" },
      { id: "8001", state: "deleted" },
      // Held for this conversation, but not in what the model read.
      { id: "8002", state: "absent" },
      // In the window as the model's own message: not the fan message the client meant.
      { id: "9002", state: "unknown" },
      { id: "7000", state: "absent" },
    ]);
  });

  it("answers unknown, never absent, when the stores could not be read", () => {
    expect(resolveKnownFanMessages({ ids: ["9001", "8001"], window, stores: null })).toEqual([
      { id: "9001", state: "included" },
      { id: "8001", state: "unknown" },
    ]);
  });
});

describe("context frame body", () => {
  const served: TranscriptServedSnapshot = {
    source: "union",
    window: [
      { messageRef: "9003", occurredAt: new Date("2026-10-04T05:46:00.000Z"), isFromFan: true },
      { messageRef: "9005", occurredAt: new Date("2026-10-04T05:56:00.123Z"), isFromFan: false },
    ],
    archiveHead: { messageRef: "9003", occurredAt: new Date("2026-10-04T05:46:00.000Z"), isFromFan: true },
  };

  it("reports the served head, the archive head, the window and no fresh text", () => {
    const body = buildAiContextFrameBody({ served, requestedCount: 100, coverage: "partial", fanLanguageEvidence: "latin" });
    expect(body).toEqual({
      source: "union",
      servedHead: { messageRef: "9005", occurredAt: "2026-10-04T05:56:00.123Z", isFromFan: false },
      archiveHead: { messageRef: "9003", occurredAt: "2026-10-04T05:46:00.000Z", isFromFan: true },
      window: { requested: 100, served: 2 },
      coverage: "partial",
      live: { status: "not_sent", accepted: 0, rejected: 0 },
      fanLanguageEvidence: "latin",
    });
    expect(body).not.toHaveProperty("knownFanMessages");
    // What the client's frozen schema checks beyond the hub's: an ISO instant
    // with an offset (primitives.ts ISO_TIMESTAMP_PATTERN).
    const clientIso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
    expect(body.servedHead!.occurredAt).toMatch(clientIso);
    expect(body.archiveHead!.occurredAt).toMatch(clientIso);
    expect(aiFeatureContextFrameSchema.safeParse({ type: "context_v1", generationRef: GENERATION, ...body }).success).toBe(true);
  });

  it("an empty window has no served head; an archive row without a time keeps a null time", () => {
    const body = buildAiContextFrameBody({
      served: { source: "archive", window: [], archiveHead: { messageRef: "9000", occurredAt: null, isFromFan: true } },
      requestedCount: 30,
      coverage: "unknown",
      knownFanMessages: [{ id: "9003", state: "absent" }],
      fanLanguageEvidence: "unknown",
    });
    expect(body.servedHead).toBeNull();
    expect(body.archiveHead).toEqual({ messageRef: "9000", occurredAt: null, isFromFan: true });
    expect(body.window).toEqual({ requested: 30, served: 0 });
    expect(body.knownFanMessages).toEqual([{ id: "9003", state: "absent" }]);
  });
});

describe("client coverage", () => {
  const proof = (overrides: Partial<OfapiMessageCoverageServingState> = {}): OfapiMessageCoverageServingState => ({
    pageId: 1,
    chatId: "518588958",
    classification: "continuous_history",
    frozenHeadId: "9003",
    oldestMessageId: "9001",
    requiredServingHighWater: 4,
    proofPolicyVersion: OFAPI_CAPTURE_PROOF_POLICY_VERSION,
    sourceContractVersion: "ofapi-capture-v1",
    parserVersion: "ofapi-capture-parser-v1",
    revokedAt: null,
    messageArchiveHighWater: 4,
    ...overrides,
  });

  it("is complete only for a standing continuous proof the archive has caught up with", () => {
    expect(classifyClientCoverage(proof())).toBe("complete");
    expect(classifyClientCoverage(proof({ messageArchiveHighWater: 9 }))).toBe("complete");
  });

  it("is partial when a standing proof does not vouch for the whole history", () => {
    expect(classifyClientCoverage(proof({ messageArchiveHighWater: 3 }))).toBe("partial");
    expect(classifyClientCoverage(proof({ classification: "explicit_open_debt" }))).toBe("partial");
    expect(classifyClientCoverage(proof({ classification: "verified_unavailable" }))).toBe("partial");
  });

  it("is unknown without a proof the hub accepts", () => {
    expect(classifyClientCoverage(null)).toBe("unknown");
    expect(classifyClientCoverage(proof({ revokedAt: new Date() }))).toBe("unknown");
    expect(classifyClientCoverage(proof({ proofPolicyVersion: "ofapi-proof-v0" }))).toBe("unknown");
  });
});
