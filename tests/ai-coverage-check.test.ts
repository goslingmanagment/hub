import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as contracts from "@agency_hub_core/contracts";
import {
  AI_COVERAGE_CHECK_DELETED_MAX,
  AI_COVERAGE_CHECK_DELETED_STATES,
  AI_COVERAGE_CHECK_DIRECTIONS,
  AI_COVERAGE_CHECK_WINDOW_MAX,
  AI_COVERAGE_CHECK_WINDOW_STATES,
  AI_KNOWN_FAN_MESSAGE_IDS_MAX,
  AI_STREAM_CAPABILITIES,
  CLIENT_HUB_CAPABILITY_NAMES,
  aiFeatureContextFrameSchema,
  routeSchemas,
  type AiCoverageCheck,
} from "@agency_hub_core/contracts";
import { AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS, type AiKnownMessageStoreState } from "@agency_hub_core/db";

import {
  buildAiContextFrameBody,
  loadAiContextFrameBody,
  parseAiStreamCapabilities,
  resolveCoverageCheck,
  type AiContextMessageRef,
  type AiCoverageCheckAnswer,
  type TranscriptMessage,
  type TranscriptServedSnapshot,
} from "../apps/runtime/src/modules/ai/index.ts";
import { SERVED_CLIENT_CAPABILITIES } from "../apps/runtime/src/services/client-capabilities.ts";
import * as sdk from "../packages/sdk/src/index.ts";

// chat-extension Project Unite R20, HF-8в: the window coverage check. The
// client names the ids of its tab's window (both sides) and the ids it saw
// deleted; the hub answers each one in the `context_v1` frame, from the
// transcript that served the generation. The answers and how the client reads
// them live in one fixture matrix shared with the client
// (tests/fixtures/ai-coverage-check-matrix.json, copied verbatim by
// chat-extension P8b2).

type Direction = (typeof AI_COVERAGE_CHECK_DIRECTIONS)[number];
type Verdict = "fresh" | "miss" | "stale" | "unverified";
type Answer = { id: string; state: string };
interface Matrix {
  version: number;
  classes: { window: Record<string, string>; deleted: Record<string, string> };
  hubCases: Array<{
    name: string;
    served: Array<{ id: string; dir: Direction }>;
    stores: Record<string, AiKnownMessageStoreState> | null;
    request: AiCoverageCheck;
    answer: AiCoverageCheckAnswer;
    coverageVerdict: Verdict;
  }>;
  clientCases: Array<{
    name: string;
    request: AiCoverageCheck;
    answer: { window: Answer[]; deleted: Answer[] } | null;
    coverageVerdict: Verdict;
  }>;
  invalidRequests: Array<{ name: string; request: unknown }>;
}

const matrix = JSON.parse(readFileSync(
  fileURLToPath(new URL("./fixtures/ai-coverage-check-matrix.json", import.meta.url)),
  "utf8",
)) as Matrix;

const GENERATION = "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f";

function servedWindow(served: Array<{ id: string; dir: Direction }>): AiContextMessageRef[] {
  return served.map((message, index) => ({
    messageRef: message.id,
    occurredAt: new Date(1_000 * (index + 1)),
    isFromFan: message.dir === "fan",
  }));
}

function storesOf(stores: Record<string, AiKnownMessageStoreState> | null): Map<string, AiKnownMessageStoreState> | null {
  return stores === null ? null : new Map(Object.entries(stores));
}

/**
 * The reference reader of the matrix: the coverage check's part of the
 * client's verdict, exactly as the file's `$comment` states it. The client
 * implements its own; both are held to the same `coverageVerdict`s.
 */
