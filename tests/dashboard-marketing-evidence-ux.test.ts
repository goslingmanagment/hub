import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelApiError, ofapiMarketingIntentSchema, routeSchemas } from "@agency_hub_core/contracts";
import { createMarketingPreparation, marketingFailureUncertain, marketingMatches, newMarketingForm } from "../apps/dashboard/src/pages/marketing/marketingForm.ts";
import { acknowledgeCaptureCustody, captureCustodyKey, clearCaptureCustody, parseCaptureCustody, readCaptureCustody, saveCaptureCustody, type OfapiCaptureCustody } from "../apps/dashboard/src/lib/ofapiCaptureCustody.ts";
import { clearEvidenceCustody, evidenceCustodyKey, parseEvidenceCustody, readEvidenceCustody, saveEvidenceCustody, type PendingOfapiEvidence } from "../apps/dashboard/src/lib/ofapiEvidenceCustody.ts";
import { marketingEvidenceFixture, marketingEvidenceFixtureNames } from "./fixtures/marketing-evidence.ts";

const api = vi.hoisted(() => ({ stored: vi.fn(), content: vi.fn(), webhook: vi.fn(), dictionary: vi.fn(), refresh: vi.fn(), marketing: vi.fn(), collection: vi.fn(), workspaces: new Map<string, unknown>() }));
vi.mock("../apps/dashboard/src/api/adminOfapiStoredReads.ts", () => ({ useAdminOfapiStoredReads: api.stored }));
vi.mock("../apps/dashboard/src/api/adminOfapiContentEvents.ts", () => ({ useAdminOfapiContentEvents: api.content }));
vi.mock("../apps/dashboard/src/api/adminOfapiWebhookRecovery.ts", () => ({ useOfapiWebhookRecovery: api.webhook, ofapiWebhookRecoveryActions: {} }));
vi.mock("../apps/dashboard/src/api/adminOfapiBannedWords.ts", () => ({ useAdminOfapiBannedWords: api.dictionary, useRefreshOfapiBannedWords: () => ({ isPending: false, mutateAsync: api.refresh }) }));
vi.mock("../apps/dashboard/src/api/ofapiMarketing.ts", () => ({ useOfapiMarketing: api.marketing, marketingActions: {} }));
vi.mock("../apps/dashboard/src/api/adminOfapiCollection.ts", () => ({ useAdminOfapiCollection: api.collection }));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({ useAuthMe: () => ({ data: { user: { id: 7 } } }) }));
vi.mock("../apps/dashboard/src/lib/useSessionWorkspace.ts", () => ({ useSessionWorkspace: (name: string, initial: () => unknown) => {
  const value = api.workspaces.has(name) ? api.workspaces.get(name) : initial();
  return [value, vi.fn(), () => value];
} }));
import { OfapiStoredReads } from "../apps/dashboard/src/pages/settings/OfapiStoredReads.tsx";
import { OfapiContentEvidence } from "../apps/dashboard/src/pages/settings/OfapiContentEvidence.tsx";
import { OfapiWebhookRecovery } from "../apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx";
import { OfapiBannedWords } from "../apps/dashboard/src/pages/settings/OfapiBannedWords.tsx";
import { OfapiMarketing } from "../apps/dashboard/src/pages/OfapiMarketing.tsx";

