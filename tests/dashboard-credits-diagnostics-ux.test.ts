import type * as ReactModule from "react";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
const queries = vi.hoisted(() => ({ useAdminOfapiCreditsSummary: vi.fn(), useAdminOfapiCreditsDaily: vi.fn(), useAdminOfapiCreditsLedger: vi.fn(), useAdminQueueJobs: vi.fn(), useAdminIncidents: vi.fn(), downloadCsv: vi.fn() }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof ReactModule>(),
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
  useRef(initial: unknown) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: initial }; return hooks.values[index]; },
  useId: () => "synthetic-detail",
  useMemo: (calculate: () => unknown) => calculate(),
  useEffect: () => undefined,
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);
vi.mock("../apps/dashboard/src/api/adminOfapiCredits.ts", () => ({ downloadOfapiCreditsLedgerCsv: queries.downloadCsv }));
vi.mock("../apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx", () => ({ OfapiWebhookRecovery: () => null }));
vi.mock("../apps/dashboard/src/pages/settings/OfapiBannedWords.tsx", () => ({ OfapiBannedWords: () => null }));
vi.mock("react-router", () => ({ Link: "a" }));
import { creditLedgerDateRange } from "../apps/dashboard/src/lib/creditsNavigation.ts";
import { OfapiCreditsPage } from "../apps/dashboard/src/pages/OfapiCreditsPage.tsx";
import { QueuePage } from "../apps/dashboard/src/pages/dev/QueuePage.tsx";
import { IncidentsPage } from "../apps/dashboard/src/pages/dev/IncidentsPage.tsx";

type Element = ReactElement<Record<string, unknown>>;
function find(node: ReactNode, matches: (element: Element) => boolean): Element {
  const queue: ReactNode[] = [node];
  while (queue.length) {
    const child = queue.shift();
    if (Array.isArray(child)) { queue.push(...child); continue; }
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (matches(child)) return child;
    queue.push(child.props.children as ReactNode);
  }
  throw new Error("Control not found");
}
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function draw(component: () => ReactNode) { hooks.cursor = 0; return component(); }
function change(element: Element, value: string) { (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function click(element: Element) { return (element.props.onClick as (event: { stopPropagation: () => void }) => Promise<void> | void)({ stopPropagation: vi.fn() }); }
const ready = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });
const job = { id: "synthetic-first", name: "First job", state: "failed", data: { scope: "first-data" }, output: { error: "first-output" }, createdOn: "2026-09-11T00:00:00Z", startedOn: null, completedOn: null, retryCount: 0 };

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; vi.resetAllMocks();
  queries.useAdminOfapiCreditsSummary.mockReturnValue(ready({
    enabled: true, balance: { value: 1000, observedAt: "2026-09-11T00:00:00Z" },
    today: { day: "2026-09-11", total: 0, bySource: { rest: 0, webhookAccrual: 0, external: 0, adjustment: 0 } },
    budgets: [], floor: { value: 0, blocked: false }, forecast: { avgDailySpend7d: 0, daysLeft: null, runOutDate: null }, incidents: [], reconciliation: { lastRunAt: null, lastDriftCredits: null }, accrual: { lastPostedDay: null },
  }));
  queries.useAdminOfapiCreditsDaily.mockReturnValue(ready({ days: [], balance: [], refills: [], byOperation: [], byPage: [] }));
  queries.useAdminOfapiCreditsLedger.mockReturnValue(ready({ total: 1, pageOptions: [], rows: [{ id: 1 }] }));
  queries.useAdminQueueJobs.mockReturnValue(ready([job, { ...job, id: "synthetic-second", name: "Second job", data: null, output: null }]));
  queries.useAdminIncidents.mockReturnValue(ready({ summary: [{ code: "synthetic-code", severity: "error", count: 123 }], items: [] }));
});

