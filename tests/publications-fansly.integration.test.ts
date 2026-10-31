import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PublicationContentBody } from "@agency_hub_core/contracts";
import {
  admitFanslyWriteCommand,
  refuseFanslyWriteCommand,
  settleFanslyWriteCommand,
  type Database,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import {
  FANSLY_STEP_RETRY_GAP_MS,
  followFanslyCreates,
  runFanslyPublishingTick,
  type FanslyPublishingOptions,
} from "../apps/runtime/src/services/publications-fansly.ts";
import { approvePublications, createPublicationDraft } from "../apps/runtime/src/services/publications.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { seedSyncPage } from "./helpers/sync-engine-host.ts";

/**
 * Fansly wall posts (plan PR 9): an approved publication becomes one dispatch
 * and a chain of its page's write commands, each step queued once and only
 * after the one before it answered; five creates per page in a row; a story in
 * its window, urgent; too late, missed without a request; the post's lost
 * answer "unknown" and never queued again; nothing at all while a route is
 * unverified. The engine's side is played here: a command is admitted and
 * settled as its one attempt would.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HASH = "f".repeat(64);

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let pageId = 0;
let ownerId = 0;
let attemptId = 1000;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await testDb!.pool.query<T>(text, values)).rows;
}

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  app = createTestAppContext(testDb);
  app.config.publishingEnabled = true;
  ({ pageId } = await seedSyncPage({ db: app.db as unknown as Database, pool: testDb.pool }, { mode: "live", guard: "fansly_sync_engine" }));
  await sql("update sync_pages set transport = 'browser' where page_id = $1", [pageId]);
  await sql(
    `insert into page_walls (page_id, platform, wall_ref, name, default_wall, main_wall, first_observed_at, last_observed_at,
                             content_hash, source_event_id, source_observation_id, source_account_seq)
     values ($1, 'fansly', 'wall-main', 'Main', true, true, now(), now(), $2, 1, 1, 1)`,
    [pageId, HASH],
  );
  for (let ref = 1; ref <= 9; ref += 1) {
    await sql(
      `insert into creator_raw_media (page_id, platform, media_ref, source_kind, first_origin, first_observed_at,
                                      last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
       values ($1, 'fansly', $2, 'vault_media', 'vault', now(), now(), $3, 1, 1, 1)`,
      [pageId, `m${ref}`, HASH],
    );
  }
  await sql("insert into page_publishing_settings (page_id, enabled) values ($1, true)", [pageId]);
  ownerId = (await createUserAccount(app, { username: "owner", role: "owner", password: "owner-password-for-tests" }, { source: "cli" })).id;
});

function body(overrides: Partial<PublicationContentBody> = {}): PublicationContentBody {
  return {
    kind: "fyp_post", text: "new set", media: [{ source: "vault", mediaRef: "m1" }], previews: [],
    publishAt: new Date(Date.now() + 2 * DAY).toISOString(), expiresAt: null, wallRefs: [], tierRefs: [], priceMills: null,
    repost: false, pinWallRefs: [], replyLock: [], subscribersOnly: false, extraAttachments: [], ...overrides,
  };
}

async function approved(overrides: Partial<PublicationContentBody> = {}): Promise<number> {
  const draft = await createPublicationDraft(app.db, { pageId, body: body(overrides), author: { kind: "human", userId: ownerId }, idempotencyKey: null });
  const [result] = await approvePublications(app.db, { items: [{ id: draft.id, version: draft.version }], userId: ownerId });
  expect(result?.outcome, JSON.stringify(result)).toBe("approved");
  return draft.id;
}

/** Every route verified: the stand's session is played as done. */
const tick = (options: FanslyPublishingOptions = {}) => runFanslyPublishingTick(app, { isSendable: () => true, ...options });

interface CommandRow extends Record<string, unknown> {
  id: string;
  step: string;
  state: string;
  priority: string;
  not_before: Date;
  not_after: Date | null;
  work_id: string | null;
}

const commandsOf = (publicationId: number) => sql<CommandRow>(
  "select id::text, step, state, priority, not_before, not_after, work_id::text from fansly_write_commands where publication_id = $1 order by id",
  [publicationId],
);

async function publication(id: number) {
  return (await sql<{ status: string; status_reason: string | null; platform_post_ref: string | null }>(
    "select status, status_reason, platform_post_ref from publications where id = $1", [id],
  ))[0]!;
}

/** The engine's one attempt of a command, settled. */
async function settleCommand(id: string | number, to: "answered" | "rejected" | "unknown", result: Record<string, unknown> | null = null, reason: string | null = null) {
  attemptId += 1;
  expect(await admitFanslyWriteCommand(app.db, {
    id: Number(id), attemptId, workId: 1,
    request: { spec: "publish.post", method: "POST", host: "api", pathAndQuery: "/api/v1/post", body: "{}", fingerprint: "e".repeat(64) },
  })).toBe(true);
  expect(await settleFanslyWriteCommand(app.db, { id: Number(id), attemptId, to, reason, result })).toBe(true);
}

describe("a Fansly create goes once, step by step (spec §5, §8.1)", () => {
  it("one dispatch, the account media first, the post after its answer, scheduled with the post's id", async () => {
    const id = await approved();
    const [first, second] = await Promise.all([tick(), tick()]);
    expect(first.dispatched + second.dispatched).toBe(1);
    expect(await publication(id)).toMatchObject({ status: "submitting" });
    let commands = await commandsOf(id);
    expect(commands.map((row) => `${row.step}:${row.state}:${row.priority}`)).toEqual(["account_media:queued:background"]);
    // The engine runs it under its own work row of the planned class.
    const works = await sql<{ resource: string; subject: string }>("select resource, subject from sync_work where resource like 'publish.%'");
    expect(works).toEqual([{ resource: "publish.background", subject: commands[0]!.id }]);

    // In flight: nothing more is queued, however many minutes pass.
    await tick();
    expect(await commandsOf(id)).toHaveLength(1);

    await settleCommand(commands[0]!.id, "answered", { accountMediaIds: ["a1"] });
    expect((await tick()).queued).toBe(1);
    commands = await commandsOf(id);
    expect(commands.map((row) => `${row.step}:${row.state}`)).toEqual(["account_media:answered", "post:queued"]);
    // A post into Fansly's schedule is sent no later than a minute before its time.
    const publishAt = new Date((await sql<{ publish_at: Date }>("select publish_at from publications where id = $1", [id]))[0]!.publish_at);
    expect(commands[1]!.not_after?.getTime()).toBe(publishAt.getTime() - 5 * MIN);

    await settleCommand(commands[1]!.id, "answered", { postId: "p100" });
    await tick();
    expect(await publication(id)).toMatchObject({ status: "scheduled", platform_post_ref: "p100" });
    await tick();
    expect(await commandsOf(id)).toHaveLength(2);
    expect(await sql("select kind, platform, mode from publication_dispatches")).toEqual([{ kind: "create", platform: "fansly", mode: "scheduled" }]);
  });

  it("nothing at all while a route is unverified or the global switch is off: the publication stays approved", async () => {
    const id = await approved();
    // A route the contract did not verify (as the upload's still are).
    const report = await runFanslyPublishingTick(app, { isSendable: () => false });
    expect(report).toMatchObject({ dispatched: 0, routesUnverified: 1 });
    app.config.publishingEnabled = false;
    expect(await tick()).toMatchObject({ sending: false, dispatched: 0 });
    expect(await publication(id)).toMatchObject({ status: "approved" });
    expect(await sql("select id from publication_dispatches")).toEqual([]);
    expect(await sql("select id from fansly_write_commands")).toEqual([]);
  });

  it("five creates of a page in a row, the next ones 10 minutes later", async () => {
    const ids: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(await approved({ media: [], text: `post ${index}`, publishAt: new Date(Date.now() + (index + 1) * DAY / 2).toISOString() }));
    }
    for (let round = 0; round < 6; round += 1) {
      await tick();
      for (const row of await sql<{ id: string }>("select id::text from fansly_write_commands where state = 'queued'")) {
        await settleCommand(row.id, "answered", { postId: `p${row.id}` });
      }
    }
    await tick();
    const statuses = await Promise.all(ids.map(async (id) => (await publication(id)).status));
    expect(statuses).toEqual(["scheduled", "scheduled", "scheduled", "scheduled", "scheduled", "approved"]);
    expect((await sql("select id from publication_dispatches")).length).toBe(5);
  });
});