function coverageVerdict(request: AiCoverageCheck, answer: { window: Answer[]; deleted: Answer[] } | null): Verdict {
  if (answer === null) {
    return "unverified";
  }
  const lists = [
    { asked: request.window.map((item) => item.id), answers: answer.window, table: matrix.classes.window },
    { asked: request.deletedIds, answers: answer.deleted, table: matrix.classes.deleted },
  ];
  const classes: string[] = [];
  for (const list of lists) {
    const asked = new Set(list.asked);
    const counts = new Map<string, number>();
    for (const one of list.answers) {
      if (!asked.has(one.id)) {
        return "unverified";
      }
      counts.set(one.id, (counts.get(one.id) ?? 0) + 1);
      classes.push(list.table[one.state] ?? "unverified");
    }
    if (list.asked.some((id) => counts.get(id) !== 1)) {
      return "unverified";
    }
  }
  for (const verdict of ["unverified", "miss", "stale"] as const) {
    if (classes.includes(verdict)) {
      return verdict;
    }
  }
  return "fresh";
}

describe("the shared fixture matrix (chat-extension P8b2 copies it verbatim)", () => {
  it("names every state the hub sends, in the list it is sent in, and nothing else of the hub's", () => {
    expect(matrix.version).toBe(1);
    // Every state the hub can send has a class; `included` in the deleted
    // table is the client's defensive reading (spec §3.5): the hub says
    // `still_served` there.
    for (const state of AI_COVERAGE_CHECK_WINDOW_STATES) {
      expect(matrix.classes.window, state).toHaveProperty(state);
    }
    for (const state of AI_COVERAGE_CHECK_DELETED_STATES) {
      expect(matrix.classes.deleted, state).toHaveProperty(state);
    }
    expect(Object.keys(matrix.classes.window).sort()).toEqual([...AI_COVERAGE_CHECK_WINDOW_STATES].sort());
    expect(Object.keys(matrix.classes.deleted).sort()).toEqual([...AI_COVERAGE_CHECK_DELETED_STATES, "included"].sort());
    // A window answer can be a miss, never stale; a deleted answer the other way round.
    expect(new Set(Object.values(matrix.classes.window))).toEqual(new Set(["counted", "miss", "unverified"]));
    expect(new Set(Object.values(matrix.classes.deleted))).toEqual(new Set(["counted", "stale", "unverified"]));
  });

  it("covers every state the hub sends and every verdict, in hub cases", () => {
    const windowStates = new Set(matrix.hubCases.flatMap((one) => one.answer.window.map((answer) => answer.state)));
    const deletedStates = new Set(matrix.hubCases.flatMap((one) => one.answer.deleted.map((answer) => answer.state)));
    expect([...windowStates].sort()).toEqual([...AI_COVERAGE_CHECK_WINDOW_STATES].sort());
    expect([...deletedStates].sort()).toEqual([...AI_COVERAGE_CHECK_DELETED_STATES].sort());
    expect(new Set(matrix.hubCases.map((one) => one.coverageVerdict))).toEqual(new Set(["fresh", "miss", "stale", "unverified"]));
  });

  it("holds bodies the hub accepts and frames it may send", () => {
    const body = routeSchemas.aiFeatureStream.body;
    for (const one of matrix.hubCases) {
      expect(body.safeParse({
        clientRequestId: GENERATION,
        pageLabel: "fs-page",
        platform: "fansly",
        conversationRef: "650000000000000001",
        coverageCheck: one.request,
      }).success, one.name).toBe(true);
      expect(aiFeatureContextFrameSchema.safeParse({
        type: "context_v1",
        generationRef: GENERATION,
        ...buildAiContextFrameBody({
          served: { source: "archive", window: servedWindow(one.served), archiveHead: null },
          requestedCount: 100,
          coverage: "complete",
          coverageCheck: one.answer,
          fanLanguageEvidence: "unknown",
        }),
      }).success, one.name).toBe(true);
    }
    for (const one of matrix.clientCases) {
      expect(body.safeParse({
        clientRequestId: GENERATION, pageLabel: "fs-page", platform: "fansly", conversationRef: "650000000000000001",
        coverageCheck: one.request,
      }).success, one.name).toBe(true);
    }
  });

  for (const one of matrix.hubCases) {
    it(`hub: ${one.name}`, () => {
      const answer = resolveCoverageCheck({
        check: one.request,
        window: servedWindow(one.served),
        stores: storesOf(one.stores),
      });
      expect(answer).toEqual(one.answer);
      // Exactly one answer per asked id, in the client's order, in its own list.
      expect(answer.window.map((item) => item.id)).toEqual(one.request.window.map((item) => item.id));
      expect(answer.deleted.map((item) => item.id)).toEqual(one.request.deletedIds);
      expect(coverageVerdict(one.request, answer)).toBe(one.coverageVerdict);
    });
  }

  for (const one of matrix.clientCases) {
    it(`client: ${one.name}`, () => {
      expect(coverageVerdict(one.request, one.answer)).toBe(one.coverageVerdict);
    });
  }

  for (const one of matrix.invalidRequests) {
    it(`refused with 400: ${one.name}`, () => {
      expect(routeSchemas.aiFeatureStream.body.safeParse({
        clientRequestId: GENERATION,
        pageLabel: "fs-page",
        platform: "fansly",
        conversationRef: "650000000000000001",
        coverageCheck: one.request,
      }).success).toBe(false);
    });
  }
});

