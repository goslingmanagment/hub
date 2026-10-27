import { describe, expect, it } from "vitest";

import type { Database, SyncAttemptRow, SyncPageRow, SyncWorkRow } from "@agency_hub_core/db";
import { describeFanslyWrite } from "@agency_hub_core/fansly";
import type { AppConfig } from "@agency_hub_core/shared";

import type { ApplyInput, ApplyResult, PlanContext, RequestPlan, StepPlan } from "../apps/runtime/src/sync/engine/resource.ts";
import { diffFanSetList, FAN_SET_LIST_AFTER_CUT_MS, FAN_SET_LIST_RECHECK_MS } from "../apps/runtime/src/sync/fansly/lib/fan-set-list-rules.ts";
import {
  fanSetListsModule,
  parseFanSetListCursor,
  type FanSetListSet,
  type FanSetListStore,
} from "../apps/runtime/src/sync/fansly/resources/fan-set-lists.ts";

// Fan set lists (2026-10-28): the Fansly list Hub keeps equal to a page's
// cross-page spenders. The diff and its removal guard, and the sync's steps:
// one request a step, one attempt a write, a cut sync never re-sent but
// re-read and recomputed by the next one.

const db = {} as Database;
const T0 = new Date("2026-10-28T10:00:00.000Z");
const LIST = "971603845501181952";
const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(100_000 + from + i));

describe("the diff of a list and its set", () => {
  it("adds the set's fans the list lacks, in the set's order, and removes the rest, a fan added by hand too; a lookup miss is neither", () => {
    const diff = diffFanSetList({ members: ["1", "2", "9"], set: ["5", "1", "2", "7", "8"], ignored: ["8", "9"] });
    expect(diff.toAdd).toEqual(["5", "7"]);
    expect(diff.toRemove).toEqual([]);
    expect(diff.withheld).toBeNull();
    const handAdded = diffFanSetList({ members: ["1", "2", "3", "4"], set: ["1", "2", "4"] });
    expect(handAdded).toMatchObject({ toAdd: [], toRemove: ["3"], withheld: null, writes: [{ op: "remove", accountIds: ["3"] }] });
  });

  it("writes adds first, in batches", () => {
    const diff = diffFanSetList({ members: ids(0, 10), set: [...ids(0, 6), ...ids(1000, 120)], batch: 50 });
    expect(diff.writes.map((write) => [write.op, write.accountIds.length])).toEqual([["add", 50], ["add", 50], ["add", 20], ["remove", 4]]);
    expect(diff.writes[0]!.accountIds[0]).toBe(ids(1000, 1)[0]);
  });

  it("withholds every removal when the set comes back empty or would take more than half the list; the adds still go", () => {
    const empty = diffFanSetList({ members: ids(0, 2), set: [] });
    expect(empty).toMatchObject({ toRemove: ids(0, 2), withheld: "set_empty", writes: [] });
    const half = diffFanSetList({ members: ids(0, 10), set: [...ids(0, 4), "42"] });
    expect(half.toRemove).toHaveLength(6);
    expect(half.withheld).toBe("removes_over_half");
    expect(half.writes).toEqual([{ op: "add", accountIds: ["42"] }]);
    // Half exactly goes, and so does a small list's churn.
    expect(diffFanSetList({ members: ids(0, 10), set: ids(0, 5) }).withheld).toBeNull();
    expect(diffFanSetList({ members: ids(0, 4), set: ids(0, 1) })).toMatchObject({ withheld: null, toRemove: ids(1, 3) });
    expect(diffFanSetList({ members: ids(0, 4), set: [] }).withheld).toBe("set_empty");
  });
});

// ── the sync's steps ───────────────────────────────────────────────────────

type Attempt = Pick<SyncAttemptRow, "outcome" | "applyState" | "errorClass" | "httpStatus" | "request" | "operation">;

interface World {
  setting: string;
  canWrite: boolean;
  set: FanSetListSet;
  attempts: Map<number, Attempt>;
  work: { cursor: unknown; lastAttemptId: number | null };
}

function world(overrides: Partial<World> = {}): World {
  return {
    setting: JSON.stringify({ "lora-1": {} }),
    canWrite: true,
    set: { kind: "ok", accountIds: ["11", "12", "13"], lookupMisses: [] },
    attempts: new Map(),
    work: { cursor: {}, lastAttemptId: null },
    ...overrides,
  };
}

function storeOf(w: World): FanSetListStore {
  return {
    getAttempt: async (_db, id) => w.attempts.get(id) ?? null,
    getWork: async () => ({ pageId: 1, cursor: w.work.cursor, lastAttemptId: w.work.lastAttemptId }),
    pageLabel: async () => "lora-1",
    readSet: async () => w.set,
  };
}

