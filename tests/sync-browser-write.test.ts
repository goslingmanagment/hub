import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";

import { parseEngineValue } from "../apps/page-browser/src/rpc/protocol.ts";
import { parseOperatorMessage } from "../apps/runtime/src/services/egress/page-browser-protocol.ts";
import { PageBrowserRpcClient, systemMonoBridge, type PageBrowserLinkSettings } from "../apps/runtime/src/services/egress/page-browser-rpc.ts";
import { PageTransportUnavailableError, type PageTransport } from "../apps/runtime/src/sync/engine/ports.ts";
import { BrowserPublishing } from "../apps/runtime/src/sync/fansly/browser-publishing.ts";
import { createBrowserPageTransport } from "../apps/runtime/src/sync/fansly/browser-transport.ts";
import { FakeOperator, OPERATOR_TOKEN } from "./helpers/page-browser-operator.ts";
import { until } from "./helpers/page-browser-fakes.ts";

// Hub's writes through a page's browser, as the two are rolled out apart
// (wall posts PR 7; protocol minor 8): the operator's own RPC server answers
// the engine's own link, with nothing else behind them.
// - A new Hub with an older operator (or one rolled back): reads go on as
//   ever; the operator never said it takes writes, so no write is ever
//   prepared for it — refused before anything is admitted — and it is never
//   sent a `setPublishing` (it would take it for a protocol error).
// - A new Hub with a new operator: the page's permissions follow its
//   settings, read fresh at every look — a switch turned off takes create
//   away at the next one, withdraw stays; an autostop takes both. The
//   operator starts with both off at every hello.
// - An older Hub with a new operator: answered as before — no `writes`, no
//   `state.publishing`, its GET sends and admissions parse as they did.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SETTINGS: PageBrowserLinkSettings = {
  token: OPERATOR_TOKEN,
  pageId: 7,
  expectedAccountId: "300000000000000001",
  pinnedExitIp: "203.0.113.7",
  socks5: { ip: "127.0.0.1", port: 1080, username: "u", password: "p" },
  env: { timeZone: "Europe/Berlin", languages: ["en-US", "en"], geolocation: { latitude: 52.5, longitude: 13.4, accuracyM: 50 } },
};

/** The page's publishing as a stub database answers it — its settings row
 *  (null: none), read and autostopped; nothing else of the database may be
 *  touched. */
interface PageRow {
  enabled: boolean;
  autostop_reason: string | null;
  autostopped_at: Date | null;
}

/** The text of a drizzle query and its parameters. */
function queryOf(query: { queryChunks: unknown[] }): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const text = query.queryChunks.map((chunk) => {
    if (typeof chunk === "object" && chunk !== null && Array.isArray((chunk as { value?: unknown }).value)) return (chunk as { value: string[] }).value.join("");
    params.push(chunk);
    return "?";
  }).join("").replace(/\s+/g, " ").trim();
  return { text, params };
}

