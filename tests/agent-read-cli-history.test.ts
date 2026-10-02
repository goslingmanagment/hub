import { describe, expect, it } from "vitest";

import {
  agentHistoryRequestCancelBodySchema,
  agentHistoryRequestCreateBodySchema,
  agentHistoryRequestGetQuerySchema,
  agentHistoryRequestListQuerySchema,
} from "@agency_hub_core/contracts";
import type { KernelClient } from "@kernel/sdk";
import { KernelApiError } from "@kernel/sdk";

import {
  HUB_HISTORY_FALLBACK_HINT,
  hubChunkIdempotencyKey,
  parseHubBatchFile,
  parseHubRequestFile,
} from "../packages/hub-agent-cli/src/commands.ts";
import { HUB_EXIT_ERROR, HUB_EXIT_OK, HUB_EXIT_PARTIAL, runHubCli } from "../packages/hub-agent-cli/src/main.ts";

/**
 * The `hub` history-request commands (design §7.6, D20): flat names and
 * `--page-label`, one call per command except the two marked COMPOSITE, the
 * hydration fallback printed beside a 409 on a page the engine does not own,
 * and a fake clock and file system throughout.
 */

const ENV = { HUB_AGENT_KEY: "agency_hub_agent_history-test" };
const NO_MODE = () => null;
const REF = "7f9d3c2e-1b4a-4c8e-9f20-3a5b6c7d8e9f";

type Call = { method: string; input: unknown };
type Responder = (call: Call, index: number) => unknown;

function stubClient(calls: Call[], respond: Responder) {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, property: string) {
      return (input: unknown) => {
        const call = { method: property, input };
        calls.push(call);
        const response = respond(call, calls.length - 1);
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
      };
    },
  };
  return new Proxy({}, handler) as unknown as KernelClient;
}

async function run(argv: string[], options: {
  respond?: Responder;
  files?: Record<string, string>;
  uuids?: string[];
} = {}) {
  const calls: Call[] = [];
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const uuids = [...(options.uuids ?? [])];
  const result = await runHubCli({
    argv,
    env: ENV,
    readFile: (path) => options.files?.[path] ?? null,
    fileMode: NO_MODE,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    randomUUID: () => uuids.shift() ?? "00000000-0000-4000-8000-000000000000",
    createHubClient: () => stubClient(calls, options.respond ?? (() => ({ conclusion: { blockers: [] } }))),
  });
  return { result, calls, sleeps };
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return (call?.input as { body: Record<string, unknown> }).body;
}

