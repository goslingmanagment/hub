import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentHydrationRequestDecideBodySchema, KernelApiError, type AgentHydrationRequest } from "@agency_hub_core/contracts";
import {
  beginHydrationReview, hydrationDecisionFailure, hydrationListFilters, hydrationReviewChanged,
  hydrationStorageKey, prepareHydrationDecision, restoreHydrationWorkspace, serializeHydrationWorkspace,
  settleHydrationWorkspace, type HydrationDecisionWorkspace,
} from "../apps/dashboard/src/lib/agentHydrationReview.ts";

const mocks = vi.hoisted(() => ({ list: vi.fn(), auth: vi.fn(), decide: vi.fn() }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({
  useAgentHydrationRequests: mocks.list,
  useAuthMe: mocks.auth,
  useDecideAgentHydrationRequest: () => ({ isPending: false, mutateAsync: mocks.decide }),
}));
import { AgentHydrationPage } from "../apps/dashboard/src/pages/AgentHydrationPage.tsx";

const clock = Date.parse("2026-09-11T12:00:00Z");
const request: AgentHydrationRequest = {
  requestRef: "00000000-0000-4000-8000-000000000001", state: "requested", pageLabel: "review-fansly", platform: "fansly",
  conversationRef: "thread-1", target: { kind: "thread_backfill_before", beforeAt: "2026-08-01T00:00:00Z", beforeMessageRef: null },
  admissibility: { orderEvaluated: ["free_local_replay", "vendor_paid_low"], selected: "vendor_paid_low", admissible: true, reason: null, costNote: "egress_quota_and_ban_risk" },
  coverageFingerprint: "a".repeat(64), rowVersion: 7, requestedBy: { principal: "agent_key", keyPrefix: "test-agent" },
  reasonSha256: "b".repeat(64), reasonLength: 10, createdAt: "2026-09-10T12:00:00Z", updatedAt: "2026-09-10T12:00:00Z", expiresAt: "2099-09-20T12:00:00Z", decision: null,
  progress: { dispatchCount: 0, acceptedItems: 0, acceptedPages: 0, spentCredits: 0, lastError: "none", executionRef: null },
};
const key = "00000000-0000-4000-8000-000000000002";
const secondKey = "00000000-0000-4000-8000-000000000003";
const draft = { ...beginHydrationReview(request).draft, allowMarkRead: false, maxCredits: "0" };
function prepared(phase: HydrationDecisionWorkspace["phase"] = "review"): HydrationDecisionWorkspace {
  return { ...beginHydrationReview(request), draft, body: prepareHydrationDecision(request, draft, "approve", clock, key), phase };
}
function query(data: unknown, state = "ready") {
  return { data, isError: state === "error", isLoading: state === "loading", isFetching: state === "loading", refetch: vi.fn() };
}
function list(items: AgentHydrationRequest[] = [request], capped = false) {
  return { items, delivery: { cappedBy: capped ? "limit" : null, matchedInScope: { value: items.length, exact: !capped } } };
}
function render(path = "/agent-hydration") {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AgentHydrationPage)));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockReturnValue(query({ user: { id: 1, role: "owner" } }));
  mocks.list.mockReturnValue(query(list()));
});
afterEach(() => vi.unstubAllGlobals());

describe("hydration query context", () => {
  it("defaults only to supported filters and retains all/partial/expired and exact limits", () => {
    expect(hydrationListFilters(new URLSearchParams())).toEqual({ state: "requested", limit: 50, invalid: false });
    for (const state of ["all", "partially_completed", "rejected", "expired"]) {
      expect(hydrationListFilters(new URLSearchParams({ state, limit: "1" }))).toEqual({ state, limit: 1, invalid: false });
    }
    expect(hydrationListFilters(new URLSearchParams("state=failed&limit=200"))).toEqual({ state: "failed", limit: 200, invalid: false });
  });
  it.each(["state=unsupported", "state=", "limit=201", "limit=0", "limit=1.5", "limit="])("flags an invalid URL instead of sending it to the API: %s", search => {
    expect(hydrationListFilters(new URLSearchParams(search))).toMatchObject({ invalid: true });
  });
  it("restores status/limit from a link without inventing a cursor or offset", () => {
    render("/agent-hydration?state=partially_completed&limit=200");
    expect(mocks.list).toHaveBeenLastCalledWith({ state: "partially_completed", limit: 200 });
    render("/agent-hydration?state=all&limit=25");
    expect(mocks.list).toHaveBeenLastCalledWith({ limit: 25 });
  });
});