async function rig(options: { protocolMinor?: number } = {}) {
  const operator = await FakeOperator.start(options.protocolMinor === undefined ? {} : { protocolMinor: options.protocolMinor });
  cleanups.push(() => operator.close());
  const client = new PageBrowserRpcClient({
    url: operator.url,
    ownerGeneration: 1n,
    settings: async () => SETTINGS,
    timing: { pingMs: 100, linkLossMs: 1_000, helloTimeoutMs: 1_000, reconnectMs: [50, 100], refusedRetryMs: 500 },
  });
  const page: { row: PageRow | null } = { row: { enabled: true, autostop_reason: null, autostopped_at: null } };
  const row = page.row!;
  const live = { publishingEnabled: true };
  const touched: string[] = [];
  const autostops: string[] = [];
  const told: Array<{ reason: string; note?: string }> = [];
  const db = {
    execute: async (query: { queryChunks: unknown[] }) => {
      const { text, params } = queryOf(query);
      const current = page.row;
      if (text.startsWith("select * from page_publishing_settings")) return { rows: current === null ? [] : [{ page_id: 7, repost_threshold_days: 30, updated_at: new Date(), ...current }] };
      if (text.startsWith("update page_publishing_settings") && text.includes("autostop_reason =")) {
        if (current === null || current.autostopped_at !== null) return { rows: [] };
        current.enabled = false;
        current.autostop_reason = String(params[0]);
        current.autostopped_at = new Date();
        autostops.push(current.autostop_reason);
        return { rows: [{ page_id: 7 }] };
      }
      throw new Error(`a query this stub does not answer: ${text}`);
    },
  };
  const untouchable = new Proxy(db, {
    get: (target, name) => {
      if (name === "execute") return target.execute;
      touched.push(String(name));
      throw new Error(`the database is not to be touched here (${String(name)})`);
    },
  }) as unknown as Database;
  const transport: PageTransport = await createBrowserPageTransport({ db: untouchable, config: {} as AppConfig }, { pageId: 7 }, { client });
  cleanups.push(() => transport.close());
  const publishing = new BrowserPublishing({
    db: untouchable,
    pageId: 7,
    client,
    bridge: systemMonoBridge(),
    clock: { monoNow: () => performance.now() } as never,
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined } as never,
    metrics: { increment: () => undefined },
    settings: { read: async () => live as unknown as AppConfig },
    notify: async (input) => {
      told.push({ reason: input.reason, ...(input.note === undefined ? {} : { note: input.note }) });
      return true;
    },
  });
  cleanups.push(() => publishing.stop());
  await until(() => client.up && client.quiesced !== null, 5_000, "the link and the operator's hand-over");
  return { operator, client, transport, publishing, row, page, live, touched, autostops, told };
}

const POST = { spec: "publish.post" as const, params: { content: "hi", fyp: false, attachments: [{ contentId: "1", contentType: 1 as const, pos: 0 }], scheduledForMs: 0, expiresAtMs: 0, wallIds: ["w"], pinWallIds: [], replyLock: [] } };
const CANCEL = { spec: "publish.post_cancel" as const, params: { postId: "1" } };
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

const PART = { spec: "publish.upload_part" as const, params: { uploadCommandId: 9, partIndex: 0, host: "uploads.example.net", path: "/p/1", fileId: 3, byteOffset: 0, byteLength: 4, partSha256: "a".repeat(64) } };
const STATUS = { spec: "publish.upload_status" as const, params: { uploadId: "777" } };

describe("an upload's bytes (wall posts PR 8; protocol minor 9), as the two are rolled out apart", () => {
  it("a new Hub with an operator of minor 8 writes on but uploads nothing: no part or status read is prepared or sent", async () => {
    const r = await rig({ protocolMinor: 8 });
    expect(r.client.writes).toBe(true);
    expect(r.client.uploads).toBe(false);
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.create === true, 2_000, "the permissions said");
    expect(r.transport.canWrite?.("create")).toBe(true);
    expect(r.transport.canWrite?.("create", "publish.upload_part")).toBe(false);
    expect(r.transport.canWrite?.("create", "publish.upload_status")).toBe(false);
    for (const plan of [PART, STATUS]) {
      expect(await refusal(r.transport.prepare(plan)), plan.spec).toMatchObject({ reason: expect.stringContaining("takes no upload") });
    }
    expect(r.client.sendPart({ attemptId: 1, route: "publish.upload_part", credentialsGeneration: "c".repeat(64), sessionFingerprint: "a".repeat(64), method: "PUT", url: "https://uploads.example.net/p/1", headers: {}, kind: "part", maxBodyBytes: 1024, sendDeadlineMono: 1, requestDeadlineMono: 2, writeFingerprint: "f".repeat(64) }, Buffer.from("abcd"))).toBe(false);
    expect(r.operator.sends).toEqual([]);
    expect(r.touched).toEqual([]);
  });

  it("a new Hub with a new operator: uploads under create; a part's bytes reach the operator whole, as frames before its send", async () => {
    const r = await rig();
    expect(r.client.uploads).toBe(true);
    expect(r.transport.canWrite?.("create", "publish.upload_part")).toBe(false);
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.create === true, 2_000, "the permissions said");
    expect(r.transport.canWrite?.("create", "publish.upload_part")).toBe(true);
    expect(r.transport.canWrite?.("create", "publish.upload_status")).toBe(true);
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 3);
    const sent = r.client.sendPart({ attemptId: 4242, route: "publish.upload_part", credentialsGeneration: "c".repeat(64), sessionFingerprint: "a".repeat(64), method: "PUT", url: "https://uploads.example.net/p/1", headers: {}, kind: "part", maxBodyBytes: 1024, sendDeadlineMono: 1, requestDeadlineMono: 2, writeFingerprint: "f".repeat(64) }, bytes);
    expect(sent).toBe(true);
    await until(() => r.operator.partBodies.has(4242), 2_000, "the part's send");
    expect(r.operator.partBodies.get(4242)?.equals(bytes)).toBe(true);
    // Its permission gone: no part is planned.
    r.row.enabled = false;
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.create === false, 2_000, "create taken away");
    expect(r.transport.canWrite?.("create", "publish.upload_part")).toBe(false);
  });

  it("an older Hub with a new operator: never told `uploads`; the engine reads an operator of minor 9 with what it adds", () => {
    const state = { type: "state", step: "ready", stopReason: null, retryAtWall: null, exitOpen: true, mode: "automation", sessionFingerprint: null, accountId: null, exitIp: null, chromeVersion: "1", operatorVersion: "1", buffer: { bytes: 0, oldestAgeMs: 0 }, selfTest: null };
    expect(parseOperatorMessage(JSON.stringify({ type: "helloResult", ok: true, protocol: { major: 1, minor: 9 }, bufferId: "b", state, writes: { fingerprint: "fansly-write.v1" }, uploads: { fingerprint: "fansly-part.v1", maxPartBytes: 64 * 1024 * 1024 } })))
      .toMatchObject({ ok: true, message: { uploads: { fingerprint: "fansly-part.v1", maxPartBytes: 64 * 1024 * 1024 } } });
    const older = parseOperatorMessage(JSON.stringify({ type: "helloResult", ok: true, protocol: { major: 1, minor: 8 }, bufferId: "b", state, writes: { fingerprint: "fansly-write.v1" } }));
    expect((older as { message: object }).message).not.toHaveProperty("uploads");
  });
});