describe("a deleted message the hub still serves", () => {
  it("is a discrepancy: answered still_served, and the client reads the context as stale", () => {
    const answer = resolveCoverageCheck({
      check: { window: [{ id: "700000000000000101", dir: "fan" }], deletedIds: ["700000000000000201"] },
      window: servedWindow([{ id: "700000000000000101", dir: "fan" }, { id: "700000000000000201", dir: "model" }]),
      // Whatever the stores say about it: the model read it.
      stores: new Map([["700000000000000201", "deleted"]]),
    });
    expect(answer.deleted).toEqual([{ id: "700000000000000201", state: "still_served" }]);
    expect(matrix.classes.deleted.still_served).toBe("stale");
    expect(coverageVerdict(
      { window: [{ id: "700000000000000101", dir: "fan" }], deletedIds: ["700000000000000201"] },
      answer,
    )).toBe("stale");
  });
});

describe("exactly one answer per asked id", () => {
  const id = (n: number) => `7000000000000${String(n).padStart(5, "0")}`;

  it("answers 60 window ids and 60 deleted ids, each once, whatever the window and the stores hold", () => {
    const check: AiCoverageCheck = {
      window: Array.from({ length: AI_COVERAGE_CHECK_WINDOW_MAX }, (_, n) => ({
        id: id(n + 1),
        dir: n % 3 === 0 ? "model" : "fan",
      })),
      deletedIds: Array.from({ length: AI_COVERAGE_CHECK_DELETED_MAX }, (_, n) => id(n + 101)),
    };
    // The served window holds every other window id (from either side) and a
    // few of the deleted ones; the stores hold a mix of the rest.
    const served = [
      ...check.window.filter((_, n) => n % 2 === 0).map((item, n) => ({ id: item.id, dir: (n % 2 === 0 ? "fan" : "model") as Direction })),
      ...check.deletedIds.filter((_, n) => n % 7 === 0).map((deleted) => ({ id: deleted, dir: "fan" as Direction })),
    ];
    const states: AiKnownMessageStoreState[] = ["present", "deleted", "absent"];
    const stores = new Map(
      [...check.window.map((item) => item.id), ...check.deletedIds].map((ref, n) => [ref, states[n % 3]!] as const),
    );
    for (const storeMap of [stores, null]) {
      const answer = resolveCoverageCheck({ check, window: servedWindow(served), stores: storeMap });
      expect(answer.window.map((item) => item.id)).toEqual(check.window.map((item) => item.id));
      expect(answer.deleted.map((item) => item.id)).toEqual(check.deletedIds);
      for (const item of answer.window) {
        expect(AI_COVERAGE_CHECK_WINDOW_STATES).toContain(item.state);
      }
      for (const item of answer.deleted) {
        expect(AI_COVERAGE_CHECK_DELETED_STATES).toContain(item.state);
      }
      expect(aiFeatureContextFrameSchema.shape.coverageCheck.safeParse(answer).success).toBe(true);
    }
  });

  it("an empty check gets an empty answer, not no answer", () => {
    expect(resolveCoverageCheck({ check: { window: [], deletedIds: [] }, window: [], stores: null }))
      .toEqual({ window: [], deleted: [] });
  });
});