describe("hub history-request", () => {
  it("files one request from flags and a list file, fans de-duplicated, depth explicit", async () => {
    const { result, calls } = await run([
      "history-request", "--page-label", "lora-1",
      "--fan", "510000000000000001", "--fan", "510000000000000001",
      "--conversation", "810272281019305984",
      "--chat-url", "https://fansly.com/messages/810272281019305985",
      "--file", "fans.txt",
      "--latest", "200", "--reason", "context", "--claim-field", "textPlain",
    ], {
      files: { "fans.txt": "# list\n510000000000000002\n\nconversation:810272281019305984\nhttps://www.fansly.com/messages/9/\n" },
      uuids: [REF],
    });
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("agentHistoryRequestCreate");
    expect((calls[0]?.input as { params: unknown }).params).toEqual({ pageLabel: "lora-1" });
    const body = bodyOf(calls[0]);
    expect(body).toEqual({
      fans: [
        { kind: "fan", platformUserId: "510000000000000001" },
        { kind: "conversation", conversationRef: "810272281019305984" },
        { kind: "chat_url", url: "https://fansly.com/messages/810272281019305985" },
        { kind: "fan", platformUserId: "510000000000000002" },
        { kind: "chat_url", url: "https://www.fansly.com/messages/9/" },
      ],
      depth: { kind: "latest", count: 200 },
      reason: "context",
      idempotencyKey: REF,
      claim: { fields: ["textPlain"], targets: "all_in_scope" },
    });
    expect(agentHistoryRequestCreateBodySchema.safeParse(body).success).toBe(true);
  });

  it("refuses a missing or double depth, no fans, no page, a bad key and an unreadable file", async () => {
    const base = ["history-request", "--page-label", "lora-1", "--reason", "r"];
    const usage = async (argv: string[], files?: Record<string, string>) => {
      const { result, calls } = await run(argv, files === undefined ? {} : { files });
      expect(result.exitCode, argv.join(" ")).toBe(HUB_EXIT_ERROR);
      expect((result.document.error as { category: string }).category).toBe("usage");
      expect(calls).toHaveLength(0);
      return (result.document.error as { message: string }).message;
    };
    expect(await usage([...base, "--fan", "1"])).toContain("say the depth");
    expect(await usage([...base, "--fan", "1", "--all", "--latest", "5"])).toContain("say the depth");
    expect(await usage([...base, "--fan", "1", "--latest", "0"])).toContain("--latest");
    expect(await usage([...base, "--all"])).toContain("name at least one fan");
    expect(await usage([...base, "--all", "--fan", "1", "--idempotency-key", "nope"])).toContain("uuid");
    expect(await usage([...base, "--all", "--file", "missing.txt"])).toContain("cannot be read");
    // A fan with no page: neither --page-label nor a pageLabel<TAB> on its line.
    const noPage = ["history-request", "--reason", "r", "--all"];
    expect(await usage([...noPage, "--fan", "1"])).toContain("--page-label is required");
    expect(await usage([...noPage, "--file", "mixed.txt"], { "mixed.txt": "lora-1\t1\n2\n" }))
      .toContain("--page-label is required");
    expect(await usage([...base, "--all", "--file", "bad.txt"], { "bad.txt": "\t1\n" })).toContain("line 1");
  });

  const fansOf = (count: number, offset = 0) =>
    Array.from({ length: count }, (_, index) => `5100000000000${String(offset + index).padStart(5, "0")}`);
  const pageOf = (call: Call) => (call.input as { params: { pageLabel: string } }).params.pageLabel;

  it("splits more than 1000 fans of a page itself: one request per 1000, keys derived from the given key", async () => {
    // Plan §4.1: the CLI divides a big list into requests; nobody has to.
    const respond: Responder = (call, index) => ({
      disposition: "created",
      request: { ref: `ref-${index}` },
      conclusion: { blockers: ["claim_not_declared"] },
    });
    const argv = [
      "history-request", "--page-label", "lora-1", "--fan", fansOf(1)[0]!, "--file", "big.txt",
      "--latest", "100", "--reason", "q3", "--idempotency-key", REF, "--claim-field", "textPlain",
    ];
    const files = { "big.txt": fansOf(2500).join("\n") };
    const { result, calls } = await run(argv, { files, respond });
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(calls.map((call) => call.method)).toEqual(Array(3).fill("agentHistoryRequestCreate"));
    expect(calls.map(pageOf)).toEqual(["lora-1", "lora-1", "lora-1"]);
    // The fan named by flag and again in the file is sent once.
    expect(calls.map((call) => (bodyOf(call).fans as unknown[]).length)).toEqual([1000, 1000, 500]);
    const sent = calls.flatMap((call) => bodyOf(call).fans as Array<{ platformUserId: string }>);
    expect(sent.map((fan) => fan.platformUserId)).toEqual(fansOf(2500));
    for (const call of calls) {
      expect(agentHistoryRequestCreateBodySchema.safeParse(bodyOf(call)).success).toBe(true);
      expect(bodyOf(call)).toMatchObject({
        depth: { kind: "latest", count: 100 },
        reason: "q3",
        claim: { fields: ["textPlain"], targets: "all_in_scope" },
      });
    }
    const keys = calls.map((call) => bodyOf(call).idempotencyKey);
    expect(keys).toEqual([0, 1, 2].map((chunk) => hubChunkIdempotencyKey(REF, "lora-1", chunk)));
    expect(result.document).toMatchObject({
      ok: true,
      composite: { calls: 3, failed: 0, pages: 1 },
      blockers: [],
    });
    const requests = (result.document.data as { requests: Array<Record<string, unknown>> }).requests;
    expect(requests.map((entry) => [entry.chunk, entry.fans, entry.ok])).toEqual([[0, 1000, true], [1, 1000, true], [2, 500, true]]);

    // The same key re-files the same requests, never second copies.
    const again = await run(argv, { files, respond });
    expect(again.calls.map((call) => bodyOf(call).idempotencyKey)).toEqual(keys);
  });

  it("splits a list of several pages itself: one request per page, the flags' page first", async () => {
    const list = [
      "# whales across pages",
      "lora-2\t510000000000000002",
      "510000000000000003",
      "lora-3\thttps://fansly.com/messages/810272281019305984",
      "lora-2\tconversation:810272281019305985",
      "lora-1\t510000000000000001",
    ].join("\n");
    const { result, calls } = await run(
      ["history-request", "--page-label", "lora-1", "--fan", "510000000000000001", "--file", "pages.txt",
        "--all", "--reason", "q3"],
      { files: { "pages.txt": list }, uuids: [REF, "0c6f5e1a-2b3d-4e5f-8a9b-1c2d3e4f5a6b", "1d7e6f2b-3c4e-4f6a-9b0c-2d3e4f5a6b7c"] },
    );
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(calls.map(pageOf)).toEqual(["lora-1", "lora-2", "lora-3"]);
    expect(calls.map((call) => bodyOf(call).fans)).toEqual([
      [{ kind: "fan", platformUserId: "510000000000000001" }, { kind: "fan", platformUserId: "510000000000000003" }],
      [{ kind: "fan", platformUserId: "510000000000000002" }, { kind: "conversation", conversationRef: "810272281019305985" }],
      [{ kind: "chat_url", url: "https://fansly.com/messages/810272281019305984" }],
    ]);
    // Without --idempotency-key every request gets a fresh key.
    expect(calls.map((call) => bodyOf(call).idempotencyKey))
      .toEqual([REF, "0c6f5e1a-2b3d-4e5f-8a9b-1c2d3e4f5a6b", "1d7e6f2b-3c4e-4f6a-9b0c-2d3e4f5a6b7c"]);
    expect(result.document.composite).toEqual({ calls: 3, failed: 0, pages: 3 });

    // Every line naming its own page needs no --page-label; one page and
    // at most 1000 fans stays ONE call with the operation's own document.
    const single = await run(
      ["history-request", "--file", "one.txt", "--all", "--reason", "q3", "--idempotency-key", REF],
      { files: { "one.txt": "lora-2\t510000000000000002\nlora-2\t510000000000000004\n" } },
    );
    expect(single.result.exitCode).toBe(HUB_EXIT_OK);
    expect(single.calls).toHaveLength(1);
    expect(pageOf(single.calls[0]!)).toBe("lora-2");
    expect(bodyOf(single.calls[0]).idempotencyKey).toBe(REF);
    expect(single.result.document).not.toHaveProperty("composite");
  });

  it("files the other pages past a refused one, lists every result with the fallback, and exits 4", async () => {
    const respond: Responder = (call) => pageOf(call) === "lora-2"
      ? new KernelApiError("not open", "conflict", 409, "history_requests_unavailable_on_page", { secret: "body" })
      : { disposition: "created", request: { ref: "r1" } };
    const { result, calls } = await run(
      ["history-request", "--page-label", "lora-1", "--fan", "1", "--file", "pages.txt", "--all", "--reason", "q3"],
      { files: { "pages.txt": "lora-2\t2\nlora-3\t3\n" }, respond },
    );
    expect(calls.map(pageOf)).toEqual(["lora-1", "lora-2", "lora-3"]);
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(result.document.ok).toBe(false);
    const requests = (result.document.data as { requests: Array<Record<string, unknown>> }).requests;
    expect(requests[1]).toMatchObject({
      pageLabel: "lora-2",
      ok: false,
      error: { status: 409, code: "history_requests_unavailable_on_page", hint: HUB_HISTORY_FALLBACK_HINT },
    });
    expect(JSON.stringify(requests[1])).not.toContain("secret");
    expect(requests.filter((entry) => entry.ok === true).map((entry) => entry.pageLabel)).toEqual(["lora-1", "lora-3"]);
    expect(result.document.composite).toEqual({ calls: 3, failed: 1, pages: 3 });
  });

  it("prints the hydration fallback beside a 409 on a page the engine does not own", async () => {
    const refusal = new KernelApiError(
      "History requests are not open on page 7",
      "conflict",
      409,
      "history_requests_unavailable_on_page",
      { error: "history_requests_unavailable_on_page" },
    );
    const { result } = await run(
      ["history-request", "--page-label", "lora-1", "--fan", "1", "--all", "--reason", "r"],
      { respond: () => refusal },
    );
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(result.document.error).toMatchObject({
      status: 409,
      code: "history_requests_unavailable_on_page",
      hint: HUB_HISTORY_FALLBACK_HINT,
    });
    expect(HUB_HISTORY_FALLBACK_HINT).toContain("/hydration-requests");

    // Any other refusal carries no hint.
    const other = await run(
      ["history-request", "--page-label", "lora-1", "--fan", "1", "--all", "--reason", "r"],
      { respond: () => new KernelApiError("same key, other fans", "conflict", 409, "idempotency_mismatch", {}) },
    );
    expect(other.result.document.error).not.toHaveProperty("hint");
  });
});