describe("a new Hub with an older operator (or one rolled back to it)", () => {
  it("reads on and publishes nothing: no write is prepared, no permission is sent", async () => {
    const r = await rig({ protocolMinor: 7 });
    expect(r.client.status).toMatchObject({ kind: "up", protocol: { minor: 7 } });
    expect(r.client.writes).toBe(false);
    expect(r.client.state).not.toHaveProperty("publishing");
    await r.publishing.tick();
    expect(r.operator.publishingSet).toEqual([]);
    expect(r.operator.commands).toEqual([]);
    expect(r.transport.canWrite?.("create")).toBe(false);
    expect(r.transport.canWrite?.("withdraw")).toBe(false);
    for (const plan of [POST, CANCEL]) {
      const refused = await refusal(r.transport.prepare(plan));
      expect(refused, plan.spec).toBeInstanceOf(PageTransportUnavailableError);
      expect(refused, plan.spec).toMatchObject({ reason: expect.stringContaining("takes no writes") });
    }
    // Nothing was admitted, sent or read for them.
    expect(r.operator.sends).toEqual([]);
    expect(r.touched).toEqual([]);
  });
});

describe("a new Hub with a new operator", () => {
  it("tells the page's permissions from its settings, read fresh: off at the hello, then create and withdraw; a switch off takes create away at the next look; an autostop both", async () => {
    const r = await rig();
    expect(r.client.writes).toBe(true);
    // Off at the hello, until the engine says them.
    expect(r.client.state?.publishing).toMatchObject({ create: false, withdraw: false });
    expect(r.transport.canWrite?.("create")).toBe(false);
    expect(await refusal(r.transport.prepare(POST))).toMatchObject({ reason: expect.stringContaining("no permission to create") });
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.create === true, 2_000, "the permissions said");
    expect(r.operator.publishingSet).toEqual([{ create: true, withdraw: true }]);
    expect(r.transport.canWrite?.("create")).toBe(true);
    expect(r.transport.canWrite?.("withdraw")).toBe(true);
    // Said once: the next looks find them current.
    await r.publishing.tick();
    expect(r.operator.publishingSet).toHaveLength(1);
    // The page's switch off: create goes, withdraw stays (spec §8.4).
    r.row.enabled = false;
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.create === false, 2_000, "create taken away");
    expect(r.transport.canWrite?.("create")).toBe(false);
    expect(r.transport.canWrite?.("withdraw")).toBe(true);
    // The global switch off, the page's on: the same.
    r.row.enabled = true;
    r.live.publishingEnabled = false;
    await r.publishing.tick();
    expect(r.operator.publishingSet.at(-1)).toEqual({ create: false, withdraw: true });
    // An autostop (the engine's own, on a write's 429): both; the owner told once.
    r.live.publishingEnabled = true;
    r.row.autostop_reason = "fansly_http_429";
    r.row.autostopped_at = new Date();
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.withdraw === false, 2_000, "both taken away");
    expect(r.operator.publishingSet.at(-1)).toEqual({ create: false, withdraw: false });
    expect(r.transport.canWrite?.("withdraw")).toBe(false);
    await r.publishing.tick();
    expect(r.told).toEqual([{ reason: "fansly_http_429", note: expect.stringContaining("Fansly refused a publishing request") }]);
    // The owner's commands a test reads are untouched by these.
    expect(r.operator.commands).toEqual([]);
  });

  it("a new hello (the operator or the link started again) takes both away until the engine says them again", async () => {
    const r = await rig();
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.create === true, 2_000, "the permissions said");
    r.client.reconnect("the test says hello again");
    await until(() => r.client.up && r.operator.hellos.length === 2, 5_000, "the second hello");
    expect(r.client.state?.publishing).toMatchObject({ create: false, withdraw: false });
    expect(r.transport.canWrite?.("create")).toBe(false);
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.create === true, 2_000, "said again");
  });
});

