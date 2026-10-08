import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyTrafficBindingsChange,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  TrafficBindingsConflictError,
  type TrafficBindingsChangeSet,
} from "@agency_hub_core/db";

import { TRAFFIC_BINDINGS_FILE_FORMAT } from "../apps/runtime/src/services/traffic-bindings.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// OnlyFans traffic sources (plan 2026-10-08, PR 11): the owner's CLI over
// "link → channel → contractor", end to end through buildProgram, and the
// one-binding-per-instant rule under two concurrent writers (П9.6).

let testDb: StartedTestDatabase | null = null;
let workDir = "";
let vipPageId = 0;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "traffic-bindings-"));
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  vi.restoreAllMocks();
  await resetIntegrationDatabase(testDb.pool);
  const model = await createModel(testDb.db, { slug: "lora", name: "Lora" });
  if (!model) throw new Error("model seed failed");
  const vip = await createOnlyFansPage(testDb.db, { modelId: model.id, label: "lora-vip-of" });
  await createOnlyFansPage(testDb.db, { modelId: model.id, label: "lora-of" });
  await createFanslyPage(testDb.db, { modelId: model.id, label: "lora-1" });
  if (!vip) throw new Error("page seed failed");
  vipPageId = vip.id;
});

afterEach(() => {
  process.exitCode = undefined;
});

/** The fields of the commands' JSON the tests read (asserted at runtime). */
interface CliJson {
  written: boolean;
  counts: Record<string, Record<string, number>>;
  conflicts: string[];
  warnings: string[];
  changes: Record<string, unknown[]>;
}

async function runCli(args: string[]) {
  const appContext = createTestAppContext(testDb!);
  vi.resetModules();
  vi.doMock("../apps/runtime/src/bootstrap.ts", () => ({ createAppContext: async () => appContext }));
  const { buildProgram } = await import("../apps/runtime/src/cli.ts");
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    out.push(String(message ?? ""));
  });
  const err = vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
    out.push(String(message ?? ""));
  });
  process.exitCode = undefined;
  try {
    await program.parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  const exitCode = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { out: out.join("\n"), json: () => JSON.parse(out.join("\n")) as CliJson, exitCode };
}

let fileSeq = 0;
async function bindingsFile(body: Record<string, unknown>) {
  fileSeq += 1;
  const file = path.join(workDir, `bindings-${fileSeq}.json`);
  await writeFile(file, JSON.stringify({ format: TRAFFIC_BINDINGS_FILE_FORMAT, ...body }, null, 2));
  return file;
}

async function count(sql: string) {
  const result = await testDb!.pool.query<{ n: number }>(`select count(*)::int as n from ${sql}`);
  return result.rows[0]!.n;
}

const trafficAuditCount = () => count("audit_events where event_type like 'admin.traffic\\_%'");
const tableCounts = async () => ({
  contractors: await count("traffic_contractors"),
  channels: await count("traffic_channels"),
  terms: await count("traffic_channel_contractors"),
  bindings: await count("traffic_link_bindings"),
});

const seed = {
  comment: "integration fixture",
  contractors: [
    { key: "coraline-red", title: "Coraline Red" },
    { key: "garantteam-social", title: "GaranTTeam" },
  ],
  channels: [
    {
      key: "lora.porntoki",
      title: "Порнтоки",
      contractors: [
        { contractor: "coraline-red", validFrom: "2026-04-01T13:31:01Z", validTo: "2026-09-16", validFromBasis: "assumed_link_created" },
        { contractor: "coraline-red", validFrom: "2026-09-16", validFromBasis: "confirmed" },
      ],
    },
    {
      key: "lora.insta-farm",
      title: "Instagram ферма",
      contractors: [
        { contractor: "garantteam-social", validFrom: "2026-04-19T01:18:43Z", validTo: "2026-09-30", validFromBasis: "assumed_link_created" },
      ],
    },
  ],
  bindings: [
    { page: "lora-vip-of", kind: "trial", link: "11170786", channel: "lora.porntoki", validFrom: "2026-04-01", validFromBasis: "confirmed", note: "Fikfap" },
    { page: "lora-vip-of", kind: "trial", link: "11213035", channel: "lora.insta-farm", validFrom: "2026-04-19T01:18:43Z", validTo: "2026-09-30", validFromBasis: "assumed_link_created" },
  ],
};