const id = "40000000-0000-4000-8000-000000000001";
const nextId = "40000000-0000-4000-8000-000000000002";
const pages = [{ id: 2, label: "demo-onlyfans" }, { id: 3, label: "demo-onlyfans-vip" }];
const query = (data: unknown, isError = false) => ({ data, isError, isLoading: data === undefined && !isError, isFetching: false, refetch: vi.fn() });
const fixture = (operation: string, params = new URLSearchParams(), mode = "normal") => marketingEvidenceFixture(operation, params, {}, {}, undefined, undefined, mode);
const render = (element: ReactElement, url = "/settings?tab=collection&page=demo-onlyfans") => renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [url] }, element));
const capture = (clientRequestId = id): Extract<OfapiCaptureCustody, { kind: "marketing" }> => ({ kind: "marketing", clientRequestId, pageLabel: "demo-onlyfans-vip", startedAt: "2026-09-11T10:00:00.000Z", body: { pageId: 3, category: "smart_links", expectedRevision: 7, maxCalls: 5, maxCredits: 10, maxBytes: 4_194_304, from: "2026-09-01T00:00:00.000Z", to: "2026-09-10T23:59:59.999Z", selection: ["smart_links"] } });
function installStorage() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  vi.stubGlobal("window", { sessionStorage: storage });
  return { values, storage };
}
function webhook(overrides: Partial<Record<"policy" | "catalog" | "history", unknown>> = {}) {
  return { policy: query(fixture("adminOfapiWebhookCollectionPolicy")), catalog: query(fixture("adminOfapiWebhookEventCatalog")), history: query(fixture("adminOfapiWebhookDeliveries")), isFetching: false, refetch: vi.fn(), ...overrides };
}
function marketingIntent() {
  const value = fixture("ofapiMarketingGet") as { intents: unknown[] };
  return ofapiMarketingIntentSchema.parse(value.intents[0]);
}
beforeEach(() => {
  vi.clearAllMocks(); api.workspaces.clear();
  api.stored.mockImplementation((pageId: number | undefined) => query(pageId ? fixture("ofapiReadCollectionsGet", new URLSearchParams({ pageId: String(pageId) })) : undefined));
  api.content.mockImplementation((pageId: number | undefined) => query(pageId ? fixture("ofapiContentEventsGet", new URLSearchParams({ pageId: String(pageId) })) : undefined));
  api.webhook.mockReturnValue(webhook()); api.dictionary.mockReturnValue(query(fixture("ofapiBannedWordsAdminGet")));
  api.marketing.mockReturnValue(query(fixture("ofapiMarketingGet"))); api.collection.mockReturnValue(query({ pages, revision: 7, backgroundPaused: false }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("bounded evidence navigation and truthful states", () => {
  it("keeps an unavailable explicit page unavailable in both local evidence views", () => {
    const url = "/settings?tab=collection&page=unavailable";
    expect(render(createElement(OfapiStoredReads, { pages }), url)).toContain("Выберите страницу для сохранённых данных");
    expect(render(createElement(OfapiContentEvidence, { pages }), url)).toContain("Выберите страницу для истории контента");
    expect(api.stored).toHaveBeenLastCalledWith(undefined, ""); expect(api.content).toHaveBeenLastCalledWith(undefined);
  });
  it("searches beyond the first hundred rows while preserving the requested account", () => {
    const html = render(createElement(OfapiStoredReads, { pages }), "/settings?page=demo-onlyfans-vip&storedQuery=пределами");
    expect(api.stored).toHaveBeenLastCalledWith(3, ""); expect(html).toContain("SYNTHETIC за пределами первых ста"); expect(html).not.toContain("synthetic-2-104");
  });
  it("does not substitute a different stored response for an explicit missing snapshot", () => {
    const html = render(createElement(OfapiStoredReads, { pages }), "/settings?page=demo-onlyfans&storedSnapshot=absent");
    expect(html).toContain("Выбранного ответа нет в текущей выборке"); expect(html).not.toContain("SYNTHETIC сохранённые сведения");
  });
  it("distinguishes absent membership previews from captured zero previews", () => {
    const html = render(createElement(OfapiStoredReads, { pages }));
    expect(html).toContain("превью: неизвестно"); expect(html).toContain("пользователей: 0 · превью: 0"); expect(html).toContain("Показать ещё 100 строк");
  });
  it("does not describe a failed initial read as a confirmed empty archive", () => {
    api.stored.mockReturnValue(query(undefined, true));
    const html = render(createElement(OfapiStoredReads, { pages }));
    expect(html).toContain("Повторить"); expect(html).not.toContain("Сохранённых ответов пока нет");
  });
  it("shows removal of a like and the evidence bound, rather than implying an active complete roster", () => {
    const html = render(createElement(OfapiContentEvidence, { pages }), "/settings?page=demo-onlyfans-vip&contentView=likes");
    expect(html).toContain("Лайк снят"); expect(html).toContain("post-3"); expect(html).toContain("полного состава лайков эта выборка не подтверждает"); expect(html).not.toContain("queue-3");
  });
  it("keeps history and filters available when the independent policy and catalog reads fail", () => {
    api.webhook.mockReturnValue(webhook({ policy: query(undefined, true), catalog: query(undefined, true) }));
    const html = render(createElement(OfapiWebhookRecovery), "/settings?webhookOffset=25&webhookFailed=true&webhookQuery=event_1");
    expect(api.webhook).toHaveBeenLastCalledWith({ offset: 25, failedOnly: true });
    expect(html).toContain("Политика событий недоступна"); expect(html).toContain("synthetic.event_1"); expect(html).toContain("Только неуспешные доставки"); expect(html).toContain("число неизвестно");
  });
  it("freezes edited webhook groups to their original version while polling returns a newer policy", () => {
    api.workspaces.set("ofapi-webhook-recovery", { draft: { version: 6, groups: ["engagement"], historyEnabled: false }, busy: false, message: null, error: "", preview: null, scan: null, custodyError: "" });
    const html = render(createElement(OfapiWebhookRecovery));
    expect(html).toContain("Черновик привязан к прежней версии"); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Сохранить выбор<\/button>/); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Применить события/);
  });
  it("does not call an unread dictionary empty and retains its bounded entries", () => {
    api.dictionary.mockReturnValue(query(undefined, true));
    const failed = render(createElement(OfapiBannedWords)); expect(failed).not.toContain("Словарь ещё не собирался"); expect(failed).toContain("Повторить");
    api.dictionary.mockReturnValue(query(null)); expect(render(createElement(OfapiBannedWords))).toContain("Словарь ещё не собирался");
    api.dictionary.mockReturnValue(query(fixture("ofapiBannedWordsAdminGet"))); const loaded = render(createElement(OfapiBannedWords)); expect(loaded).toContain("частичный обход"); expect(loaded).toContain("SYNTHETIC alternative");
  });
});

describe("non-idempotent bounded capture custody", () => {
  it("restores the exact page, revision, limits and dates, scoped to the current owner", () => {
    const record = capture(); const raw = JSON.stringify({ version: 1, ownerId: 7, record });
    expect(parseCaptureCustody(raw, 7, "marketing")).toEqual(record);
    expect(() => parseCaptureCustody(raw, 8, "marketing")).toThrow(); expect(() => parseCaptureCustody(raw, 7, "dictionary")).toThrow();
    expect(() => parseCaptureCustody(JSON.stringify({ version: 1, ownerId: 7, record: { ...record, body: { ...record.body, maxCalls: 0 } } }), 7, "marketing")).toThrow();
  });
  it("archives the unknown request only after an explicit acknowledgement and never loses a newer marker to a late clear", () => {
    installStorage(); const previous = capture(); saveCaptureCustody(7, previous);
    expect(readCaptureCustody(7, "marketing")).toMatchObject({ record: previous, history: [] });
    expect(acknowledgeCaptureCustody(7, previous)).toEqual([previous]);
    const next = capture(nextId); saveCaptureCustody(7, next); clearCaptureCustody(7, previous);
    expect(readCaptureCustody(7, "marketing")).toMatchObject({ record: next, history: [previous] });
    clearCaptureCustody(7, next); expect(readCaptureCustody(7, "marketing")).toMatchObject({ record: null, history: [previous] });
  });
  it("requires storage admission before a non-idempotent POST while allowing failed-storage reads", () => {
    vi.stubGlobal("window", { sessionStorage: { setItem: () => { throw new Error("unavailable"); }, getItem: () => { throw new Error("unavailable"); } } });
    const send = vi.fn(); expect(() => { saveCaptureCustody(7, capture()); send(); }).toThrow(); expect(send).not.toHaveBeenCalled();
    expect(readCaptureCustody(7, "marketing").error).toContain("чтение сохранённых данных работает");
  });
  it("reloads a sent dictionary read as unknown, without restarting it or carrying an acknowledgement", () => {
    installStorage(); saveCaptureCustody(7, { kind: "dictionary", clientRequestId: id, startedAt: "2026-09-11T10:00:00.000Z", maxPages: 8 });
    const html = render(createElement(OfapiBannedWords)); expect(html).toContain("Результат сбора неизвестен"); expect(html).toContain('value="8"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Перейти к проверке нового сбора<\/button>/); expect(api.refresh).not.toHaveBeenCalled();
  });
  it("rejects corrupted pending data without pretending no operation was sent", () => {
    const { storage } = installStorage(); storage.setItem(captureCustodyKey(7, "marketing"), "{corrupted");
    expect(readCaptureCustody(7, "marketing").error).toContain("Новая отправка недоступна");
  });
});

describe("prepared actions and paid redelivery custody", () => {
  it("freezes a preparation ID and exact command despite later edits to the form", () => {
    const form = { ...newMarketingForm("postback_create", 3), scope: "global" as const, url: "https://example.test/receive", headers: [{ name: "Authorization", value: "synthetic-private-value" }] };
    const pending = createMarketingPreparation(form, id); form.headers[0]!.value = "changed"; form.url = "https://other.test";
    expect(pending.id).toBe(id); expect(pending.command).toMatchObject({ url: "https://example.test/receive", headers: [{ name: "Authorization", value: "synthetic-private-value" }] });
  });
  it("keeps network, server and invalid-success outcomes uncertain; a definite 4xx can be corrected", () => {
    expect(marketingFailureUncertain(new Error("network"))).toBe(true);
    expect(marketingFailureUncertain(new KernelApiError("bad payload", "contract", 200, null, null))).toBe(true);
    expect(marketingFailureUncertain(new KernelApiError("unknown", "server", 503, null, null))).toBe(true);
    expect(marketingFailureUncertain(new KernelApiError("revision changed", "conflict", 409, null, null))).toBe(false);
    expect(marketingMatches("0", null, 0)).toBe(true); expect(marketingMatches(" absent ", null, undefined)).toBe(false);
  });
  it.each([403, 404, 409])("does not turn an older unknown send into a refusal when recovery returns %i", status => {
    const laterRefusal = new KernelApiError("Access or policy changed", "http", status, null, null);
    expect(marketingFailureUncertain(laterRefusal, false)).toBe(false);
    expect(marketingFailureUncertain(laterRefusal, true)).toBe(true);
  });
  it("restores the same safe intent and allows collapsing the review while keeping a new action unavailable", () => {
    installStorage(); const intent = marketingIntent(); const pending: PendingOfapiEvidence = { kind: "marketing", requestId: id, intent }; saveEvidenceCustody(7, pending);
    const html = render(createElement(OfapiMarketing), "/ofapi-marketing?page=demo-onlyfans-vip");
    expect(html).toContain(intent.id); expect(html).toContain("Запросить исход того же действия"); expect(html).toContain("Свернуть"); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Создать ссылку<\/button>/);
    expect(parseEvidenceCustody(JSON.stringify({ version: 1, ownerId: 7, request: pending }), 7, "marketing")).toEqual(pending);
    expect(() => parseEvidenceCustody(JSON.stringify({ version: 1, ownerId: 7, request: pending }), 8, "marketing")).toThrow();
  });
  it("keeps a paid redelivery target visible even when every local read fails, without any automatic replay", () => {
    installStorage(); saveEvidenceCustody(7, { kind: "redelivery", requestId: id, id: nextId, attemptId: 101 });
    api.webhook.mockReturnValue(webhook({ policy: query(undefined, true), catalog: query(undefined, true), history: query(undefined, true) }));
    const html = render(createElement(OfapiWebhookRecovery)); expect(html).toContain(nextId); expect(html).toContain("Повтор попытки 101"); expect(html).toContain("Проверить сохранённый исход · без отправки"); expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Запросить платный повтор<\/button>/);
  });
  it("does not let an old redelivery completion clear a newer operation in the same owner session", () => {
    const { storage } = installStorage(); const old: PendingOfapiEvidence = { kind: "redelivery", requestId: id, id, attemptId: 101 }; const next: PendingOfapiEvidence = { kind: "redelivery", requestId: nextId, id: nextId, attemptId: 102 };
    saveEvidenceCustody(7, old); saveEvidenceCustody(7, next); clearEvidenceCustody(7, old); expect(readEvidenceCustody(7, "redelivery").request).toEqual(next);
    storage.setItem(evidenceCustodyKey(7, "redelivery"), "{broken"); expect(readEvidenceCustody(7, "redelivery").error).toContain("Новая отправка недоступна");
  });
});

describe("synthetic preview response contracts", () => {
  it.each(marketingEvidenceFixtureNames)("provides a valid %s fixture without reaching a provider", operation => {
    const body = operation === "ofapiMarketingPrepare" ? { id, command: { action: "smart_link_create", pageId: 2, name: "Synthetic", link_type: "tracking_link" } } : operation === "adminOfapiWebhookRedeliver" ? { id, attemptId: 101, dryRun: true } : {};
    const response = marketingEvidenceFixture(operation, new URLSearchParams(), {}, body);
    expect(routeSchemas[operation].response[200].safeParse(response).success).toBe(true);
  });
});
