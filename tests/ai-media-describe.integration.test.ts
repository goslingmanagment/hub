import { createRequire } from "node:module";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  listChatterUsageSummary,
  storeProxyConfig,
  upsertAiMediaDescriptionCandidate,
  type AiMediaDescriptionRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import type {
  MediaDescribeClient,
  MediaDescribeProviderMessage,
} from "../apps/runtime/src/services/ai-media-describe/describer.ts";
import {
  runAiMediaDescribeSweep,
  type AiMediaDescribeDeps,
  type AiMediaSource,
  type AiMediaSourceResolution,
} from "../apps/runtime/src/services/ai-media-describe/worker.ts";
import {
  createAiMediaDescribeLoopState,
  runAiMediaDescribeLoopTick,
} from "../apps/runtime/src/services/ai-media-describe/loop.ts";
import {
  AI_MEDIA_DESCRIBE_BREAKER_SUBKEY,
  AI_MEDIA_DESCRIBE_FAST_LANE_SUBKEY,
  openCriticalNotificationIncident,
} from "../apps/runtime/src/services/notification-incidents.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// AI media describer core (H1): the sweep against the real Postgres, with a
// fake source, a fake download and a fake provider (never a mock of the
// service under test).

interface SharpChain {
  jpeg(): SharpChain;
  toBuffer(): Promise<Buffer>;
}
const sharp = createRequire(path.resolve("apps/runtime/package.json"))("sharp") as (
  input: { create: Record<string, unknown> },
) => SharpChain;

// The SDK's ESM entry: the error classes the runtime's classifier checks.
const Anthropic = (await import(
  pathToFileURL(path.resolve("apps/runtime/node_modules/@anthropic-ai/sdk/index.mjs")).href
) as {
  default: {
    APIConnectionTimeoutError: new () => Error;
    AuthenticationError: new (status: number, error: unknown, message: string, headers: Headers) => Error;
  };
}).default;

const SINCE = new Date("2026-09-28T10:00:00Z");
const NOW = new Date("2026-09-28T12:00:00Z");
const FAN = "700700700";
const GROUP = "9001900190019";

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let imageA: Buffer;
let imageB: Buffer;

async function jpeg(color: string) {
  return sharp({ create: { width: 900, height: 600, channels: 3, background: color } }).jpeg().toBuffer();
}

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  imageA = await jpeg("#aa2233");
  imageB = await jpeg("#2233aa");
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  Object.assign(app.config, {
    aiMediaDescribeEnabled: true,
    aiMediaDescribePagePolicies: JSON.stringify({ "vision-page": { since: SINCE.toISOString() } }),
    aiMediaDescribeModel: "anthropic:claude-sonnet-5",
    aiMediaDescribeDailyImageLimit: 150,
    aiMediaDescribeDailyMicroUsdLimit: 1_000_000,
    aiMediaDescribeModelMedia: "teasers",
  });
  const model = await createModel(app.db, { slug: "vision", name: "Vision" });
  const page = await createFanslyPage(app.db, { modelId: model!.id, label: "vision-page" });
  pageId = page!.id;
  await storeProxyConfig(app.db, pageId, {
    url: "socks5://proxy.example.internal:1080",
    encryptedAuth: null,
    keyVersion: null,
  });
});

async function candidate(input: {
  mediaRef: string;
  variant?: "full" | "poster" | "preview";
  senderRole?: "fan" | "model";
  messageAt?: Date;
  messageRef?: string;
}) {
  const senderRole = input.senderRole ?? "fan";
  const result = await upsertAiMediaDescriptionCandidate(app.db, {
    pageId,
    platform: "fansly",
    mediaRef: input.mediaRef,
    variant: input.variant ?? "full",
    mediaKind: "photo",
    senderRole,
    fanPlatformUserId: senderRole === "fan" ? FAN : null,
    status: "pending",
    sourceObservationId: 1,
    link: {
      messageRef: input.messageRef ?? `msg-${input.mediaRef}`,
      conversationRef: GROUP,
      fanPlatformUserId: FAN,
      senderRole,
      messageAt: input.messageAt ?? new Date("2026-09-28T11:00:00Z"),
    },
    observedAt: NOW,
    now: NOW,
  });
  if (result.status !== "applied") {
    throw new Error(`candidate not applied: ${result.status}`);
  }
  return result.descriptionId;
}

