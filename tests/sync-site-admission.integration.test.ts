import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getSyncPage, setPagePause, type Database } from "@agency_hub_core/db";

import type { PendingSiteRequest, SiteAdmissionPort, SiteRefusalReason, SiteRequestEnd } from "../apps/runtime/src/sync/engine/ports.ts";
import { SITE_SENDS_PER_HOUR } from "../apps/runtime/src/sync/engine/site-admission.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { FakeOwnershipSession, makeTestActor, RecordingMetrics, seedSyncPage, testRegistry, testSpec, waitFor } from "./helpers/sync-engine-host.ts";

// The admission of a page's own site requests by the live actor (Project
// Browser, plan §3.2, spec §3; stage 3 PR 8) on a real Postgres, with a fake
// page browser: what is admitted goes through the pacer and the journal
// (origin site/login, class site), what must be refused is, the manual login
// passes the owner's pause, and the answers hold routes and credentials by
// the engine's own rules.

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  if (testDb) await resetIntegrationDatabase(testDb.pool);
});

function db(): Database {
  return testDb!.db as unknown as Database;
}

async function rows<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await testDb!.pool.query(text, values)).rows as T[];
}

/** A page browser that holds the site's requests and answers as scripted. */
class FakeSiteBrowser implements SiteAdmissionPort {
  readonly waiting: PendingSiteRequest[] = [];
  readonly granted: Array<{ id: string; attemptId: number; sendWithinMs: number; atMs: number }> = [];
  readonly refused: Array<{ id: string; reason: SiteRefusalReason }> = [];
  answer: (request: PendingSiteRequest) => SiteRequestEnd = () => ({ kind: "response", status: 200, retryAfterMs: null });
  #ends = new Map<string, SiteRequestEnd>();

  ask(request: Partial<PendingSiteRequest> & { id: string }, agoMs = 0): void {
    this.waiting.push({ method: "GET", host: "api", path: "/api/v1/timeline/home", manualLogin: false, askedMono: performance.now() - agoMs, ...request });
  }

  pending(): readonly PendingSiteRequest[] {
    return this.waiting;
  }

  grant(id: string, admission: { attemptId: number; sendWithinMs: number }): void {
    const index = this.waiting.findIndex((request) => request.id === id);
    const [request] = this.waiting.splice(index, 1);
    this.granted.push({ id, ...admission, atMs: performance.now() });
    this.#ends.set(id, this.answer(request!));
  }

  refuse(id: string, reason: SiteRefusalReason): void {
    const index = this.waiting.findIndex((request) => request.id === id);
    if (index >= 0) this.waiting.splice(index, 1);
    this.refused.push({ id, reason });
  }

  async end(id: string): Promise<SiteRequestEnd> {
    return this.#ends.get(id) ?? { kind: "transport_error", sent: false, message: "unknown request" };
  }
}

async function runActor(pageId: number, site: FakeSiteBrowser, until: () => Promise<boolean> | boolean, settingMs = 40) {
  const { actor, deps, stop, abort } = await makeTestActor({ db: db(), pageId, registry: testRegistry([]), settingMs, metrics: new RecordingMetrics() });
  deps.site = site;
  const run = actor.run({ stop: stop.signal, abort: abort.signal });
  try {
    await waitFor(async () => ((await until()) ? true : null), 20_000, "the site's requests to settle");
  } finally {
    stop.abort();
    await run;
  }
}

interface AttemptRow extends Record<string, unknown> {
  origin: string;
  class: string;
  work_id: string | null;
  operation: string;
  outcome: string;
  http_status: number | null;
  sent: boolean;
}

async function attempts(pageId: number): Promise<AttemptRow[]> {
  return rows<AttemptRow>(
    "select origin, class, work_id, operation, outcome, http_status, sent_at is not null as sent from sync_attempts where page_id = $1 order by id",
    [pageId],
  );
}

