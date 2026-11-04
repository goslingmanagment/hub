import { Fragment, useState } from "react";
import { useLocation } from "react-router";
import { ChevronRight } from "lucide-react";
import type { TeamAuthorshipResponse } from "@agency_hub_core/contracts";
import { useTeamAuthorship } from "@/api/team";
import { NoAnswerPanel } from "@/components/shared/StatusPanel";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { DisclosureCard } from "@/components/ui/DisclosureCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatCount, formatDay, formatPercent, formatWindowRange } from "@/lib/format";
import { useScrollToAnchor } from "@/lib/useScrollToAnchor";
import { ChatterLink, PageLink } from "./teamLinks.js";

/**
 * «Сообщения без автора» on Команда → Смены (`teamAuthorship`): how many of each
 * page's personal messages left with no chatter known. The sum stands in the
 * folded header; the table opens under it, each page into its days.
 * `/team/shifts#authors` opens it and scrolls to it.
 */

type Page = TeamAuthorshipResponse["pages"][number];
type Counts = Page["total"];

/** The goal: no more than this share without an author of what left while the extension was open. */
const GOAL_PERCENT = 5;

/** «8 % · 161»: the share without an author and how many; «—» with nothing to count. */
export function withoutAuthor(personal: number, authored: number): string {
  if (personal === 0) return "—";
  const without = personal - authored;
  return `${formatPercent((100 * without) / personal)} · ${formatCount(without)}`;
}

function sumCounts(pages: readonly Page[]): Counts {
  return pages.reduce<Counts>((total, page) => ({
    personal: total.personal + page.total.personal,
    authored: total.authored + page.total.authored,
    inShift: total.inShift + page.total.inShift,
    inShiftAuthored: total.inShiftAuthored + page.total.inShiftAuthored,
  }), { personal: 0, authored: 0, inShift: 0, inShiftAuthored: 0 });
}

function headline(total: Counts): string {
  if (total.personal === 0) return "Сообщения без автора";
  const without = total.personal - total.authored;
  const share = formatPercent((100 * without) / total.personal);
  const inShift = total.inShift === 0 ? "" : `, пока расширение было открыто: ${formatPercent((100 * (total.inShift - total.inShiftAuthored)) / total.inShift)}`;
  return `Сообщения без автора: ${share} (${formatCount(without)} из ${formatCount(total.personal)})${inShift}`;
}

function aboveGoal(counts: Counts): boolean {
  return counts.inShift > 0 && (100 * (counts.inShift - counts.inShiftAuthored)) / counts.inShift > GOAL_PERCENT;
}

function Cells({ counts }: { counts: Counts }) {
  return (
    <>
      <td className="num">{formatCount(counts.personal)}</td>
      <td className="num">{withoutAuthor(counts.personal, counts.authored)}</td>
      <td className="num">
        {withoutAuthor(counts.inShift, counts.inShiftAuthored)}
        {aboveGoal(counts) && <span className="ml-2"><StatusBadge tone="attention">Выше цели</StatusBadge></span>}
      </td>
    </>
  );
}

function Table({ pages }: { pages: readonly Page[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (label: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(label)) next.delete(label);
    else next.add(label);
    return next;
  });
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Страница</th>
            <th scope="col" className="num">Личных сообщений</th>
            <th scope="col" className="num">Без автора</th>
            <th scope="col" className="num">Пока расширение было открыто</th>
            <th scope="col">Кто писал</th>
          </tr>
        </thead>
        <tbody>
          {pages.map((page) => {
            const expandable = page.days.length > 1;
            const expanded = open.has(page.pageLabel);
            return (
              <Fragment key={page.pageLabel}>
                <tr className="align-top">
                  <td>
                    <span className="team-expand">
                      {expandable ? (
                        <button
                          type="button"
                          className="team-expand-button"
                          aria-expanded={expanded}
                          aria-label={expanded ? `Свернуть дни ${page.pageLabel}` : `По дням: ${page.pageLabel}`}
                          onClick={() => toggle(page.pageLabel)}
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      ) : <span className="team-expand-space" />}
                      <PageLink label={page.pageLabel} />
                    </span>
                  </td>
                  <Cells counts={page.total} />
                  <td>
                    {page.authors.map((author) => (
                      <span key={author.userId} className="team-line">
                        <ChatterLink userId={author.userId} username={author.username} /> <span className="team-muted">· {formatCount(author.messages)}</span>
                      </span>
                    ))}
                  </td>
                </tr>
                {expanded && page.days.map((day) => (
                  <tr key={day.day} className="team-subrow">
                    <td><span className="team-expand-indent">{formatDay(day.day)}</span></td>
                    <Cells counts={day} />
                    <td />
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AuthorlessCard({ days, page }: { days: number; page: string | null }) {
  const location = useLocation();
  const anchored = location.hash === "#authors";
  useScrollToAnchor("authors", anchored);
  const { data, isLoading, isError, refetch, dataUpdatedAt } = useTeamAuthorship(days);
  const pages = (data?.pages ?? []).filter((one) => page === null || one.pageLabel === page);
  const dates = data ? (days === 1 ? "сегодня, с 00:00" : formatWindowRange(data.from, data.to)) : null;

  return (
    <div id="authors" className="team-anchor">
      <DisclosureCard
        key={anchored ? "anchored" : "plain"}
        defaultOpen={anchored}
        title={data ? headline(sumCounts(pages)) : "Сообщения без автора"}
        description="Сколько личных сообщений страницы ушло без автора. Цель: не больше 5 % из тех, что ушли, пока расширение было открыто."
        meta={dates}
      >
        {data && isError && <div className="team-card-inner team-card-top"><QueryNotice error stale retry={refetch} at={dataUpdatedAt} /></div>}
        {!data
          ? (isLoading ? <TableSkeleton rows={4} columns={5} /> : <NoAnswerPanel retry={refetch} />)
          : pages.length === 0
            ? <div className="empty"><p className="empty-title">Сообщений нет</p><p className="empty-text">За это время страницы не отправили ни одного личного сообщения.</p></div>
            : <Table pages={pages} />}
      </DisclosureCard>
    </div>
  );
}