describe("coverageCheck body field", () => {
  const schema = routeSchemas.aiFeatureStream.body;
  const body = (coverageCheck?: unknown) => ({
    clientRequestId: GENERATION,
    pageLabel: "fs-page",
    platform: "fansly",
    conversationRef: "650000000000000001",
    ...(coverageCheck === undefined ? {} : { coverageCheck }),
  });
  const ids = (count: number, base = 1) => Array.from({ length: count }, (_, n) => String(base + n));

  it("takes up to 60 window ids and 60 deleted ids, empty lists included", () => {
    expect(schema.safeParse(body()).success).toBe(true);
    expect(schema.safeParse(body({ window: [], deletedIds: [] })).success).toBe(true);
    expect(schema.safeParse(body({
      window: ids(AI_COVERAGE_CHECK_WINDOW_MAX).map((one) => ({ id: one, dir: "fan" })),
      deletedIds: ids(AI_COVERAGE_CHECK_DELETED_MAX, 1_000),
    })).success).toBe(true);
    expect(schema.safeParse(body({ window: [{ id: "9".repeat(30), dir: "model" }], deletedIds: [] })).success).toBe(true);
  });

  it("refuses a 61st id in either list, and a repeat within or across them", () => {
    expect(schema.safeParse(body({
      window: ids(AI_COVERAGE_CHECK_WINDOW_MAX + 1).map((one) => ({ id: one, dir: "fan" })),
      deletedIds: [],
    })).success).toBe(false);
    expect(schema.safeParse(body({ window: [], deletedIds: ids(AI_COVERAGE_CHECK_DELETED_MAX + 1) })).success).toBe(false);
    const across = schema.safeParse(body({ window: [{ id: "5", dir: "fan" }], deletedIds: ["4", "5"] }));
    expect(across.success).toBe(false);
    expect(across.error?.issues.map((issue) => issue.path.join("."))).toEqual(["coverageCheck.deletedIds.1"]);
  });

  it("refuses non-canonical ids, other sides, missing lists and extra keys", () => {
    for (const id of ["", "0", "09003", "9".repeat(31), "90x3", " 9003", 9003]) {
      expect(schema.safeParse(body({ window: [{ id, dir: "fan" }], deletedIds: [] })).success, String(id)).toBe(false);
      expect(schema.safeParse(body({ window: [], deletedIds: [id] })).success, String(id)).toBe(false);
    }
    for (const dir of ["Fan", "creator", "", null]) {
      expect(schema.safeParse(body({ window: [{ id: "1", dir }], deletedIds: [] })).success, String(dir)).toBe(false);
    }
    expect(schema.safeParse(body({ window: [] })).success).toBe(false);
    expect(schema.safeParse(body({ deletedIds: [] })).success).toBe(false);
    expect(schema.safeParse(body({ window: [], deletedIds: [], extra: 1 })).success).toBe(false);
    expect(schema.safeParse(body({ window: [{ id: "1", dir: "fan", text: "hi" }], deletedIds: [] })).success).toBe(false);
  });
});