describe("the operator's own stop (spec §8.3; PR 7 part 2)", () => {
  const stop = (reason: "login_lost" | "challenge" | "http_401" | "http_403" | "http_429", id = "stop-1") => ({ create: false, withdraw: false, stop: { id, reason, atWall: Date.now() } });

  it("is recorded as the page's autostop before it is named back; the owner is told once, with the word that the schedule stays; both stay off until the owner turns publishing on", async () => {
    const r = await rig();
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.create === true, 2_000, "the permissions said");
    // A Fansly check answered the page: the operator stops both by itself.
    r.operator.pushState({ publishing: stop("challenge") });
    await until(() => r.client.state?.publishing?.stop?.id === "stop-1", 2_000, "the stop said");
    expect(r.transport.canWrite?.("withdraw")).toBe(false);
    await r.publishing.tick();
    expect(r.autostops).toEqual(["browser_challenge"]);
    expect(r.told).toEqual([{ reason: "browser_challenge", note: expect.stringContaining("posts on Fansly's schedule stay there") }]);
    // Named back only now, with both off: the database holds the stop.
    expect(r.operator.publishingSet.at(-1)).toEqual({ create: false, withdraw: false, clearStop: "stop-1" });
    await until(() => r.client.state?.publishing?.stop === null, 2_000, "the stop let go");
    // Looks on: nothing told or recorded again; both off until the owner.
    await r.publishing.tick();
    await r.publishing.tick();
    expect(r.autostops).toHaveLength(1);
    expect(r.told).toHaveLength(1);
    expect(r.transport.canWrite?.("create")).toBe(false);
    expect(r.transport.canWrite?.("withdraw")).toBe(false);
    // The owner turns it on again (the autostop cleared): both back.
    Object.assign(r.row, { enabled: true, autostop_reason: null, autostopped_at: null });
    await r.publishing.tick();
    await until(() => r.client.state?.publishing?.create === true && r.client.state.publishing.withdraw, 2_000, "back on");
  });

  it("a 429 to a write, and the operator's halt for a lost login, are stops too", async () => {
    const r = await rig();
    r.operator.pushState({ publishing: stop("http_429", "s-429") });
    await until(() => r.client.state?.publishing?.stop?.id === "s-429", 2_000, "the stop said");
    await r.publishing.tick();
    expect(r.autostops).toEqual(["fansly_http_429"]);
    expect(r.operator.publishingSet.at(-1)).toMatchObject({ clearStop: "s-429" });
    // Fansly signed the browser out: the halt, held across the operator's
    // restarts, is the stop — once the owner turned publishing on again.
    Object.assign(r.row, { enabled: true, autostop_reason: null, autostopped_at: null });
    r.operator.pushState({ step: "exit_closed", stopReason: "login_required", exitOpen: false, halt: { id: "h-1", reason: "login_required", atWall: Date.now() } });
    await until(() => r.client.state?.halt?.id === "h-1", 2_000, "the halt said");
    await r.publishing.tick();
    expect(r.autostops).toEqual(["fansly_http_429", "browser_login_lost"]);
    expect(r.told.map((told) => told.reason)).toEqual(["fansly_http_429", "browser_login_lost"]);
  });

  it("of a page that never published (no settings): nothing to record, the stop is let go", async () => {
    const r = await rig();
    r.page.row = null;
    r.operator.pushState({ publishing: stop("challenge", "s-none") });
    await until(() => r.client.state?.publishing?.stop?.id === "s-none", 2_000, "the stop said");
    await r.publishing.tick();
    expect(r.autostops).toEqual([]);
    expect(r.told).toEqual([]);
    expect(r.operator.publishingSet.at(-1)).toEqual({ create: false, withdraw: true, clearStop: "s-none" });
  });
});