describe("hydration decision review", () => {
  it("keeps consent and caps bound to the opened version when polling replaces or mutates the row", () => {
    const original = structuredClone(request);
    const opened = beginHydrationReview(original);
    original.rowVersion += 1;
    original.coverageFingerprint = "c".repeat(64);
    expect(hydrationReviewChanged(opened.snapshot, original)).toBe(true);
    const body = prepareHydrationDecision(opened.snapshot, draft, "approve", clock, key);
    expect(body).toMatchObject({ expectedVersion: 7, coverageFingerprint: "a".repeat(64), allowMarkReadSideEffect: false });
    expect(hydrationReviewChanged(opened.snapshot, undefined)).toBe(false);
  });
  it("preserves all real cap boundaries including zero credits and an explicit refusal of mark-read", () => {
    const body = prepareHydrationDecision(request, { ...draft, maxCalls: "500", maxPages: "500", maxCredits: "100000" }, "approve", clock, key);
    expect(agentHydrationRequestDecideBodySchema.safeParse(body).success).toBe(true);
    expect(prepareHydrationDecision(request, { ...draft, maxCalls: "1", maxPages: "1", maxCredits: "0" }, "approve", clock, key)).toMatchObject({ maxCalls: 1, maxPages: 1, maxCredits: 0, allowMarkReadSideEffect: false });
  });
  it.each([
    { maxCalls: "" }, { maxCalls: "501" }, { maxCalls: "1.5" }, { maxPages: "0" },
    { maxCredits: "-1" }, { maxCredits: "100001" }, { expiresInHours: "0" }, { expiresInHours: "1e100" }, { allowMarkRead: null },
  ])("rejects invalid review inputs without coercing them into authority: %j", patch => {
    expect(() => prepareHydrationDecision(request, { ...draft, ...patch }, "approve", clock, key)).toThrow();
  });
  it("requires a real rejection reason and sends no approval caps or consent with it", () => {
    expect(() => prepareHydrationDecision(request, { ...draft, reason: " " }, "reject", clock, key)).toThrow("причину");
    const body = prepareHydrationDecision(request, { ...draft, reason: " Не требуется " }, "reject", clock, key);
    expect(body).toEqual({ decision: "reject", expectedVersion: 7, coverageFingerprint: request.coverageFingerprint, idempotencyKey: key, reason: "Не требуется" });
  });
  it("refuses expired or already-decided requests and freezes the absolute approval expiry", () => {
    expect(() => prepareHydrationDecision({ ...request, expiresAt: new Date(clock).toISOString() }, draft, "approve", clock, key)).toThrow();
    expect(() => prepareHydrationDecision({ ...request, state: "approved" }, draft, "approve", clock, key)).toThrow();
    expect(prepared().body?.expiresAt).toBe("2026-09-12T12:00:00.000Z");
  });
});