describe("coverageCheck frame field", () => {
  const frame = (coverageCheck: unknown) => ({
    type: "context_v1",
    generationRef: GENERATION,
    source: "archive",
    servedHead: null,
    window: { requested: 100, served: 0 },
    coverage: "unknown",
    live: { status: "not_sent", accepted: 0, rejected: 0 },
    ...(coverageCheck === undefined ? {} : { coverageCheck }),
  });

  it("is optional, carries open tokens and drops a later key", () => {
    expect(aiFeatureContextFrameSchema.safeParse(frame(undefined)).success).toBe(true);
    const parsed = aiFeatureContextFrameSchema.parse(frame({
      window: [{ id: "1", state: "future_state", futureKey: 1 }],
      deleted: [{ id: "2", state: "still_served" }],
      futureList: [],
    }));
    expect(parsed.coverageCheck).toEqual({
      window: [{ id: "1", state: "future_state" }],
      deleted: [{ id: "2", state: "still_served" }],
    });
  });

  it("holds at most 60 answers per list and both lists", () => {
    const answers = (count: number) => Array.from({ length: count }, (_, n) => ({ id: String(n + 1), state: "absent" }));
    expect(aiFeatureContextFrameSchema.safeParse(frame({ window: answers(60), deleted: answers(60) })).success).toBe(true);
    expect(aiFeatureContextFrameSchema.safeParse(frame({ window: answers(61), deleted: [] })).success).toBe(false);
    expect(aiFeatureContextFrameSchema.safeParse(frame({ window: [], deleted: answers(61) })).success).toBe(false);
    expect(aiFeatureContextFrameSchema.safeParse(frame({ window: [] })).success).toBe(false);
    expect(aiFeatureContextFrameSchema.safeParse(frame({ window: [{ id: "1", state: "" }], deleted: [] })).success).toBe(false);
  });
});

describe("the capability", () => {
  it("is a header token and a bootstrap capability, served by this hub", () => {
    expect(AI_STREAM_CAPABILITIES).toContain("coverage-check-v1");
    expect([...parseAiStreamCapabilities("context-v1, coverage-check-v1")]).toEqual(["context-v1", "coverage-check-v1"]);
    // Every token the SDK may write still fits the header's 256 characters.
    expect(AI_STREAM_CAPABILITIES.join(", ").length).toBeLessThanOrEqual(256);
    expect(CLIENT_HUB_CAPABILITY_NAMES).toContain("coverage-check-v1");
    expect(SERVED_CLIENT_CAPABILITIES).toContain("coverage-check-v1");
  });

  it("re-exports the check's known values from the generated SDK (the client cannot reach contracts)", () => {
    expect(AI_COVERAGE_CHECK_WINDOW_MAX).toBe(60);
    expect(AI_COVERAGE_CHECK_DELETED_MAX).toBe(60);
    expect(AI_COVERAGE_CHECK_DIRECTIONS).toEqual(["fan", "model"]);
    expect(AI_COVERAGE_CHECK_WINDOW_STATES).toEqual([
      "included", "direction_mismatch", "outside_window", "deleted", "absent", "unknown",
    ]);
    expect(AI_COVERAGE_CHECK_DELETED_STATES).toEqual(["deleted", "still_served", "absent", "unknown"]);
    for (const name of [
      "AI_COVERAGE_CHECK_DELETED_MAX",
      "AI_COVERAGE_CHECK_DELETED_STATES",
      "AI_COVERAGE_CHECK_DIRECTIONS",
      "AI_COVERAGE_CHECK_WINDOW_MAX",
      "AI_COVERAGE_CHECK_WINDOW_STATES",
    ] as const) {
      expect(sdk[name], name).toBeDefined();
      expect(sdk[name], name).toBe(contracts[name]);
    }
  });

  it("one store lookup takes every id a request can name", () => {
    expect(AI_KNOWN_FAN_MESSAGE_IDS_MAX + AI_COVERAGE_CHECK_WINDOW_MAX + AI_COVERAGE_CHECK_DELETED_MAX)
      .toBe(AI_KNOWN_MESSAGE_LOOKUP_MAX_REFS);
  });
});