describe("a Fansly create's outcomes (spec §4, §8.2)", () => {
  it("the post's lost answer is unknown and never queued again", async () => {
    const id = await approved();
    await tick();
    await settleCommand((await commandsOf(id))[0]!.id, "answered", { accountMediaIds: ["a1"] });
    await tick();
    await settleCommand((await commandsOf(id))[1]!.id, "unknown", null, "no_answer:timeout");
    await tick();
    expect(await publication(id)).toMatchObject({ status: "unknown", status_reason: "post:no_answer:timeout" });
    await tick();
    expect((await commandsOf(id)).map((row) => `${row.step}:${row.state}`)).toEqual(["account_media:answered", "post:unknown"]);
  });

  it("a step before the post lost: the post never went — missed; Fansly's refusal: rejected", async () => {
    const lost = await approved();
    await tick();
    await settleCommand((await commandsOf(lost))[0]!.id, "unknown", null, "no_answer:timeout");
    await tick();
    expect(await publication(lost)).toMatchObject({ status: "missed", status_reason: "not_sent:account_media_unknown:no_answer:timeout" });

    const refused = await approved({ media: [{ source: "vault", mediaRef: "m2" }], publishAt: new Date(Date.now() + 3 * DAY).toISOString() });
    await tick();
    await settleCommand((await commandsOf(refused))[0]!.id, "rejected", null, "fansly_http_400");
    await tick();
    expect(await publication(refused)).toMatchObject({ status: "rejected", status_reason: "account_media:fansly_http_400" });
    expect(await commandsOf(refused)).toHaveLength(1);
  });

  it("a step a switch held back is queued again when it is back on, inside its window", async () => {
    const id = await approved();
    await tick();
    const [first] = await commandsOf(id);
    expect(await refuseFanslyWriteCommand(app.db, { id: Number(first!.id), reason: "page_publishing_off" })).toBe(true);
    app.config.publishingEnabled = false;
    await tick();
    // Off: the enqueue refuses before writing anything.
    expect((await commandsOf(id)).map((row) => row.state)).toEqual(["refused"]);
    app.config.publishingEnabled = true;
    await tick();
    expect((await commandsOf(id)).map((row) => `${row.step}:${row.state}`)).toEqual(["account_media:refused", "account_media:queued"]);
    expect(await publication(id)).toMatchObject({ status: "submitting" });
  });
});

