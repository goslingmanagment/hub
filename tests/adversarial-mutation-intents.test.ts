import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MutationObserver,
  QueryClient,
  onlineManager,
  type MutationObserverOptions,
} from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

const sdk = vi.hoisted(() => ({
  createFanNote: vi.fn(),
  workboardV2Contact: vi.fn(),
  workboardV2Snooze: vi.fn(),
  workboardV2UndoContact: vi.fn(),
  workboardV2Unsnooze: vi.fn(),
  workboardV2Recompute: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

import { createFanNoteMutationOptions } from "../apps/dashboard/src/api/pages.ts";
import {
  workboardContactMutationOptions,
  workboardRecomputeMutationOptions,
  workboardSnoozeMutationOptions,
  workboardUndoContactMutationOptions,
  workboardUnsnoozeMutationOptions,
} from "../apps/dashboard/src/api/workboard.ts";
import { createWorkboardUndoReceipt } from "../apps/dashboard/src/pages/daily/workboardUndo.ts";
import { fanNoteDraftsReducer, type FanNoteDraftState } from "../apps/dashboard/src/pages/daily/fanNoteDrafts.ts";

const clients: QueryClient[] = [];
function makeClient() {
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  clients.push(client);
  return client;
}

beforeEach(() => {
  onlineManager.setOnline(true);
  for (const fn of Object.values(sdk)) fn.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => {
  onlineManager.setOnline(true);
  for (const client of clients.splice(0)) client.clear();
});

// Use the installed observer, including its offline first-attempt queue and
// setOptions behavior. The SDK boundary is synthetic; no HTTP is performed.
async function resumeAfterRerender<TData, TVariables>(
  client: QueryClient,
  options: (client: QueryClient) => MutationObserverOptions<TData, Error, TVariables, unknown>,
  variables: TVariables,
) {
  onlineManager.setOnline(false);
  const observer = new MutationObserver(client, options(client));
  const unsubscribe = observer.subscribe(() => {});
  try {
    const result = observer.mutate(variables);
    await Promise.resolve();
    expect(observer.getCurrentResult().isPaused).toBe(true);
    // React useMutation invokes this when a new route render supplies options.
    observer.setOptions(options(client));
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
    await result;
  } finally {
    unsubscribe();
  }
}

function cacheBoards(client: QueryClient) {
  client.setQueryData(["workboard-v2", "page-a"], { fanId: 10 });
  client.setQueryData(["workboard-v2", "page-b"], { fanId: 20 });
}
function expectOriginalBoardInvalidated(client: QueryClient) {
  expect(client.getQueryState(["workboard-v2", "page-a"])?.isInvalidated).toBe(true);
  expect(client.getQueryState(["workboard-v2", "page-b"])?.isInvalidated).toBe(false);
}

describe("mutation targets survive an offline route change", () => {
  it("posts a queued note to the reviewed page and fan and invalidates only that profile", async () => {
    const client = makeClient();
    client.setQueryData(["pageFanDetail", "page-a", "fan-a"], { notes: [] });
    client.setQueryData(["pageFanDetail", "page-b", "fan-b"], { notes: [] });
    await resumeAfterRerender(client, createFanNoteMutationOptions, {
      pageLabel: "page-a", platformUserId: "fan-a", body: "Reviewed for A",
    });
    expect(sdk.createFanNote).toHaveBeenCalledExactlyOnceWith({
      params: { pageLabel: "page-a", platformUserId: "fan-a" }, body: { body: "Reviewed for A" },
    });
    expect(client.getQueryState(["pageFanDetail", "page-a", "fan-a"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["pageFanDetail", "page-b", "fan-b"])?.isInvalidated).toBe(false);
  });

  it("keeps the contact page in the intent", async () => {
    const client = makeClient(); cacheBoards(client);
    await resumeAfterRerender(client, workboardContactMutationOptions, {
      pageLabel: "page-a", fanId: 10, action: "handled", wasProductive: true,
    });
    expect(sdk.workboardV2Contact).toHaveBeenCalledExactlyOnceWith({
      params: { pageLabel: "page-a" }, body: { fanId: 10, action: "handled", wasProductive: true },
    });
    expectOriginalBoardInvalidated(client);
  });

  it("keeps the snooze page and duration in the intent", async () => {
    const client = makeClient(); cacheBoards(client);
    await resumeAfterRerender(client, workboardSnoozeMutationOptions, { pageLabel: "page-a", fanId: 10, days: 3 });
    expect(sdk.workboardV2Snooze).toHaveBeenCalledExactlyOnceWith({ params: { pageLabel: "page-a" }, body: { fanId: 10, days: 3 } });
    expectOriginalBoardInvalidated(client);
  });

  it("keeps a queued contact undo on its original page", async () => {
    const client = makeClient(); cacheBoards(client);
    await resumeAfterRerender(client, workboardUndoContactMutationOptions, { pageLabel: "page-a", fanId: 10 });
    expect(sdk.workboardV2UndoContact).toHaveBeenCalledExactlyOnceWith({ params: { pageLabel: "page-a", fanId: 10 } });
    expectOriginalBoardInvalidated(client);
  });

  it("keeps a queued unsnooze on its original page", async () => {
    const client = makeClient(); cacheBoards(client);
    await resumeAfterRerender(client, workboardUnsnoozeMutationOptions, { pageLabel: "page-a", fanId: 10 });
    expect(sdk.workboardV2Unsnooze).toHaveBeenCalledExactlyOnceWith({ params: { pageLabel: "page-a", fanId: 10 } });
    expectOriginalBoardInvalidated(client);
  });

  it("keeps recompute scoped to the requested page", async () => {
    const client = makeClient(); cacheBoards(client);
    await resumeAfterRerender(client, workboardRecomputeMutationOptions, { pageLabel: "page-a" });
    expect(sdk.workboardV2Recompute).toHaveBeenCalledExactlyOnceWith({ params: { pageLabel: "page-a" } });
    expectOriginalBoardInvalidated(client);
  });
});

describe("one attempt per Undo receipt", () => {
  it("cannot retract an earlier contact after a committed undo loses its reply and a GET succeeds", async () => {
    const client = makeClient();
    const remainingContacts = ["earlier-contact", "reviewed-contact"];
    sdk.workboardV2UndoContact.mockImplementation(async () => {
      remainingContacts.pop();
      throw new Error("Reply lost after committing retraction");
    });
    const observer = new MutationObserver(client, workboardUndoContactMutationOptions(client));
    const receipt = createWorkboardUndoReceipt("page-a", 10, "contact");
    const send = () => receipt.run(target => observer.mutate(target));
    await expect(send()).rejects.toThrow("Reply lost");
    expect(remainingContacts).toEqual(["earlier-contact"]);

    // A successful read/new render must not renew the consumed receipt.
    client.setQueryData(["workboard-v2", "page-a"], { items: [{ fanId: 10 }] });
    observer.setOptions(workboardUndoContactMutationOptions(client));
    await expect(send()).rejects.toThrow("already been attempted");
    expect(sdk.workboardV2UndoContact).toHaveBeenCalledTimes(1);
    expect(remainingContacts).toEqual(["earlier-contact"]);
  });

  it("consumes a receipt before awaiting transport, including two immediate clicks", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const action = vi.fn(() => pending);
    const receipt = createWorkboardUndoReceipt("page-a", 10, "snooze");
    const first = receipt.run(action);
    await expect(receipt.run(action)).rejects.toThrow("already been attempted");
    expect(action).toHaveBeenCalledExactlyOnceWith({ pageLabel: "page-a", fanId: 10 });
    finish(); await first;
    await expect(receipt.run(action)).rejects.toThrow("already been attempted");
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("fan note drafts are local to the reviewed fan and principal", () => {
  const routeA = "page-a\0fansly\0fan-a";
  const routeB = "page-b\0fansly\0fan-b";
  const empty: FanNoteDraftState = { principalId: 1, drafts: {} };

  it("restores A after visiting and editing B without putting A's text in B", () => {
    const a = fanNoteDraftsReducer(empty, { type: "edit", principalId: 1, routeKey: routeA, text: "Unsent A" });
    expect(a.drafts[routeB] ?? "").toBe("");
    const b = fanNoteDraftsReducer(a, { type: "edit", principalId: 1, routeKey: routeB, text: "Unsent B" });
    expect(b.drafts[routeA]).toBe("Unsent A");
    expect(b.drafts[routeB]).toBe("Unsent B");
  });

  it("clears only the matching submitted draft after its response arrives on another fan", () => {
    const a = fanNoteDraftsReducer(empty, { type: "edit", principalId: 1, routeKey: routeA, text: "Submitted A" });
    const b = fanNoteDraftsReducer(a, { type: "edit", principalId: 1, routeKey: routeB, text: "Unsent B" });
    const saved = fanNoteDraftsReducer(b, { type: "saved", principalId: 1, routeKey: routeA, submittedText: "Submitted A" });
    expect(saved.drafts[routeA] ?? "").toBe("");
    expect(saved.drafts[routeB]).toBe("Unsent B");
  });

  it("preserves a new A draft if the earlier A request completes after returning", () => {
    const a = fanNoteDraftsReducer(empty, { type: "edit", principalId: 1, routeKey: routeA, text: "Submitted A" });
    const revised = fanNoteDraftsReducer(a, { type: "edit", principalId: 1, routeKey: routeA, text: "New unsent A" });
    const saved = fanNoteDraftsReducer(revised, { type: "saved", principalId: 1, routeKey: routeA, submittedText: "Submitted A" });
    expect(saved.drafts[routeA]).toBe("New unsent A");
  });

  it("drops the prior principal's drafts and ignores that principal's late completion", () => {
    const a = fanNoteDraftsReducer(empty, { type: "edit", principalId: 1, routeKey: routeA, text: "Private to owner 1" });
    const changed = fanNoteDraftsReducer(a, { type: "principal", principalId: 2 });
    expect(changed.drafts).toEqual({});
    const edited = fanNoteDraftsReducer(changed, { type: "edit", principalId: 2, routeKey: routeA, text: "Owner 2 draft" });
    const saved = fanNoteDraftsReducer(edited, { type: "saved", principalId: 1, routeKey: routeA, submittedText: "Private to owner 1" });
    expect(saved).toBe(edited);
  });
});