const settings = (w: World) => ({ read: async () => ({ crossSpendersLists: w.setting }) as AppConfig });

function workOf(w: World): SyncWorkRow {
  return { id: 9, pageId: 1, resource: "fan-set-lists.sync", subject: "", cursor: w.work.cursor, lastAttemptId: w.work.lastAttemptId } as SyncWorkRow;
}

async function plan(w: World, now: Date): Promise<StepPlan> {
  const ctx: PlanContext = {
    db,
    pageId: 1,
    now,
    page: { pageId: 1, pageLabel: "lora-1" } as SyncPageRow,
    registry: {} as never,
    settings: settings(w),
    transportWrites: () => w.canWrite,
  };
  return fanSetListsModule(storeOf(w)).plan(workOf(w), ctx);
}

let attemptIds = 100;

/** The plan's request admitted: the row's last attempt is now its own. */
function admit(w: World, request: RequestPlan, outcome: Partial<Attempt> = {}): number {
  const id = ++attemptIds;
  w.attempts.set(id, { outcome: "admitted", applyState: "none", errorClass: null, httpStatus: null, request: { spec: request.spec, params: request.params, step: request.step }, operation: request.spec, ...outcome });
  w.work.lastAttemptId = id;
  return id;
}

/** Its 2xx answer applied: the row takes the step's cursor. */
async function answer(w: World, request: RequestPlan, response: unknown, now: Date): Promise<ApplyResult> {
  const id = admit(w, request, { outcome: "response", applyState: "applied", httpStatus: 200 });
  const input = {
    pageId: 1, now, ownRef: null, work: workOf(w), attempt: { id } as SyncAttemptRow, request, parsed: response, response,
    observation: { id: 1, receivedAt: now }, fenced: false, page: { pageId: 1, pageLabel: "lora-1" } as SyncPageRow,
  } satisfies ApplyInput;
  const result = await fanSetListsModule(storeOf(w)).apply(db, input);
  if (result.work.cursor !== undefined) w.work.cursor = result.work.cursor;
  return result;
}

async function local(w: World, step: StepPlan, now: Date): Promise<ApplyResult> {
  if (step.kind !== "local") throw new Error(`expected a local step, got ${step.kind}`);
  const result = await fanSetListsModule(storeOf(w)).applyLocal!(db, { pageId: 1, work: workOf(w), now, ownRef: null, plan: { reason: step.reason, detail: step.detail } });
  if (result.work.cursor !== undefined) w.work.cursor = result.work.cursor;
  return result;
}

function requestOf(step: StepPlan): RequestPlan {
  if (step.kind !== "request") throw new Error(`expected a request, got ${step.kind}: ${JSON.stringify(step)}`);
  return step.request;
}

const lists = (extra: unknown[] = []) => [{ id: "727366232164016128", accountId: "7", pos: null, type: 1, label: "Бомж", itemCount: 3 }, ...extra];
const ours = (itemCount: number) => ({ id: LIST, accountId: "7", pos: null, type: 1, label: "Спендеры других страниц · хаб", itemCount });
const items = (accounts: string[], from = 1) => accounts.map((id, i) => ({ id, sortId: String(900 + from + i), listId: LIST, type: 1, metadata: "" }));