describe("an older Hub with a new operator", () => {
  it("is answered and read as before: no writes said, its GET send and admission parse; a write without its body or fingerprint is a protocol error", () => {
    const send = {
      type: "send", ownerGeneration: 1, attemptId: 5, route: "polls", credentialsGeneration: "c".repeat(64), sessionFingerprint: "a".repeat(64),
      method: "GET", url: "https://apiv3.fansly.com/api/v1/polls?ngsw-bypass=true", headers: {}, kind: "api", maxBodyBytes: 1024, sendDeadlineMono: 1, requestDeadlineMono: 2,
    };
    expect(parseEngineValue(send)).toMatchObject({ ok: true, message: { method: "GET" } });
    expect(parseEngineValue({ type: "checkResult", ownerGeneration: 1, attemptId: 5, admit: true, deadlineMono: 1, pauseMs: 2500 })).toMatchObject({ ok: true, message: { admit: true } });
    expect(parseEngineValue({ ...send, method: "POST" })).toMatchObject({ ok: false });
    expect(parseEngineValue({ ...send, method: "POST", body: "{}" })).toMatchObject({ ok: false });
    expect(parseEngineValue({ ...send, method: "POST", body: "{}", writeFingerprint: "f".repeat(64), kind: "image" })).toMatchObject({ ok: false });
    expect(parseEngineValue({ ...send, method: "GET", body: "{}" })).toMatchObject({ ok: false });
    expect(parseEngineValue({ ...send, method: "POST", body: "x".repeat(16 * 1024), writeFingerprint: "f".repeat(64) })).toMatchObject({ ok: false });
    expect(parseEngineValue({ ...send, method: "POST", body: "{}", writeFingerprint: "f".repeat(64) })).toMatchObject({ ok: true, message: { method: "POST", body: "{}" } });
    // The engine reads an operator from before minor 8 as before, and one
    // of minor 8 with what it adds.
    const state = { type: "state", step: "ready", stopReason: null, retryAtWall: null, exitOpen: true, mode: "automation", sessionFingerprint: null, accountId: null, exitIp: null, chromeVersion: "1", operatorVersion: "1", buffer: { bytes: 0, oldestAgeMs: 0 }, selfTest: null };
    const older = parseOperatorMessage(JSON.stringify({ type: "helloResult", ok: true, protocol: { major: 1, minor: 7 }, bufferId: "b", state }));
    expect(older).toMatchObject({ ok: true });
    expect((older as { message: object }).message).not.toHaveProperty("writes");
    expect(parseOperatorMessage(JSON.stringify({ type: "helloResult", ok: true, protocol: { major: 1, minor: 8 }, bufferId: "b", state: { ...state, publishing: { create: true, withdraw: false } }, writes: { fingerprint: "fansly-write.v1" } })))
      .toMatchObject({ ok: true, message: { writes: { fingerprint: "fansly-write.v1" }, state: { publishing: { create: true, withdraw: false } } } });
    expect(parseOperatorMessage(JSON.stringify({ type: "result", attemptId: 5, sessionFingerprint: "a".repeat(64), outcome: { kind: "aborted_before_send", refusal: "write_refused" } })))
      .toMatchObject({ ok: true, message: { outcome: { refusal: "write_refused" } } });
  });
});
