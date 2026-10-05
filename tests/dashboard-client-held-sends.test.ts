import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clientSendCustodyListResponseSchema,
  clientSendCustodyResolveBodySchema,
  type ClientSendCustodyListItem,
  type ClientSendCustodyListResponse,
} from "@agency_hub_core/contracts";
import {
  MutationObserver,
  QueryClient,
  QueryObserver,
} from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

const sdk = vi.hoisted(() => ({
  clientSendCustodyList: vi.fn(),
  clientSendCustodyResolve: vi.fn(),
}));
const queryMocks = vi.hoisted(() => ({
  useClientHeldSends: vi.fn(),
  useResolveClientSend: vi.fn(),
}));

// The page takes its hooks from the barrel; the hooks' own module is left real
// and reaches the hub only through the SDK object mocked here.
vi.mock("../apps/dashboard/src/api/sdk.ts", () => ({ kernel: sdk }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queryMocks);

import { clientHeldSendsQueryOptions, resolveClientSendMutationOptions } from "../apps/dashboard/src/api/clientHeldSends.ts";
import { DashboardShellProvider } from "../apps/dashboard/src/components/layout/DashboardShellContext.tsx";
import { ClientHeldSendsPage, ResolveSendDialog } from "../apps/dashboard/src/pages/ClientHeldSendsPage.tsx";
import {
  EMPTY_RESOLVE_DRAFT,
  HELD_SENDS_PAGE_SIZE,
  formatMoment,
  formatSpan,
  greetingCell,
  heldCountLabel,
  heldSendRows,
  heldSendsPageLabels,
  heldSendsSearch,
  notSentWarning,
  parseHeldSendsView,
  partLabel,
  purposeLabel,
  resolveFailure,
  resolveForm,
  resolvedSendRows,
  shortId,
  type ResolveDraft,
} from "../apps/dashboard/src/pages/clientHeldSendsView.ts";
import { KernelApiError } from "../packages/sdk/src/index.ts";

// The cabinet's held-sends page (chat-extension H-7e): its view model, the
// resolve as the form builds it and the hook sends it, and the page as it
// renders. What the hub answers is tests/client-held-sends.integration.test.ts;
// this pins how it is put in front of the person who resolves, and that the
// resolve the page sends is one the hub's contract takes.

const MSK = "Europe/Moscow";
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

const REPLY = item({
  attemptId: "11111111-2222-4333-8444-555555555555", fanRef: "777000778", username: "nikita", purpose: "preview-reply",
  instanceId: "aaaaaaaa-7a7e-4c0b-9a55-0c8f6e1b2d33", variant: 0, partIndex: 0, partCount: 1,
  createdAt: "2026-10-03T07:00:00.000Z", updatedAt: "2026-10-03T07:00:00.000Z", ticketExpiresAt: "2026-10-03T07:00:10.000Z",
  greeting: { state: "confirmed", at: "2026-09-21T10:00:00.000Z", source: "desktop-outbox", firstPartIsThisAttempt: false },
});
const BY_HAND = item({
  attemptId: "22222222-2222-4333-8444-555555555555", fanRef: "777000779",
  greeting: { state: "confirmed", at: "2026-10-05T09:50:00.000Z", source: "native-register", firstPartIsThisAttempt: true },
});
const RESOLVED_SENT = item({
  state: "resolved-sent", updatedAt: "2026-10-05T10:30:00.000Z",
  greeting: { state: "confirmed", at: "2026-10-05T10:30:00.000Z", source: "resolve", firstPartIsThisAttempt: true },
  resolution: {
    outcome: "sent", at: "2026-10-05T10:30:00.000Z", userId: 2, username: "lead", note: "посмотрел чат, сообщение на месте",
    platformMessageId: "7001",
  },
});
const RESOLVED_NOT_SENT = item({
  attemptId: REPLY.attemptId, fanRef: REPLY.fanRef, username: "nikita", purpose: "preview-reply", variant: 0, partCount: 1,
  state: "resolved-not-sent", updatedAt: "2025-12-30T21:30:00.000Z", createdAt: "2025-12-30T21:00:00.000Z",
  resolution: {
    outcome: "not_sent", at: "2025-12-30T21:30:00.000Z", userId: 1, username: "owner", note: "в чате пусто", platformMessageId: null,
  },
});

/** A list answer as the hub's contract lets it out. */
function answer(items: ClientSendCustodyListItem[], overrides: Partial<ClientSendCustodyListResponse> = {}) {
  return clientSendCustodyListResponseSchema.parse({ items, limit: 25, offset: 0, total: items.length, serverNow: NOW, ...overrides });
}

describe("held-sends view model", () => {
  it("reads the tab, the page and the offset from the address, and falls back instead of failing", () => {
    const labels = ["lora-of", "mia-of"];
    expect(parseHeldSendsView(new URLSearchParams(""), labels)).toEqual({ state: "held", pageLabel: null, offset: 0 });
    expect(parseHeldSendsView(new URLSearchParams("state=resolved&page=mia-of&offset=50"), labels))
      .toEqual({ state: "resolved", pageLabel: "mia-of", offset: 50 });
    // A hand-edited link: an unknown tab, a page the viewer does not have, a bad offset.
    expect(parseHeldSendsView(new URLSearchParams("state=all&page=ghost-of&offset=-5"), labels))
      .toEqual({ state: "held", pageLabel: null, offset: 0 });
    expect(parseHeldSendsView(new URLSearchParams("page=&offset=1.5"), labels)).toEqual({ state: "held", pageLabel: null, offset: 0 });
    // Until the page catalog loads the filter is kept as asked.
    expect(parseHeldSendsView(new URLSearchParams("page=mia-of"), null).pageLabel).toBe("mia-of");

    expect(heldSendsSearch({ state: "held", pageLabel: null, offset: 0 }).toString()).toBe("");
    expect(heldSendsSearch({ state: "resolved", pageLabel: "mia-of", offset: 50 }).toString()).toBe("state=resolved&page=mia-of&offset=50");
    for (const search of ["", "state=resolved", "page=lora-of&offset=25", "state=resolved&page=mia-of&offset=50"]) {
      expect(heldSendsSearch(parseHeldSendsView(new URLSearchParams(search), labels)).toString()).toBe(search);
    }
  });

  it("offers only the pages that can hold a send", () => {
    expect(heldSendsPageLabels([
      { label: "lora-fansly", platform: "fansly" },
      { label: "lora-of", platform: "onlyfans" },
      { label: "mia-of", platform: "onlyfans" },
    ])).toEqual(["lora-of", "mia-of"]);
  });

  it("words a send for a person: what it was, which part, when and for how long", () => {
    expect(purposeLabel("greeting")).toBe("Приветствие");
    expect(purposeLabel("preview-reply")).toBe("Ответ из превью");
    // A purpose a newer hub adds prints its code.
    expect(purposeLabel("story-reply")).toBe("story-reply");
    expect(partLabel({ purpose: "greeting", variant: 1, partIndex: 0, partCount: 3 })).toBe("часть 1 из 3, вариант 2");
    expect(partLabel({ purpose: "greeting", variant: 0, partIndex: 0, partCount: 1 })).toBe("одно сообщение, вариант 1");
    expect(partLabel({ purpose: "preview-reply", variant: 0, partIndex: 2, partCount: 4 })).toBe("часть 3 из 4");
    expect(partLabel({ purpose: "preview-reply", variant: 0, partIndex: 0, partCount: 1 })).toBe("одно сообщение");
    expect(shortId("5d3c1c0a-7a7e-4c0b-9a55-0c8f6e1b2d33")).toBe("5d3c1c0a");

    const now = new Date(NOW);
    expect(formatMoment("2026-10-05T09:45:50.000Z", now, MSK)).toBe("5 октября, 12:45");
    expect(formatMoment("2026-10-04T21:05:00.000Z", now, MSK)).toBe("5 октября, 00:05");
    // Another year carries it: a date without one reads as this year's.
    expect(formatMoment("2025-12-30T21:30:00.000Z", now, MSK)).toBe("31 декабря 2025, 00:30");
    expect(formatMoment("not a date", now, MSK)).toBe("—");

    expect(formatSpan(-5_000)).toBe("меньше минуты");
    expect(formatSpan(59_000)).toBe("меньше минуты");
    expect(formatSpan(25 * 60_000)).toBe("25 мин");
    expect(formatSpan(3 * 3_600_000)).toBe("3 ч");
    expect(formatSpan(3 * 3_600_000 + 5 * 60_000)).toBe("3 ч 5 мин");
    expect(formatSpan(24 * 3_600_000)).toBe("1 день");
    expect(formatSpan(52 * 3_600_000)).toBe("2 дня 4 ч");
    expect(formatSpan(5 * 24 * 3_600_000 + 40 * 60_000)).toBe("5 дней");

    expect(heldCountLabel(1)).toBe("1 отправка ждёт разбора");
    expect(heldCountLabel(3)).toBe("3 отправки ждут разбора");
    expect(heldCountLabel(5)).toBe("5 отправок ждут разбора");
    expect(heldCountLabel(21)).toBe("21 отправка ждёт разбора");
  });

  it("says where the fan's greeting stands, and singles out a part sent by hand over the held one", () => {
    const now = new Date(NOW);
    expect(greetingCell(item(), now, MSK)).toEqual({ label: "Нет", hint: null, sentByHand: false });
    expect(greetingCell(REPLY, now, MSK)).toEqual({ label: "Есть", hint: "отправлено из десктопа, 21 сентября, 13:00", sentByHand: false });
    const byHand = greetingCell(BY_HAND, now, MSK);
    expect(byHand).toMatchObject({ label: "Есть: эту часть отправили вручную", sentByHand: true });
    expect(byHand.hint).toContain("5 октября, 12:50");
    expect(byHand.hint).toContain("ответьте только про отправку из превью");
    // The same source on another attempt's greeting is an ordinary "greeted".
    expect(greetingCell(item({
      greeting: { state: "confirmed", at: null, source: "native-register", firstPartIsThisAttempt: false },
    }), now, MSK)).toEqual({ label: "Есть", hint: "отправлено вручную из поля ввода", sentByHand: false });
    // A source or a state this build does not know: the code, and "not greeted" for anything but `confirmed`.
    expect(greetingCell(item({
      greeting: { state: "confirmed", at: null, source: "import", firstPartIsThisAttempt: false },
    }), now, MSK).hint).toBe("import");
    expect(greetingCell(item({
      greeting: { state: "pending", at: null, source: null, firstPartIsThisAttempt: false },
    }), now, MSK).label).toBe("Нет");
  });

  it("builds the queue's rows from the hub's answer, counted against the hub's clock", () => {
    const list = answer([REPLY, item(), BY_HAND]);
    const rows = heldSendRows(list.items, list.serverNow, MSK);
    expect(rows.map((row) => row.key)).toEqual([REPLY.attemptId, ATTEMPT, BY_HAND.attemptId]);
    expect(rows[0]).toMatchObject({
      pageLabel: "lora-of", fanRef: "777000778", purpose: "Ответ из превью", part: "одно сообщение",
      username: "nikita", install: "aaaaaaaa", dispatchedAt: "3 октября, 10:00",
      // From the moment the hub stopped waiting (the ticket's end), not from the dispatch.
      heldFor: "2 дня 4 ч",
    });
    expect(rows[1]).toMatchObject({
      purpose: "Приветствие", part: "часть 1 из 3, вариант 2", username: "grisha", install: "5d3c1c0a",
      dispatchedAt: "5 октября, 12:45", heldFor: "2 ч 14 мин",
      greeting: { label: "Нет", sentByHand: false },
    });
    expect(rows[2]!.greeting.sentByHand).toBe(true);
    // The row carries the hub's own item: the dialog resolves exactly that attempt on that page.
    expect(rows[1]!.item).toBe(list.items[1]);
    // A row with no ticket on record counts from its dispatch.
    expect(heldSendRows([item({ ticketExpiresAt: null })], NOW, MSK)[0]!.heldFor).toBe("2 ч 14 мин");
  });

  it("builds the trail of the resolves: who, when, which outcome, why", () => {
    const rows = resolvedSendRows(answer([RESOLVED_SENT, RESOLVED_NOT_SENT]).items, NOW, MSK);
    expect(rows).toEqual([
      {
        key: ATTEMPT, attemptId: ATTEMPT, pageLabel: "lora-of", fanRef: "777000777", purpose: "Приветствие", part: "часть 1 из 3, вариант 2",
        username: "grisha", dispatchedAt: "5 октября, 12:45", outcome: "Сообщение ушло", sent: true,
        resolvedBy: "lead", resolvedAt: "5 октября, 13:30", note: "посмотрел чат, сообщение на месте", platformMessageId: "7001",
      },
      {
        key: REPLY.attemptId, attemptId: REPLY.attemptId, pageLabel: "lora-of", fanRef: "777000778", purpose: "Ответ из превью",
        part: "одно сообщение",
        username: "nikita", dispatchedAt: "31 декабря 2025, 00:00", outcome: "Сообщение не ушло", sent: false,
        resolvedBy: "owner", resolvedAt: "31 декабря 2025, 00:30", note: "в чате пусто", platformMessageId: null,
      },
    ]);
    // An outcome a newer hub adds prints its code; a row without a resolve is not a resolve.
    expect(resolvedSendRows([
      item({ resolution: { ...RESOLVED_SENT.resolution!, outcome: "withdrawn" } }), item(),
    ], NOW, MSK).map((row) => row.outcome)).toEqual(["withdrawn"]);
  });
});

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

  it("builds the body the hub's contract takes: the note trimmed, the message id only with «ушло»", () => {
    expect(resolveForm(draft({ outcome: "sent", note: "  видел в чате  " }))).toEqual({
      body: { outcome: "sent", note: "видел в чате" }, platformMessageIdError: null, noteLeft: 488, missing: null,
    });
    expect(resolveForm(draft({ outcome: "sent", note: "видел в чате", platformMessageId: " 7001 " })).body)
      .toEqual({ outcome: "sent", note: "видел в чате", platformMessageId: "7001" });
    expect(resolveForm(draft({ outcome: "not_sent", note: "в чате пусто" })).body).toEqual({ outcome: "not_sent", note: "в чате пусто" });
    // An id typed before the person changed their mind is dropped, good or bad: the hub refuses one next to "not sent".
    for (const platformMessageId of ["7001", "not an id"]) {
      expect(resolveForm(draft({ outcome: "not_sent", note: "в чате пусто", platformMessageId })))
        .toEqual({ body: { outcome: "not_sent", note: "в чате пусто" }, platformMessageIdError: null, noteLeft: 488, missing: null });
    }

    // Every body the form lets out is one the hub parses to the same body.
    const drafts = [
      draft({ outcome: "sent", note: "a" }),
      draft({ outcome: "sent", note: "x".repeat(500), platformMessageId: "9".repeat(30) }),
      draft({ outcome: "not_sent", note: "б", platformMessageId: "7001" }),
      draft({ outcome: "not_sent", note: `  ${"я".repeat(500)}  ` }),
    ];
    for (const one of drafts) {
      const { body } = resolveForm(one);
      expect(body).not.toBeNull();
      expect(clientSendCustodyResolveBodySchema.parse(body)).toEqual(body);
    }
  });

  it("holds back a message id that is not one and a note that is too long, and says which", () => {
    for (const platformMessageId of ["12 34", "0123", "abc", "7001a", "-5", "9".repeat(31)]) {
      const form = resolveForm(draft({ outcome: "sent", note: "видел", platformMessageId }));
      expect(form.body, platformMessageId).toBeNull();
      expect(form.platformMessageIdError, platformMessageId).toContain("только цифры");
      expect(form.missing).toBe("Исправьте ID сообщения или сотрите его.");
      // And the hub would have refused it: the form is not stricter than the contract.
      expect(clientSendCustodyResolveBodySchema.safeParse({ outcome: "sent", note: "видел", platformMessageId }).success).toBe(false);
    }
    expect(resolveForm(draft({ outcome: "sent", note: "x".repeat(501) }))).toMatchObject({
      body: null, noteLeft: -1, missing: "Заметка длиннее 500 знаков.",
    });
    expect(clientSendCustodyResolveBodySchema.safeParse({ outcome: "sent", note: "x".repeat(501) }).success).toBe(false);
  });

  it("warns what «не ушло» does before it is recorded: the fan can be written to again, and the archive proves nothing", () => {
    const greeting = notSentWarning(item());
    expect(greeting[0]).toContain("снова можно будет поприветствовать");
    expect(greeting[0]).toContain("получит приветствие дважды");
    const reply = notSentWarning(REPLY);
    expect(reply[0]).toContain("снова можно будет отправить эту часть");
    expect(reply[0]).toContain("получит его дважды");
    // A later part of a greeting already on record: that part can go again, but nobody greets the fan anew.
    const laterPart = notSentWarning(item({
      partIndex: 1, greeting: { state: "confirmed", at: NOW, source: "preview-send", firstPartIsThisAttempt: false },
    }));
    expect(laterPart[0]).toBe(reply[0]);
    for (const lines of [greeting, reply, laterPart]) {
      expect(lines[1]).toContain("Правила «в архиве Hub нет — значит не ушло» не существует");
      expect(lines[1]).toContain("Смотрите сам чат");
    }
    // The part already sent by hand: the hub sends nothing again whatever is answered, and the warning
    // does not threaten a second greeting that cannot happen.
    const byHand = notSentWarning(BY_HAND);
    expect(byHand[0]).toContain("заново фана не поприветствуют");
    expect(byHand[1]).toContain("стоит дважды");
    expect(byHand.join(" ")).not.toContain("получит приветствие дважды");
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

    it("resolves that attempt on its own page with the form's body, once, and reads both lists again", async () => {
      sdk.clientSendCustodyResolve.mockResolvedValue({ attemptId: ATTEMPT, state: "resolved-sent" });
      const { result, body } = await resolveThroughHook(draft({ outcome: "sent", note: " видел в чате ", platformMessageId: "7001" }));
      expect(result).toEqual({ attemptId: ATTEMPT, state: "resolved-sent" });
      expect(sdk.clientSendCustodyResolve).toHaveBeenCalledOnce();
      expect(sdk.clientSendCustodyResolve).toHaveBeenCalledWith({
        params: { pageLabel: "lora-of", attemptId: ATTEMPT },
        body: { outcome: "sent", note: "видел в чате", platformMessageId: "7001" },
      });
      expect(body).toEqual({ outcome: "sent", note: "видел в чате", platformMessageId: "7001" });
      // The held list and the resolved list, one more read each.
      expect(sdk.clientSendCustodyList.mock.calls.map(([call]) => (call as { query: { state: string } }).query.state))
        .toEqual(["held", "resolved", "held", "resolved"]);
      expect(sdk.clientSendCustodyList).toHaveBeenLastCalledWith({ query: { state: "resolved", limit: 25, offset: 0 } });
    });

    it("keeps the previous rows while a page of the same list loads, and never shows one list's rows under the other", async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      const heldList = answer([item()]);
      const never = new Promise<never>(() => {});
      sdk.clientSendCustodyList.mockImplementation(({ query }: { query: { state: string; offset: number; pageLabel?: string } }) =>
        query.state === "held" && query.offset === 0 && query.pageLabel === undefined ? Promise.resolve(heldList) : never);
      const observer = new QueryObserver(client, clientHeldSendsQueryOptions({ state: "held", limit: 25, offset: 0 }));
      const stop = observer.subscribe(() => {});
      try {
        await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(heldList));
        // The next page, and another page filter, of the queue: the rows stay, marked as not the asked ones.
        for (const next of [{ offset: 25 }, { offset: 0, pageLabel: "mia-of" }]) {
          observer.setOptions(clientHeldSendsQueryOptions({ state: "held", limit: 25, ...next }));
          expect(observer.getCurrentResult()).toMatchObject({ data: heldList, isPlaceholderData: true });
        }
        // The other list: nothing until its own rows arrive. A held row under «Разобранные» would
        // read as resolved, and a resolved one under «Ждут разбора» would offer a resolve.
        observer.setOptions(clientHeldSendsQueryOptions({ state: "resolved", limit: 25, offset: 0 }));
        expect(observer.getCurrentResult()).toMatchObject({ data: undefined, isPlaceholderData: false, isLoading: true });
      } finally {
        stop();
      }
      // Only the queue refreshes by itself.
      expect(clientHeldSendsQueryOptions({ state: "held", limit: 25, offset: 0 }).refetchInterval).toBe(30_000);
      expect(clientHeldSendsQueryOptions({ state: "resolved", limit: 25, offset: 0 }).refetchInterval).toBe(false);
    });

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

  it("words every refusal of the hub, and tells a send that is gone from one worth another try", () => {
    const refusal = (status: number, code: string, reason?: string) =>
      new KernelApiError(code, "conflict", status, code, { error: code, message: "hub prose", statusCode: status, ...(reason ? { reason } : {}) });
    const sent = { outcome: "sent" } as const;
    const notSent = { outcome: "not_sent" } as const;

    // Inside the 10 seconds the page may still send: wait, the same answer passes later.
    const live = resolveFailure(refusal(409, "conflict", "ticket_live"), notSent);
    expect(live.gone).toBe(false);
    expect(live.message).toContain("ещё в пути");
    expect(live.message).toContain("10 секунд");
    // The client reported in the meantime: nothing to resolve.
    expect(resolveFailure(refusal(409, "conflict", "custody_not_held"), sent).gone).toBe(true);
    // Resolved otherwise, or the id belongs to another send.
    expect(resolveFailure(refusal(409, "attempt_conflict"), sent)).toMatchObject({ gone: false });
    expect(resolveFailure(refusal(409, "attempt_conflict"), sent).message).toContain("ID сообщения уже записан за другой отправкой");
    expect(resolveFailure(refusal(409, "attempt_conflict"), notSent)).toEqual({
      message: "Не записано: эту отправку уже разобрали как ушедшую. Откройте «Разобранные».", gone: true,
    });
    expect(resolveFailure(refusal(404, "not_found"), sent)).toMatchObject({ gone: true });
    expect(resolveFailure(refusal(403, "forbidden"), sent)).toMatchObject({ gone: true });
    expect(resolveFailure(refusal(400, "validation_error"), sent)).toMatchObject({ gone: false });
    expect(resolveFailure(refusal(401, "unauthorized"), sent)).toMatchObject({ gone: false });
    // No answer at all, a 5xx, a 409 with a reason this build does not know: the outcome is unknown,
    // and the resolve is safe to press again (the hub records the same resolve once).
    for (const error of [
      new TypeError("Failed to fetch"), new KernelApiError("boom", "server", 500, "internal_error", null),
      new KernelApiError("net", "network", null, null, null), refusal(409, "conflict", "something_new"), null, "boom",
    ]) {
      const failure = resolveFailure(error, sent);
      expect(failure.gone).toBe(false);
      expect(failure.message).toContain("неизвестно, записан ли разбор");
      expect(failure.message).toContain("одинаковый разбор записывается один раз");
    }
    // No refusal is shown in the hub's own English.
    for (const error of [refusal(409, "conflict", "ticket_live"), refusal(404, "not_found"), refusal(400, "validation_error")]) {
      expect(resolveFailure(error, sent).message).not.toContain("hub prose");
    }
  });
});