describe("traffic:bindings:import", () => {
  it("without --write prints the plan and writes nothing — no row, no audit event", async () => {
    const file = await bindingsFile(seed);
    const result = await runCli(["traffic:bindings:import", "--file", file]);
    expect(result.exitCode).toBe(0);
    const plan = result.json();
    expect(plan.written).toBe(false);
    expect(plan.counts).toEqual({
      contractors: { create: 2 },
      channels: { create: 2 },
      channelContractors: { create: 3 },
      linkBindings: { create: 2 },
    });
    expect(plan.conflicts).toEqual([]);
    expect(await tableCounts()).toEqual({ contractors: 0, channels: 0, terms: 0, bindings: 0 });
    expect(await trafficAuditCount()).toBe(0);
  });

  it("with --write applies it, one audit event per change; the same file again changes nothing", async () => {
    const file = await bindingsFile(seed);
    const first = await runCli(["traffic:bindings:import", "--file", file, "--write"]);
    expect(first.exitCode).toBe(0);
    expect(first.json().written).toBe(true);
    expect(await tableCounts()).toEqual({ contractors: 2, channels: 2, terms: 3, bindings: 2 });
    expect(await trafficAuditCount()).toBe(9);

    const stored = await testDb!.pool.query(`
      select b.platform_link_id, c.key as channel, b.valid_from, b.valid_to, b.valid_from_basis, b.note
        from traffic_link_bindings b join traffic_channels c on c.id = b.channel_id order by 1`);
    expect(stored.rows).toEqual([
      {
        platform_link_id: "11170786", channel: "lora.porntoki", valid_from: new Date("2026-03-31T21:00:00Z"),
        valid_to: null, valid_from_basis: "confirmed", note: "Fikfap",
      },
      {
        platform_link_id: "11213035", channel: "lora.insta-farm", valid_from: new Date("2026-04-19T01:18:43Z"),
        valid_to: new Date("2026-09-29T21:00:00Z"), valid_from_basis: "assumed_link_created", note: null,
      },
    ]);
    const audit = await testDb!.pool.query(`
      select platform_account_id::int as page, metadata->>'command' as command, metadata->>'fileSha256' as sha
        from audit_events where event_type = 'admin.traffic_link_binding_created' order by id`);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.every((row) => row.page === vipPageId && row.command === "import" && /^[0-9a-f]{64}$/.test(row.sha)))
      .toBe(true);

    const again = await runCli(["traffic:bindings:import", "--file", file, "--write"]);
    expect(again.exitCode).toBe(0);
    expect(again.json().counts).toEqual({
      contractors: { unchanged: 2 },
      channels: { unchanged: 2 },
      channelContractors: { unchanged: 3 },
      linkBindings: { unchanged: 2 },
    });
    expect(await trafficAuditCount()).toBe(9);

    const listed = await runCli(["traffic:bindings:list", "--channel", "lora.porntoki"]);
    expect(listed.json()).toEqual({
      contractors: [{ key: "coraline-red", title: "Coraline Red" }, { key: "garantteam-social", title: "GaranTTeam" }],
      channels: [{
        key: "lora.porntoki",
        title: "Порнтоки",
        note: null,
        contractors: [
          { contractorKey: "coraline-red", validFrom: "2026-04-01T13:31:01.000Z", validTo: "2026-09-15T21:00:00.000Z", validFromBasis: "assumed_link_created", note: null },
          { contractorKey: "coraline-red", validFrom: "2026-09-15T21:00:00.000Z", validTo: null, validFromBasis: "confirmed", note: null },
        ],
      }],
      bindings: [{
        pageLabel: "lora-vip-of", linkKind: "trial", linkId: "11170786", channelKey: "lora.porntoki",
        validFrom: "2026-03-31T21:00:00.000Z", validTo: null, validFromBasis: "confirmed", note: "Fikfap",
      }],
    });
  });

  it("refuses overlapping dates — closed intervals included — and writes nothing of the file", async () => {
    await runCli(["traffic:bindings:import", "--file", await bindingsFile(seed), "--write"]);
    const before = await tableCounts();
    const audits = await trafficAuditCount();

    // The farm binding is closed [04-19, 09-30); a second channel from 09-01
    // to 10-01 overlaps it although neither row is open. The file's other
    // row (a fresh link) is fine, and is not written either.
    const file = await bindingsFile({
      channels: [{ key: "lora.reddit", title: "Reddit" }],
      bindings: [
        { page: "lora-vip-of", kind: "trial", link: "11213035", channel: "lora.reddit", validFrom: "2026-09-01", validTo: "2026-10-01", validFromBasis: "confirmed" },
        { page: "lora-vip-of", kind: "trial", link: "10573270", channel: "lora.reddit", validFrom: "2025-09-06T16:52:26Z", validFromBasis: "assumed_link_created" },
      ],
    });
    const dry = await runCli(["traffic:bindings:import", "--file", file]);
    expect(dry.exitCode).toBe(1);
    expect(dry.json().conflicts).toEqual([expect.stringMatching(/link lora-vip-of trial 11213035: lora\.insta-farm .* overlaps lora\.reddit/)]);

    const write = await runCli(["traffic:bindings:import", "--file", file, "--write"]);
    expect(write.exitCode).toBe(1);
    expect(write.json()).toEqual({ written: false, conflicts: [expect.stringMatching(/overlaps/)] });
    expect(await tableCounts()).toEqual(before);
    expect(await trafficAuditCount()).toBe(audits);
  });

  it("refuses an unknown page, a non-OnlyFans page, an unknown channel and a bad file", async () => {
    const file = await bindingsFile({
      bindings: [
        { page: "nope", kind: "trial", link: "1", channel: "lora.x", validFrom: "2026-01-01", validFromBasis: "confirmed" },
        { page: "lora-1", kind: "trial", link: "2", channel: "lora.x", validFrom: "2026-01-01", validFromBasis: "confirmed" },
        { page: "lora-vip-of", kind: "trial", link: "3", channel: "lora.x", validFrom: "2026-01-01", validFromBasis: "confirmed" },
      ],
    });
    const result = await runCli(["traffic:bindings:import", "--file", file, "--write"]);
    expect(result.exitCode).toBe(1);
    expect(result.json().conflicts).toEqual([
      "link nope trial 1: unknown page nope",
      "link lora-1 trial 2: page lora-1 is fansly/active, not an active OnlyFans page",
      "link lora-vip-of trial 3: unknown channel lora.x (not in the file, not stored)",
    ]);
    const bad = await runCli(["traffic:bindings:import", "--file", await bindingsFile({ bindings: [{ page: "lora-vip-of" }] })]);
    expect(bad.exitCode).toBe(1);
    expect(bad.out).toMatch(/bindings\[0\]\.kind/);
    expect(await tableCounts()).toEqual({ contractors: 0, channels: 0, terms: 0, bindings: 0 });
  });

  it("warns about a link the series has not seen and an assumed start that is not the series' creation date", async () => {
    const run = await testDb!.pool.query<{ id: string }>(`
      insert into page_link_stat_runs (platform_account_id, link_kind, status, pulled_at, api_pages, raw_items, written_rows)
      values ($1, 'trial', 'complete', now(), 1, 1, 1) returning id::text as id`, [vipPageId]);
    await testDb!.pool.query(`
      insert into page_link_stat_snapshots (run_id, platform_account_id, link_kind, platform_link_id, name,
        link_created_at, clicks_count, subscribers_count)
      values ($1, $2, 'trial', '11213035', 'Instagram Farm', '2026-04-19T01:18:43Z', 1, 1)`, [run.rows[0]!.id, vipPageId]);
    const file = await bindingsFile({
      ...seed,
      bindings: [
        ...seed.bindings,
        { page: "lora-vip-of", kind: "trial", link: "11332533", channel: "lora.insta-farm", validFrom: "2026-06-06", validTo: "2026-09-30", validFromBasis: "assumed_link_created" },
      ],
    });
    // 11213035 is seen and its assumed start is the series' creation date: no
    // warning. 11170786 and 11332533 are not in this series at all.
    const result = await runCli(["traffic:bindings:import", "--file", file]);
    expect(result.json().warnings).toEqual([
      "link lora-vip-of trial 11170786: not seen in the link series (page_link_stat_snapshots)",
      "link lora-vip-of trial 11332533: not seen in the link series (page_link_stat_snapshots)",
    ]);
    await testDb!.pool.query(`
      update page_link_stat_snapshots set link_created_at = '2026-04-20T00:00:00Z' where platform_link_id = '11213035'`);
    const moved = await runCli(["traffic:bindings:import", "--file", file]);
    expect(moved.json().warnings).toContain(
      "link lora-vip-of trial 11213035: assumed_link_created from 2026-04-19T01:18:43.000Z, "
        + "the series says the link was created 2026-04-20T00:00:00.000Z",
    );
  });
});

