import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientSendCustodyListResponseSchema,
  type ClientSendCustodyListItem,
  type ClientSendCustodyListResponse,
} from "@agency_hub_core/contracts";
// A dashboard module first: tsc must reach @tanstack/react-query through its bare
// import (resolved to the real pnpm path, where query-core sits beside it) before
// the relative node_modules path below, or its query-core re-exports go missing.
import { clientHeldSendsQueryOptions, resolveClientSendMutationOptions } from "../apps/dashboard/src/api/clientHeldSends.ts";
import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";

const sdk = vi.hoisted(() => ({
  clientSendCustodyList: vi.fn(),
  clientSendCustodyResolve: vi.fn(),
}));

vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));

import {
  EMPTY_RESOLVE_DRAFT,
  HELD_SENDS_PAGE_SIZE,
  resolveFailure,
  resolveForm,
  type ResolveDraft,
} from "../apps/dashboard/src/pages/clientHeldSendsView.ts";
import { KernelApiError } from "../packages/sdk/src/index.ts";

// The cabinet's held-sends page (chat-extension H-7e): its view model, the
// resolve as the form builds it and the hook sends it, and the page as it
// renders. What the hub answers is tests/client-held-sends.integration.test.ts;
// this pins how it is put in front of the person who resolves, and that the
// resolve the page sends is one the hub's contract takes.

const NOW = "2026-10-05T12:00:00.000Z";
const ATTEMPT = "9f1b2c3d-4e5f-4a6b-8c7d-0123456789ab";

function item(overrides: Partial<ClientSendCustodyListItem> = {}): ClientSendCustodyListItem {
  return {
    attemptId: ATTEMPT,
    pageLabel: "lora-of",
    fanRef: "777000777",
    userId: 7,
    username: "grisha",
    instanceId: "5d3c1c0a-7a7e-4c0b-9a55-0c8f6e1b2d33",
    purpose: "greeting",
    state: "uncertain-held",
    generationRef: "3c2b1a09-8f7e-4d6c-b5a4-fedcba987654",
    variant: 1,
    partIndex: 0,
    partCount: 3,
    createdAt: "2026-10-05T09:45:50.000Z",
    updatedAt: "2026-10-05T09:45:50.000Z",
    ticketExpiresAt: "2026-10-05T09:46:00.000Z",
    greeting: { state: "none", at: null, source: null, firstPartIsThisAttempt: false },
    resolution: null,
    ...overrides,
  };
}

/** A list answer as the hub's contract lets it out. */
function answer(items: ClientSendCustodyListItem[], overrides: Partial<ClientSendCustodyListResponse> = {}) {
  return clientSendCustodyListResponseSchema.parse({ items, limit: 25, offset: 0, total: items.length, serverNow: NOW, ...overrides });
}

describe("the resolve, from the form to the hub", () => {
  const draft = (overrides: Partial<ResolveDraft>): ResolveDraft => ({ ...EMPTY_RESOLVE_DRAFT, ...overrides });

  it("preselects no answer and sends nothing until there is an outcome and a reason", () => {
    expect(EMPTY_RESOLVE_DRAFT).toEqual({ outcome: null, platformMessageId: "", note: "" });
    expect(resolveForm(EMPTY_RESOLVE_DRAFT)).toEqual({
      body: null, platformMessageIdError: null, noteLeft: 500, missing: "Выберите, ушло сообщение или нет.",
    });
    // A reason typed first does not choose an outcome for the person.
    expect(resolveForm(draft({ note: "видел в чате" })).body).toBeNull();
    for (const outcome of ["sent", "not_sent"] as const) {
      expect(resolveForm(draft({ outcome }))).toMatchObject({ body: null, missing: "Напишите, почему вы так решили." });
      expect(resolveForm(draft({ outcome, note: "   \n " }))).toMatchObject({ body: null, missing: "Напишите, почему вы так решили." });
    }
  });

  describe("through the hook", () => {
    const clients: QueryClient[] = [];
    beforeEach(() => {
      sdk.clientSendCustodyList.mockReset().mockResolvedValue(answer([]));
      sdk.clientSendCustodyResolve.mockReset();
    });
    afterEach(() => {
      for (const client of clients.splice(0)) client.clear();
    });

    /** Both lists on screen, then the resolve the form built for this attempt. */
    async function resolveThroughHook(one: ResolveDraft) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { gcTime: Infinity } } });
      clients.push(client);
      const lists = (["held", "resolved"] as const).map((state) =>
        new QueryObserver(client, clientHeldSendsQueryOptions({ state, limit: HELD_SENDS_PAGE_SIZE, offset: 0 })));
      const unsubscribe = lists.map((list) => list.subscribe(() => {}));
      await vi.waitFor(() => expect(sdk.clientSendCustodyList).toHaveBeenCalledTimes(2));
      const { body } = resolveForm(one);
      const observer = new MutationObserver(client, resolveClientSendMutationOptions(client));
      const stop = observer.subscribe(() => {});
      try {
        const held = item();
        return { result: await observer.mutate({ pageLabel: held.pageLabel, attemptId: held.attemptId, body: body! }), body };
      } finally {
        stop();
        await vi.waitFor(() => expect(sdk.clientSendCustodyList).toHaveBeenCalledTimes(4));
        for (const off of unsubscribe) off();
      }
    }

    it("reads both lists again after a refusal too, and never retries the resolve by itself", async () => {
      const refusal = new KernelApiError("conflict", "conflict", 409, "conflict", {
        error: "conflict", message: "The send attempt is not held", statusCode: 409, reason: "custody_not_held",
      });
      sdk.clientSendCustodyResolve.mockRejectedValue(refusal);
      const attempt = draft({ outcome: "not_sent", note: "в чате пусто" });
      await expect(resolveThroughHook(attempt)).rejects.toBe(refusal);
      expect(sdk.clientSendCustodyResolve).toHaveBeenCalledOnce();
      expect(sdk.clientSendCustodyResolve).toHaveBeenCalledWith({
        params: { pageLabel: "lora-of", attemptId: ATTEMPT },
        body: { outcome: "not_sent", note: "в чате пусто" },
      });
      // The refusal reaches the dialog, not a global toast in the server's English.
      expect(resolveClientSendMutationOptions(new QueryClient()).meta).toEqual({ suppressGlobalError: true });
      expect(resolveFailure(refusal, attempt)).toEqual({
        message: "Разбирать уже нечего: расширение само сообщило, чем закончилась отправка. Ничего не записано, список обновлён.",
        gone: true,
      });
    });
  });
});
