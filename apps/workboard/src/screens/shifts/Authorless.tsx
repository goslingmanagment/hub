import { ChevronRight } from "lucide-react";
import { useSearchParams } from "react-router";
import { Badge, Button, Drawer, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatCount, formatPercent, formatWeekdayDay, formatWindowRange } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
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

/**
 * The drawer in the address: `?authors=1` open, `?authors=mia-3` open on that
 * page by day (a link opens it as it was, «←» closes it).
 */
function useAuthorsAddress(): { open: boolean; picked: string | null; set: (value: string | null) => void } {
  const [search, setSearch] = useSearchParams();
  const value = search.get("authors");
  const set = (next: string | null) => setSearch((current) => {
    const updated = new URLSearchParams(current);
    if (next === null) updated.delete("authors");
    else updated.set("authors", next);
    return updated;
  }, { preventScrollReset: true });
  return { open: value !== null, picked: value !== null && value !== "1" ? value : null, set };
}

/**
 * «Сообщения без автора» (the console's AuthorlessCard): a check that the
 * extension tells Hub who wrote each message, not a number of the shifts. One
 * quiet line under the journal — a warning only when a page is above the 5 %
 * goal — and the table in a side panel. Hub counts it only back from today
 * (≤ 7 days), so it shows only while the period goes on, with its own dates.
 */
export function AuthorlessLine({ days, page, enabled, partial }: {
  days: number;
  page: string | null;
  enabled: boolean;
  /** The screen's period is longer than Hub reads here: say «за последние 7 дней», not a period of its own. */
  partial: boolean;
}) {
  const { state, query } = useAuthorship(days, page, enabled);
  const address = useAuthorsAddress();
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
  const when = partial ? `за последние ${days} ${ruPlural(days, "день", "дня", "дней")} (${dates})` : `за ${dates}`;
  const warn = state.above.length > 0;
  return (
    <>
      <p className={warn ? "shifts-authors shifts-authors--warn" : "shifts-authors"}>
        <span aria-hidden className="shifts-authors__dot" />
        <span>
          {warn ? (
            <>
              Без автора ушло {state.above.map((one) => `${percentText(withoutAuthorPercent(one.total))} сообщений ${one.pageLabel}`).join(", ")}
              {" "}{when} — выше цели {AUTHORSHIP_GOAL_PERCENT} %.
            </>
          ) : (
            <>
              Сообщения без автора: {percentText(state.inShiftPercent)} {when}, в пределах цели {AUTHORSHIP_GOAL_PERCENT} %.
            </>
          )}
        </span>
        <button type="button" className="shifts-authors__more" onClick={() => address.set("1")}>
          Подробнее
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </p>
      <AuthorlessDrawer
        open={address.open}
        picked={address.picked}
        onPick={(label) => address.set(label ?? "1")}
        onClose={() => address.set(null)}
        state={state}
        dates={dates}
      />
    </>
  );
}

/**
 * «8 % · 161» of what left while the extension was open (the goal is held
 * against this), «выше цели» past it; all of the page's messages on hover.
 */
function WithoutAuthorCell({ counts }: { counts: AuthorshipCounts }) {
  return (
    <Tooltip content={`Всего без автора за эти дни, считая ушедшие без открытого расширения: ${withoutAuthor(counts.personal, counts.authored)}`} align="end">
      <span className="shifts-authors__cell">
        {aboveGoal(counts) && <Badge tone="warning" bare>выше цели</Badge>}
        <span>{withoutAuthor(counts.inShift, counts.inShiftAuthored)}</span>
      </span>
    </Tooltip>
  );
}

const WITHOUT_AUTHOR_HINT = `Из личных сообщений, что ушли, пока у кого-то было открыто расширение: с этим сравнивается цель ${AUTHORSHIP_GOAL_PERCENT} %. Всего без автора — по наведению на число.`;

function AuthorlessDrawer({ open, picked, onPick, onClose, state, dates }: {
  open: boolean;
  picked: string | null;
  onPick: (label: string | null) => void;
  onClose: () => void;
  state: AuthorshipState;
  dates: string;
}) {
  const selected = state.pages.find((one) => one.pageLabel === picked) ?? null;
  const columns: Column<AuthorshipPage>[] = [
    { key: "page", header: "Страница", nowrap: true, cell: (one) => one.pageLabel },
    { key: "personal", header: "Личных", hint: "Личных сообщений страницы: не рассылка", numeric: true, cell: (one) => formatCount(one.total.personal) },
    { key: "open", header: "Без автора", hint: WITHOUT_AUTHOR_HINT, numeric: true, cell: (one) => <WithoutAuthorCell counts={one.total} /> },
    {
      key: "who",
      header: "Кто писал",
      grow: true,
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
    { key: "open", header: "Без автора", hint: WITHOUT_AUTHOR_HINT, numeric: true, cell: (day) => <WithoutAuthorCell counts={day} /> },
  ];

  return (
    <Drawer open={open} onClose={onClose} title="Сообщения без автора" subtitle={dates} size="lg">
      <div className="shifts-drawer">
        <p className="shifts-drawer__lead">
          Сообщения без автора — личные сообщения страницы, про которые Hub не знает, кто из чаттеров их написал. Цель: не
          больше {AUTHORSHIP_GOAL_PERCENT} % из тех, что ушли, пока у кого-то было открыто расширение. Без автора смена
          недосчитывает сообщения и продажи.
        </p>
        <Table
          label="Сообщения без автора по страницам"
          columns={columns}
          rows={state.pages}
          rowKey={(one) => one.pageLabel}
          onRowClick={(one) => onPick(picked === one.pageLabel ? null : one.pageLabel)}
          selectedKey={picked}
          align="first-line"
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
