import { Fragment, useState } from "react";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { sumMills } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/auth";
import { useSaveWinBackApproach, useTeamWinBackApproaches, useTeamWinBackResults } from "@/api/team";
import { useScreenPeriod } from "@/components/layout/useScreenPeriod";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { DisclosureCard } from "@/components/ui/DisclosureCard";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { formatCount, formatMills, formatPercent, formatWindowRange } from "@/lib/format";
import { ChatterLink } from "./teamLinks.js";

/**
 * Команда → Продажи → Возврат фанов: which approaches bring silent fans back,
 * and with whom (`teamWinBackResults`), and for the owner the list itself
 * (`teamWinBackApproaches`, `teamWinBackApproachSave`). Its own period, a month
 * by default: the results ripen over 72 hours, 7 and 30 days.
 */

type Row = KernelOperationResponse<"teamWinBackResults">["rows"][number];

interface Totals {
  attempts: number;
  sent: number;
  replied72h: number;
  matured72h: number;
  bought7d: number;
  matured7d: number;
  spent30d: bigint;
  matured30d: number;
}

/** "3 из 5 · 60 %"; "—" when nothing matured yet. */
export function outOf(hits: number, matured: number): string {
  if (matured === 0) return "—";
  return `${hits} из ${matured} · ${formatPercent((100 * hits) / matured)}`;
}

function totalsOf(rows: readonly Row[]): Totals {
  return {
    attempts: rows.reduce((sum, row) => sum + row.attempts, 0),
    sent: rows.reduce((sum, row) => sum + row.sent, 0),
    replied72h: rows.reduce((sum, row) => sum + row.replied72h, 0),
    matured72h: rows.reduce((sum, row) => sum + row.matured72h, 0),
    bought7d: rows.reduce((sum, row) => sum + row.bought7d, 0),
    matured7d: rows.reduce((sum, row) => sum + row.matured7d, 0),
    spent30d: sumMills(rows.map((row) => row.spent30dMills)),
    matured30d: rows.reduce((sum, row) => sum + row.matured30d, 0),
  };
}

function Cells({ totals }: { totals: Totals }) {
  return (
    <>
      <td className="num">{formatCount(totals.attempts)}</td>
      <td className="num">{formatCount(totals.sent)}</td>
      <td className="num">{outOf(totals.replied72h, totals.matured72h)}</td>
      <td className="num">{outOf(totals.bought7d, totals.matured7d)}</td>
      <td className="num">{totals.matured30d === 0 ? "—" : formatMills(totals.spent30d)}</td>
    </>
  );
}

