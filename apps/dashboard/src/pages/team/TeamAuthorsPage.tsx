import { Fragment } from "react";
import { useSearchParams } from "react-router";
import type { TeamAuthorshipResponse } from "@agency_hub_core/contracts";
import { useTeamAuthorship } from "@/api/team";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatBusinessDateShort } from "@/lib/format";

/**
 * Chat Memory week 1: how many of each page's outgoing messages have an author
 * (`teamAuthorship`), per day. Read-only; the owner and team leads. The goal
 * of the roadmap: at least 95 % with an author among those sent while someone
 * worked in the extension.
 */

const RANGES = [
  { key: "1", label: "Сегодня" },
  { key: "3", label: "3 дня" },
  { key: "7", label: "7 дней" },
] as const;

const HOW_IT_WORKS = [
  "Автор — сотрудник, из чьего браузера с расширением ChatGoose ушло сообщение. Hub узнаёт его из запроса, который "
    + "страница уже отправила, и привязывает к сообщению по его id.",
  "Считаются личные сообщения: без рассылок Fansly и без одинакового текста, ушедшего пяти и больше фанам за час "
    + "(так выглядят рассылки OnlyMonster). Без автора остаются сообщения с телефона, из браузера без расширения и "
    + "из старых версий расширения.",
  "«В смену» — сообщения, ушедшие, когда у кого-то из команды было открыто расширение на этой странице. Цель — "
    + "без автора не больше 5 % из них.",
];

const HEAD_CELL = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const NUM_HEAD = "whitespace-nowrap px-3 py-2 text-right text-xs font-medium text-text-muted xl:px-4";
const CELL = "px-3 py-2 align-top text-text-secondary xl:px-4";
const NUM = "px-3 py-2 align-top text-right tabular-nums text-text-secondary xl:px-4";
const NUM_MAIN = "px-3 py-2 align-top text-right tabular-nums font-medium text-text-primary xl:px-4";

type Counts = TeamAuthorshipResponse["pages"][number]["total"];

/** "12 % · 40" — the share without an author and how many; "—" when there is nothing to count. */
export function withoutAuthor(personal: number, authored: number): string {
  if (personal === 0) return "—";
  const without = personal - authored;
  return `${Math.round((100 * without) / personal)} % · ${without}`;
}

function Row({ label, counts, main, authors }: { label: string; counts: Counts; main: boolean; authors?: TeamAuthorshipResponse["pages"][number]["authors"] }) {
  const num = main ? NUM_MAIN : NUM;
  return (
    <tr className={main ? "border-t border-border" : ""}>
      <td className={main ? `${CELL} font-medium text-text-primary` : `${CELL} pl-6 xl:pl-8`}>{label}</td>
      <td className={num}>{counts.personal}</td>
      <td className={num}>{withoutAuthor(counts.personal, counts.authored)}</td>
      <td className={num}>{withoutAuthor(counts.inShift, counts.inShiftAuthored)}</td>
      <td className={CELL}>
        {authors?.map((author) => (
          <div key={author.userId} className="whitespace-nowrap">
            {author.username} <span className="text-text-muted">· {author.messages}</span>
          </div>
        ))}
      </td>
    </tr>
  );
}

export function TeamAuthorsPage() {
  const [search, setSearch] = useSearchParams();
  const range = RANGES.some((item) => item.key === search.get("days")) ? search.get("days")! : "7";
  const { data, isLoading, isFetching, refetch } = useTeamAuthorship(Number(range));

  const header = (
    <div className="mb-5">
      <p className="max-w-3xl text-sm text-text-secondary">
        Сколько сообщений каждой страницы Hub знает по автору — и сколько ушло без него.
      </p>
      <details className="help mt-1">
        <summary>Как это считается</summary>
        <div className="help-body">
          {HOW_IT_WORKS.map((line) => <p key={line}>{line}</p>)}
        </div>
      </details>
      <div className="mt-4">
        <FilterButtons
          filters={RANGES.map(({ key, label }) => ({ key, label }))}
          active={range}
          onChange={(key) => setSearch((current) => {
            const next = new URLSearchParams(current);
            next.set("days", key);
            return next;
          })}
        />
      </div>
    </div>
  );

  if (!data) {
    return (
      <div>
        {header}
        {isLoading
          ? <TableSkeleton rows={6} columns={5} />
          : (
            <StatusPanel
              title="Цифры не загрузились"
              description="Hub не ответил. Попробуйте ещё раз."
              tone="error"
              action={<button type="button" onClick={() => void refetch()} disabled={isFetching} className="btn btn-sm">Повторить</button>}
            />
          )}
      </div>
    );
  }

  if (data.pages.length === 0) {
    return (
      <div>
        {header}
        <StatusPanel title="Сообщений нет" description="За это время страницы не отправили ни одного личного сообщения." />
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className={HEAD_CELL}>Страница · день</th>
              <th className={NUM_HEAD}>Личных</th>
              <th className={NUM_HEAD}>Без автора</th>
              <th className={NUM_HEAD}>В смену без автора</th>
              <th className={HEAD_CELL}>Авторы</th>
            </tr>
          </thead>
          <tbody>
            {data.pages.map((page) => (
              <Fragment key={page.pageLabel}>
                <Row label={page.pageLabel} counts={page.total} main authors={page.authors} />
                {page.days.length > 1 && page.days.map((day) => (
                  <Row key={day.day} label={formatBusinessDateShort(day.day)} counts={day} main={false} />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
