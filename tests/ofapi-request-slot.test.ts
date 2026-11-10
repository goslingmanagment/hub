import type * as timers from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";

// The client paces its request slot with this delay: route it through the
// global timers so the fake clock drives it.
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...await importOriginal<typeof timers>(),
  setTimeout: (ms?: number, value?: unknown) => new Promise((resolve) => { globalThis.setTimeout(() => resolve(value), ms); }),
}));

const ACCOUNT = "acct_slot";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("gives the request slot to interactive requests ahead of a background request, holding it back at most 10 s", async () => {
  vi.useFakeTimers();
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    sent.push(url.endsWith("/posts") ? "background" : new URL(url).pathname.split("/").pop()!);
    return new Response(JSON.stringify({ data: { id: "1" } }), { status: 200 });
  }));
  const client = createOfapiClient({ apiKey: "test", restDelayMs: 1_000 });
  const message = (text: string) => client.dispatchGovernedRaw!({}, {
    attemptId: text, operation: "ofapi_chats", method: "GET", pathname: `/${ACCOUNT}/chats/${text}`,
    priorityClass: "interactive", deadlineAt: new Date(Date.now() + 65_000), beforeDispatch: async () => true,
  });
  const background = (attemptId: string) => client.dispatchGovernedRaw!({}, {
    attemptId, operation: "ofapi_command_action_post_create", method: "POST", pathname: `/${ACCOUNT}/posts`,
    priorityClass: "background", deadlineAt: new Date(Date.now() + 65_000), beforeDispatch: async () => true,
  });

  // An interactive request that arrives while a background request waits for the slot goes first.
  const first = [message("busy"), background("first"), message("chat")];
  await vi.advanceTimersByTimeAsync(5_000);
  await Promise.all(first);
  expect(sent).toEqual(["busy", "chat", "background"]);

  // A busy client holds a background request back for 10 s at most; then it
  // takes its turn after the slots already claimed and ahead of later interactive requests.
  sent.length = 0;
  const busy = Array.from({ length: 15 }, (_, index) => message(`queued-${index}`));
  const late = background("late");
  await vi.advanceTimersByTimeAsync(11_000);
  const after = message("after");
  await vi.advanceTimersByTimeAsync(10_000);
  await Promise.all([...busy, late, after]);
  expect(sent.slice(-3)).toEqual(["queued-14", "background", "after"]);
});
