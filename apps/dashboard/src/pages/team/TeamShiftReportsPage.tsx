import { useMemo, useState } from "react";
import type { TeamShiftDisputesResponse, TeamShiftExportResponse } from "@agency_hub_core/contracts";
import { millsToRoundedDollars } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { useResolveShiftDispute, useTeamShiftDisputes, useTeamShiftExport } from "@/api/team";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatDateTime, formatMills } from "@/lib/format";

/**
 * Chat Memory week 4 (week-4.md §2): the owner's side of the shift reports —
 * the disputes (any marks but one «моё» or two «делим» naming each other) and
 * the payout export of the confirmed reports, chatter × page × the sale's day.
 */

const HEAD = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const CELL = "px-3 py-2 align-top text-text-secondary xl:px-4";
const MARK_LABELS: Readonly<Record<string, string>> = { mine: "моё", share: "делим", not_mine: "не моё" };
const REASON_LABELS: Readonly<Record<string, string>> = {
  two_mine: "двое «моё»",
  share_not_agreed: "«делим» без согласия",
  conflicting: "отметки не сходятся",
};

function moscowDay(offsetDays: number): string {
  return new Date(Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function daysOf(from: string, to: string): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`) && days.length < 31; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/** A payout-sheet cell: Fansly to the cent, OnlyFans whole dollars, a dot for the decimals. */
export function sheetCell(platform: string, mills: number): string {
  return platform === "onlyfans" ? String(millsToRoundedDollars(mills)) : (mills / 1000).toFixed(2);
}

interface PivotRow { username: string; pageLabel: string; platform: string; cells: Map<string, number> }

export function pivotOf(rows: TeamShiftExportResponse["rows"]): PivotRow[] {
  const byKey = new Map<string, PivotRow>();
  for (const row of rows) {
    const key = `${row.username}\u0000${row.pageLabel}`;
    const pivot = byKey.get(key) ?? { username: row.username, pageLabel: row.pageLabel, platform: row.platform, cells: new Map() };
    pivot.cells.set(row.shiftDate, (pivot.cells.get(row.shiftDate) ?? 0) + row.creditedMills);
    byKey.set(key, pivot);
  }
  return [...byKey.values()];
}

/** Tab-separated, one block per chatter: the page, then a column per day — pasted into the chatter's tab of the payout sheet. */
export function sheetText(pivot: readonly PivotRow[], days: readonly string[]): string {
  const blocks: string[] = [];
  for (const username of [...new Set(pivot.map((row) => row.username))]) {
    const lines = [[username, ...days].join("\t")];
    for (const row of pivot.filter((one) => one.username === username)) {
      lines.push([row.pageLabel, ...days.map((day) => (row.cells.has(day) ? sheetCell(row.platform, row.cells.get(day)!) : ""))].join("\t"));
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

function Disputes({ owner }: { owner: boolean }) {
  const { data, isLoading } = useTeamShiftDisputes();
  const resolve = useResolveShiftDispute();
  if (isLoading) return <TableSkeleton rows={2} columns={5} />;
  if (!data) return <StatusPanel title="Споры не загрузились" description="Hub не ответил. Обновите страницу." tone="error" />;
  if (data.disputes.length === 0) return <StatusPanel title="Споров нет" description="За 14 дней отметки чаттеров по продажам сходятся." />;
  const split = (dispute: TeamShiftDisputesResponse["disputes"][number], shares: Array<{ userId: number; percent: number }>) =>
    resolve.mutate({ saleRef: dispute.saleRef, body: { shares } });
  return (
    <ul className="flex flex-col gap-2">
      {data.disputes.map((dispute) => {
        return (
          <li key={dispute.saleRef} className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-text-primary">
                {formatDateTime(dispute.occurredAt)} · {dispute.pageLabel} · <span className="font-semibold">{formatMills(dispute.netMills)}</span>
                <span className="text-text-muted"> · {REASON_LABELS[dispute.reason] ?? dispute.reason}</span>
              </p>
              {dispute.resolution !== null && (
                <p className="text-xs text-text-muted">
                  Решено: {dispute.resolution.map((share) => `${share.username} ${share.percent}%`).join(", ")}
                </p>
              )}
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              {dispute.marks.map((mark) => `${mark.username}: ${MARK_LABELS[mark.mark] ?? mark.mark}${mark.shareWith ? ` с ${mark.shareWith}` : ""}${mark.amountMills !== null ? ` (${formatMills(mark.amountMills)})` : ""}`).join(" · ")}
            </p>
            {owner && (
              <div className="mt-2 flex flex-wrap gap-2">
                {dispute.people.map((person) => (
                  <button key={person.userId} type="button" className="btn btn-sm" disabled={resolve.isPending} onClick={() => split(dispute, [{ userId: person.userId, percent: 100 }])}>
                    Всё — {person.username}
                  </button>
                ))}
                {dispute.people.length === 2 && (
                  <button type="button" className="btn btn-sm" disabled={resolve.isPending}
                    onClick={() => split(dispute, dispute.people.map((person) => ({ userId: person.userId, percent: 50 })))}>
                    Пополам
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Export() {
  const [from, setFrom] = useState(moscowDay(-6));
  const [to, setTo] = useState(moscowDay(0));
  const { data, isLoading } = useTeamShiftExport({ from, to });
  const [copied, setCopied] = useState(false);
  const days = useMemo(() => daysOf(from, to), [from, to]);
  const pivot = useMemo(() => pivotOf(data?.rows ?? []), [data]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sheetText(pivot, days));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1 text-text-secondary">с <input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setCopied(false); }} className="rounded-md border border-border bg-card px-2 py-1" /></label>
        <label className="flex items-center gap-1 text-text-secondary">по <input type="date" value={to} onChange={(event) => { setTo(event.target.value); setCopied(false); }} className="rounded-md border border-border bg-card px-2 py-1" /></label>
        <button type="button" className="btn btn-sm" disabled={pivot.length === 0} onClick={() => void copy()}>{copied ? "Скопировано" : "Скопировать для таблицы"}</button>
      </div>
      {isLoading ? <TableSkeleton rows={3} columns={5} /> : !data ? (
        <StatusPanel title="Выгрузка не загрузилась" description="Проверьте даты: окно — не больше 31 дня." tone="error" />
      ) : (
        <>
          {(data.disputedOpen > 0 || data.unconfirmed.length > 0) && (
            <p className="mb-3 text-sm text-text-secondary">
              {data.disputedOpen > 0 && `Не вошло: ${data.disputedOpen} продаж в споре. `}
              {data.unconfirmed.length > 0 && `Не подтверждены смены: ${data.unconfirmed.map((shift) => `${shift.username} ${formatDateTime(shift.startedAt)}`).join(", ")}.`}
            </p>
          )}
          {data.ownAmounts.length > 0 && (
            <div className="mb-3 text-sm text-text-secondary">
              <p>Своя сумма чаттера вместо суммы Hub (вошла в выгрузку так):</p>
              <ul className="mt-1 list-disc pl-5">
                {data.ownAmounts.map((own) => (
                  <li key={`${own.username}-${own.saleRef}`}>
                    {own.username} · {own.pageLabel} · {formatDateTime(own.occurredAt)}: {formatMills(own.amountMills)} вместо {formatMills(own.netMills)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pivot.length === 0 ? <StatusPanel title="Подтверждённых отчётов нет" description="За эти дни чаттеры ещё не подтвердили ни одного отчёта смены." /> : (
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
              <table className="w-full text-sm">
                <thead className="border-b border-border">
                  <tr>
                    <th className={HEAD}>Чаттер</th>
                    <th className={HEAD}>Страница</th>
                    {days.map((day) => <th key={day} className={HEAD}>{day.slice(8)}.{day.slice(5, 7)}</th>)}
                    <th className={HEAD}>Итого</th>
                  </tr>
                </thead>
                <tbody>
                  {pivot.map((row) => (
                    <tr key={`${row.username}-${row.pageLabel}`} className="border-b border-border last:border-b-0">
                      <td className={`${CELL} font-medium text-text-primary`}>{row.username}</td>
                      <td className={CELL}>{row.pageLabel}</td>
                      {days.map((day) => <td key={day} className={`${CELL} tabular-nums`}>{row.cells.has(day) ? sheetCell(row.platform, row.cells.get(day)!) : ""}</td>)}
                      <td className={`${CELL} font-medium tabular-nums text-text-primary`}>{formatMills([...row.cells.values()].reduce((sum, mills) => sum + mills, 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function TeamShiftReportsPage() {
  const { data: me } = useAuthMe();
  const owner = me?.user.role === "owner";
  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-3xl text-sm text-text-secondary">
        Чаттеры отмечают продажи своих смен в кабинете («моё», «делим», «не моё») и подтверждают отчёт. Здесь — споры, которые
        решает владелец, и выгрузка подтверждённых отчётов в формате таблицы выплат. Продажа входит в одну выгрузку — по дню начала
        самой ранней подтверждённой смены, где она есть; «делим» — пополам.
      </p>
      <section>
        <h2 className="mb-2 text-base font-semibold text-text-primary">Споры</h2>
        <Disputes owner={owner} />
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold text-text-primary">Выгрузка для оплаты</h2>
        <Export />
      </section>
    </div>
  );
}