describe("held-sends page", () => {
  const SHELL = {
    pageCatalogState: "ready" as const,
    pageCatalogError: null,
    pages: [
      { id: 1, label: "lora-fansly", platform: "fansly" as const, modelSlug: "lora", modelName: "Lora", username: null },
      { id: 2, label: "lora-of", platform: "onlyfans" as const, modelSlug: "lora", modelName: "Lora", username: null },
      { id: 3, label: "mia-of", platform: "onlyfans" as const, modelSlug: "mia", modelName: "Mia", username: null },
    ],
    findPageByLabel: () => null,
  };

  function renderPage(entry = "/held-sends") {
    return renderToStaticMarkup(createElement(
      MemoryRouter,
      { initialEntries: [entry] },
      createElement(DashboardShellProvider, { value: SHELL, children: createElement(ClientHeldSendsPage) }),
    ));
  }

  const loaded = (data: ClientSendCustodyListResponse) =>
    ({ data, isLoading: false, isError: false, isFetching: false, isPlaceholderData: false, refetch: vi.fn() });

  beforeEach(() => {
    queryMocks.useClientHeldSends.mockReset();
    queryMocks.useResolveClientSend.mockReset().mockReturnValue({ mutate: vi.fn(), reset: vi.fn(), isPending: false });
  });

  it("asks for the queue of every page first, and for what the address names", () => {
    queryMocks.useClientHeldSends.mockReturnValue(loaded(answer([])));
    renderPage();
    expect(queryMocks.useClientHeldSends).toHaveBeenLastCalledWith({ state: "held", limit: 25, offset: 0 });
    renderPage("/held-sends?state=resolved&page=mia-of&offset=25");
    expect(queryMocks.useClientHeldSends).toHaveBeenLastCalledWith({ state: "resolved", pageLabel: "mia-of", limit: 25, offset: 25 });
    // A page that is not the viewer's, or not one that can hold a send, is not asked for.
    renderPage("/held-sends?page=lora-fansly");
    expect(queryMocks.useClientHeldSends).toHaveBeenLastCalledWith({ state: "held", limit: 25, offset: 0 });
  });

  it("shows the queue: one row per held send with a resolve button, and no message text", () => {
    queryMocks.useClientHeldSends.mockReturnValue(loaded(answer([REPLY, item(), BY_HAND], { total: 28 })));
    const html = renderPage();

    expect(html).toContain("Зависшие отправки расширения");
    expect(html).toContain("Текста сообщений на этой странице нет: Hub его не хранит.");
    expect(html).toContain("28 отправок ждут разбора");
    for (const column of ["Страница и фан", "Что отправляли", "Кто отправлял", "Когда", "Приветствие фана"]) {
      expect(html).toContain(column);
    }
    expect(html.match(/>Разобрать<\/button>/g)).toHaveLength(3);
    // Each row: the page, the fan (a link to what the hub knows of them), the part, the person, the install.
    expect(html).toContain('href="/pages/lora-of/fans/onlyfans/777000777"');
    expect(html).toContain("часть 1 из 3, вариант 2");
    expect(html).toContain("Ответ из превью");
    expect(html).toContain("nikita");
    expect(html).toContain("5d3c1c0a");
    expect(html).not.toContain("5d3c1c0a-7a7e");
    expect(html).toContain("без отчёта 2 ч 14 мин");
    expect(html).toContain("Есть: эту часть отправили вручную");
    // The filter offers the pages that can hold a send, and the list is paged in Russian.
    expect(html).toContain("<option value=\"\" selected=\"\">Все страницы</option>");
    expect(html).toContain("<option value=\"lora-of\">lora-of</option>");
    expect(html).not.toContain("lora-fansly");
    expect(html).toContain("1–25 из 28");
    expect(html).toContain(">Дальше</button>");
    expect(html).not.toMatch(/>Previous<|>Next<| of \d/);
    // No dialog until a row is opened.
    expect(html).not.toContain('role="dialog"');
  });

  it("shows the trail of the resolves: the outcome, who and when, the note and the recorded message id", () => {
    queryMocks.useClientHeldSends.mockReturnValue(loaded(answer([RESOLVED_SENT, RESOLVED_NOT_SENT])));
    const html = renderPage("/held-sends?state=resolved");

    expect(html).toContain("Разобрано вручную: 2");
    for (const column of ["Итог", "Кто и когда разобрал", "Почему так решили"]) expect(html).toContain(column);
    expect(html).toContain("Сообщение ушло");
    expect(html).toContain("Сообщение не ушло");
    expect(html).toContain("посмотрел чат, сообщение на месте");
    expect(html).toContain("в чате пусто");
    expect(html).toContain(">lead<");
    expect(html).toContain(">owner<");
    expect(html).toContain("7001");
    // The attempt the audit event names, short on screen and whole in the tooltip.
    expect(html).toContain(`title="Попытка ${ATTEMPT}"`);
    expect(html).toContain(">9f1b2c3d<");
    // The trail is read, not acted on.
    expect(html).not.toContain(">Разобрать<");
  });

  it("says so when nothing is held, when the hub did not answer, and when a refresh failed", () => {
    queryMocks.useClientHeldSends.mockReturnValue(loaded(answer([])));
    expect(renderPage()).toContain("Зависших отправок нет");
    expect(renderPage("/held-sends?page=mia-of")).toContain("На этой странице все отправки из превью закончились");
    expect(renderPage("/held-sends?state=resolved")).toContain("Разобранных отправок нет");
    // Past the end of the list: a way back, not an empty table that reads as "nothing held".
    queryMocks.useClientHeldSends.mockReturnValue(loaded(answer([], { offset: 50, total: 28 })));
    const past = renderPage("/held-sends?offset=50");
    expect(past).toContain("К началу списка");
    expect(past).not.toContain("Зависших отправок нет");

    queryMocks.useClientHeldSends.mockReturnValue({
      data: undefined, isLoading: false, isError: true, isFetching: false, isPlaceholderData: false, refetch: vi.fn(),
    });
    const failed = renderPage();
    expect(failed).toContain("Список не загрузился");
    expect(failed).toContain("Повторить");
    expect(failed).not.toContain("Зависших отправок нет");

    queryMocks.useClientHeldSends.mockReturnValue({ ...loaded(answer([item()])), isError: true });
    const stale = renderPage();
    expect(stale).toContain("Обновить не получилось. Показан список прошлой загрузки: он мог устареть.");
    expect(stale).toContain(">Разобрать<");
  });

  describe("the resolve dialog", () => {
    const dialog = (props: Partial<Parameters<typeof ResolveSendDialog>[0]> = {}) => renderToStaticMarkup(createElement(ResolveSendDialog, {
      item: item(), serverNow: NOW, isPending: false, failure: null, onSubmit: vi.fn(), onClose: vi.fn(), ...props,
    }));

    it("opens with the send named, two answers, neither chosen, and nothing to send yet", () => {
      const html = dialog();
      expect(html).toContain('role="dialog"');
      expect(html).toContain("Разобрать отправку");
      expect(html).toContain("lora-of");
      expect(html).toContain("777000777");
      expect(html).toContain("Приветствие, часть 1 из 3, вариант 2");
      // The attempt and its generation, whole: what the sender's extension and the audit trail call this send.
      expect(html).toContain(ATTEMPT);
      expect(html).toContain("3c2b1a09-8f7e-4d6c-b5a4-fedcba987654");
      expect(html).toContain("Текста сообщения в Hub нет");
      expect(html).toContain("Сообщение ушло");
      expect(html).toContain("Сообщение не ушло");
      expect(html).not.toContain('checked=""');
      expect(html).toContain("Почему вы так решили (обязательно)");
      expect(html).toContain("Выберите, ушло сообщение или нет.");
      expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Записать<\/button>/);
      // Neither the warning nor the message id field before an answer is chosen.
      expect(html).not.toContain("Проверьте, прежде чем записать");
      expect(html).not.toContain("ID сообщения в OnlyFans");
    });

    it("with «ушло»: an optional message id, and the button says what it records", () => {
      const html = dialog({ initialDraft: { outcome: "sent", platformMessageId: "", note: "видел в чате" } });
      expect(html).toContain("ID сообщения в OnlyFans, если вы его знаете (необязательно)");
      expect(html).not.toContain("Проверьте, прежде чем записать");
      expect(html).toMatch(/<button type="submit" class="[^"]*bg-accent[^"]*">Записать: сообщение ушло<\/button>/);
      const bad = dialog({ initialDraft: { outcome: "sent", platformMessageId: "12 34", note: "видел" } });
      expect(bad).toContain("ID сообщения — только цифры");
      expect(bad).toMatch(/<button type="submit" disabled=""/);
    });

    it("with «не ушло»: the warning is on screen before the button, and the button is the dangerous one", () => {
      const html = dialog({ initialDraft: { outcome: "not_sent", platformMessageId: "", note: "в чате пусто" } });
      expect(html).toContain("Проверьте, прежде чем записать «не ушло»");
      expect(html).toContain("После этого фана снова можно будет поприветствовать");
      expect(html).toContain("Правила «в архиве Hub нет — значит не ушло» не существует");
      expect(html.indexOf("Проверьте, прежде чем записать")).toBeLessThan(html.indexOf("Записать: сообщение не ушло"));
      expect(html).toMatch(/<button type="submit" class="[^"]*bg-danger[^"]*">Записать: сообщение не ушло<\/button>/);
      expect(html).not.toContain("ID сообщения в OnlyFans");
      // A reply's warning speaks of the part, not of a greeting.
      const reply = dialog({ item: REPLY, initialDraft: { outcome: "not_sent", platformMessageId: "", note: "пусто" } });
      expect(reply).toContain("снова можно будет отправить эту часть из превью");
      // Without a reason there is nothing to record.
      expect(dialog({ initialDraft: { outcome: "not_sent", platformMessageId: "", note: "" } }))
        .toMatch(/<button type="submit" disabled=""/);
    });

    it("shows a part sent by hand over the held one, so the answer is about the preview send only", () => {
      const html = dialog({ item: BY_HAND });
      expect(html).toContain("Есть: эту часть отправили вручную");
      expect(html).toContain("здесь ответьте только про отправку из превью");
      const notSent = dialog({ item: BY_HAND, initialDraft: { outcome: "not_sent", platformMessageId: "", note: "одно сообщение" } });
      expect(notSent).toContain("Запись закроет только отправку из превью");
      expect(notSent).not.toContain("снова можно будет поприветствовать");
    });

    it("locks while the hub records, shows a refusal in words, and offers only to close when the send is gone", () => {
      const pending = dialog({ isPending: true, initialDraft: { outcome: "sent", platformMessageId: "", note: "видел" } });
      expect(pending).toContain("Записываем…");
      expect(pending).toMatch(/<fieldset disabled=""/);

      const retry = dialog({
        initialDraft: { outcome: "not_sent", platformMessageId: "", note: "пусто" },
        failure: resolveFailure(new KernelApiError("c", "conflict", 409, "conflict", { reason: "ticket_live" }), { outcome: "not_sent" }),
      });
      expect(retry).toContain('role="alert"');
      expect(retry).toContain("ещё в пути");
      expect(retry).toContain("Записать: сообщение не ушло");

      const gone = dialog({
        initialDraft: { outcome: "sent", platformMessageId: "", note: "видел" },
        failure: resolveFailure(new KernelApiError("c", "conflict", 409, "conflict", { reason: "custody_not_held" }), { outcome: "sent" }),
      });
      expect(gone).toContain("Разбирать уже нечего");
      expect(gone).not.toContain('type="submit"');
      expect(gone).toMatch(/>Закрыть<\/button>/);
    });
  });
});
