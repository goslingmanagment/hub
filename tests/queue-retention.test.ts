import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUSINESS_CRON_MIN_RETENTION_SECONDS,
  DEFAULT_DELETE_AFTER_SECONDS,
  DEFAULT_RETENTION_SECONDS,
  HEARTBEAT_RETENTION_SECONDS,
  QUEUE_RETENTION_SETTINGS,
} from "../apps/runtime/src/services/queue-retention.ts";
import {
  RETIRED_QUEUES,
  RETIRED_SCHEDULES,
  reconcileQueueRetention,
  retireRemovedQueues,
} from "../apps/runtime/src/services/sync-queue.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSourceRoot = path.join(repoRoot, "apps/runtime/src");

async function collectTypeScriptSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptSources(full);
    }
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  }));
  return files.flat();
}

/**
 * Every `export const *_QUEUE = "..."` declared in the runtime, keyed by the
 * literal queue name. Read statically so this pin needs no module graph.
 */
async function readDeclaredQueueNames(): Promise<Map<string, string>> {
  const sources = await collectTypeScriptSources(runtimeSourceRoot);
  const declared = new Map<string, string>();
  for (const file of sources) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/export const (\w*_QUEUE) = "([^"]+)"/g)) {
      declared.set(match[2]!, match[1]!);
    }
  }
  return declared;
}

interface StoredRetention {
  retentionSeconds: number;
  deleteAfterSeconds: number;
}

const LIBRARY_DEFAULTS: StoredRetention = {
  retentionSeconds: DEFAULT_RETENTION_SECONDS,
  deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS,
};

/**
 * A pg-boss stand-in that models the two behaviours this reconcile depends on:
 * `updateQueue` matches ZERO rows for a queue that does not exist, and
 * COALESCEs each supplied field over what is stored (`plans.js:533`).
 */
function createQueueStore(options?: {
  /** Names that already exist, on library defaults. */
  existing?: readonly string[];
  /** Model the race: the first read of a name finds it just-created. */
  createOnFirstRead?: boolean;
  /** Model a broken backend: updates never land. */
  swallowUpdates?: boolean;
}) {
  const stored = new Map<string, StoredRetention>(
    (options?.existing ?? []).map((name) => [name, { ...LIBRARY_DEFAULTS }]),
  );
  const updates: Array<{ queue: string; payload: Record<string, unknown> }> = [];
  const read = new Set<string>();

  return {
    stored,
    updates,
    boss: {
      createQueue: async () => undefined,
      updateQueue: async (queue: string, payload: Record<string, unknown>) => {
        updates.push({ queue, payload });
        const current = stored.get(queue);
        if (!current || options?.swallowUpdates) {
          return;
        }
        stored.set(queue, {
          retentionSeconds: (payload.retentionSeconds as number | undefined) ?? current.retentionSeconds,
          deleteAfterSeconds: (payload.deleteAfterSeconds as number | undefined) ?? current.deleteAfterSeconds,
        });
      },
      getQueue: async (queue: string) => {
        if (options?.createOnFirstRead && !read.has(queue)) {
          read.add(queue);
          stored.set(queue, { ...LIBRARY_DEFAULTS });
        }
        const current = stored.get(queue);
        return current ? { name: queue, ...current } : null;
      },
    },
  };
}