describe("hub history-request-batch (COMPOSITE)", () => {
  const fansOf = (count: number, offset = 0) =>
    Array.from({ length: count }, (_, index) => `5100000000000${String(offset + index).padStart(5, "0")}`);

  it("files one request per page and per 1000 fans, with keys derived from the batch key", async () => {
    const tsv = [
      ...fansOf(1001).map((fan) => `lora-1\t${fan}`),
      "lora-2\thttps://fansly.com/messages/810272281019305984",
      "lora-1\t" + fansOf(1)[0]!,
    ].join("\n");
    const respond: Responder = (call) => ({
      disposition: "created",
      request: { ref: `ref-${(call.input as { params: { pageLabel: string } }).params.pageLabel}` },
      conclusion: { blockers: ["claim_not_declared"] },
    });
    const argv = ["history-request-batch", "--file", "pages.tsv", "--all", "--reason", "q3", "--idempotency-key", REF];
    const { result, calls } = await run(argv, { files: { "pages.tsv": tsv }, respond });
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(calls.map((call) => (call.input as { params: { pageLabel: string } }).params.pageLabel))
      .toEqual(["lora-1", "lora-1", "lora-2"]);
    expect(calls.map((call) => (bodyOf(call).fans as unknown[]).length)).toEqual([1000, 1, 1]);
    for (const call of calls) {
      expect(agentHistoryRequestCreateBodySchema.safeParse(bodyOf(call)).success).toBe(true);
    }
    const keys = calls.map((call) => bodyOf(call).idempotencyKey);
    expect(keys).toEqual([
      hubChunkIdempotencyKey(REF, "lora-1", 0),
      hubChunkIdempotencyKey(REF, "lora-1", 1),
      hubChunkIdempotencyKey(REF, "lora-2", 0),
    ]);
    expect(new Set(keys).size).toBe(3);
    expect(result.document).toMatchObject({
      ok: true,
      composite: { calls: 3, failed: 0, pages: 2 },
      // A composite's own document has no conclusion to lift.
      blockers: [],
    });

    // The same batch key re-files the same requests, never second copies.
    const again = await run(argv, { files: { "pages.tsv": tsv }, respond });
    expect(again.calls.map((call) => bodyOf(call).idempotencyKey)).toEqual(keys);
  });

  it("keeps going past a refused page, lists every result, and exits 4", async () => {
    const tsv = "lora-1\t510000000000000001\nlora-2\t510000000000000002\n";
    const respond: Responder = (call) => (call.input as { params: { pageLabel: string } }).params.pageLabel === "lora-1"
      ? new KernelApiError("not open", "conflict", 409, "history_requests_unavailable_on_page", { secret: "body" })
      : { disposition: "created", request: { ref: "r2" } };
    const { result, calls } = await run(
      ["history-request-batch", "--file", "pages.tsv", "--latest", "50", "--reason", "q3"],
      { files: { "pages.tsv": tsv }, respond, uuids: [REF, "0c6f5e1a-2b3d-4e5f-8a9b-1c2d3e4f5a6b"] },
    );
    expect(calls).toHaveLength(2);
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(result.document.ok).toBe(false);
    const requests = (result.document.data as { requests: Array<Record<string, unknown>> }).requests;
    expect(requests[0]).toMatchObject({
      pageLabel: "lora-1",
      ok: false,
      error: { status: 409, code: "history_requests_unavailable_on_page", hint: HUB_HISTORY_FALLBACK_HINT },
    });
    // Metadata only: a refused body never reaches the document.
    expect(JSON.stringify(requests[0])).not.toContain("secret");
    expect(requests[1]).toMatchObject({ pageLabel: "lora-2", ok: true, disposition: "created", request: { ref: "r2" } });
    expect(result.document.composite).toEqual({ calls: 2, failed: 1, pages: 2 });
  });

  it("refuses a line that is not pageLabel<TAB>fan", () => {
    expect(() => parseHubBatchFile("lora-1 510000000000000001\n")).toThrow(/line 1/);
    expect([...parseHubBatchFile("# x\n\nlora-1\t1\n").keys()]).toEqual(["lora-1"]);
  });
});

