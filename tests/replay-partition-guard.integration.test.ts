// §3.2c(ii) — the WRITE-side target-month partition census, on the SWEEP path.
//
// The failure this prevents is the one two earlier passes left live. Two lanes
// are deliberately PROVIDER-dated — `message.material_observed` (the archive's
// occurred_at IS the message time) and `post.observed` — and a version bump
// drains months of history through them. An append whose target month has no
// ATTACHED partition fails ExecFindPartition (23514) per row, FOREVER: the
// observation is never stamped, so every later sweep retries it.
//
// The gate lives in `runCanonicalization`, not in a command, because that one
// engine backs BOTH the minutely sweep and the `events:replay` drain. A
// CLI-only gate would leave the steady-state sweep completely unguarded after a
// version bump — which is the case asserted first here.
//
// [S1] scope, pinned deliberately: the check name-matches
// domain_events_YYYY_MM for 2026–2030 ONLY. Everything else is covered by
// construction (pre_2024 spans MINVALUE→2024; _2024/_2025 are YEARLY partitions
// 0077 named so tiering cannot re-detach them; 0082 catches 2031+), so a draft
// outside that regime is passed through — and that pass-through is asserted,
// not assumed.

import { createHash } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertDomainEventTargetMonthsAttached,
  createFanslyPage,
  createModel,
  domainEventTargetMonthKey,
  DomainEventTargetMonthsUnattachedError,
  ensureDomainEventPartitions,
  insertObservation,
  listEventsSince,
  loadDomainEventPartitionCoverage,
} from "@agency_hub_core/db";

import {
  resetCanonicalizeSweepRuntime,
  runCanonicalization,
} from "../apps/runtime/src/services/canonicalize-driver.ts";
import { replayWindowMonths } from "../apps/runtime/src/cli.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) {
    await resetIntegrationDatabase(testDb.pool);
  }
  resetCanonicalizeSweepRuntime();
  if (testDb) {
    // Detached relations survive a truncate-based reset; start every case from
    // a known partition set instead of inheriting the previous one.
    for (const month of [DETACHED_MONTH, ABSENT_MONTH]) {
      await testDb.pool.query(`drop table if exists "${monthName(month)}" cascade`);
    }
  }
});

const OWN_REF = "acct-creator-guard";

/** A month in the 2026 monthly regime, safely in the past so the driver's
 *  [2024-01-01, now + 2 months] clamp leaves the draft provider-dated. */
const DETACHED_MONTH = { year: 2026, month: 3 };
const ABSENT_MONTH = { year: 2026, month: 4 };

function monthName(month: { year: number; month: number }) {
  return `domain_events_${month.year}_${String(month.month).padStart(2, "0")}`;
}