describe("hydration decision custody", () => {
  it("restores interrupted sending as uncertain with the exact original body/key/expiry", () => {
    const sending = prepared("sending");
    const restored = restoreHydrationWorkspace(serializeHydrationWorkspace(1, sending), 1)!;
    expect(restored).toMatchObject({ phase: "uncertain", everUncertain: true, body: sending.body, snapshot: sending.snapshot });
    expect(restoreHydrationWorkspace(serializeHydrationWorkspace(1, restored), 1)?.body).toEqual(sending.body);
    expect(restoreHydrationWorkspace(serializeHydrationWorkspace(1, sending), 1, false)?.phase).toBe("sending");
  });
  it("never restores another owner, a mismatched coverage snapshot, or a malformed stored body", () => {
    expect(hydrationStorageKey(1)).not.toBe(hydrationStorageKey(2));
    expect(() => restoreHydrationWorkspace(serializeHydrationWorkspace(1, prepared()), 2)).toThrow();
    const changed = { ...prepared(), snapshot: { ...request, rowVersion: 8 } };
    expect(() => restoreHydrationWorkspace(serializeHydrationWorkspace(1, changed), 1)).toThrow("match request");
    expect(() => restoreHydrationWorkspace("broken", 1)).toThrow();
  });
  it("keeps an earlier lost reply unresolved after a later definitive refusal", () => {
    const refused = new KernelApiError("Conflict", "conflict", 409, "conflict", null);
    expect(hydrationDecisionFailure(refused).uncertain).toBe(false);
    expect(hydrationDecisionFailure(refused, true).uncertain).toBe(true);
    expect(hydrationDecisionFailure(new Error("Connection closed")).uncertain).toBe(true);
    expect(hydrationDecisionFailure(new KernelApiError("Invalid success", "contract", 200, null, null)).uncertain).toBe(true);
    expect(settleHydrationWorkspace({ ...prepared("uncertain"), everUncertain: true }, prepared("refused"))).toMatchObject({ phase: "uncertain", everUncertain: true });
  });
  it("does not let a late outcome replace a new review, a closed record, or a confirmed result", () => {
    const newer = { ...prepared(), body: { ...prepared().body!, idempotencyKey: secondKey } };
    expect(settleHydrationWorkspace(newer, prepared("uncertain"))).toBe(newer);
    expect(settleHydrationWorkspace(null, prepared("confirmed"))).toBeNull();
    const confirmed = { ...prepared("confirmed"), result: { request: { ...request, state: "approved" as const }, disposition: "already_decided" as const } };
    expect(settleHydrationWorkspace(confirmed, prepared("uncertain"))).toBe(confirmed);
  });
});

describe("hydration queue truthful UI states", () => {
  it.each(["loading", "error"])("keeps the header and filters during initial %s, without a false empty state", state => {
    mocks.list.mockReturnValue(query(undefined, state));
    const html = render();
    expect(html).toContain("Запросы дозагрузки");
    expect(html).toContain("Состояние запросов");
    expect(html).not.toContain("Нет запросов, ожидающих решения");
    expect(html).toContain(state === "loading" ? "Загружаем запросы" : "Повторить");
  });
  it("retains cached rows, marks them stale and prevents a fresh decision during a query error", () => {
    mocks.list.mockReturnValue(query(list(), "error"));
    const html = render();
    expect(html).toContain("Показаны ранее полученные данные");
    expect(html).toContain("review-fansly");
    expect(html).toMatch(/disabled=""[^>]*>Рассмотреть запрос/);
  });
  it("reports an actual capped list as incomplete rather than fabricating a total or next page", () => {
    mocks.list.mockReturnValue(query(list([request], true)));
    const html = render();
    expect(html).toContain("всего может быть больше");
    expect(html).toContain("Показать до 200 запросов");
    expect(html).not.toContain("Следующая страница");
  });
  it("shows policy provenance, actual usage and distinct partial completion", () => {
    mocks.list.mockReturnValue(query(list([{ ...request, state: "partially_completed", decision: { decidedAt: request.createdAt, decisionSource: "auto_policy", policyVersion: 3, approved: true, allowMarkReadSideEffect: false, maxCalls: 40, maxPages: 40, maxCredits: 0, maxItems: null }, progress: { ...request.progress, dispatchCount: 1, acceptedItems: 120, acceptedPages: 4, lastError: "budget_exhausted" } }])));
    const html = render("/agent-hydration?state=partially_completed");
    expect(html).toContain("автоматической политикой v3");
    expect(html).toContain("Выполнено частично");
    expect(html).toContain("Сохранено 120 записей на 4 страницах");
    expect(html).not.toContain("Рассмотреть запрос");
  });
  it("restores a pending decision above a different filter without automatically dispatching", () => {
    const getItem = vi.fn(() => serializeHydrationWorkspace(1, prepared("sending")));
    vi.stubGlobal("window", { sessionStorage: { getItem } });
    mocks.list.mockReturnValue(query(list([])));
    const html = render("/agent-hydration?state=completed");
    expect(getItem).toHaveBeenCalledWith(hydrationStorageKey(1));
    expect(html).toContain("Повторить то же решение");
    expect(html).toContain(key);
    expect(html).toContain("review-fansly");
    expect(html).not.toContain("Закрыть проверку");
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it("keeps ordinary queue reading available when storage cannot be restored", () => {
    vi.stubGlobal("window", { sessionStorage: { getItem: () => { throw new Error("Unavailable"); } } });
    const html = render();
    expect(html).toContain("Чтение очереди работает");
    expect(html).toContain("review-fansly");
    expect(html).toContain("Состояние запросов");
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});