describe("credit ledger dates and export", () => {
  it("keeps inclusive UTC end dates and rejects inverted or invalid ranges", () => {
    expect(creditLedgerDateRange("2026-09-11", "2026-09-11")).toEqual({ from: "2026-09-11T00:00:00.000Z", to: "2026-09-12T00:00:00.000Z", error: null });
    expect(creditLedgerDateRange("", "2024-02-29")).toEqual({ from: undefined, to: "2024-03-01T00:00:00.000Z", error: null });
    expect(creditLedgerDateRange("2026-09-12", "2026-09-11").error).toContain("раньше");
    expect(creditLedgerDateRange("2026-02-30", "").error).toContain("корректные даты");
  });

  it("blocks the query and CSV for an inverted range, then exports the corrected exact filters", async () => {
    change(find(draw(OfapiCreditsPage), (element) => element.props["aria-label"] === "Дата с (UTC)"), "2026-09-12");
    change(find(draw(OfapiCreditsPage), (element) => element.props["aria-label"] === "Дата по (UTC)"), "2026-09-11");
    const invalid = draw(OfapiCreditsPage);
    expect(queries.useAdminOfapiCreditsLedger).toHaveBeenLastCalledWith(expect.any(Object), { enabled: false });
    expect(textOf(invalid)).toContain("Поля сохранены; журнал и экспорт будут доступны после исправления");
    expect(textOf(invalid)).not.toContain("Под текущие фильтры не попало");
    const exportButton = find(invalid, (element) => element.type === "button" && textOf(element) === "Экспорт CSV");
    expect(exportButton.props.disabled).toBe(true);
    await click(exportButton); expect(queries.downloadCsv).not.toHaveBeenCalled();
    change(find(invalid, (element) => element.props["aria-label"] === "Дата по (UTC)"), "2026-09-12");
    change(find(draw(OfapiCreditsPage), (element) => element.props["aria-label"] === "Фильтр по источнику"), "rest");
    queries.downloadCsv.mockResolvedValue({ rowCount: 1, truncated: false });
    await click(find(draw(OfapiCreditsPage), (element) => element.type === "button" && textOf(element) === "Экспорт CSV"));
    expect(queries.useAdminOfapiCreditsLedger).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2026-09-12T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z", source: "rest" }), { enabled: true });
    expect(queries.downloadCsv).toHaveBeenCalledExactlyOnceWith({ source: "rest", from: "2026-09-12T00:00:00.000Z", to: "2026-09-13T00:00:00.000Z" });
  });
});

describe("diagnostic detail placement and scope", () => {
  it("inserts a job detail row immediately after its controlling row, before the next job", async () => {
    await click(find(draw(QueuePage), (element) => element.props["aria-label"] === "Details for First job"));
    const body = find(draw(QueuePage), (element) => element.type === "tbody");
    const groups = Children.toArray(body.props.children as ReactNode) as Element[];
    expect(groups).toHaveLength(2);
    const firstRows = Children.toArray(groups[0]!.props.children as ReactNode) as Element[];
    expect(firstRows).toHaveLength(2);
    expect(firstRows[0]!.type).toBe("tr"); expect(firstRows[1]!.type).toBe("tr");
    expect(textOf(firstRows[1])).toContain("first-data"); expect(textOf(firstRows[1])).toContain("first-output");
    const control = find(firstRows[0], (element) => element.type === "button");
    expect(control.props["aria-controls"]).toBe(firstRows[1]!.props.id);
    expect(textOf(groups[1])).toContain("Second job"); expect(textOf(groups[1])).not.toContain("first-output");
  });

  it("labels independent seven-day summary counts and the bounded all-time filtered incident list", async () => {
    let tree = draw(IncidentsPage);
    expect(textOf(tree)).toContain("за последние 7 дней");
    expect(textOf(tree)).toContain("До 20 групп");
    expect(textOf(tree)).toContain("До 100 последних событий за всё время");
    await click(find(tree, (element) => element.type === "button" && textOf(element).includes("synthetic-code")));
    tree = draw(IncidentsPage);
    expect(queries.useAdminIncidents).toHaveBeenLastCalledWith({ code: "synthetic-code", limit: 100 });
    expect(textOf(tree)).toContain("за всё время с кодом synthetic-code");
    expect(textOf(tree)).toContain("не меняются от фильтра журнала");
    expect(textOf(tree)).toContain("123");
  });
});
