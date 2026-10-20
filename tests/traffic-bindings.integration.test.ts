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
});
