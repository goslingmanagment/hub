import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  acquireSyncPageOwnership,
  appendDomainEvents,
  getSyncPage,
  upsertPageDmMessages,
  writeSafeRelease,
  type Database,
} from "@agency_hub_core/db";
import { FANSLY_WS_CAPTURE_KIND } from "@agency_hub_core/shared";

import { runCanonicalization } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { executeErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { applyFanslyWsLive } from "../apps/runtime/src/services/fansly-ws/live-apply.ts";
import { runFanslyWsHintProjection } from "../apps/runtime/src/services/projections/fansly-ws-hints.ts";
import { runMessageArchiveProjection } from "../apps/runtime/src/services/projections/message-archive.ts";
import { createEngineRegistry } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { SWITCH_EXIT } from "../apps/runtime/src/sync/switch/context.ts";
import { FANSLY_WS_OWNERSHIP_LOCK_NAMESPACE } from "../apps/runtime/src/sync/switch/legacy-stop.ts";
import { runSyncRollback } from "../apps/runtime/src/sync/switch/rollback.ts";
import { runSyncSwitch } from "../apps/runtime/src/sync/switch/switch.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { openWsCapture, seedWsThread, wsDeleted, type WsCapturePage } from "./helpers/fansly-ws-capture.ts";
import { harnessConfig, HARNESS_OWN_REF, runActorUntil, seedHarnessPage, type HarnessPage } from "./helpers/sync-engine.ts";
import { makeTestActor, quietLogger, ScriptedLiveTransport, testOwner } from "./helpers/sync-engine-host.ts";
import { acceptedShadowReport, seedSwitchPage, switchContext, switchRegistry, testCapability } from "./helpers/sync-switch.ts";

// Step 3b, PR 1-8 (plan amendment A5): the ws-hints projector keeps filing a
// socket deletion's `mutation_debt` receipt on the engine's pages, unchanged
// since #384, whatever the frame's receive time. On a page the engine owns,
// that receipt is the only debt of a deletion that outlives a way back before
// the engine applied it locally: phase B reverting a switch and a rollback
// both cancel the `dm-live.deletions` work the post-ack hook raised
// (`cancelLiveWorkForRollback` spares only history work). These tests drive
// the real chain — capture, the step-1 ack with the production post-ack hook,
// canonicalization, the projector, the minutely message-archive sweep, the
// real switch, rollback and erasure — and judge the marks where readers see
// them: `page_dm_messages` AND `message_archive`, not only the overlay.
// A projector that skipped frames received after `engine_switched_at` (the
// withdrawn ruling 7) fails the first group.
//
//   - a deletion the legacy socket received after A, canonicalized late, and
//     a phase-B revert before the engine's local apply;
//   - a rollback while the engine's deletion work is still pending;
//   - repeat: one deletion delivered twice reaches both the engine's apply and
//     the legacy receipts, in either order: marked once, at the first frame's
//     time, and re-runs change nothing;
//   - an erasure while the debt waits for its drain: no receipt, no mark,
//     no row brought back.

const PROXY = "http://proxy.invalid:8080";
const FAN = "510000000000000081";
const GROUP = "620000000000000081";
const KEPT = "910000000000200001";
const DELETED = "910000000000200002";

let testDb: StartedTestDatabase | null = null;
const receivers: Client[] = [];

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) return context.skip();
  await resetIntegrationDatabase(testDb.pool);
});