describe("a Fansly story (spec §3.5)", () => {
  it("goes at its time as urgent work that ends 30 minutes after it", async () => {
    const publishAt = new Date(Date.now() + 2 * MIN);
    const id = await approved({ kind: "story", text: "", publishAt: publishAt.toISOString() });
    expect((await tick({ now: new Date(publishAt.getTime() - MIN) })).dispatched).toBe(0);
    expect((await tick({ now: new Date(publishAt.getTime() + MIN) })).dispatched).toBe(1);
    const [command] = await commandsOf(id);
    expect(command).toMatchObject({ step: "account_media", priority: "urgent" });
    expect(command!.not_after?.getTime()).toBe(publishAt.getTime() + 30 * MIN);
    expect(await sql("select resource from sync_work where resource like 'publish.%'")).toEqual([{ resource: "publish.urgent" }]);
    expect(await sql("select mode from publication_dispatches")).toEqual([{ mode: "story" }]);
  });

  it("too late is missed without a request", async () => {
    const publishAt = new Date(Date.now() + 2 * MIN);
    const id = await approved({ kind: "story", text: "", media: [{ source: "vault", mediaRef: "m3" }], publishAt: publishAt.toISOString() });
    expect((await tick({ now: new Date(publishAt.getTime() + 31 * MIN) })).missed).toBe(1);
    expect(await publication(id)).toMatchObject({ status: "missed", status_reason: "window_passed" });
    expect(await sql("select id from publication_dispatches")).toEqual([]);
    expect(await sql("select id from fansly_write_commands")).toEqual([]);
  });
});