function monthStart(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}-01 00:00:00+00`;
}

async function createMonthPartition(month: { year: number; month: number }) {
  const next = month.month === 12
    ? { year: month.year + 1, month: 1 }
    : { year: month.year, month: month.month + 1 };
  // Dropped first: `resetIntegrationDatabase` truncates, it does not un-detach,
  // so a DETACHED leftover from a previous test would silently satisfy
  // `if not exists` and then fail the detach below.
  await testDb!.pool.query(`drop table if exists "${monthName(month)}" cascade`);
  await testDb!.pool.query(`
    create table "${monthName(month)}" partition of "domain_events"
    for values from ('${monthStart(month.year, month.month)}')
    to ('${monthStart(next.year, next.month)}')
  `);
}

async function detachMonth(month: { year: number; month: number }) {
  await createMonthPartition(month);
  await testDb!.pool.query(`alter table "domain_events" detach partition "${monthName(month)}"`);
}

async function dropMonth(month: { year: number; month: number }) {
  // The ABSENT shape: no partition exists at all. `ensureDomainEventPartitions`
  // only ever creates the current month + 3, so this is what a historical month
  // looks like in production — not a mishap, a construction.
  await testDb!.pool.query(`drop table if exists "${monthName(month)}" cascade`);
}

function sha256(value: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(value)).digest();
}

/** A paid-video DM page. `messageAt` is what the PROVIDER-dated
 *  message.material_observed draft aims at; everything else in the batch is
 *  receipt-time by construction. */
function dmPayload(messageId: string, messageAt: Date) {
  const seconds = Math.floor(messageAt.getTime() / 1000);
  return {
    messages: [{
      id: messageId,
      type: 0,
      content: "",
      groupId: `group-${messageId}`,
      senderId: OWN_REF,
      createdAt: seconds,
      attachments: [{ messageId, contentType: 1, contentId: `media-${messageId}`, pos: 0 }],
      embeds: [],
      interactions: [],
      likes: [],
      totalTipAmount: 0,
    }],
    accountMedia: [{
      id: `media-${messageId}`,
      accountId: OWN_REF,
      mediaId: `raw-${messageId}`,
      permissionFlags: 9,
      createdAt: seconds,
      permissions: {
        permissionFlags: [{ id: `perm-${messageId}`, type: 0, flags: 9, price: 79_000 }],
      },
      saleStats: { sales: 1, total: 63_200, pending: 0 },
      media: { id: `raw-${messageId}`, type: 2, mimetype: "video/mp4" },
      access: true,
    }],
    accountMediaBundles: [],
    accountMediaOrders: [],
  };
}

async function seedPage() {
  const model = await createModel(testDb!.db, { slug: "guard", name: "Guard" });
  if (!model) {
    throw new Error("Expected the guard test model to be created");
  }
  const page = await createFanslyPage(testDb!.db, { modelId: model.id, label: "guard-page" });
  if (!page) {
    throw new Error("Expected the guard test page to be created");
  }
  await testDb!.pool.query("update pages set external_page_id = $1 where id = $2", [
    OWN_REF,
    page.id,
  ]);
  // Receipt-time drafts land in the CURRENT month; without its partition the
  // whole test would block for the wrong reason.
  await ensureDomainEventPartitions(testDb!.db);
  return page;
}

/**
 * WP-F6. A timeline page whose post was PUBLISHED in the target month.
 *
 * `post.observed` is the OTHER provider-dated family (`canonicalize/posts.ts`
 * dates it at `publishedAt`), and WP-F6's v6 bump re-parses the whole posts
 * corpus across history — so it aims appends at months the DM drain never
 * touches. The census covers it by construction; this fixture is what proves
 * "by construction" rather than asserting it.
 */
function postsPayload(postId: string, publishedAt: Date) {
  return {
    posts: [{
      id: postId,
      accountId: OWN_REF,
      content: "#viral",
      createdAt: Math.floor(publishedAt.getTime() / 1000),
      attachments: [],
      likeCount: 3,
      mediaLikeCount: 0,
      replyCount: 0,
      fypFlags: 0,
      expiresAt: null,
      inReplyTo: null,
      inReplyToRoot: null,
      wallIds: [],
      accountMentions: [],
    }],
    tipGoals: [],
  };
}

async function seedPosts(pageId: number, key: string, publishedAt: Date) {
  const payload = postsPayload(key, publishedAt);
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:posts",
    platform: "fansly",
    accountId: pageId,
    kind: "posts",
    payload,
    payloadHash: sha256(`posts:${key}`),
    idempotencyKey: `guard:${key}`,
  });
}

async function seedDm(pageId: number, key: string, messageAt: Date) {
  const payload = dmPayload(key, messageAt);
  await insertObservation(testDb!.db, {
    source: "pull",
    producer: "sync:fansly:dm_messages",
    platform: "fansly",
    accountId: pageId,
    kind: "dm_messages",
    payload,
    payloadHash: sha256(key),
    idempotencyKey: `guard:${key}`,
  });
}

function appStub() {
  const errors: unknown[] = [];
  const app = {
    db: testDb!.db,
    logger: {
      info: () => {},
      warn: () => {},
      error: (payload: unknown) => {
        errors.push(payload);
      },
    },
  } as never;
  return { app, errors };
}

async function parseVersionOf(key: string): Promise<number> {
  const row = await testDb!.pool.query<{ parse_version: number }>(
    "select parse_version from observations where idempotency_key = $1",
    [`guard:${key}`],
  );
  return row.rows[0]!.parse_version;
}

describe("§3.2c(ii) partition census on the SWEEP path", () => {
  for (
    const shape of [
      {
        name: "detached",
        month: DETACHED_MONTH,
        prepare: () => detachMonth(DETACHED_MONTH),
        recovery: /re-attach the month .*0077 ritual.*NEVER DROP/s,
        relations: true,
      },
      {
        name: "absent",
        month: ABSENT_MONTH,
        prepare: () => dropMonth(ABSENT_MONTH),
        recovery: /create the missing monthly partition/,
        relations: false,
      },
    ]
  ) {
    it(`refuses a provider-dated draft aimed at an ${shape.name} month, before any write`, async (context) => {
      if (!testDb) {
        context.skip();
        return;
      }
      const page = await seedPage();
      await shape.prepare();
      const messageAt = new Date(Date.UTC(shape.month.year, shape.month.month - 1, 12, 9, 0, 0));
      await seedDm(page.id, `${shape.name}-1`, messageAt);

      const { app, errors } = appStub();
      const result = await runCanonicalization(app, { kinds: ["dm_messages"] });

      // A refusal is NOT a failure: it is counted apart from `errored`, and a
      // run reporting partitionBlocked > 0 is a SKIPPED step, not a passed one.
      expect(result.partitionBlocked).toBe(1);
      expect(result.errored).toBe(0);
      // Zero events appended — the refusal happens before ANY write, so the
      // deliverable and receipt-time drafts of the same observation are held
      // back with the provider-dated one.
      expect(result.appended).toBe(0);
      expect(await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 })).toHaveLength(0);
      // The observation keeps its parse debt so the recovery is replayable.
      expect(result.stamped).toBe(0);
      expect(await parseVersionOf(`${shape.name}-1`)).toBe(0);

      // The anomaly names the shape AND its own recovery — the mechanism does
      // not need to tell detached from absent to refuse, but the OPERATOR does,
      // because using the absent recovery on a detached month orphans facts.
      expect(result.partitionAnomalies).toHaveLength(1);
      const anomaly = result.partitionAnomalies[0]!;
      expect(anomaly.family).toBe("pull:sync");
      expect(anomaly.month)
        .toBe(`${shape.month.year}_${String(shape.month.month).padStart(2, "0")}`);
      expect(anomaly.shape).toBe(shape.name);
      expect(anomaly.recovery).toMatch(shape.recovery);
      if (shape.relations) {
        expect(anomaly.detachedRelations).toEqual([`public.${monthName(shape.month)}`]);
      } else {
        expect(anomaly.detachedRelations).toEqual([]);
      }
      // …and it is logged once, as an error the operator will actually see.
      expect(errors).toHaveLength(1);
    });
  }

  it("raises exactly ONE anomaly per (family, month), not one per refused row", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await detachMonth(DETACHED_MONTH);
    for (const index of [1, 2, 3]) {
      await seedDm(
        page.id,
        `many-${index}`,
        new Date(Date.UTC(DETACHED_MONTH.year, DETACHED_MONTH.month - 1, index + 1, 9, 0, 0)),
      );
    }

    const { app, errors } = appStub();
    const result = await runCanonicalization(app, { kinds: ["dm_messages"] });

    expect(result.partitionBlocked).toBe(3);
    // A blocked drain can be thousands of rows; thousands of identical log
    // lines are how an operator stops reading them.
    expect(result.partitionAnomalies).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("covers the OTHER provider-dated family too — a post.observed aimed at a cold month", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await detachMonth(DETACHED_MONTH);
    // A post PUBLISHED in the detached month. WP-F6's v6 bump re-parses the
    // whole posts corpus, so this is the exact shape its drain produces.
    const publishedAt = new Date(
      Date.UTC(DETACHED_MONTH.year, DETACHED_MONTH.month - 1, 9, 15, 0, 0),
    );
    await seedPosts(page.id, "post-cold", publishedAt);

    const { app, errors } = appStub();
    const result = await runCanonicalization(app, { kinds: ["posts"] });

    expect(result.partitionBlocked).toBe(1);
    expect(result.errored).toBe(0);
    expect(result.appended).toBe(0);
    expect(await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 })).toHaveLength(0);
    // The observation keeps its parse debt, so the v6 drain is replayable after
    // the re-attach rather than needing the capture again.
    expect(await parseVersionOf("post-cold")).toBe(0);
    expect(result.partitionAnomalies).toHaveLength(1);
    expect(result.partitionAnomalies[0]).toMatchObject({
      month: `${DETACHED_MONTH.year}_${String(DETACHED_MONTH.month).padStart(2, "0")}`,
      shape: "detached",
    });
    expect(errors).toHaveLength(1);
  });

  it("POSITIVE CONTROL: a post.observed appends at its publication month once attached", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    const publishedAt = new Date(
      Date.UTC(DETACHED_MONTH.year, DETACHED_MONTH.month - 1, 9, 15, 0, 0),
    );
    await createMonthPartition(DETACHED_MONTH);
    await seedPosts(page.id, "post-warm", publishedAt);

    const result = await runCanonicalization(appStub().app, { kinds: ["posts"] });
    expect(result.partitionBlocked).toBe(0);
    expect(result.stamped).toBe(1);

    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 });
    const observed = events.find((event) => event.type === "post.observed")!;
    expect(observed).toBeDefined();
    // Provider-dated at the post's own publication instant — §3.2b's exception,
    // and the reason this family needs the census at all.
    expect(observed.occurredAt.toISOString()).toBe(publishedAt.toISOString());
    const placed = await testDb.pool.query<{ tableoid: string }>(
      "select tableoid::regclass::text as tableoid from domain_events where dedup_key = $1",
      [observed.dedupKey],
    );
    expect(placed.rows[0]?.tableoid).toBe(monthName(DETACHED_MONTH));
  });

  it("POSITIVE CONTROL: the same draft appends normally once the month is attached", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await detachMonth(DETACHED_MONTH);
    const messageAt = new Date(Date.UTC(DETACHED_MONTH.year, DETACHED_MONTH.month - 1, 12, 9, 0, 0));
    await seedDm(page.id, "recover-1", messageAt);

    const blocked = await runCanonicalization(appStub().app, { kinds: ["dm_messages"] });
    expect(blocked.partitionBlocked).toBe(1);
    expect(blocked.appended).toBe(0);

    // The documented recovery: re-ATTACH, never DROP.
    const next = { year: DETACHED_MONTH.year, month: DETACHED_MONTH.month + 1 };
    await testDb.pool.query(`
      alter table "domain_events" attach partition "${monthName(DETACHED_MONTH)}"
      for values from ('${monthStart(DETACHED_MONTH.year, DETACHED_MONTH.month)}')
      to ('${monthStart(next.year, next.month)}')
    `);
    resetCanonicalizeSweepRuntime();

    const recovered = await runCanonicalization(appStub().app, { kinds: ["dm_messages"] });
    expect(recovered.partitionBlocked).toBe(0);
    expect(recovered.appended).toBeGreaterThan(0);
    expect(recovered.stamped).toBe(1);
    expect(await parseVersionOf("recover-1")).toBeGreaterThan(0);

    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 });
    const material = events.find((event) => event.type === "message.material_observed")!;
    expect(material).toBeDefined();
    // Provider-dated, and it really did land in the re-attached month.
    expect(material.occurredAt.toISOString()).toBe(messageAt.toISOString());
    const placed = await testDb.pool.query<{ tableoid: string }>(
      "select tableoid::regclass::text as tableoid from domain_events where dedup_key = $1",
      [material.dedupKey],
    );
    expect(placed.rows[0]?.tableoid).toBe(monthName(DETACHED_MONTH));
  });

  it("POSITIVE CONTROL: a receipt-time observation is never blocked by a cold month", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await detachMonth(DETACHED_MONTH);
    // One observation aimed at the cold month…
    await seedDm(
      page.id,
      "mixed-cold",
      new Date(Date.UTC(DETACHED_MONTH.year, DETACHED_MONTH.month - 1, 12, 9, 0, 0)),
    );
    // …and one whose provider date is the current month, so every draft it
    // makes — receipt-time and provider-dated alike — targets an attached
    // partition. §3.2b's receipt-time rule is what keeps this the normal case.
    await seedDm(page.id, "mixed-warm", new Date());

    const result = await runCanonicalization(appStub().app, { kinds: ["dm_messages"] });

    expect(result.partitionBlocked).toBe(1);
    expect(result.stamped).toBe(1);
    expect(result.appended).toBeGreaterThan(0);
    expect(await parseVersionOf("mixed-cold")).toBe(0);
    expect(await parseVersionOf("mixed-warm")).toBeGreaterThan(0);
  });

  it("POSITIVE CONTROL: a draft dated outside 2026–2030 is passed through", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    // 2025 is a YEARLY partition migration 0077 named so tiering cannot
    // re-detach it. The census name-matches domain_events_YYYY_MM only, so this
    // draft is not even considered — deliberately, and pinned here so nobody
    // "generalises" the check back into a relpartbound parser.
    expect(domainEventTargetMonthKey(new Date("2025-12-19T18:40:24Z"))).toBeNull();
    expect(domainEventTargetMonthKey(new Date("2031-01-05T00:00:00Z"))).toBeNull();
    expect(domainEventTargetMonthKey(new Date("2026-03-12T09:00:00Z"))).toBe("2026_03");

    await seedDm(page.id, "yearly-1", new Date("2025-12-19T18:40:24Z"));
    const result = await runCanonicalization(appStub().app, { kinds: ["dm_messages"] });
    expect(result.partitionBlocked).toBe(0);
    expect(result.stamped).toBe(1);

    const events = await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 });
    const material = events.find((event) => event.type === "message.material_observed")!;
    const placed = await testDb.pool.query<{ tableoid: string }>(
      "select tableoid::regclass::text as tableoid from domain_events where dedup_key = $1",
      [material.dedupKey],
    );
    expect(placed.rows[0]?.tableoid).toBe("domain_events_2025");
  });
});

describe("§3.2c(ii) the census helper itself", () => {
  it("reports detached vs absent from one catalog read", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await ensureDomainEventPartitions(testDb.db);
    await detachMonth(DETACHED_MONTH);
    await dropMonth(ABSENT_MONTH);

    const coverage = await loadDomainEventPartitionCoverage(testDb.db);
    expect(coverage.attachedMonths.has("2026_03")).toBe(false);
    expect(coverage.detachedMonths.get("2026_03"))
      .toEqual([`public.${monthName(DETACHED_MONTH)}`]);
    expect(coverage.attachedMonths.has("2026_04")).toBe(false);
    expect(coverage.detachedMonths.has("2026_04")).toBe(false);

    await expect(assertDomainEventTargetMonthsAttached(testDb.db, [
      new Date("2026-03-12T09:00:00Z"),
      new Date("2026-04-12T09:00:00Z"),
    ])).rejects.toThrow(DomainEventTargetMonthsUnattachedError);

    // Out-of-regime instants are not checked at all, so an empty target set
    // issues no catalog query and refuses nothing.
    await expect(assertDomainEventTargetMonthsAttached(testDb.db, [
      new Date("2023-05-01T00:00:00Z"),
      new Date("2025-12-19T18:40:24Z"),
    ])).resolves.toBeUndefined();
  });
});

describe("§3.2c(ii) the events:replay CLI refuses up front", () => {
  it("enumerates one instant per month in the --from/--to window", () => {
    expect(replayWindowMonths(new Date("2026-02-10T00:00:00Z"), new Date("2026-04-02T00:00:00Z"))
      .map((date) => date.toISOString()))
      .toEqual([
        "2026-02-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
      ]);
    // An open-ended window anchors on the bound it has; a window with neither
    // is left to the engine gate rather than guessed at.
    expect(replayWindowMonths(new Date("2026-03-10T00:00:00Z"), null)).toHaveLength(1);
    expect(replayWindowMonths(null, null)).toEqual([]);
    expect(replayWindowMonths(new Date("2026-04-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z")))
      .toEqual([]);
  });

  it("exits non-zero and dispatches NO work when a window month is uncovered", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    const page = await seedPage();
    await detachMonth(DETACHED_MONTH);
    await seedDm(
      page.id,
      "cli-1",
      new Date(Date.UTC(DETACHED_MONTH.year, DETACHED_MONTH.month - 1, 12, 9, 0, 0)),
    );

    const appContext = createTestAppContext(testDb);
    vi.resetModules();
    vi.doMock("../apps/runtime/src/bootstrap.ts", () => ({
      createAppContext: async () => appContext,
    }));
    const { buildProgram } = await import("../apps/runtime/src/cli.ts");
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });

    const stderr: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    });
    const previousExitCode = process.exitCode;
    try {
      await program.parseAsync([
        "node",
        "cli",
        "events:replay",
        "--kind",
        "dm_messages",
        "--from",
        "2026-03-01T00:00:00Z",
        "--to",
        "2026-03-31T00:00:00Z",
      ]);
      expect(process.exitCode).toBe(1);
      const joined = stderr.join("\n");
      expect(joined).toContain("REFUSED before dispatching work");
      expect(joined).toContain("2026_03");
      expect(joined).toContain("detached");
      // …and it really dispatched nothing: the observation is untouched.
      expect(await parseVersionOf("cli-1")).toBe(0);
      expect(await listEventsSince(testDb.db, { accountId: page.id, afterSeq: 0 }))
        .toHaveLength(0);
    } finally {
      process.exitCode = previousExitCode;
      errorSpy.mockRestore();
      vi.doUnmock("../apps/runtime/src/bootstrap.ts");
      vi.resetModules();
    }
  });
});