describe("hub history-status", () => {
  it("is one call without --wait", async () => {
    const { result, calls } = await run(["history-status", "--request", REF, "--state", "blocked", "--limit", "20"]);
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(calls).toEqual([{
      method: "agentHistoryRequestGet",
      input: { params: { requestRef: REF }, query: { state: "blocked", limit: 20 } },
    }]);
    expect(agentHistoryRequestGetQuerySchema.safeParse({ state: "blocked", limit: 20 }).success).toBe(true);
  });

  it("--wait polls until the request ends and prints only the last answer", async () => {
    const states = ["open", "open", "done"];
    const respond: Responder = (_call, index) => ({
      request: { state: states[index] },
      conclusion: { blockers: ["claim_not_declared", "capture_floor_unknown"] },
    });
    const { result, calls, sleeps } = await run(
      ["history-status", "--request", REF, "--wait", "--poll-seconds", "20"],
      { respond },
    );
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([20_000, 20_000]);
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(result.document).toMatchObject({
      ok: true,
      operation: "agentHistoryRequestGet",
      composite: { calls: 3, finished: true, waitedSeconds: 40 },
      blockers: ["claim_not_declared", "capture_floor_unknown"],
      data: { request: { state: "done" } },
    });
  });

  it("--wait gives up after the maximum and says so", async () => {
    const { result, calls } = await run(
      ["history-status", "--request", REF, "--wait", "--poll-seconds", "15", "--max-wait-seconds", "40"],
      { respond: () => ({ request: { state: "open" }, conclusion: { blockers: [] } }) },
    );
    // 0 s, 15 s, 30 s — a fourth poll would land past 40 s.
    expect(calls).toHaveLength(3);
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(result.document.composite).toEqual({ calls: 3, finished: false, waitedSeconds: 30 });
  });

  it("--fail-on-partial still lifts the last answer's blockers", async () => {
    const { result } = await run(
      ["history-status", "--request", REF, "--wait", "--fail-on-partial"],
      { respond: () => ({ request: { state: "cancelled" }, conclusion: { blockers: ["claim_not_declared"] } }) },
    );
    expect(result.exitCode).toBe(HUB_EXIT_PARTIAL);
  });

  it("refuses a poll faster than 15 s and a cursor beside --wait", async () => {
    const fast = await run(["history-status", "--request", REF, "--wait", "--poll-seconds", "5"]);
    expect(fast.result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(fast.calls).toHaveLength(0);
    const cursor = await run(["history-status", "--request", REF, "--wait", "--cursor", "abc"]);
    expect(cursor.result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(cursor.calls).toHaveLength(0);
  });
});

describe("hub history-cancel and history-list", () => {
  it("cancel sends the ref and an optional reason as the POST body", async () => {
    const withReason = await run(["history-cancel", "--request", REF, "--reason", "superseded"]);
    expect(withReason.calls[0]).toEqual({
      method: "agentHistoryRequestCancel",
      input: { params: { requestRef: REF }, body: { reason: "superseded" } },
    });
    const bare = await run(["history-cancel", "--request", REF]);
    expect(bodyOf(bare.calls[0])).toEqual({});
    expect(agentHistoryRequestCancelBodySchema.safeParse({}).success).toBe(true);
  });

  it("list narrows by page and state, from a closed vocabulary", async () => {
    const { calls } = await run(["history-list", "--page-label", "lora-1", "--state", "open", "--limit", "10"]);
    expect(calls[0]).toEqual({
      method: "agentHistoryRequestList",
      input: { query: { pageLabel: "lora-1", state: "open", limit: 10 } },
    });
    expect(agentHistoryRequestListQuerySchema.safeParse({ pageLabel: "lora-1", state: "open", limit: 10 }).success)
      .toBe(true);
    const bad = await run(["history-list", "--state", "pending"]);
    expect(bad.result.exitCode).toBe(HUB_EXIT_ERROR);
  });
});

describe("fan lists", () => {
  it("reads chat links, conversation refs and account ids, each of --page-label or of its own page", () => {
    expect(parseHubRequestFile(" 1 \nconversation:22\nfansly.com/messages/33\n#x\nlora-2\t44\n\n")).toEqual([
      { pageLabel: null, fan: { kind: "fan", platformUserId: "1" } },
      { pageLabel: null, fan: { kind: "conversation", conversationRef: "22" } },
      { pageLabel: null, fan: { kind: "chat_url", url: "fansly.com/messages/33" } },
      { pageLabel: "lora-2", fan: { kind: "fan", platformUserId: "44" } },
    ]);
    expect(() => parseHubRequestFile("1\nlora-2\t\n")).toThrow(/line 2/);
  });

  it("derives a valid uuid per chunk", () => {
    const key = hubChunkIdempotencyKey(REF, "lora-1", 3);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(hubChunkIdempotencyKey(REF.toUpperCase(), "lora-1", 3)).toBe(key);
    expect(hubChunkIdempotencyKey(REF, "lora-1", 4)).not.toBe(key);
  });
});