describe("traffic:bindings:set", () => {
  it("re-hangs a link: the open binding closes at --from, the new one opens there; a repeat is a no-op", async () => {
    await runCli(["traffic:bindings:import", "--file", await bindingsFile(seed), "--write"]);
    await runCli(["traffic:bindings:import", "--file", await bindingsFile({ channels: [{ key: "lora.erome", title: "Erome" }] }), "--write"]);
    const audits = await trafficAuditCount();

    const dry = await runCli([
      "traffic:bindings:set", "--page", "lora-vip-of", "--kind", "trial", "--link", "11170786",
      "--channel", "lora.erome", "--from", "2026-10-01", "--dry-run",
    ]);
    expect(dry.json().written).toBe(false);
    expect(await trafficAuditCount()).toBe(audits);

    const set = await runCli([
      "traffic:bindings:set", "--page", "lora-vip-of", "--kind", "trial", "--link", "11170786",
      "--channel", "lora.erome", "--from", "2026-10-01", "--note", "moved to Erome",
    ]);
    expect(set.exitCode).toBe(0);
    expect(set.json().changes.linkBindings).toEqual([
      expect.objectContaining({ action: "close", before: expect.objectContaining({ target: "lora.porntoki", validTo: null }),
        after: expect.objectContaining({ target: "lora.porntoki", validTo: "2026-09-30T21:00:00.000Z" }) }),
      expect.objectContaining({ action: "create", after: expect.objectContaining({
        target: "lora.erome", validFrom: "2026-09-30T21:00:00.000Z", validTo: null, validFromBasis: "confirmed", note: "moved to Erome",
      }) }),
    ]);
    const rows = await testDb!.pool.query(`
      select c.key, b.valid_from, b.valid_to, b.valid_from_basis from traffic_link_bindings b
        join traffic_channels c on c.id = b.channel_id where b.platform_link_id = '11170786' order by b.valid_from`);
    expect(rows.rows).toEqual([
      { key: "lora.porntoki", valid_from: new Date("2026-03-31T21:00:00Z"), valid_to: new Date("2026-09-30T21:00:00Z"), valid_from_basis: "confirmed" },
      { key: "lora.erome", valid_from: new Date("2026-09-30T21:00:00Z"), valid_to: null, valid_from_basis: "confirmed" },
    ]);
    const events = await testDb!.pool.query(`
      select event_type, metadata->>'command' as command from audit_events where id > (
        select coalesce(max(id), 0) from audit_events where event_type = 'admin.traffic_channel_created' and metadata->>'key' = 'lora.erome')
      order by id`);
    expect(events.rows).toEqual([
      { event_type: "admin.traffic_link_binding_closed", command: "set" },
      { event_type: "admin.traffic_link_binding_created", command: "set" },
    ]);

    const repeat = await runCli([
      "traffic:bindings:set", "--page", "lora-vip-of", "--kind", "trial", "--link", "11170786",
      "--channel", "lora.erome", "--from", "2026-10-05",
    ]);
    expect(repeat.json().counts.linkBindings).toEqual({ unchanged: 1 });
    expect(await trafficAuditCount()).toBe(audits + 2);
  });

  it("refuses an earlier --from on a link the channel already has, instead of a silent no-op (review #512)", async () => {
    // The link is A's until Feb 1, then B's. `set B --from Jan 15` must not
    // succeed unchanged: Jan 15–31 would silently stay with A.
    await runCli(["traffic:bindings:import", "--file", await bindingsFile({
      channels: [{ key: "lora.a", title: "A" }, { key: "lora.b", title: "B" }],
      bindings: [
        { page: "lora-vip-of", kind: "trial", link: "777", channel: "lora.a", validFrom: "2026-01-01", validTo: "2026-02-01", validFromBasis: "confirmed" },
        { page: "lora-vip-of", kind: "trial", link: "777", channel: "lora.b", validFrom: "2026-02-01", validFromBasis: "confirmed" },
      ],
    }), "--write"]);
    const audits = await trafficAuditCount();
    const set = (from: string) => runCli([
      "traffic:bindings:set", "--page", "lora-vip-of", "--kind", "trial", "--link", "777", "--channel", "lora.b", "--from", from,
    ]);

    const earlier = await set("2026-01-15");
    expect(earlier.exitCode).toBe(1);
    expect(earlier.json()).toEqual({
      written: false,
      conflicts: [
        "link lora-vip-of trial 777: already lora.b only since 2026-01-31T21:00:00.000Z; "
          + "--from 2026-01-14T21:00:00.000Z is earlier — set does not move a stored start",
      ],
    });
    // The same start and a later one already hold: no-ops.
    expect((await set("2026-02-01")).json().counts.linkBindings).toEqual({ unchanged: 1 });
    expect((await set("2026-03-01")).json().counts.linkBindings).toEqual({ unchanged: 1 });
    expect(await trafficAuditCount()).toBe(audits);
    const rows = await testDb!.pool.query(`
      select c.key, b.valid_from, b.valid_to from traffic_link_bindings b
        join traffic_channels c on c.id = b.channel_id where b.platform_link_id = '777' order by b.valid_from`);
    expect(rows.rows).toEqual([
      { key: "lora.a", valid_from: new Date("2025-12-31T21:00:00Z"), valid_to: new Date("2026-01-31T21:00:00Z") },
      { key: "lora.b", valid_from: new Date("2026-01-31T21:00:00Z"), valid_to: null },
    ]);
  });

  it("refuses a --from that is not after the open binding's start, and a channel that does not exist", async () => {
    await runCli(["traffic:bindings:import", "--file", await bindingsFile(seed), "--write"]);
    await runCli(["traffic:bindings:import", "--file", await bindingsFile({ channels: [{ key: "lora.erome", title: "Erome" }] }), "--write"]);
    const early = await runCli([
      "traffic:bindings:set", "--page", "lora-vip-of", "--kind", "trial", "--link", "11170786",
      "--channel", "lora.erome", "--from", "2026-03-01",
    ]);
    expect(early.exitCode).toBe(1);
    expect(early.json().conflicts).toContainEqual(expect.stringMatching(/lora\.porntoki .* ends before it starts/));
    const unknown = await runCli([
      "traffic:bindings:set", "--page", "lora-vip-of", "--kind", "trial", "--link", "11170786",
      "--channel", "lora.nowhere", "--from", "2026-10-01",
    ]);
    expect(unknown.exitCode).toBe(1);
    // The closed farm link: a new channel from inside its closed interval overlaps it.
    const closed = await runCli([
      "traffic:bindings:set", "--page", "lora-vip-of", "--kind", "trial", "--link", "11213035",
      "--channel", "lora.erome", "--from", "2026-09-01",
    ]);
    expect(closed.exitCode).toBe(1);
    expect(closed.json().conflicts).toEqual([expect.stringMatching(/lora\.insta-farm .* overlaps lora\.erome/)]);
    const rows = await count("traffic_link_bindings where valid_to is null and platform_link_id = '11170786'");
    expect(rows).toBe(1);
  });
});