function describedMessage(text = "A red square photo."): MediaDescribeProviderMessage {
  return { id: "msg_x", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 900, output_tokens: 12 } };
}

function refusalMessage(): MediaDescribeProviderMessage {
  return { id: "msg_r", stop_reason: "refusal", content: [], usage: { input_tokens: 900, output_tokens: 0 } };
}

function harness(options: {
  responses?: Array<MediaDescribeProviderMessage | Error>;
  bytesByRef?: Record<string, Buffer>;
  respond?: () => MediaDescribeProviderMessage | Error;
} = {}) {
  const calls = { provider: 0, download: 0, requests: [] as unknown[] };
  const queue = [...(options.responses ?? [])];
  const client: MediaDescribeClient = {
    async create(request) {
      calls.provider += 1;
      calls.requests.push(request);
      const next = options.respond ? options.respond() : queue.shift() ?? describedMessage();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const source: AiMediaSource = {
    platform: "fansly",
    async resolve(_app, row: AiMediaDescriptionRow): Promise<AiMediaSourceResolution> {
      return { kind: "url", url: `https://cdn3.fansly.com/${row.mediaRef}.jpeg?Signature=secret`, source: "test" };
    },
  };
  const deps: AiMediaDescribeDeps = {
    sources: new Map([["fansly", source]]),
    clientFactory: () => client,
    now: () => NOW,
    sleep: async () => undefined,
    download: async ({ url }) => {
      calls.download += 1;
      const ref = url.split("/").pop()!.split(".")[0]!;
      return { ok: true, bytes: options.bytesByRef?.[ref] ?? imageA, contentType: "image/jpeg" };
    },
  };
  return { calls, deps };
}

async function row(id: number) {
  const { rows } = await testDb!.pool.query(`select * from ai_media_descriptions where id = $1`, [id]);
  return rows[0] as Record<string, unknown>;
}

describe("AI media describer sweep", () => {
  it("does nothing while the master switch is off", async () => {
    app.config.aiMediaDescribeEnabled = false;
    await candidate({ mediaRef: "m1" });
    const { calls, deps } = harness();
    const result = await runAiMediaDescribeSweep(app, deps);
    expect(result.skipped).toBe("disabled");
    expect(calls.download + calls.provider).toBe(0);
  });

  it("describes a fan photo: ledger row, restricted record without URL or bytes, budget reserved", async () => {
    const id = await candidate({ mediaRef: "m1" });
    const { calls, deps } = harness();
    const result = await runAiMediaDescribeSweep(app, deps);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(calls.provider).toBe(1);
    const described = await row(id);
    expect(described).toMatchObject({ status: "described", description: "A red square photo.", model: "anthropic:claude-sonnet-5" });
    expect(described.content_sha256).toMatch(/^[0-9a-f]{64}$/);

    const usage = await testDb!.pool.query(
      `select user_id, feature, gateway_outcome, cost_micro_usd, page_id from ai_usage_events`,
    );
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0]).toMatchObject({ user_id: null, feature: "media-describe", gateway_outcome: "completed" });
    expect(Number(usage.rows[0].page_id)).toBe(pageId);
    expect(Number(usage.rows[0].cost_micro_usd)).toBeGreaterThan(0);

    const content = await testDb!.pool.query(`select fan_ref, conversation_ref, prompt_blocks::text as blocks, params::text as params from ai_generation_content`);
    expect(content.rows).toHaveLength(1);
    expect(content.rows[0]).toMatchObject({ fan_ref: FAN, conversation_ref: GROUP });
    const stored = `${content.rows[0].blocks}${content.rows[0].params}`;
    expect(stored).not.toContain("https://");
    expect(stored).not.toContain("Signature");
    expect(stored).not.toContain(imageA.subarray(0, 64).toString("base64").slice(0, 40));

    const day = await testDb!.pool.query(`select images_reserved, micro_usd_reserved from ai_media_describe_days`);
    expect(day.rows[0]).toMatchObject({ images_reserved: 1 });
    expect(Number(day.rows[0].micro_usd_reserved)).toBe(Number(usage.rows[0].cost_micro_usd));

    // The provider saw base64 bytes, never the URL.
    expect(JSON.stringify(calls.requests[0])).not.toContain("https://");
  });

  it("never processes a message at or before the enable boundary", async () => {
    const id = await candidate({ mediaRef: "old", messageAt: new Date("2026-09-28T09:59:00Z") });
    const { calls, deps } = harness();
    await runAiMediaDescribeSweep(app, deps);
    expect(await row(id)).toMatchObject({ status: "skipped_policy", error_code: "before_enable_boundary" });
    expect(calls.download + calls.provider).toBe(0);
  });

  it("remembers a refusal for every variant of the file and for the same bytes elsewhere", async () => {
    const teaser = await candidate({ mediaRef: "m2", variant: "preview", senderRole: "model" });
    const { calls, deps } = harness({ responses: [refusalMessage()] });
    await runAiMediaDescribeSweep(app, deps);
    expect(await row(teaser)).toMatchObject({ status: "refused", error_code: "provider_refusal" });
    expect(calls.provider).toBe(1);

    const sameFileOtherVariant = await candidate({ mediaRef: "m2", variant: "full", senderRole: "model" });
    const sameBytesOtherFile = await candidate({ mediaRef: "m3" });
    await runAiMediaDescribeSweep(app, deps);
    expect(await row(sameFileOtherVariant)).toMatchObject({ status: "refused", error_code: "refused_by_media_ref" });
    expect(await row(sameBytesOtherFile)).toMatchObject({ status: "refused", error_code: "refused_by_content" });
    expect(calls.provider).toBe(1);
  });

  it("marks a timeout outcome_unknown, keeps its reservation and never resends", async () => {
    const id = await candidate({ mediaRef: "m4" });
    const timeout = new Anthropic.APIConnectionTimeoutError();
    const { calls, deps } = harness({ responses: [timeout] });
    await runAiMediaDescribeSweep(app, deps);
    expect(await row(id)).toMatchObject({ status: "outcome_unknown", error_code: "provider_timeout" });
    await runAiMediaDescribeSweep(app, deps);
    await runAiMediaDescribeSweep(app, deps);
    expect(calls.provider).toBe(1);
    const day = await testDb!.pool.query(`select images_reserved, micro_usd_reserved from ai_media_describe_days`);
    expect(day.rows[0].images_reserved).toBe(1);
    expect(Number(day.rows[0].micro_usd_reserved)).toBeGreaterThan(0);
  });

  it("never resends after the request may have left, even when the settle fails", async () => {
    const id = await candidate({ mediaRef: "w1" });
    const { calls, deps } = harness();
    // Break the restricted-record write that follows a successful send.
    await testDb!.pool.query("alter table ai_generation_content add constraint vision_break check (generation_ref not like 'media-describe:%') not valid");
    try {
      await runAiMediaDescribeSweep(app, deps);
    } finally {
      await testDb!.pool.query("alter table ai_generation_content drop constraint vision_break");
    }
    expect(calls.provider).toBe(1);
    expect(await row(id)).toMatchObject({ status: "outcome_unknown", error_code: "in_flight" });
    await runAiMediaDescribeSweep(app, deps);
    expect(calls.provider).toBe(1);
  });

  it("checks the daily caps before any network", async () => {
    app.config.aiMediaDescribeDailyImageLimit = 1;
    const first = await candidate({ mediaRef: "m5" });
    const second = await candidate({ mediaRef: "m6" });
    const { calls, deps } = harness({ bytesByRef: { m5: imageA, m6: imageB } });
    await runAiMediaDescribeSweep(app, deps);
    expect(await row(first)).toMatchObject({ status: "described" });
    expect(await row(second)).toMatchObject({ status: "budget_deferred", error_code: "daily_cap" });
    expect(calls.provider).toBe(1);

    app.config.aiMediaDescribeDailyImageLimit = 0;
    const third = await candidate({ mediaRef: "m7" });
    const before = { ...calls };
    await runAiMediaDescribeSweep(app, deps);
    expect(calls.download).toBe(before.download);
    expect(calls.provider).toBe(before.provider);
    expect((await row(third)).status).toBe("budget_deferred");
  });

  it("sends each file once under concurrent sweeps (lease single-flight)", async () => {
    const ids = await Promise.all(["c1", "c2", "c3"].map((mediaRef, index) => candidate({ mediaRef, messageRef: `msg-${index}` })));
    const images = await Promise.all(["#111111", "#222222", "#333333"].map(jpeg));
    const { calls, deps } = harness({ bytesByRef: { c1: images[0]!, c2: images[1]!, c3: images[2]! } });
    await Promise.all([runAiMediaDescribeSweep(app, deps), runAiMediaDescribeSweep(app, deps), runAiMediaDescribeSweep(app, deps)]);
    expect(calls.provider).toBe(3);
    for (const id of ids) {
      expect((await row(id)).status).toBe("described");
    }
    const usage = await testDb!.pool.query(`select count(*)::int as n from ai_usage_events where feature = 'media-describe'`);
    expect(usage.rows[0].n).toBe(3);
  });

  it("keeps describing through a run of refusals; an older build's latch and incident clear", async () => {
    // Owner, 2026-09-30: refusals of explicit images are a normal outcome, so
    // no share of them pauses the lane. Clearly distinct colours: identical
    // bytes would be (correctly) refused from memory without a send.
    const images = await Promise.all(Array.from({ length: 10 }, (_, index) => {
      const hex = (value: number) => value.toString(16).padStart(2, "0");
      return jpeg(`#${hex(index * 25)}${hex(255 - index * 25)}${hex((index * 90) % 256)}`);
    }));
    const bytesByRef: Record<string, Buffer> = {};
    for (let index = 0; index < 10; index += 1) {
      bytesByRef[`r${index}`] = images[index]!;
      await candidate({ mediaRef: `r${index}` });
    }
    let refuse = true;
    const { calls, deps } = harness({ bytesByRef, respond: () => (refuse ? refusalMessage() : describedMessage()) });
    await runAiMediaDescribeSweep(app, deps);
    expect(calls.provider).toBe(10);
    const day = await testDb!.pool.query(`select refusals, breaker_tripped_at from ai_media_describe_days`);
    expect(day.rows[0].refusals).toBe(10);
    expect(day.rows[0].breaker_tripped_at).toBeNull();

    // A build with the breaker latched the day and opened its incident.
    await testDb!.pool.query(`update ai_media_describe_days set breaker_tripped_at = now(), breaker_reason = 'legacy'`);
    await openCriticalNotificationIncident(app, {
      kind: "ai_provider_failed",
      platformAccountId: null,
      pageLabel: null,
      platform: null,
      subKey: AI_MEDIA_DESCRIBE_BREAKER_SUBKEY,
      errorCode: "media_describe_refusals",
      errorSummary: "legacy latch",
      occurredAt: NOW,
    });

    refuse = false;
    const after = await candidate({ mediaRef: "after-refusals" });
    const next = await runAiMediaDescribeSweep(app, deps);
    expect(next.skipped).toBeUndefined();
    expect(calls.provider).toBe(11);
    expect((await row(after)).status).toBe("described");
    const incident = await testDb!.pool.query(
      `select status from notification_incidents where incident_key = 'ai_provider_failed:global:media_describe_breaker'`,
    );
    expect(incident.rows[0]?.status).not.toBe("open");
  });

  it("stops the lane on 401 until the owner resolves the incident", async () => {
    await candidate({ mediaRef: "k1" });
    const authError = new Anthropic.AuthenticationError(401, { type: "authentication_error" }, "invalid x-api-key", new Headers());
    const { calls, deps } = harness({ responses: [authError] });
    await runAiMediaDescribeSweep(app, deps);
    expect(calls.provider).toBe(1);
    const incident = await testDb!.pool.query(
      `select status from notification_incidents where incident_key = 'ai_provider_failed:global:media_describe_account_stop'`,
    );
    expect(incident.rows[0]?.status).toBe("open");
    await candidate({ mediaRef: "k2" });
    const next = await runAiMediaDescribeSweep(app, deps);
    expect(next.skipped).toBe("account_stopped");
  });

  it("clears the fast lane incident an older build left open: the lane is deleted (step 4, S4-12)", async () => {
    await openCriticalNotificationIncident(app, {
      kind: "ai_provider_failed",
      platformAccountId: null,
      pageLabel: null,
      platform: "fansly",
      subKey: AI_MEDIA_DESCRIBE_FAST_LANE_SUBKEY,
      errorCode: "media_fast_lane_unavailable",
      errorSummary: "Fresh fan photos wait for the minutely path on: lilly-1: socket_down.",
      occurredAt: NOW,
    });
    const status = async () => (await testDb!.pool.query(
      `select status from notification_incidents where incident_key = 'ai_provider_failed:global:media_describe_fast_lane'`,
    )).rows[0]?.status;
    expect(await status()).toBe("open");
    const { deps } = harness();
    await runAiMediaDescribeSweep(app, deps);
    expect(await status()).toBe("resolved");
  });

  it("keeps the owner Usage report working with system describer rows", async () => {
    await candidate({ mediaRef: "u1" });
    const { deps } = harness();
    await runAiMediaDescribeSweep(app, deps);
    await expect(listChatterUsageSummary(app.db, {
      from: new Date("2026-09-01T00:00:00Z"),
      toExclusive: new Date("2026-10-01T00:00:00Z"),
    })).resolves.toEqual([]);
  });

  it("fan erasure removes the fan's descriptions and links but keeps a teaser; page erasure removes all", async () => {
    const fanPhoto = await candidate({ mediaRef: "e1" });
    const teaser = await candidate({ mediaRef: "e2", variant: "preview", senderRole: "model", messageRef: "msg-teaser-1" });
    // The same teaser also went to another fan.
    await upsertAiMediaDescriptionCandidate(app.db, {
      pageId,
      platform: "fansly",
      mediaRef: "e2",
      variant: "preview",
      mediaKind: "photo",
      senderRole: "model",
      fanPlatformUserId: null,
      status: "pending",
      sourceObservationId: 1,
      link: { messageRef: "msg-teaser-2", conversationRef: "other-group", fanPlatformUserId: "600600600", senderRole: "model", messageAt: new Date("2026-09-28T11:00:00Z") },
      observedAt: NOW,
      now: NOW,
    });
    const operator = await testDb!.pool.query(`insert into users (username, role) values ('vision-owner', 'owner') returning id`);
    const lakeDir = await mkdtemp(path.join(tmpdir(), "vision-erasure-"));
    try {
      const stub = {
        db: testDb!.db,
        pool: testDb!.pool,
        config: { lakeDir } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      } as never;
      const result = await executeErasure(stub, { scopeType: "fan", platform: "fansly", fanRef: FAN }, { initiatedBy: Number(operator.rows[0].id) });
      expect(result.executedCounts["hot:ai_media_descriptions:delete"]).toBe(1);
      expect(result.executedCounts["hot:ai_media_description_links:delete"]).toBe(2);
      expect(await row(fanPhoto)).toBeUndefined();
      expect(await row(teaser)).toMatchObject({ media_ref: "e2" });
      const links = await testDb!.pool.query(`select message_ref from ai_media_description_links`);
      expect(links.rows.map((link) => link.message_ref)).toEqual(["msg-teaser-2"]);

      await executeErasure(stub, { scopeType: "page", pageLabel: "vision-page" }, { initiatedBy: Number(operator.rows[0].id) });
      const left = await testDb!.pool.query(`select count(*)::int as n from ai_media_descriptions`);
      expect(left.rows[0].n).toBe(0);
    } finally {
      await rm(lakeDir, { recursive: true, force: true });
    }
  });
});

