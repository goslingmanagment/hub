import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { Badge, Button, Drawer, Table, type Column } from "@agency_hub_core/ui";
import { formatCount, formatPercent, formatWeekdayDay, formatWindowRange } from "@agency_hub_core/ui/format";
import {
  AUTHORSHIP_GOAL_PERCENT,
  aboveGoal,
  useAuthorship,
  withoutAuthorPercent,
  type AuthorshipCounts,
  type AuthorshipPage,
  type AuthorshipState,
} from "./data.js";

/** «8 % · 161»: the share without an author and how many; «—» with nothing to count. */
function withoutAuthor(all: number, authored: number): string {
  if (all === 0) return "—";
  const without = all - authored;
  return `${formatPercent((100 * without) / all)} · ${formatCount(without)}`;
}

function percentText(value: number | null): string {
  return value === null ? "—" : formatPercent(value);
}

/** The drawer's address: `?authors=1` (a link opens it, «←» closes it). */
function useOpen(): [boolean, (open: boolean) => void] {
  const [search, setSearch] = useSearchParams();
  const open = search.get("authors") === "1";
  const set = (next: boolean) => setSearch((current) => {
    const updated = new URLSearchParams(current);
    if (next) updated.set("authors", "1");
    else updated.delete("authors");
    return updated;
  });
  return [open, set];
}

/**
 * «Сообщения без автора» (the console's AuthorlessCard): a check that the
 * extension tells Hub who wrote each message, not a number of the shifts. One
 * quiet line under the journal — a warning only when a page is above the 5 %
 * goal — and the table in a side panel. Hub counts it only back from today
 * (≤ 7 days), so it shows only while the period goes on, with its own dates.
 */
export function AuthorlessLine({ days, page, enabled }: { days: number; page: string | null; enabled: boolean }) {
  const { state, query } = useAuthorship(days, page, enabled);
  const [open, setOpen] = useOpen();
  if (!enabled) return null;
  if (!state) {
    if (!query.isError) return null;
    return (
      <p className="shifts-authors">
        <span aria-hidden className="shifts-authors__dot" />
        <span>Сообщения без автора: Hub не ответил.</span>
        <Button size="sm" variant="ghost" loading={query.isFetching} onClick={() => void query.refetch()}>
          {query.isFetching ? "Повторяем…" : "Повторить"}
        </Button>
      </p>
    );
  }
  // Nothing left while the extension was open: nothing to hold against the goal.
  if (state.total.personal === 0 || state.inShiftPercent === null) return null;

  const dates = formatWindowRange(state.from, state.to);
  const warn = state.above.length > 0;
  return (
    <>
      <p className={warn ? "shifts-authors shifts-authors--warn" : "shifts-authors"}>
        <span aria-hidden className="shifts-authors__dot" />
        <span>
          {warn ? (
            <>
              Без автора ушло {state.above.map((one) => `${percentText(withoutAuthorPercent(one.total))} сообщений ${one.pageLabel}`).join(", ")}
              {" "}за {dates} — выше цели {AUTHORSHIP_GOAL_PERCENT} %.
            </>
          ) : (
            <>
              Сообщения без автора: {percentText(state.inShiftPercent)} за {dates}, в пределах цели {AUTHORSHIP_GOAL_PERCENT} %.
            </>
          )}
        </span>
        <button type="button" className="shifts-authors__more" onClick={() => setOpen(true)}>
          Подробнее
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </p>
      <AuthorlessDrawer open={open} onClose={() => setOpen(false)} state={state} dates={dates} />
    </>
  );
}

function CountsCells({ counts }: { counts: AuthorshipCounts }) {
  return (
    <>
      <span>{withoutAuthor(counts.inShift, counts.inShiftAuthored)}</span>
      {aboveGoal(counts) && <Badge tone="warning" bare>выше цели</Badge>}
    </>
  );
}

function AuthorlessDrawer({ open, onClose, state, dates }: { open: boolean; onClose: () => void; state: AuthorshipState; dates: string }) {
  const [picked, setPicked] = useState<string | null>(null);
  const selected = state.pages.find((one) => one.pageLabel === picked) ?? null;
  const columns: Column<AuthorshipPage>[] = [
    { key: "page", header: "Страница", nowrap: true, cell: (one) => one.pageLabel },
    { key: "personal", header: "Личных", title: "Личных сообщений страницы: не рассылка", numeric: true, cell: (one) => formatCount(one.total.personal) },
    { key: "all", header: "Без автора, всего", headerWrap: true, numeric: true, cell: (one) => withoutAuthor(one.total.personal, one.total.authored) },
    {
      key: "open",
      header: "При открытом расширении",
      headerWrap: true,
      numeric: true,
      title: "Без автора из тех, что ушли, пока у кого-то было открыто расширение: с этим сравнивается цель",
      cell: (one) => <span className="shifts-authors__cell"><CountsCells counts={one.total} /></span>,
    },
    {
      key: "who",
      header: "Кто писал",
      cell: (one) => (one.authors.length === 0 ? <span className="ui-muted">—</span> : (
        <span className="shifts-authors__who">
          {one.authors.map((author) => (
            <span key={author.userId} className="shifts-authors__author">
              {author.username} <span className="ui-muted">{formatCount(author.messages)}</span>
            </span>
          ))}
        </span>
      )),
    },
  ];
  const dayColumns: Column<AuthorshipPage["days"][number]>[] = [
    { key: "day", header: "День", nowrap: true, cell: (day) => formatWeekdayDay(day.day) },
    { key: "personal", header: "Личных", numeric: true, cell: (day) => formatCount(day.personal) },
    { key: "all", header: "Без автора, всего", headerWrap: true, numeric: true, cell: (day) => withoutAuthor(day.personal, day.authored) },
    { key: "open", header: "При открытом расширении", headerWrap: true, numeric: true, cell: (day) => <span className="shifts-authors__cell"><CountsCells counts={day} /></span> },
  ];

  return (
    <Drawer open={open} onClose={onClose} title="Сообщения без автора" subtitle={dates} width={820}>
      <div className="shifts-drawer">
        <p className="shifts-drawer__lead">
          Сколько личных сообщений страницы ушло без автора — Hub не знает, кто из чаттеров их написал. Цель: не больше
          {" "}{AUTHORSHIP_GOAL_PERCENT} % из тех, что ушли, пока у кого-то было открыто расширение. Без автора смена
          недосчитывает сообщения и продажи.
        </p>
        <Table
          label="Сообщения без автора по страницам"
          columns={columns}
          rows={state.pages}
          rowKey={(one) => one.pageLabel}
          onRowClick={(one) => setPicked((was) => (was === one.pageLabel ? null : one.pageLabel))}
          selectedKey={picked}
          stickyHeader={false}
        />
        {selected ? (
          <section className="shifts-drawer__days" aria-label={`${selected.pageLabel} по дням`}>
            <h3 className="shifts-drawer__title">{selected.pageLabel} по дням</h3>
            <Table label={`${selected.pageLabel} по дням`} columns={dayColumns} rows={selected.days} rowKey={(day) => day.day} stickyHeader={false} />
          </section>
        ) : (
          <p className="shifts-drawer__hint">Нажмите на страницу, чтобы увидеть её по дням.</p>
        )}
      </div>
    </Drawer>
  );
}