function Results({ rows, inactive }: { rows: readonly Row[]; inactive: ReadonlySet<number> }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const groups = [...new Map(rows.map((row) => [row.approachId, row.approach])).entries()].map(([id, label]) => {
    const people = rows.filter((row) => row.approachId === id);
    return { id, label, people, totals: totalsOf(people) };
  }).sort((a, b) => {
    const rate = (totals: Totals) => (totals.matured7d === 0 ? -1 : totals.bought7d / totals.matured7d);
    return rate(b.totals) - rate(a.totals) || b.totals.attempts - a.totals.attempts;
  });
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Подход</th>
            <th scope="col" className="num">Выбрали</th>
            <th scope="col" className="num">Написали</th>
            <th scope="col" className="num">Ответили за 72 ч</th>
            <th scope="col" className="num">Купили за 7 дней</th>
            <th scope="col" className="num">Потратили за 30 дней</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const expanded = open.has(group.id);
            const off = inactive.has(group.id);
            return (
              <Fragment key={group.id}>
                <tr className={off ? "team-off-row" : undefined}>
                  <td>
                    <span className="team-expand">
                      <button
                        type="button"
                        className="team-expand-button"
                        aria-expanded={expanded}
                        aria-label={expanded ? `Свернуть: ${group.label}` : `По чаттерам: ${group.label}`}
                        onClick={() => setOpen((current) => {
                          const next = new Set(current);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        })}
                      >
                        <ChevronRight size={16} aria-hidden="true" />
                      </button>
                      <span className="font-medium">{group.label}</span>
                      {off && <span className="team-muted">выключен</span>}
                    </span>
                  </td>
                  <Cells totals={group.totals} />
                </tr>
                {expanded && group.people.map((row) => (
                  <tr key={`${row.approachId}:${row.userId}`} className="team-subrow">
                    <td><span className="team-expand-indent"><ChatterLink userId={row.userId} username={row.username} /></span></td>
                    <Cells totals={totalsOf([row])} />
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

function ApproachesEditor() {
  const { data, isLoading, refetch } = useTeamWinBackApproaches(true);
  const save = useSaveWinBackApproach();
  const [draft, setDraft] = useState("");

  function submit(body: Parameters<typeof save.mutate>[0], done?: () => void) {
    save.mutate(body, {
      onSuccess: () => done?.(),
      onError: () => toast.error("Не сохранилось: такое название уже есть или Hub не ответил."),
    });
  }

  return (
    <DisclosureCard
      title="Список подходов"
      description="Чаттеры видят включённые, по порядку. Выключенный подход пропадает из расширения, его итоги остаются."
      meta={data ? `${data.approaches.filter((approach) => approach.active).length} включено` : undefined}
    >
      {!data ? (isLoading ? <TableSkeleton rows={3} columns={2} /> : <NoAnswerPanel retry={refetch} />) : (
        <ul className="team-list">
          {data.approaches.map((approach) => (
            <li key={approach.id} className="team-list-row">
              <span className={approach.active ? "" : "team-struck"}>{approach.label}</span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={save.isPending}
                onClick={() => submit({ id: approach.id, label: approach.label, sortOrder: approach.sortOrder, active: !approach.active })}
              >
                {approach.active ? "Выключить" : "Включить"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="team-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          const label = draft.trim();
          // The order is the list's length + 1: no adding before the list is in.
          if (label === "" || !data) return;
          submit({ label, sortOrder: data.approaches.length + 1, active: true }, () => setDraft(""));
        }}
      >
        <input
          className="input"
          aria-label="Новый подход"
          placeholder="Новый подход, например «Голосовое с именем»"
          maxLength={80}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={save.isPending || draft.trim() === "" || !data}>Добавить</button>
      </form>
    </DisclosureCard>
  );
}

export function TeamWinBackPage() {
  const { days: shownDays, select } = useScreenPeriod();
  const { data: me } = useAuthMe();
  const owner = me?.user.role === "owner";
  const days = shownDays === 7 || shownDays === 90 ? shownDays : 30;
  const query = useTeamWinBackResults(days);
  const approaches = useTeamWinBackApproaches(owner);
  const { data, isLoading, isError, refetch, dataUpdatedAt } = query;
  const inactive = new Set((approaches.data?.approaches ?? []).filter((approach) => !approach.active).map((approach) => approach.id));
  const noneMatured = data !== undefined && data.rows.length > 0 && data.rows.every((row) => row.matured7d === 0);

  return (
    <div className="team-screen">
      {data && <PageHeader window={formatWindowRange(data.from, data.to)} fresh={{ at: dataUpdatedAt, onRefresh: () => void refetch(), refreshing: query.isFetching }} />}
      {noneMatured && days === 7 && (
        <Notice action={<button type="button" className="btn btn-sm" onClick={() => select("30d")}>Показать 30 дней</button>}>
          За 7 дней срок «купили за 7 дней» ещё не прошёл.
        </Notice>
      )}
      <section className="card" aria-label="Итоги по подходам">
        {data && <div className="team-card-inner team-card-top"><QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} /></div>}
        {!data
          ? (isLoading ? <TableSkeleton rows={4} columns={6} /> : <NoAnswerPanel retry={refetch} />)
          : data.rows.length === 0
            ? <StatusPanel title="Попыток пока нет" description="Как только чаттеры начнут выбирать подходы на вкладке «Вернуть» в расширении, здесь появятся итоги." />
            : <div className={query.isPlaceholderData ? "is-refreshing" : ""}><Results rows={data.rows} inactive={inactive} /></div>}
      </section>
      {owner && <ApproachesEditor />}
      <Disclosure>
        <p>Подход — то, что чаттер выбирает на вкладке «Вернуть» в расширении.</p>
        <p>
          Чаттер выбирает подход одним касанием и пишет фану сам. Hub записывает выбор и считает, что было после первого
          сообщения этого чаттера фану (в течение 48 часов после выбора).
        </p>
        <p>
          «Ответили» — фан написал в течение 72 часов; «Купили» — заплатил в течение 7 дней; «Потратили» — сколько за 30
          дней. Итог считается, только когда его срок прошёл: «3 из 5» — из пяти созревших попыток.
        </p>
        <p>Hub не назначает подходы и не засчитывает продажи: только записывает и считает.</p>
      </Disclosure>
    </div>
  );
}
