import type * as ReactModule from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelApiError } from "@agency_hub_core/contracts";

// Actual admission/storage handlers; remount creates fresh hook state while
// retaining this tab's storage. DOM and focus are checked in the browser pass.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => unknown> }));
vi.mock("react", async original => ({
  ...await original<typeof ReactModule>(),
  useState(initial: unknown) {
    const values = hooks.values;
    const index = hooks.cursor++;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (next: unknown) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
}));

import { collectionJobStorageKey, restoreCollectionJobLaunch, useCollectionJobCustody } from "../apps/dashboard/src/pages/settings/collection/collectionJobCustody.ts";
import { emptyDraft, draftKey, removeAppliedChanges } from "../apps/dashboard/src/pages/settings/collection/collectionModel.ts";

const body = { pageId: 7, category: "visitors" as const, expectedRevision: 3, maxCredits: 7, maxCalls: 5, maxBytes: 1000, from: null, to: null, selection: ["selected-1"] };
let saved: Map<string, string>;
let failWrite = false;
function render(ownerId = 1) { hooks.cursor = 0; return useCollectionJobCustody(ownerId); }
function remount(ownerId = 1) { hooks.values = []; return render(ownerId); }

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; saved = new Map(); failWrite = false;
  const events = new EventTarget();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { if (failWrite) throw new Error("Unavailable"); saved.set(key, value); },
      removeItem: (key: string) => saved.delete(key),
    },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("collection job admission and custody", () => {
  it("persists the exact request before sending and blocks synchronous clicks and a remounted page", async () => {
    let resolve!: (value: { id: string; state: "queued" }) => void;
    const send = vi.fn(() => new Promise<{ id: string; state: "queued" }>(done => { resolve = done; }));
    const first = render();
    const pending = first.submit(body, "original-page", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(restoreCollectionJobLaunch(saved.get(collectionJobStorageKey(1))!, 1)).toMatchObject({ body, pageLabel: "original-page", phase: "uncertain" });
    await first.submit({ ...body, pageId: 8 }, "other-page", send);
    const next = remount();
    expect(next.blocked).toBe(true);
    await next.submit(body, "original-page", send);
    next.dismiss();
    expect(send).toHaveBeenCalledTimes(1);
    expect(saved.has(collectionJobStorageKey(1))).toBe(true);
    resolve({ id: "confirmed-job", state: "queued" });
    await pending;
    expect(remount()).toMatchObject({ blocked: false, launch: { phase: "confirmed", jobId: "confirmed-job", body } });
  });

  it("never replays an unknown outcome and keeps it separate from another owner", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Response lost"));
    await render().submit(body, "original-page", send);
    const restored = remount();
    expect(restored.launch?.phase).toBe("uncertain");
    await restored.submit(body, "original-page", send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(remount(2).launch).toBeNull();
    expect(() => restoreCollectionJobLaunch(saved.get(collectionJobStorageKey(1))!, 2)).toThrow();
  });

  it("permits only an acknowledged separate intent and keeps a late original receipt in history", async () => {
    let resolve!: (value: { id: string; state: "queued" }) => void;
    const send = vi.fn(() => new Promise<{ id: string; state: "queued" }>(done => { resolve = done; }));
    const first = render().submit(body, "original-page", send);
    const restored = remount();
    expect(restored.allowSeparateJob(false)).toBe(false);
    expect(restored.allowSeparateJob(true)).toBe(true);
    const separate = vi.fn().mockResolvedValue({ id: "separate-job", state: "queued" });
    await render().submit({ ...body, pageId: 8 }, "other-page", separate);
    resolve({ id: "original-job", state: "queued" });
    await first;
    const final = remount();
    expect(final.launch).toMatchObject({ pageLabel: "other-page", jobId: "separate-job" });
    expect(final.history).toMatchObject([{ pageLabel: "original-page", body, jobId: "original-job", phase: "confirmed" }]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(separate).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade a receipt that arrives between remount render and its recovery effect", async () => {
    let resolve!: (value: { id: string; state: "queued" }) => void;
    const first = render().submit(body, "original-page", () => new Promise(done => { resolve = done; }));
    remount();
    const effect = hooks.effects.at(-1)!;
    resolve({ id: "late-receipt", state: "queued" });
    await first;
    const cleanup = effect() as () => void;
    expect(render().launch).toMatchObject({ phase: "confirmed", jobId: "late-receipt" });
    cleanup();
  });

  it("allows an explicit correction after a definite refusal without discarding the submitted parameters", async () => {
    const send = vi.fn().mockRejectedValueOnce(new KernelApiError("Revision changed", "conflict", 409, "conflict", null))
      .mockResolvedValueOnce({ id: "corrected-job", state: "queued" });
    await render().submit(body, "original-page", send);
    expect(remount()).toMatchObject({ blocked: false, launch: { phase: "refused", body } });
    await render().submit({ ...body, expectedRevision: 4 }, "original-page", send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(remount().launch?.jobId).toBe("corrected-job");
  });

  it("refuses admission when storage cannot retain the request or an older record is corrupt", async () => {
    const send = vi.fn();
    failWrite = true;
    await render().submit(body, "original-page", send);
    expect(send).not.toHaveBeenCalled();
    expect(render().storageError).toContain("Отправка не началась");
    failWrite = false;
    saved.set(collectionJobStorageKey(1), "not-json");
    expect(remount().blocked).toBe(true);
    await render().submit(body, "original-page", send);
    expect(send).not.toHaveBeenCalled();
  });
});

it("a late policy apply consumes only matching entries and preserves later edits", () => {
  const applied = { pageId: 7, category: "visitors" as const, mode: "scheduled" as const, intervalMinutes: 60, dailyCreditLimit: 7, maxCallsPerRun: 5, includeDetails: false };
  const original = { ...emptyDraft(3, { kind: "page", pageId: 7 }), entries: { [draftKey(7, "visitors")]: { base: null, settings: applied } } };
  const changed = { ...original, entries: { ...original.entries, [draftKey(7, "visitors")]: { base: null, settings: { ...applied, dailyCreditLimit: 9 } } } };
  expect(removeAppliedChanges(original, { expectedRevision: 3, changes: [applied] })).toBeNull();
  expect(removeAppliedChanges(changed, { expectedRevision: 3, changes: [applied] })?.entries[draftKey(7, "visitors")]?.settings.dailyCreditLimit).toBe(9);
});