describe("the minute's job follows its creates each second, not once a minute", () => {
  /** A clock the loop's waits move on; each wait plays the page's engine: what is queued and due is answered. */
  function engine(answer: (step: string) => Record<string, unknown> | null) {
    let at = Date.now();
    const waits: number[] = [];
    return {
      waits,
      clock: () => new Date(at),
      sleep: async (ms: number) => {
        waits.push(ms);
        at += ms;
        const due = await sql<{ id: string; step: string }>(
          "select id::text, step from fansly_write_commands where state = 'queued' and not_before <= $1 order by id", [new Date(at)],
        );
        for (const row of due) {
          const result = answer(row.step);
          if (result !== null) await settleCommand(row.id, "answered", result);
        }
      },
    };
  }

  it("a post's chain goes inside one job: its next step is queued about a second after the one before answered", async () => {
    const id = await approved();
    const played = engine((step) => (step === "post" ? { postId: "p7" } : { accountMediaIds: ["a1"] }));
    expect((await tick({ now: played.clock() })).dispatched).toBe(1);
    const follow = await followFanslyCreates(app, {
      until: new Date(played.clock().getTime() + 50_000), isSendable: () => true, clock: played.clock, sleep: played.sleep,
    });
    expect(await publication(id)).toMatchObject({ status: "scheduled", platform_post_ref: "p7" });
    expect((await commandsOf(id)).map((row) => `${row.step}:${row.state}`)).toEqual(["account_media:answered", "post:answered"]);
    expect(follow).toMatchObject({ queued: 1, settled: 1 });
    // Seconds, not the next minute; and nothing more to follow, the loop ends.
    expect(played.waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(5_000);
  });

  it("a refused step goes again a minute after its refusal, and holds its page meanwhile", async () => {
    const first = await approved();
    const second = await approved({ media: [], text: "next one", publishAt: new Date(Date.now() + 3 * DAY).toISOString() });
    const played = engine(() => null);
    expect((await tick({ now: played.clock() })).dispatched).toBe(1);
    const [queued] = await commandsOf(first);
    expect(await refuseFanslyWriteCommand(app.db, { id: Number(queued!.id), reason: "not_sent:not_sent:write_refused" })).toBe(true);
    const follow = await followFanslyCreates(app, {
      until: new Date(played.clock().getTime() + 50_000), isSendable: () => true, clock: played.clock, sleep: played.sleep,
    });
    // Queued again for a minute later: nothing to follow before the loop's end.
    expect(follow).toMatchObject({ passes: 1, queued: 1 });
    const rows = await sql<{ state: string; not_before: Date; settled_at: Date | null }>(
      "select state, not_before, settled_at from fansly_write_commands where publication_id = $1 order by id", [first],
    );
    expect(rows.map((row) => row.state)).toEqual(["refused", "queued"]);
    expect(new Date(rows[1]!.not_before).getTime() - new Date(rows[0]!.settled_at!).getTime()).toBeGreaterThanOrEqual(FANSLY_STEP_RETRY_GAP_MS);
    // A later pass before the retry is due: the page is still the first one's; the second waits.
    await tick({ now: new Date(played.clock().getTime() + MIN / 2) });
    expect(await publication(second)).toMatchObject({ status: "approved" });
  });

  it("ends when its time is up or the worker stops", async () => {
    await approved();
    const played = engine(() => null);
    await tick({ now: played.clock() });
    const until = new Date(played.clock().getTime() + 10_000);
    // The engine never answers: the loop looks each second until its end.
    const follow = await followFanslyCreates(app, { until, isSendable: () => true, clock: played.clock, sleep: played.sleep });
    expect(follow.passes).toBeGreaterThan(1);
    expect(played.clock().getTime()).toBeLessThan(until.getTime());
    const stopped = new AbortController();
    stopped.abort();
    expect((await followFanslyCreates(app, { until, signal: stopped.signal, isSendable: () => true })).passes).toBe(0);
  });
});