afterEach(async () => {
  await Promise.all(receivers.splice(0).map((client) => client.end().catch(() => undefined)));
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

function handles() {
  return { db: db(), pool: testDb!.pool };
}

function config() {
  return harnessConfig(testDb!.connectionString);
}

/** The worker's context for the canonicalizer, the projector and the sweep. */
function app() {
  return { db: db(), logger: quietLogger as never, config: config() };
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** The page's chat with the fan: two fan messages in the hot table and in the
 *  archive (written from their ledger events by the sweep). */
async function seedChat(pageId: number): Promise<void> {
  const threadId = await seedWsThread(handles(), { pageId, groupId: GROUP, fanRef: FAN });
  const base = Date.now() - 3_600_000;
  const messages = [KEPT, DELETED].map((id, index) => ({ id, at: new Date(base + index * 60_000) }));
  await upsertPageDmMessages(db(), messages.map(({ id, at }) => ({
    conversationId: threadId, platformAccountId: pageId, platformMessageId: id, senderPlatformUserId: FAN,
    senderRole: "fan" as const, createdAt: at, content: `message ${id}`, totalTipAmountCents: 0,
    inReplyToMessageId: null, inReplyToRootMessageId: null,
  })));
  await appendDomainEvents(db(), pageId, messages.map(({ id, at }) => ({
    type: "message.received", occurredAt: at, fanIdentityRef: FAN, conversationRef: GROUP, messageRef: id,
    data: { text: `message ${id}`, price: 0, isTip: false }, schemaVersion: 1, observationId: 1,
    dedupKey: `msg:received:${id}`,
  })));
  await runMessageArchiveProjection(app(), { accountId: pageId });
  expect(await marks(pageId)).toEqual({ overlay: "absent", hot: null, archive: null });
}

/** The engine's owner of the page (the host's acquire), and its safe release
 *  (written when the page leaves the owner's mode). */
async function engineOwner(pageId: number): Promise<{ release(): Promise<boolean> }> {
  const acquired = await acquireSyncPageOwnership(db(), { pageId, owner: testOwner() });
  if (acquired.kind !== "acquired") throw new Error(`the page's owner: ${acquired.kind}`);
  return { release: () => writeSafeRelease(db(), { pageId, generation: acquired.generation }) };
}

interface LivePage {
  page: HarnessPage;
  owner: { release(): Promise<boolean> };
  capture: WsCapturePage["capture"];
}

/** A live page (guard row the engine's, credentials verified) with its owner,
 *  the chat and an open socket connection. */
async function livePage(label: string): Promise<LivePage> {
  const page = await seedHarnessPage(handles(), { mode: "live", proxyUrl: PROXY, label });
  const owner = await engineOwner(page.pageId);
  await seedChat(page.pageId);
  return { page, owner, capture: await openWsCapture(handles(), { pageId: page.pageId, ownRef: HARNESS_OWN_REF }) };
}

/** The legacy receiver still holding the page's socket lock (step 1, 58213):
 *  phase B cannot confirm the legacy engine stopped. */
async function legacyReceiverHolding(pageId: number): Promise<void> {
  const client = new Client({ connectionString: testDb!.connectionString });
  await client.connect();
  receivers.push(client);
  await client.query("select pg_advisory_lock($1, $2)", [FANSLY_WS_OWNERSHIP_LOCK_NAMESPACE, pageId]);
}

// ── the chain ───────────────────────────────────────────────────────────────

/** A deletion frame of DELETED captured by the page's socket and acked by the
 *  step-1 apply with the production post-ack hook (I18). */
async function deletionFrame(capture: WsCapturePage["capture"], receivedAt: Date): Promise<number> {
  const observationId = await capture(wsDeleted(DELETED, GROUP), receivedAt);
  expect((await applyFanslyWsLive(app(), observationId))?.status).toBe("applied");
  return observationId;
}

/** The frame's canonicalization, whenever the worker reaches it. */
async function canonicalize(pageId: number): Promise<void> {
  expect(await runCanonicalization(app(), { accountId: pageId, kinds: [FANSLY_WS_CAPTURE_KIND] }))
    .toMatchObject({ errored: 0 });
}

/** The minutely ws-hints projector. */
async function project(pageId: number): Promise<void> {
  await runFanslyWsHintProjection(app(), { accountId: pageId });
}

/** The minutely message-archive sweep: its closing deletion reconcile. */
async function sweep(pageId: number) {
  return (await runMessageArchiveProjection(app(), { accountId: pageId })).wsDeletions;
}

/** The page's live actor until its deletion work is closed: a local step,
 *  no request. */
async function engineApply(pageId: number): Promise<void> {
  const transport = new ScriptedLiveTransport();
  const made = await makeTestActor({
    db: db(), pageId, mode: "live", transport, ownRef: HARNESS_OWN_REF,
    registry: createEngineRegistry([fanslyResourceSpec("dm-live.deletions")!]),
  });
  await runActorUntil(made, async () => (await deletionWork(pageId)).every((work) => work.state === "done"), 20_000,
    "the deletion carried");
  expect(transport.hits).toEqual([]);
}

/** `sync rollback`; the live owner releases the page once it is in handover
 *  (the host's graceful stop). */
function rollBack(live: LivePage) {
  return runSyncRollback(switchContext({ db: db(), config: config() }, {
    sleep: async (ms) => {
      if ((await getSyncPage(db(), live.page.pageId))?.mode === "handover") await live.owner.release();
      await sleep(ms);
    },
  }), { pageLabel: live.page.pageLabel, withAuthHold: false, capabilityFor: testCapability("test rollback") });
}

async function eraseFan(): Promise<void> {
  const operator = await testDb!.pool.query<{ id: string }>(
    "insert into users (username, role) values ('ws-hints-eraser', 'owner') returning id::text as id",
  );
  const lakeDir = await mkdtemp(path.join(tmpdir(), "sync-ws-hints-pre-switch-"));
  try {
    const eraser = { db: testDb!.db, pool: testDb!.pool, config: { lakeDir }, logger: { info: () => {}, warn: () => {}, error: () => {} } } as never;
    await executeErasure(eraser, { scopeType: "fan", platform: "fansly", fanRef: FAN }, { initiatedBy: Number(operator.rows[0]!.id) });
  } finally {
    await rm(lakeDir, { recursive: true, force: true });
  }
}

// ── reads ───────────────────────────────────────────────────────────────────

/** DELETED in each store: its `deleted_at`, or `absent` without a row. */
async function marks(pageId: number): Promise<Record<"overlay" | "hot" | "archive", Date | null | "absent">> {
  const one = async (text: string) => {
    const rows = (await testDb!.pool.query<{ deleted_at: Date | null }>(text, [pageId, DELETED])).rows;
    return rows.length === 0 ? "absent" : rows[0]!.deleted_at;
  };
  return {
    overlay: await one("select deleted_at from dm_live_messages where page_id = $1 and platform_message_id = $2"),
    hot: await one("select deleted_at from page_dm_messages where platform_account_id = $1 and platform_message_id = $2"),
    archive: await one("select deleted_at from message_archive where account_id = $1 and platform = 'fansly' and message_ref = $2"),
  };
}

async function deletionWork(pageId: number) {
  return (await testDb!.pool.query<{ state: string; close_reason: string | null }>(
    "select state, close_reason from sync_work where page_id = $1 and not shadow and resource = 'dm-live.deletions' order by id",
    [pageId],
  )).rows;
}

async function receipts(pageId: number) {
  return (await testDb!.pool.query<{ message_ref: string; outcome: string; received_at: Date }>(
    "select message_ref, outcome, received_at from fansly_ws_hint_receipts where page_id = $1 order by event_id",
    [pageId],
  )).rows;
}

async function deletedEvents(pageId: number): Promise<number> {
  return Number((await testDb!.pool.query<{ n: number }>(
    "select count(*)::int as n from domain_events where account_id = $1 and type = 'message.deleted' and message_ref = $2",
    [pageId, DELETED],
  )).rows[0]!.n);
}

async function guardOf(pageId: number) {
  return (await testDb!.pool.query<{ owner_engine: string; engine_switched_at: Date | null }>(
    "select owner_engine, engine_switched_at from fansly_page_send_guards where page_id = $1", [pageId],
  )).rows[0]!;
}

// ── the tests ───────────────────────────────────────────────────────────────

describe("a switch reverted in phase B before the engine applied the deletion", () => {
  it.each(["in handover", "after the revert"] as const)(
    "a deletion the legacy socket received after A, canonicalized and projected %s: its receipt marks hot and archive",
    async (projected) => {
      const label = projected === "in handover" ? "revert-early" : "revert-late";
      const page = await seedSwitchPage(handles(), { label, proxyUrl: PROXY });
      const owner = await engineOwner(page.pageId);
      await seedChat(page.pageId);
      const capture = await openWsCapture(handles(), { pageId: page.pageId, ownRef: HARNESS_OWN_REF });
      await legacyReceiverHolding(page.pageId);
      const late: Array<{ receivedAt: Date; switchedAt: Date }> = [];
      const lines: string[] = [];
      const outcome = await runSyncSwitch(switchContext({ db: db(), config: config(), report: acceptedShadowReport([label]), lines }, {
        // Phase B waits for the receiver; meanwhile, once A handed the guard:
        sleep: async (ms) => {
          const guard = await guardOf(page.pageId);
          if (late.length === 0 && guard.owner_engine === "fansly_sync_engine") {
            const switchedAt = guard.engine_switched_at!;
            // The receiver still captures: a deletion received after A, acked
            // in handover, where the post-ack hook raises live work.
            const receivedAt = new Date(Math.max(Date.now(), switchedAt.getTime() + 1));
            await deletionFrame(capture, receivedAt);
            expect(await deletionWork(page.pageId)).toEqual([{ state: "open", close_reason: null }]);
            if (projected === "in handover") {
              await canonicalize(page.pageId);
              await project(page.pageId);
            }
            // The shadow owner released the page when it left shadow.
            await owner.release();
            late.push({ receivedAt, switchedAt });
          }
          await sleep(ms);
        },
      }), {
        pageLabel: label,
        shadowReportPath: "/tmp/shadow-report.json",
        dryRun: false,
        registry: switchRegistry(),
        capabilityFor: testCapability("test switch"),
      });

      expect(outcome).toMatchObject({ exitCode: SWITCH_EXIT.reverted, phase: "reverted" });
      expect(lines.some((line) => line.includes("ws_lock_holders=1"))).toBe(true);
      expect((await getSyncPage(db(), page.pageId))!.mode).toBe("shadow");
      expect(late).toHaveLength(1);
      const { receivedAt, switchedAt } = late[0]!;
      expect(receivedAt.getTime()).toBeGreaterThan(switchedAt.getTime());
      // The revert cancelled the engine's deletion before its local apply:
      // only the overlay knows the message is gone.
      expect(await deletionWork(page.pageId)).toEqual([{ state: "cancelled", close_reason: "switch_reverted" }]);
      expect(await marks(page.pageId)).toEqual({ overlay: receivedAt, hot: null, archive: null });

      if (projected === "after the revert") {
        await canonicalize(page.pageId);
        await project(page.pageId);
      }
      expect(await receipts(page.pageId)).toEqual([{ message_ref: DELETED, outcome: "mutation_debt", received_at: receivedAt }]);
      expect(await sweep(page.pageId)).toMatchObject({ hotMarked: 1, archiveMarked: 1 });
      expect(await marks(page.pageId)).toEqual({ overlay: receivedAt, hot: receivedAt, archive: receivedAt });
    },
    60_000,
  );
});

describe("a rollback while the engine's deletion is pending", () => {
  it.each(["before", "after"] as const)(
    "the deletion, canonicalized and projected %s the rollback, is marked hot and archive from its receipt",
    async (projected) => {
      const live = await livePage(`rollback-${projected}`);
      const receivedAt = new Date(Date.now() - 5_000);
      await deletionFrame(live.capture, receivedAt);
      expect(await deletionWork(live.page.pageId)).toEqual([{ state: "open", close_reason: null }]);
      if (projected === "before") {
        await canonicalize(live.page.pageId);
        await project(live.page.pageId);
      }

      expect(await rollBack(live)).toEqual({ exitCode: SWITCH_EXIT.done, step: "done", page: live.page.pageLabel });
      expect((await getSyncPage(db(), live.page.pageId))!.mode).toBe("off");
      expect(await deletionWork(live.page.pageId)).toEqual([{ state: "cancelled", close_reason: "rolled_back" }]);
      expect(await marks(live.page.pageId)).toEqual({ overlay: receivedAt, hot: null, archive: null });

      if (projected === "after") {
        await canonicalize(live.page.pageId);
        await project(live.page.pageId);
      }
      expect(await receipts(live.page.pageId)).toEqual([{ message_ref: DELETED, outcome: "mutation_debt", received_at: receivedAt }]);
      expect(await sweep(live.page.pageId)).toMatchObject({ hotMarked: 1, archiveMarked: 1 });
      expect(await marks(live.page.pageId)).toEqual({ overlay: receivedAt, hot: receivedAt, archive: receivedAt });
    },
    60_000,
  );
});

describe("a deletion delivered twice on a live page", () => {
  it.each(["the engine's apply", "the legacy reconcile"] as const)(
    "reaches the engine's apply and both legacy receipts; %s first: hot and archive marked once, at the first frame's time",
    async (first) => {
      const live = await livePage(first === "the engine's apply" ? "repeat-engine" : "repeat-reconcile");
      const pageId = live.page.pageId;
      const firstAt = new Date(Date.now() - 20_000);
      const secondAt = new Date(firstAt.getTime() + 10_000);
      await deletionFrame(live.capture, firstAt);
      // The same deletion again (a reconnect's replay): its own observation,
      // ack and event; the overlay mark stays the first.
      expect(await applyFanslyWsLive(app(), await live.capture(wsDeleted(DELETED, GROUP), secondAt))).not.toBeNull();
      await canonicalize(pageId);
      await project(pageId);
      expect((await receipts(pageId)).map((receipt) => [receipt.outcome, receipt.received_at]))
        .toEqual([["mutation_debt", firstAt], ["mutation_debt", secondAt]]);

      if (first === "the engine's apply") {
        await engineApply(pageId);
        expect(await sweep(pageId)).toMatchObject({ hotMarked: 0, archiveMarked: 0 });
      } else {
        expect(await sweep(pageId)).toMatchObject({ hotMarked: 1, archiveMarked: 1 });
        await engineApply(pageId);
      }
      const marked = { overlay: firstAt, hot: firstAt, archive: firstAt };
      expect(await marks(pageId)).toEqual(marked);
      expect(await deletedEvents(pageId)).toBe(1);

      // Every pass again: nothing changes.
      await canonicalize(pageId);
      await project(pageId);
      expect(await receipts(pageId)).toHaveLength(2);
      expect(await sweep(pageId)).toMatchObject({ hotMarked: 0, archiveMarked: 0 });
      expect(await marks(pageId)).toEqual(marked);
      expect(await deletedEvents(pageId)).toBe(1);
    },
    60_000,
  );
});

describe("an erasure while the deletion debt waits for its drain", () => {
  it.each(["canonicalized", "projected"] as const)(
    "after a rollback, the frame %s before the fan's erasure: no receipt, nothing marked, nothing brought back",
    async (stage) => {
      const live = await livePage(`erasure-${stage}`);
      const pageId = live.page.pageId;
      await deletionFrame(live.capture, new Date(Date.now() - 5_000));
      await canonicalize(pageId);
      if (stage === "projected") {
        await project(pageId);
        expect(await receipts(pageId)).toHaveLength(1);
      }
      expect(await rollBack(live)).toMatchObject({ exitCode: SWITCH_EXIT.done, step: "done" });

      await eraseFan();
      await project(pageId);
      expect(await receipts(pageId)).toEqual([]);
      expect(await sweep(pageId)).toMatchObject({ hotMarked: 0, archiveMarked: 0 });
      expect(await marks(pageId)).toEqual({ overlay: "absent", hot: "absent", archive: "absent" });
      expect(await deletedEvents(pageId)).toBe(0);
    },
    60_000,
  );
});
