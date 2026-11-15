import { useLocation, useSearchParams } from "react-router";
import { Button, EmptyState, ErrorState, Tabs } from "@agency_hub_core/ui";
import { carryParams } from "@/shared/links";
import { useMe } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { LedgerPayouts, LedgerPersonDrawer, LedgerSkeleton } from "./LedgerPayouts";
import { ReportsSkeleton, ReportsView } from "./ReportsView";
import { useLedgerPayouts, useLedgerReports } from "./ledger";
import "./payouts.css";

/**
 * Деньги → Долги, Отчёты (it was «Выплаты» at `/payouts`; spec §4.7 r5: money comes from ledger) — the owner's one
 * place for what people are owed and why. Two tabs, each its own address (`/money/debts`, `/money/reports`):
 *   - «Долги»: what each person accrued and was paid in the period and what the
 *     agency owes them now (`?person=` opens one, with the days and where each
 *     day's amount came from, a day with a report opening to it);
 *   - «Отчёты»: every chatter's shift report of the period — posted, changed by
 *     hand, composed and not posted, written without the agent, or a post the
 *     ledger could not parse (`?questions=1` leaves the ones worth a look); the
 *     page filter narrows them.
 * Salaries never reach anyone but the owner: a team lead is told so and asks
 * for nothing.
 */

type View = "debts" | "reports";

const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: "debts", label: "Долги" },
  { value: "reports", label: "Отчёты" },
];

export function PayoutsScreen() {
  const { isOwner } = useMe();
  const { period, setPeriod } = usePeriod();
  const { page } = usePageFilter();
  const [search, setSearch] = useSearchParams();
  const location = useLocation();
  const view: View = location.pathname.replace(/\/+$/, "").endsWith("/reports") ? "reports" : "debts";
  const questionsOnly = search.get("questions") === "1";
  const ledger = useLedgerPayouts(period);
  const reports = useLedgerReports(period, view === "reports");

  const setParam = (name: string, value: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (value === null) next.delete(name);
    else next.set(name, value);
    return next;
  });
  const personSlug = search.get("person");
  const openPerson = ledger.view?.rows.find((row) => row.person.slug === personSlug) ?? null;

  // The tabs carry the period and the page, not the person (the panel belongs to «Долги») nor the questions' filter.
  const carried = carryParams(location.search).toString();
  const tabs = <Tabs label="Разделы" items={VIEWS.map((option) => ({ to: { pathname: `/money/${option.value}`, search: carried ? `?${carried}` : "" }, label: option.label }))} />;

  if (!isOwner) {
    return (
      <>
        <ScreenHeader title="Деньги" />
        <div className="wb-content">
          <EmptyState title="Долги и отчёты видит только владелец" className="payouts-empty">
            Начисления и долги людям считает ledger агентства, и показывает их только владельцу.
          </EmptyState>
        </div>
      </>
    );
  }

  const read = view === "debts" ? ledger.query : reports.query;
  const problem = ledger.problem;
  let body;
  if (problem !== null) {
    body = (
      <EmptyState
        title={problem}
        className="payouts-empty"
        action={<Button onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать последние 30 дней</Button>}
      >
        Неделя, 14 и 30 дней подходят всегда.
      </EmptyState>
    );
  } else if (view === "debts") {
    body = ledger.view ? <div className="payouts-ledger"><LedgerPayouts view={ledger.view} selected={openPerson?.person.slug ?? null} onOpen={(slug) => setParam("person", slug)} /></div>
      : ledger.query.isError ? <Unavailable unavailable={ledger.unavailable} onRetry={() => void ledger.query.refetch()} retrying={ledger.query.isFetching} />
        : <div className="payouts-ledger"><LedgerSkeleton /></div>;
  } else {
    body = reports.data ? (
      <ReportsView
        data={reports.data}
        from={period.from}
        to={period.to}
        page={page}
        sheetsPay={ledger.view !== null && ledger.view.reportsFrom === null}
        questionsOnly={questionsOnly}
        onQuestionsOnly={(on) => setParam("questions", on ? "1" : null)}
      />
    ) : reports.query.isError ? <Unavailable unavailable={reports.unavailable} onRetry={() => void reports.query.refetch()} retrying={reports.query.isFetching} />
      : <ReportsSkeleton />;
  }

  return (
    <>
      <ScreenHeader
        title="Деньги"
        period
        pageFilter={view === "reports"}
        tabs={tabs}
        {...(read.dataUpdatedAt ? { updatedAt: read.dataUpdatedAt } : {})}
        onRefresh={() => void read.refetch()}
        refreshing={read.isFetching}
        stale={read.isRefetchError}
      />
      <div className="wb-content payouts">{body}</div>
      {view === "debts" && openPerson && ledger.view && (
        <LedgerPersonDrawer key={openPerson.person.slug} row={openPerson} view={ledger.view} period={period} onClose={() => setParam("person", null)} />
      )}
    </>
  );
}

/** The ledger did not answer: no numbers, not zeros. */
function Unavailable({ unavailable, onRetry, retrying }: { unavailable: boolean; onRetry: () => void; retrying: boolean }) {
  if (!unavailable) return <ErrorState onRetry={onRetry} retrying={retrying} />;
  return (
    <ErrorState title="Ledger не ответил" onRetry={onRetry} retrying={retrying}>
      Долги и отчёты считает ledger агентства; сейчас он недоступен. Это не ноль: цифр просто нет.
    </ErrorState>
  );
}