describe("the site path of the live actor", () => {
  it("an aborted late admission does not spend the site's turn on ten engine requests (lilly-1 322581)", async () => {
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const site = new FakeSiteBrowser();
    site.ask({ id: "dead" });
    site.ask({ id: "live" });
    site.answer = (request) => request.id === "dead" ? { kind: "aborted_before_send", reason: "cancelled" } : { kind: "response", status: 200, retryAfterMs: null };
    const made = await makeTestActor({ db: db(), pageId, settingMs: 40, registry: testRegistry([testSpec("busy.poll", {
      plan: async () => ({ kind: "request", request: { spec: "polls", params: {} } }),
      apply: async () => ({ work: { satisfiesRevision: true }, followups: [] }),
    }, { kind: "poll", class: "planned", period: { everyMs: 1 } })]) });
    made.deps.site = site;
    const run = made.actor.run({ stop: made.stop.signal, abort: made.abort.signal });
    try {
      await waitFor(() => site.granted.length === 2 ? true : null, 5_000, "the live request after an unsent grant");
    } finally { made.stop.abort(); await run; }
    expect((await attempts(pageId)).slice(0, 2)).toMatchObject([
      { origin: "site", outcome: "aborted_before_send", sent: false }, { origin: "site", outcome: "response", sent: true },
    ]);
  });

  it("admits the site's reads through the pacer and the journal", async () => {
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const site = new FakeSiteBrowser();
    site.ask({ id: "home" });
    site.ask({ id: "groups", path: "/api/v1/messaging/groups?ngsw-bypass=true" });
    await runActor(pageId, site, () => site.granted.length === 2);
    expect(site.granted.map((grant) => grant.id)).toEqual(["home", "groups"]);
    // The send window left, as the browser receives it; the pause between.
    for (const grant of site.granted) expect(grant.sendWithinMs).toBeGreaterThan(14_000);
    expect(site.granted[1]!.atMs - site.granted[0]!.atMs).toBeGreaterThanOrEqual(40);
    await waitFor(async () => ((await attempts(pageId)).every((row) => row.outcome === "response") ? true : null), 5_000, "the commits");
    expect(await attempts(pageId)).toEqual([
      { origin: "site", class: "site", work_id: null, operation: "site.other", outcome: "response", http_status: 200, sent: true },
      { origin: "site", class: "site", work_id: null, operation: "messaging.groups", outcome: "response", http_status: 200, sent: true },
    ]);
    const page = await getSyncPage(db(), pageId);
    expect(page?.lastSendAt).not.toBeNull();
  });

  it("refuses at once what no route admits and what waited too long", async () => {
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const site = new FakeSiteBrowser();
    site.ask({ id: "ack", method: "POST", path: "/api/v1/message/ack" });
    site.ask({ id: "login", method: "POST", path: "/api/v1/login" });
    site.ask({ id: "old" }, 61_000);
    await runActor(pageId, site, () => site.refused.length === 3);
    expect(site.refused.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "ack", reason: "write" },
      { id: "login", reason: "mode" },
      { id: "old", reason: "waited_too_long" },
    ]);
    expect(site.granted).toEqual([]);
    expect(await attempts(pageId)).toEqual([]);
  });

  it("the owner's pause refuses the site, and passes the manual login", async () => {
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await testDb!.pool.query("update sync_pages set paused_all = true where page_id = $1", [pageId]);
    const site = new FakeSiteBrowser();
    site.ask({ id: "read" });
    site.ask({ id: "login", method: "POST", path: "/api/v1/login", manualLogin: true });
    await runActor(pageId, site, () => site.refused.length === 1 && site.granted.length === 1);
    expect(site.refused).toEqual([{ id: "read", reason: "paused" }]);
    expect(site.granted.map((grant) => grant.id)).toEqual(["login"]);
    await waitFor(async () => ((await attempts(pageId)).length === 1 && (await attempts(pageId))[0]!.outcome !== "admitted" ? true : null), 5_000, "the commit");
    expect(await attempts(pageId)).toEqual([
      { origin: "login", class: "site", work_id: null, operation: "auth.login", outcome: "response", http_status: 200, sent: true },
    ]);
  });

  it("a pause committed after the slot's decision refuses the site's request at its admission", async () => {
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const site = new FakeSiteBrowser();
    site.ask({ id: "read" });
    // The interleaving, driven: the slot's decision saw the page unpaused;
    // the owner's pause (the lever itself) commits at the ownership ping,
    // right before the admission.
    const ownership = new FakeOwnershipSession();
    const ping = ownership.ping.bind(ownership);
    let paused = false;
    ownership.ping = async () => {
      if (!paused) {
        paused = true;
        await setPagePause(db(), { pageId, all: true, note: "owner pause" });
      }
      return ping();
    };
    const { actor, deps, stop, abort } = await makeTestActor({ db: db(), pageId, registry: testRegistry([]), settingMs: 40, metrics: new RecordingMetrics(), ownership });
    deps.site = site;
    const run = actor.run({ stop: stop.signal, abort: abort.signal });
    try {
      await waitFor(() => (site.refused.length + site.granted.length > 0 ? true : null), 20_000, "the site's request to settle");
    } finally {
      stop.abort();
      await run;
    }
    expect(paused).toBe(true);
    expect(site.granted).toEqual([]);
    expect(site.refused).toEqual([{ id: "read", reason: "paused" }]);
    expect(await attempts(pageId)).toEqual([]);
  });

  it("a 429 holds the route that answered; a 401 the credentials — not in the manual login", async () => {
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
    const site = new FakeSiteBrowser();
    site.answer = (request) => ({ kind: "response", status: request.id === "limited" ? 429 : 401, retryAfterMs: null });
    site.ask({ id: "limited" });
    site.ask({ id: "login-screen", path: "/api/v1/versioning?ngsw-bypass=true", manualLogin: true });
    await runActor(pageId, site, () => site.granted.length === 2);
    await waitFor(async () => ((await attempts(pageId)).every((row) => row.outcome === "response") ? true : null), 5_000, "the commits");
    const held = await rows<{ scope: string; key: string; kind: string }>("select scope, key, kind from sync_holds where page_id = $1 order by scope, key", [pageId]);
    // The route's state (its budget row) and its hold, of `site.other` alone.
    expect(held.filter((row) => row.scope === "route").map((row) => `${row.key}:${row.kind}`).sort()).toEqual(["site.other:route_budget", "site.other:route_hold"]);
    expect(held.filter((row) => row.scope === "page")).toEqual([]);

    // The same 401 outside the manual login holds the page's credentials.
    const second = new FakeSiteBrowser();
    second.answer = () => ({ kind: "response", status: 401, retryAfterMs: null });
    second.ask({ id: "groups", path: "/api/v1/messaging/groups" });
    await runActor(pageId, second, () => second.granted.length === 1);
    await waitFor(async () => {
      const page = await rows<{ kind: string }>("select kind from sync_holds where page_id = $1 and scope = 'page'", [pageId]);
      return page.length > 0 ? page : null;
    }, 5_000, "the credentials hold");
  });

  it("the hour's ceiling refuses", async () => {
    const { pageId } = await seedSyncPage({ db: db(), pool: testDb!.pool }, { mode: "live", guard: "fansly_sync_engine" });
    await testDb!.pool.query(
      `insert into sync_attempts (page_id, resource, subject, class, owner_generation, setting_ms, jitter_u, pause_ms,
                                  admitted_at, sent_at, operation, request, outcome, origin)
       select $1, 'site', '', 'site', 1, 2500, 0.1, 2750, t, t, 'site.other', '{}'::jsonb, 'response', 'site'
         from generate_series(1, $2::int) n, lateral (select clock_timestamp() - n * interval '5 seconds') s(t)`,
      [pageId, SITE_SENDS_PER_HOUR],
    );
    const site = new FakeSiteBrowser();
    site.ask({ id: "one-too-many" });
    await runActor(pageId, site, () => site.refused.length === 1);
    expect(site.refused).toEqual([{ id: "one-too-many", reason: "hour_ceiling" }]);
  });
});