describe("AI media describer: seconds lane (claim order, real clock, ownership)", () => {
  it("claims a fresh file before the backlog, one row per claim", async () => {
    const backlog = await candidate({ mediaRef: "old-1", messageRef: "msg-old", messageAt: new Date("2026-09-28T11:00:00Z") });
    const fresh = await candidate({ mediaRef: "new-1", messageRef: "msg-new", messageAt: new Date("2026-09-28T11:58:00Z") });
    const images = await Promise.all(["#101010", "#202020"].map(jpeg));
    const { calls, deps } = harness({ bytesByRef: { "old-1": images[0]!, "new-1": images[1]! } });
    const first = await runAiMediaDescribeSweep(app, deps, { limit: 1 });
    expect(first).toMatchObject({ claimed: 1, sent: 1 });
    expect((await row(fresh)).status).toBe("described");
    expect((await row(backlog)).status).toBe("pending");
    await runAiMediaDescribeSweep(app, deps, { limit: 1 });
    expect((await row(backlog)).status).toBe("described");
    expect(calls.provider).toBe(2);
  });

  it("stamps described_at with the settle time, not the sweep start", async () => {
    const id = await candidate({ mediaRef: "clock-1" });
    const { deps } = harness();
    let tick = 0;
    // Every clock read is one second later than the previous one.
    deps.now = () => new Date(NOW.getTime() + 1000 * tick++);
    await runAiMediaDescribeSweep(app, deps);
    const described = await row(id);
    expect(described.status).toBe("described");
    expect((described.described_at as Date).getTime()).toBeGreaterThan(NOW.getTime() + 3000);
    const usage = await testDb!.pool.query(`select completed_at from ai_usage_events`);
    expect((described.described_at as Date).getTime()).toBeGreaterThanOrEqual((usage.rows[0].completed_at as Date).getTime());
  });

  it("never sends for a claim taken over by another worker, and returns the reservation", async () => {
    const id = await candidate({ mediaRef: "stolen-1" });
    const { calls, deps } = harness();
    const thief = "00000000-0000-4000-8000-000000000001";
    const source = deps.sources.get("fansly")!;
    deps.sources = new Map([["fansly", {
      platform: "fansly",
      async resolve(appArg, claimed, context) {
        // The lease "expires" and another worker claims the row mid-flight.
        await testDb!.pool.query(`update ai_media_descriptions set lease_token = $2 where id = $1`, [claimed.id, thief]);
        return source.resolve(appArg, claimed, context);
      },
    } satisfies AiMediaSource]]);
    const result = await runAiMediaDescribeSweep(app, deps);
    expect(result).toMatchObject({ claimed: 1, sent: 0, leaseLost: 1 });
    expect(calls.provider).toBe(0);
    const after = await row(id);
    expect(after.lease_token).toBe(thief);
    expect(after.status).toBe("pending");
    const day = await testDb!.pool.query(`select images_reserved, micro_usd_reserved from ai_media_describe_days`);
    expect(day.rows[0]).toMatchObject({ images_reserved: 0 });
    expect(Number(day.rows[0].micro_usd_reserved)).toBe(0);
    const usage = await testDb!.pool.query(`select gateway_outcome, error_code, cost_micro_usd from ai_usage_events`);
    expect(usage.rows[0]).toMatchObject({ gateway_outcome: "failed", error_code: "lease_lost" });
    expect(Number(usage.rows[0].cost_micro_usd)).toBe(0);
  });

  it("claims nothing once shutdown asked it to stop", async () => {
    const id = await candidate({ mediaRef: "stop-1" });
    const { calls, deps } = harness();
    const result = await runAiMediaDescribeSweep(app, deps, { shouldContinue: () => false });
    expect(result).toMatchObject({ claimed: 0, sent: 0 });
    expect(calls.provider).toBe(0);
    expect((await row(id)).status).toBe("pending");
  });

  it("the loop tick drains due rows when switched on and idles otherwise", async () => {
    const id = await candidate({ mediaRef: "loop-1" });
    const { calls, deps } = harness();
    const state = createAiMediaDescribeLoopState();
    expect(await runAiMediaDescribeLoopTick(app, state, deps)).toBe(0);
    expect(calls.provider).toBe(0);

    app.config.aiMediaDescribeLoopEnabled = true;
    const fresh = createAiMediaDescribeLoopState();
    expect(await runAiMediaDescribeLoopTick(app, fresh, deps)).toBe(1);
    expect((await row(id)).status).toBe("described");
    // Nothing due: one probe, no sweep.
    expect(await runAiMediaDescribeLoopTick(app, fresh, deps)).toBe(0);
    expect(calls.provider).toBe(1);
  });
});