describe("a page's list, step by step", () => {
  it("off: looks at the setting again in 10 minutes and sends nothing; a page that cannot write waits too", async () => {
    const off = await plan(world({ setting: "{}" }), T0);
    expect(off).toEqual({ kind: "wait", reason: "not_due", until: new Date(T0.getTime() + FAN_SET_LIST_RECHECK_MS) });
    expect(await plan(world({ canWrite: false }), T0)).toMatchObject({ kind: "wait", reason: "dependency" });
  });

  it("creates the list when the page has none, adds the set, and leaves its receipt", async () => {
    const w = world();
    const lists1 = requestOf(await plan(w, T0));
    expect(lists1).toMatchObject({ spec: "lists.account", params: {}, step: { phase: "lists", cycle: 1 } });
    await answer(w, lists1, lists(), T0);
    const create = requestOf(await plan(w, T0));
    expect(create).toMatchObject({ spec: "lists.create", params: { label: "Спендеры других страниц · хаб" } });
    await answer(w, create, { accountId: "7", type: 1, label: "Спендеры других страниц · хаб", id: LIST }, T0);
    const add = requestOf(await plan(w, T0));
    expect(add).toMatchObject({ spec: "lists.add", params: { listId: LIST, accountIds: ["11", "12", "13"] } });
    const done = await answer(w, add, items(["11", "12", "13"]).map(({ sortId: _, ...item }) => item), T0);
    expect(done.work.result).toMatchObject({
      cycle: 1, outcome: "synced", reason: null, listRef: LIST, created: true, sizeBefore: 0, sizeAfter: 3, setSize: 3, added: 3, removed: 0, withheld: null,
    });
    const cursor = parseFanSetListCursor(w.work.cursor);
    expect(cursor).toMatchObject({ cycles: 1, list: { listRef: LIST, label: "Спендеры других страниц · хаб" }, cycle: null });
    // In sync: the next one in about 6 hours, the setting looked at meanwhile.
    expect(await plan(w, new Date(T0.getTime() + 60_000))).toMatchObject({ kind: "wait", reason: "not_due" });
  });

  it("walks the list it stored, removes whom the set lost (a hand-added fan too) and adds whom it gained", async () => {
    const w = world({ work: { cursor: { cycles: 4, list: { listRef: LIST, label: "Спендеры других страниц · хаб" } }, lastAttemptId: null } });
    // Another list carries the label: the stored one is Hub's.
    await answer(w, requestOf(await plan(w, T0)), lists([ours(4), { ...ours(9), id: "555" }]), T0);
    const page1 = requestOf(await plan(w, T0));
    expect(page1).toMatchObject({ spec: "lists.items", params: { listId: LIST, after: null }, step: { phase: "items", cycle: 5 } });
    await answer(w, page1, items(["11", "77", "12"]), T0);
    const page2 = requestOf(await plan(w, T0));
    expect(page2.params).toEqual({ listId: LIST, after: "903" });
    await answer(w, page2, items(["88"], 10), T0);
    await answer(w, requestOf(await plan(w, T0)), [], T0);
    const add = requestOf(await plan(w, T0));
    expect(add).toMatchObject({ spec: "lists.add", params: { accountIds: ["13"] } });
    await answer(w, add, [{ id: "13", listId: LIST, type: 1, metadata: "" }], T0);
    const remove = requestOf(await plan(w, T0));
    expect(remove).toMatchObject({ spec: "lists.remove", params: { listId: LIST, accountIds: ["77", "88"] } });
    const done = await answer(w, remove, ["77", "88"], T0);
    expect(done.work.result).toMatchObject({ cycle: 5, outcome: "synced", created: false, sizeBefore: 4, sizeAfter: 3, added: 1, removed: 2 });
  });

  it("never sends a write twice: one under way waits, one that may have gone cuts the sync, and the next sync re-reads and recomputes", async () => {
    const w = world({ work: { cursor: { cycles: 0, list: { listRef: LIST, label: "Спендеры других страниц · хаб" } }, lastAttemptId: null } });
    await answer(w, requestOf(await plan(w, T0)), lists([ours(0)]), T0);
    await answer(w, requestOf(await plan(w, T0)), [], T0);
    // A browser that cannot take the write now: the sync waits, nothing goes.
    w.canWrite = false;
    expect(await plan(w, T0)).toMatchObject({ kind: "wait", reason: "dependency" });
    w.canWrite = true;
    const add = requestOf(await plan(w, T0));
    admit(w, add);
    expect(await plan(w, T0)).toMatchObject({ kind: "wait", reason: "dependency" });
    admit(w, add, { outcome: "timeout" });
    const cutStep = await plan(w, T0);
    expect(cutStep).toMatchObject({ kind: "local", detail: { cycle: 1, reason: "write_unknown:timeout" } });
    const cut = await local(w, cutStep, T0);
    expect(cut.work.result).toMatchObject({ outcome: "cut", reason: "write_unknown:timeout", added: 0, sizeAfter: null });
    // Nothing is planned again until the next sync, an hour later, which starts from the lists.
    expect(await plan(w, new Date(T0.getTime() + 30 * 60_000))).toMatchObject({ kind: "wait", reason: "not_due" });
    const again = requestOf(await plan(w, new Date(T0.getTime() + FAN_SET_LIST_AFTER_CUT_MS)));
    expect(again).toMatchObject({ spec: "lists.account", step: { phase: "lists", cycle: 2 } });
  });

  it("a write the page's browser would not let go, or an error answer, cuts the sync the same way", async () => {
    for (const [outcome, reason] of [
      [{ outcome: "aborted_before_send", errorClass: "not_sent:write_refused" }, "write_not_sent:not_sent:write_refused"],
      [{ outcome: "response", applyState: "none", httpStatus: 400 }, "write_failed:400"],
    ] as const) {
      const w = world({ work: { cursor: { cycles: 0, list: { listRef: LIST, label: "Спендеры других страниц · хаб" } }, lastAttemptId: null } });
      await answer(w, requestOf(await plan(w, T0)), lists([ours(0)]), T0);
      await answer(w, requestOf(await plan(w, T0)), [], T0);
      admit(w, requestOf(await plan(w, T0)), outcome);
      expect(await plan(w, T0)).toMatchObject({ kind: "local", detail: { reason } });
    }
  });

  it("an indeterminate create is never sent again: the next sync finds the list by its label", async () => {
    const w = world();
    await answer(w, requestOf(await plan(w, T0)), lists(), T0);
    admit(w, requestOf(await plan(w, T0)), { outcome: "transport_error" });
    await local(w, await plan(w, T0), T0);
    expect(parseFanSetListCursor(w.work.cursor).last).toMatchObject({ outcome: "cut", reason: "write_unknown:transport_error", listRef: null });
    const later = new Date(T0.getTime() + FAN_SET_LIST_AFTER_CUT_MS);
    await answer(w, requestOf(await plan(w, later)), lists([ours(0)]), later);
    expect(requestOf(await plan(w, later))).toMatchObject({ spec: "lists.items", params: { listId: LIST } });
    expect(parseFanSetListCursor(w.work.cursor).list).toEqual({ listRef: LIST, label: "Спендеры других страниц · хаб" });
  });

  it("two lists under its label and none stored: Hub takes neither", async () => {
    const w = world();
    const result = await answer(w, requestOf(await plan(w, T0)), lists([ours(1), { ...ours(2), id: "555" }]), T0);
    expect(result.work.result).toMatchObject({ outcome: "cut", reason: "label_ambiguous" });
  });

  it("a removal the guard withholds is in the receipt, and the adds still went", async () => {
    const w = world({
      set: { kind: "ok", accountIds: ["11"], lookupMisses: [] },
      work: { cursor: { cycles: 0, list: { listRef: LIST, label: "Спендеры других страниц · хаб" } }, lastAttemptId: null },
    });
    await answer(w, requestOf(await plan(w, T0)), lists([ours(6)]), T0);
    await answer(w, requestOf(await plan(w, T0)), items(["21", "22", "23", "24", "25", "26"]), T0);
    await answer(w, requestOf(await plan(w, T0)), [], T0);
    const add = requestOf(await plan(w, T0));
    const done = await answer(w, add, [{ id: "11", listId: LIST, type: 1, metadata: "" }], T0);
    expect(done.work.result).toMatchObject({ outcome: "synced", sizeBefore: 6, sizeAfter: 7, added: 1, removed: 0, withheld: "removes_over_half", withheldRemovals: 6 });
  });

  it("a setting changed mid-sync cuts it, and the new one starts at once", async () => {
    const w = world();
    await answer(w, requestOf(await plan(w, T0)), lists([ours(0)]), T0);
    w.setting = JSON.stringify({ "lora-1": { minSourceSpendMills: 5000 } });
    const step = await plan(w, T0);
    expect(step).toMatchObject({ kind: "local", detail: { reason: "settings_changed" } });
    await local(w, step, T0);
    expect(requestOf(await plan(w, T0))).toMatchObject({ spec: "lists.account", step: { cycle: 2, settings: { minSourceSpendMills: 5000 } } });
  });

  it("the page's browser lets a write go only while it is still the row's next one, under the same setting", async () => {
    const w = world({ work: { cursor: { cycles: 0, list: { listRef: LIST, label: "Спендеры других страниц · хаб" } }, lastAttemptId: null } });
    await answer(w, requestOf(await plan(w, T0)), lists([ours(0)]), T0);
    await answer(w, requestOf(await plan(w, T0)), [], T0);
    const add = requestOf(await plan(w, T0));
    const attemptId = admit(w, add);
    const fingerprint = describeFanslyWrite("lists.add", add.params as never).fingerprint;
    const module = fanSetListsModule(storeOf(w));
    const confirm = (input: { attemptId: number; writeFingerprint: string }) => module.confirmWrite!(db, workOf(w), { ...input, settings: settings(w) });
    expect(await confirm({ attemptId, writeFingerprint: fingerprint })).toBeNull();
    expect(await confirm({ attemptId, writeFingerprint: "f".repeat(64) })).toBe("fingerprint_mismatch");
    expect(await confirm({ attemptId: attemptId + 1, writeFingerprint: fingerprint })).toBe("attempt_not_current");
    w.setting = "{}";
    expect(await confirm({ attemptId, writeFingerprint: fingerprint })).toBe("list_off");
  });
});