describe("context frame loader with a coverage check", () => {
  const served: TranscriptServedSnapshot = {
    source: "archive",
    window: servedWindow([
      { id: "9001", dir: "fan" },
      { id: "9002", dir: "model" },
      { id: "9003", dir: "fan" },
    ]),
    archiveHead: null,
  };
  const messages: TranscriptMessage[] = [
    { id: "9001", createdAtMs: 1000, sender: "Fan", text: "hey", labels: [] },
    { id: "9002", createdAtMs: 2000, sender: "Model", text: "hi", labels: [] },
    { id: "9003", createdAtMs: 3000, sender: "Fan", text: "how are you", labels: [] },
  ];
  const request = { pageId: 7, platform: "fansly", conversationRef: "650000000000000001", served, messages, requestedCount: 50 };

  /** The loader's reads in order: the coverage row, then one known-id lookup. */
  function stubApp(reads: Array<() => Promise<{ rows: Array<Record<string, unknown>> }>>) {
    const warnings: string[] = [];
    let calls = 0;
    const app = {
      db: { execute: async () => reads[calls++]!() },
      logger: { warn: (_fields: unknown, text: string) => { warnings.push(text); } },
    } as unknown as Parameters<typeof loadAiContextFrameBody>[0];
    return { app, warnings, calls: () => calls };
  }
  const noRows = async () => ({ rows: [] });
  const failing = async () => { throw new Error("connection terminated"); };

  it("asks the stores once for every id outside the window, of both fields", async () => {
    const lookup = async () => ({
      rows: [
        { message_ref: "8001", held: true, tombstoned: false },
        { message_ref: "8002", held: true, tombstoned: true },
      ],
    });
    const stub = stubApp([noRows, lookup]);
    const body = await loadAiContextFrameBody(stub.app, {
      ...request,
      knownFanMessageIds: ["9003", "8001"],
      coverageCheck: {
        window: [
          { id: "9003", dir: "fan" },
          { id: "9002", dir: "fan" },
          { id: "8001", dir: "fan" },
          { id: "8003", dir: "model" },
        ],
        deletedIds: ["8002", "9001"],
      },
    });
    // The coverage row and ONE lookup for the ids of both fields.
    expect(stub.calls()).toBe(2);
    expect(body.knownFanMessages).toEqual([{ id: "9003", state: "included" }, { id: "8001", state: "absent" }]);
    expect(body.coverageCheck).toEqual({
      window: [
        { id: "9003", state: "included" },
        { id: "9002", state: "direction_mismatch" },
        { id: "8001", state: "outside_window" },
        { id: "8003", state: "absent" },
      ],
      deleted: [{ id: "8002", state: "deleted" }, { id: "9001", state: "still_served" }],
    });
  });

  it("fails open: a failed lookup answers unknown outside the window and never costs the generation", async () => {
    const stub = stubApp([noRows, failing]);
    const body = await loadAiContextFrameBody(stub.app, {
      ...request,
      coverageCheck: { window: [{ id: "9001", dir: "fan" }, { id: "8001", dir: "fan" }], deletedIds: ["8002"] },
    });
    expect(body.coverageCheck).toEqual({
      window: [{ id: "9001", state: "included" }, { id: "8001", state: "unknown" }],
      deleted: [{ id: "8002", state: "unknown" }],
    });
    expect(stub.warnings).toEqual(["ai context frame known-message lookup failed"]);
  });

  it("reads nothing more for ids the window holds, and adds nothing without a check", async () => {
    const inWindow = stubApp([noRows, failing]);
    expect((await loadAiContextFrameBody(inWindow.app, {
      ...request,
      coverageCheck: { window: [{ id: "9001", dir: "fan" }], deletedIds: ["9002"] },
    })).coverageCheck).toEqual({
      window: [{ id: "9001", state: "included" }],
      deleted: [{ id: "9002", state: "still_served" }],
    });
    expect(inWindow.calls()).toBe(1);
    const none = stubApp([noRows, failing]);
    expect(await loadAiContextFrameBody(none.app, request)).not.toHaveProperty("coverageCheck");
    expect(none.calls()).toBe(1);
  });

  it("judges against the window the prompt kept: a message the budget cut is outside it", async () => {
    const held = async () => ({ rows: [{ message_ref: "9001", held: true, tombstoned: false }] });
    const stub = stubApp([noRows, held]);
    expect((await loadAiContextFrameBody(stub.app, {
      ...request,
      omittedByPromptBudget: 1,
      coverageCheck: { window: [{ id: "9001", dir: "fan" }], deletedIds: [] },
    })).coverageCheck).toEqual({ window: [{ id: "9001", state: "outside_window" }], deleted: [] });
  });
});