describe("two writers at once (П9.6)", () => {
  /** Resolves once another session of this database waits on an advisory
   *  lock, or once `otherDone()` says the other writer has finished anyway
   *  (it never waited: without the lock both would commit). */
  async function waitForAdvisoryWaiterOr(otherDone: () => boolean) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !otherDone()) {
      const waiting = await testDb!.pool.query<{ n: number }>(`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`);
      if (waiting.rows[0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const base: TrafficBindingsChangeSet = {
    contractors: [{ key: "coraline-red", title: "Coraline Red" }, { key: "dima-s", title: "Dima" }],
    channels: [{ key: "lora.a", title: "A" }, { key: "lora.b", title: "B" }],
    terms: [],
    bindings: [],
  };

  async function race(first: TrafficBindingsChangeSet, second: TrafficBindingsChangeSet) {
    let held = false;
    const settled = [false, false];
    // The first writer to hold its locks and pass its overlap check waits
    // there until the other one is queued on the same lock. Without the lock
    // the other one would not queue: it would check the same empty history,
    // write and commit, and so would this one — two bindings at one instant.
    const writer = (change: TrafficBindingsChangeSet, index: number) =>
      applyTrafficBindingsChange(testDb!.db, change, {
        write: true,
        actor: "test",
        command: "import",
        afterPlan: async () => {
          if (held) return;
          held = true;
          await waitForAdvisoryWaiterOr(() => settled[1 - index]!);
        },
      }).finally(() => {
        settled[index] = true;
      });
    return Promise.allSettled([writer(first, 0), writer(second, 1)]);
  }

  it("two imports of overlapping closed intervals of one link: one commits, the other ends in a conflict", async () => {
    await applyTrafficBindingsChange(testDb!.db, base, { write: true, actor: "test", command: "import" });
    const link = { pageLabel: "lora-vip-of", linkKind: "trial" as const, linkId: "11577238", validFromBasis: "confirmed" as const };
    const outcomes = await race(
      { ...base, contractors: [], channels: [], bindings: [{ ...link, channelKey: "lora.a", validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2026-01-10T00:00:00Z") }] },
      { ...base, contractors: [], channels: [], bindings: [{ ...link, channelKey: "lora.b", validFrom: new Date("2026-01-05T00:00:00Z"), validTo: new Date("2026-01-15T00:00:00Z") }] },
    );
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(TrafficBindingsConflictError);
    expect((rejected[0]!.reason as TrafficBindingsConflictError).conflicts).toEqual([expect.stringMatching(/overlaps/)]);
    expect(await count("traffic_link_bindings where platform_link_id = '11577238'")).toBe(1);
    expect(await count("audit_events where event_type = 'admin.traffic_link_binding_created'")).toBe(1);
  });

  it("two imports of overlapping contractor terms of one channel: one commits, the other ends in a conflict", async () => {
    await applyTrafficBindingsChange(testDb!.db, base, { write: true, actor: "test", command: "import" });
    const outcomes = await race(
      { ...base, contractors: [], channels: [], terms: [{ channelKey: "lora.a", contractorKey: "coraline-red", validFrom: new Date("2026-01-01T00:00:00Z"), validTo: new Date("2026-01-10T00:00:00Z"), validFromBasis: "confirmed" }] },
      { ...base, contractors: [], channels: [], terms: [{ channelKey: "lora.a", contractorKey: "dima-s", validFrom: new Date("2026-01-05T00:00:00Z"), validTo: null, validFromBasis: "assumed_link_created" }] },
    );
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected")!;
    expect(rejected.reason).toBeInstanceOf(TrafficBindingsConflictError);
    expect(await count("traffic_channel_contractors")).toBe(1);
  });
});