describe("reconcileQueueRetention", () => {
  it("skips queues this role never created instead of calling them drift", async () => {
    const store = createQueueStore();

    await expect(reconcileQueueRetention(store.boss as never)).resolves.toBeUndefined();
    expect(store.stored.size).toBe(0);
  });

  it("sends only the retention whitelist, never policy or partition", async () => {
    // pg-boss THROWS on either key (manager.js:677-683), so a reused creation
    // options object would take a role's boot down.
    const store = createQueueStore({
      existing: QUEUE_RETENTION_SETTINGS.map((setting) => setting.queue),
    });

    await reconcileQueueRetention(store.boss as never);

    expect(store.updates).toHaveLength(QUEUE_RETENTION_SETTINGS.length);
    for (const update of store.updates) {
      expect(Object.keys(update.payload).sort().join(","))
        .toMatch(/^(deleteAfterSeconds,retentionSeconds|retentionSeconds)$/);
    }

    const deadLetterUpdates = store.updates.filter((update) => update.queue.endsWith(".dlq"));
    expect(deadLetterUpdates).toHaveLength(2);
    for (const update of deadLetterUpdates) {
      expect(update.payload).not.toHaveProperty("deleteAfterSeconds");
    }
  });

  it("retries once when a concurrent role creates the queue mid-reconcile", async () => {
    // Roles boot together against one database: another role can CREATE a
    // queue, with library defaults, between our zero-row UPDATE and our read.
    const store = createQueueStore({ createOnFirstRead: true });

    await expect(reconcileQueueRetention(store.boss as never)).resolves.toBeUndefined();

    for (const setting of QUEUE_RETENTION_SETTINGS) {
      expect(store.stored.get(setting.queue)?.retentionSeconds, setting.queue)
        .toBe(setting.retentionSeconds);

      // Only a queue whose pinned value DIFFERS from the library defaults reads
      // back as drift after losing the race, so only those retry. The rest are
      // pinned at the defaults precisely so an upgrade cannot move them.
      const writes = store.updates.filter((update) => update.queue === setting.queue);
      expect(writes, setting.queue).toHaveLength(
        setting.retentionSeconds === DEFAULT_RETENTION_SECONDS ? 1 : 2,
      );
    }

    expect(store.updates.length).toBeGreaterThan(QUEUE_RETENTION_SETTINGS.length);
  });

  it("fails closed when retention is still wrong after the retry", async () => {
    const store = createQueueStore({ existing: ["sync.planner"], swallowUpdates: true });

    await expect(reconcileQueueRetention(store.boss as never))
      .rejects.toThrow(/Queue sync\.planner retention drift/);
  });

  it("is called only after a role has finished creating its queues", async () => {
    // updateQueue matches zero rows for a queue that does not exist yet, so
    // reconciling before the last ensure*Queues call would silently leave the
    // queues created afterwards on library defaults.
    for (const file of [
      "apps/runtime/src/api/server.ts",
      "apps/runtime/src/worker-services.ts",
      "apps/runtime/src/services/schedules.ts",
    ]) {
      const text = await readFile(path.join(repoRoot, file), "utf8");
      const reconcileAt = text.indexOf("await reconcileQueueRetention(boss)");
      expect(reconcileAt, `${file} never reconciles retention`).toBeGreaterThan(-1);

      const ensureCalls = [...text.matchAll(/await ensure\w*Queues?\(boss/g)];
      expect(ensureCalls.length, `${file} creates no queues`).toBeGreaterThan(0);
      expect(ensureCalls.at(-1)!.index, `${file} reconciles before its last ensure`)
        .toBeLessThan(reconcileAt);
    }
  });
});

describe("pg-boss queue retention settings", () => {
  it("names only queues the runtime actually declares, and classifies all of them", async () => {
    // The table carries literals (it must stay a leaf module — see its header),
    // so this is the pin that keeps them honest in BOTH directions: no invented
    // name, and no new queue that quietly inherits library defaults.
    const declared = await readDeclaredQueueNames();
    expect(declared.size).toBeGreaterThan(20);

    const pinned = QUEUE_RETENTION_SETTINGS.map((setting) => setting.queue);
    expect([...pinned].sort()).toEqual([...declared.keys()].sort());
  });

  it("lists every queue exactly once", () => {
    const names = QUEUE_RETENTION_SETTINGS.map((setting) => setting.queue);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps heartbeat crons at 24h and gives them a deletion clock", () => {
    const heartbeats = QUEUE_RETENTION_SETTINGS
      .filter((setting) => setting.retentionClass === "heartbeat-cron");
    expect(heartbeats.length).toBeGreaterThan(0);
    for (const setting of heartbeats) {
      expect(setting.retentionSeconds).toBe(HEARTBEAT_RETENTION_SECONDS);
      expect(setting.deleteAfterSeconds).toBe(HEARTBEAT_RETENTION_SECONDS);
    }
  });

  it("pins work queues to the library defaults so an upgrade cannot move them", () => {
    const work = QUEUE_RETENTION_SETTINGS.filter((setting) => setting.retentionClass === "work");
    expect(work.length).toBeGreaterThan(0);
    for (const setting of work) {
      expect(setting.retentionSeconds).toBe(DEFAULT_RETENTION_SECONDS);
      expect(setting.deleteAfterSeconds).toBe(DEFAULT_DELETE_AFTER_SECONDS);
    }
  });

  it("never shortens a business cron below the outage floor", () => {
    // A queued tick is DISCARDED once keep_until passes. Retention shorter than
    // a plausible outage would silently drop a daily run — for the observations
    // partition creator that is an incident.
    const crons = QUEUE_RETENTION_SETTINGS
      .filter((setting) => setting.retentionClass === "business-cron");
    expect(crons.length).toBeGreaterThan(0);
    for (const setting of crons) {
      expect(setting.retentionSeconds).toBeGreaterThanOrEqual(BUSINESS_CRON_MIN_RETENTION_SECONDS);
      expect(setting.deleteAfterSeconds).toBe(DEFAULT_DELETE_AFTER_SECONDS);
    }
  });

  it("leaves dead letters on retention alone, with no deletion clock", () => {
    const deadLetters = QUEUE_RETENTION_SETTINGS
      .filter((setting) => setting.retentionClass === "dead-letter");
    expect(deadLetters.map((setting) => setting.queue))
      .toEqual(["sync.planner.dlq", "sync.page.execute.dlq"]);
    for (const setting of deadLetters) {
      // Unchanged from what these queues already carry explicitly.
      expect(setting.retentionSeconds).toBe(1_209_600);
      // DLQ rows are never fetched, so completed_on stays NULL and a deletion
      // clock could never fire — declaring one would read like a policy.
      expect(setting.deleteAfterSeconds).toBeUndefined();
    }
  });
});

describe("retired pg-boss objects", () => {
  function createRetirementBoss(existing: readonly string[]) {
    const present = new Set(existing);
    const unscheduled: string[] = [];
    const deleted: string[] = [];
    return {
      unscheduled,
      deleted,
      boss: {
        unschedule: async (name: string) => { unscheduled.push(name); },
        getQueue: async (name: string) => (present.has(name) ? { name } : null),
        deleteQueue: async (name: string) => { present.delete(name); deleted.push(name); },
      },
    };
  }

  it("names only queues nothing declares any more", async () => {
    // The mirror of the retention pin above: a live queue must never be listed
    // here, or a scheduler boot would delete the queue it is about to use.
    const declared = await readDeclaredQueueNames();
    const pinned = new Set(QUEUE_RETENTION_SETTINGS.map((setting) => setting.queue));
    for (const name of [...RETIRED_QUEUES, ...RETIRED_SCHEDULES]) {
      expect(declared.has(name), `${name} is still a declared queue`).toBe(false);
      expect(pinned.has(name), `${name} is still pinned in the retention table`).toBe(false);
    }
    expect(RETIRED_QUEUES).toContain("projections.debt.sweep");
    // A cron fires into its queue: retiring the queue without its cron would
    // leave the timekeeper sending into nothing.
    for (const name of RETIRED_SCHEDULES) {
      expect(RETIRED_QUEUES, name).toContain(name);
    }
  });

  it("unschedules the cron keys and deletes only the queues that still exist", async () => {
    const store = createRetirementBoss(["projections.debt.sweep", "sync.planner"]);
    await retireRemovedQueues(store.boss);

    expect(store.unscheduled).toEqual([...RETIRED_SCHEDULES]);
    expect(store.deleted).toEqual(["projections.debt.sweep"]);
  });

  it("is a no-op on the second run, so every leader takeover can repeat it", async () => {
    const store = createRetirementBoss([...RETIRED_QUEUES]);
    await retireRemovedQueues(store.boss);
    expect(store.deleted).toEqual([...RETIRED_QUEUES]);

    store.deleted.length = 0;
    await retireRemovedQueues(store.boss);
    expect(store.deleted).toEqual([]);
  });

  it("the scheduler retires before it reconciles retention and registers the live crons", async () => {
    const text = await readFile(path.join(repoRoot, "apps/runtime/src/services/schedules.ts"), "utf8");
    const retireAt = text.indexOf("await retireRemovedQueues(boss)");
    expect(retireAt).toBeGreaterThan(-1);
    expect(retireAt).toBeLessThan(text.indexOf("await reconcileQueueRetention(boss)"));
    // Best effort: a failure to retire never keeps the live schedules from registering.
    expect(text.slice(text.lastIndexOf("try {", retireAt), retireAt)).toMatch(/try \{\s*$/);
  });
});
