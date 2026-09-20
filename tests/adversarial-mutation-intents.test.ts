import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MutationObserver,
  QueryClient,
  onlineManager,
  type MutationObserverOptions,
} from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

const sdk = vi.hoisted(() => ({
  createFanNote: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

import { createFanNoteMutationOptions } from "../apps/dashboard/src/api/pages.ts";
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
