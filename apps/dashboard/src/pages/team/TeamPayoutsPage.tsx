import { useMemo, useState, type ReactNode } from "react";
import { useLocation, useSearchParams } from "react-router";
import { ChevronRight } from "lucide-react";
import { toast } from "sonner";
import {
  SALE_RULE_SINCE_DAY,
  SHIFT_REPORT_EXPORT_MAX_DAYS,
  SHIFT_REPORT_MAX_DAYS,
  type TeamShiftDisputesResponse,
  type TeamShiftExportResponse,
} from "@agency_hub_core/contracts";
import { sumMills } from "@agency_hub_core/shared";
import { useAuthMe } from "@/api/queries";
import { KernelApiError } from "@/api/sdk";
import { TEAM_SHIFT_DISPUTE_DAYS, useResolveShiftDispute, useTeamShiftDisputes, useTeamShiftExport } from "@/api/team";
import { ConfirmModal } from "@/components/shared/ConfirmModal";
import { QueryNotice } from "@/components/shared/QueryNotice";
import { NoAnswerPanel, StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDateTime, formatDay, formatDayRange, formatMills } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { TEAM_STATUS } from "@/lib/statusWords";
import { useScrollToAnchor } from "@/lib/useScrollToAnchor";
import { daysOf, moscowDay, pivotOf, sheetCell, sheetText } from "./payoutSheet.js";
import { shiftSpan } from "./TeamShiftsPage.js";
import { FanLink, LoginName, PageLink, useLoginLink } from "./teamLinks.js";
import { platformName } from "@/lib/platformUrls";

/**
 * Команда → Выплаты: the disputes the owner settles, who has not confirmed a
 * shift, and the export for the payout sheet. Every page, on purpose: the
 * export is never cut by the page filter, nor by `?chatter=` (design/ia.md §0,
 * п. 7). The window is `?from=&to=` (Moscow days) and nothing else.
 */

type Dispute = TeamShiftDisputesResponse["disputes"][number];
type Unconfirmed = TeamShiftExportResponse["unconfirmed"][number];

const MARK_LABELS: Readonly<Record<string, string>> = { mine: "моё", share: "делим", not_mine: "не моё" };
const REASON_LABELS: Readonly<Record<string, string>> = {
  two_mine: "двое «моё»",
  share_not_agreed: "«делим» без согласия",
  conflicting: "отметки не сходятся",
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

type Span = "7" | "14" | "31" | "custom";
const SPANS: ReadonlyArray<{ value: Span; label: string; days?: number }> = [
  { value: "7", label: "7 дней", days: 7 },
  { value: "14", label: "14 дней", days: 14 },
  { value: "31", label: "31 день", days: 31 },
  { value: "custom", label: "Свой период" },
];

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

/** The window's problem in words, before any request; null when it can be asked. */
function windowProblem(from: string, to: string): string | null {
  if (!DATE.test(from) || !DATE.test(to)) return "Проверьте даты.";
  if (from > to) return "Начало позже конца.";
  if (spanDays(from, to) > SHIFT_REPORT_EXPORT_MAX_DAYS) return "Окно — не больше 31 дня.";
  return null;
}

function marksLine(dispute: Dispute): string {
  return dispute.marks
    .map((mark) => `${mark.username}: ${MARK_LABELS[mark.mark] ?? mark.mark}${mark.shareWith ? ` с ${mark.shareWith}` : ""}${mark.amountMills !== null ? ` (${formatMills(mark.amountMills)})` : ""}`)
    .join(" · ");
}

function resolutionLine(dispute: Dispute): string | null {
  return dispute.resolution === null ? null : `Решено: ${dispute.resolution.map((share) => `${share.username} ${share.percent} %`).join(", ")}`;
}

/** The hub's answer to a resolve, in the owner's words; nothing is retried by itself. */
function resolveProblem(error: unknown): string {
  const status = error instanceof KernelApiError ? error.status : null;
  if (status === 409) return "Это больше не спор: отметки чаттеров сошлись. Ничего не записано.";
  if (status === 400) return "Hub не принял решение. Ничего не записано.";
  if (status === 403) return "Решать споры может только владелец. Ничего не записано.";
  if (status === 404) return "Hub не нашёл эту продажу. Ничего не записано.";
  if (status === 401) return "Вход закончился. Войдите снова и повторите: ничего не записано.";
  return "Hub не подтвердил запись: неизвестно, записано ли решение. Список перечитан: посмотрите, что стоит в строке спора.";
}

interface Asking {
  dispute: Dispute;
  shares: Array<{ userId: number; username: string; percent: number }>;
}

function ResolveDialog({ asking, onClose }: { asking: Asking; onClose: () => void }) {
  const resolve = useResolveShiftDispute();
  const [problem, setProblem] = useState<string | null>(null);
  const { dispute, shares } = asking;
  const whole = shares.length === 1;
  const sum = formatMills(dispute.netMills);
  const close = () => {
    resolve.reset();
    onClose();
  };
  return (
    <ConfirmModal
      title={whole ? `Отдать всю продажу ${shares[0]!.username}?` : "Разделить продажу пополам?"}
      message="Решение заменит прежние отметки по этой продаже в выплате."
      facts={[
        { label: "Где", value: `${dispute.pageLabel}, ${platformName(dispute.platform)}` },
        { label: "Что", value: `Продажа ${sum}, ${formatDateTime(dispute.occurredAt)}` },
        { label: "Кому", value: shares.map((share) => `${share.username} — ${share.percent} %`).join(", ") },
        { label: "Было", value: resolutionLine(dispute) ?? marksLine(dispute) },
        { label: "Отменить", value: "Отменить нельзя, но решение можно заменить другим. Если день уже выгружен, изменение появится в блоке «Изменено после подтверждения дня»." },
      ]}
      confirmLabel={whole ? `Отдать ${shares[0]!.username}` : "Разделить пополам"}
      pendingLabel="Записываем…"
      tone="primary"
      error={problem ?? undefined}
      isPending={resolve.isPending}
      onConfirm={() => resolve.mutate(
        { saleRef: dispute.saleRef, body: { shares: shares.map(({ userId, percent }) => ({ userId, percent })) } },
        {
          onSuccess: () => {
            toast.success(whole
              ? `Записано: вся продажа ${sum} — ${shares[0]!.username}`
              : `Записано: продажа ${sum} пополам, ${shares.map((share) => share.username).join(" и ")}`);
            close();
          },
          onError: (error) => setProblem(resolveProblem(error)),
        },
      )}
      onClose={close}
    />
  );
}

function DisputeRow({ dispute, owner, onAsk }: { dispute: Dispute; owner: boolean; onAsk: (asking: Asking) => void }) {
  const decided = (userId: number, percent: number) => dispute.resolution?.some((share) => share.userId === userId && share.percent === percent) === true;
  const halves = dispute.people.length === 2 && dispute.people.every((person) => decided(person.userId, 50));
  return (
    <li className="dispute-row">
      <div className="dispute-head">
        <div className="dispute-what">
          {dispute.resolution === null
            ? <StatusBadge status={TEAM_STATUS.dispute} />
            : <span className="team-muted">{resolutionLine(dispute)}</span>}
          <span className="dispute-facts">
            {formatDateTime(dispute.occurredAt)} · <PageLink label={dispute.pageLabel} />
            {dispute.fanRef !== null && <> · <FanLink pageLabel={dispute.pageLabel} platform={dispute.platform} fanRef={dispute.fanRef} /></>}
          </span>
        </div>
        <span className="dispute-money">{formatMills(dispute.netMills)}</span>
      </div>
      <p className="dispute-marks">
        <span>{REASON_LABELS[dispute.reason] ?? dispute.reason}:</span> {marksLine(dispute)}
      </p>
      {owner ? (
        <div className="dispute-actions">
          {dispute.people.map((person) => (
            <button
              key={person.userId}
              type="button"
              className={`btn btn-sm ${decided(person.userId, 100) ? "team-picked" : ""}`}
              aria-pressed={decided(person.userId, 100)}
              onClick={() => onAsk({ dispute, shares: [{ userId: person.userId, username: person.username, percent: 100 }] })}
            >
              Всё — {person.username}
            </button>
          ))}
          {dispute.people.length === 2 && (
            <button
              type="button"
              className={`btn btn-sm ${halves ? "team-picked" : ""}`}
              aria-pressed={halves}
              onClick={() => onAsk({ dispute, shares: dispute.people.map((person) => ({ userId: person.userId, username: person.username, percent: 50 })) })}
            >
              Пополам
            </button>
          )}
        </div>
      ) : dispute.resolution === null && <p className="dispute-marks">Решает владелец</p>}
    </li>
  );
}

function Disputes({ owner }: { owner: boolean }) {
  const { data, isLoading, isError, refetch, dataUpdatedAt } = useTeamShiftDisputes();
  const [asking, setAsking] = useState<Asking | null>(null);
  const open = data?.disputes.filter((dispute) => dispute.resolution === null) ?? [];
  const settled = data?.disputes.filter((dispute) => dispute.resolution !== null) ?? [];
  return (
    <section id="disputes" className="card team-anchor" aria-labelledby="payouts-disputes">
      <header className="card-header">
        <div>
          <h2 id="payouts-disputes" className="card-title">Споры по продажам</h2>
          <p className="card-description">Показаны за {TEAM_SHIFT_DISPUTE_DAYS} день, независимо от дат выгрузки.</p>
        </div>
        {open.length > 0 && <span className="card-description">{open.length} {ruPlural(open.length, "ждёт", "ждут", "ждут")} решения</span>}
      </header>
      {data && <div className="team-card-inner"><QueryNotice error={isError} stale retry={refetch} at={dataUpdatedAt} /></div>}
      {!data ? (
        isLoading ? <TableSkeleton rows={2} columns={4} /> : <NoAnswerPanel retry={refetch} />
      ) : data.disputes.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Споров нет</p>
          <p className="empty-text">За {TEAM_SHIFT_DISPUTE_DAYS} день отметки чаттеров по продажам сходятся.</p>
        </div>
      ) : (
        <>
          {open.length > 0 && <ul className="dispute-list">{open.map((dispute) => <DisputeRow key={dispute.saleRef} dispute={dispute} owner={owner} onAsk={setAsking} />)}</ul>}
          {open.length === 0 && <p className="team-card-inner team-muted">Все споры за {TEAM_SHIFT_DISPUTE_DAYS} день решены.</p>}
          {settled.length > 0 && (
            <details className="help team-card-fold">
              <summary>Решённые ({settled.length})</summary>
              <ul className="dispute-list dispute-list-settled">
                {settled.map((dispute) => <DisputeRow key={dispute.saleRef} dispute={dispute} owner={owner} onAsk={setAsking} />)}
              </ul>
            </details>
          )}
        </>
      )}
      {asking && <ResolveDialog key={asking.dispute.saleRef} asking={asking} onClose={() => setAsking(null)} />}
    </section>
  );
}

function UnconfirmedRows({ username, shifts, open, onToggle, now, link }: {
  username: string;
  shifts: readonly Unconfirmed[];
  open: boolean;
  onToggle: () => void;
  now: number;
  link: (username: string) => number | null;
}) {
  const last = shifts[shifts.length - 1]!;
  return (
    <>
      <tr>
        <td>
          <span className="team-expand">
            <button type="button" className="team-expand-button" aria-expanded={open} aria-label={`Смены ${username}`} onClick={onToggle}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
            <LoginName username={username} link={link} />
          </span>
        </td>
        <td className="num">{shifts.length}</td>
        <td className="whitespace-nowrap">{shiftSpan(last)}</td>
      </tr>
      {open && shifts.map((shift) => (
        <tr key={shift.startedAt} className="team-subrow">
          <td><span className="team-expand-indent">{shiftSpan(shift)}</span></td>
          <td />
          <td>
            {shift.ongoing
              ? <StatusBadge tone="good" bare>ещё идёт</StatusBadge>
              : now - Date.parse(shift.startedAt) > SHIFT_REPORT_MAX_DAYS * DAY_MS
                ? <StatusBadge tone="off">подтвердить уже нельзя</StatusBadge>
                : null}
          </td>
        </tr>
      ))}
    </>
  );
}

function WhoHasNot({ data, chatter, onAll }: { data: TeamShiftExportResponse; chatter: string | null; onAll: () => void }) {
  const link = useLoginLink();
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set(chatter ? [chatter] : []));
  const now = Date.parse(data.serverNow);
  const byPerson = new Map<string, Unconfirmed[]>();
  for (const shift of [...data.unconfirmed].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    byPerson.set(shift.username, [...(byPerson.get(shift.username) ?? []), shift]);
  }
  const people = [...byPerson.entries()].filter(([username]) => chatter === null || username === chatter);
  if (byPerson.size === 0) return <div className="empty"><p className="empty-title">Все смены этих дней подтверждены</p></div>;
  return (
    <>
      {chatter !== null && (
        <div className="team-card-inner">
          <Notice action={<button type="button" className="btn btn-sm" onClick={onAll}>Показать всех</button>}>Показан только {chatter}.</Notice>
        </div>
      )}
      {people.length === 0 ? (
        <div className="empty"><p className="empty-title">У {chatter} все смены этих дней подтверждены</p></div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Чаттер</th>
                <th scope="col" className="num">Смен без подтверждения</th>
                <th scope="col">Последняя</th>
              </tr>
            </thead>
            <tbody>
              {people.map(([username, shifts]) => (
                <UnconfirmedRows
                  key={username}
                  username={username}
                  shifts={shifts}
                  now={now}
                  link={link}
                  open={opened.has(username)}
                  onToggle={() => setOpened((current) => {
                    const next = new Set(current);
                    if (next.has(username)) next.delete(username);
                    else next.add(username);
                    return next;
                  })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SheetTable({ data, days }: { data: TeamShiftExportResponse; days: readonly string[] }) {
  const link = useLoginLink();
  const pivot = useMemo(() => pivotOf(data.rows), [data]);
  return (
    <div className="table-wrap">
      <table className="data-table payout-sheet">
        <thead>
          <tr>
            <th scope="col">Чаттер</th>
            <th scope="col">Страница</th>
            {days.map((day) => <th key={day} scope="col" className="num">{day.slice(8)}.{day.slice(5, 7)}</th>)}
            <th scope="col" className="num">Итого</th>
          </tr>
        </thead>
        <tbody>
          {pivot.map((row) => (
            <tr key={`${row.username}-${row.pageLabel}`}>
              <td><LoginName username={row.username} link={link} /></td>
              <td><PageLink label={row.pageLabel} /></td>
              {days.map((day) => <td key={day} className="num">{row.cells.has(day) ? sheetCell(row.platform, row.cells.get(day)!) : ""}</td>)}
              <td className="num font-medium">{formatMills(sumMills(row.cells.values()))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OwnAmounts({ data }: { data: TeamShiftExportResponse }) {
  if (data.ownAmounts.length === 0) return null;
  return (
    <details className="help team-card-fold">
      <summary>Своя сумма чаттера вместо суммы Hub ({data.ownAmounts.length})</summary>
      <p className="team-fold-text">В выгрузку вошла своя сумма.</p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Чаттер</th>
              <th scope="col">Страница</th>
              <th scope="col">Продажа</th>
              <th scope="col" className="num">Своя сумма</th>
              <th scope="col" className="num">Сумма Hub</th>
            </tr>
          </thead>
          <tbody>
            {data.ownAmounts.map((own) => (
              <tr key={`${own.username}-${own.saleRef}`}>
                <td>{own.username}</td>
                <td><PageLink label={own.pageLabel} /></td>
                <td>{formatDateTime(own.occurredAt)}</td>
                <td className="num font-medium">{formatMills(own.amountMills)}</td>
                <td className="num muted">{formatMills(own.netMills)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

const COMMON_SOURCES: Readonly<Record<string, string>> = { post_tip: "чаевые под постом", campaign: "взнос в Campaign" };

/** The общак of the window's days: one line of its own, never a chatter's row nor the sheet's copy. */
function CommonLine({ data }: { data: TeamShiftExportResponse }) {
  const { common } = data;
  if (data.to < SALE_RULE_SINCE_DAY) return null;
  return (
    <>
      <div className="team-card-inner payout-common">
        <span className="payout-common-label">Общак</span>
        <span className="payout-common-money">{formatMills(common.netMills)}</span>
        <span className="team-muted">
          чаевые под постами и взносы в OnlyFans Campaign за эти дни (с {formatDay(SALE_RULE_SINCE_DAY)}) — ни в чью смену, в копию для таблицы не входят
        </span>
      </div>
      {common.sales.length > 0 && (
        <details className="help team-card-fold">
          <summary>Из чего общак ({common.sales.length})</summary>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Когда</th>
                  <th scope="col">Страница</th>
                  <th scope="col">Фан</th>
                  <th scope="col">Что</th>
                  <th scope="col" className="num">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {common.sales.map((sale) => (
                  <tr key={sale.saleRef}>
                    <td className="whitespace-nowrap">{formatDateTime(sale.occurredAt)}</td>
                    <td><PageLink label={sale.pageLabel} /></td>
                    <td>{sale.fanName ?? "—"}</td>
                    <td>{COMMON_SOURCES[sale.source] ?? sale.source}</td>
                    <td className="num">{formatMills(sale.netMills)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}

function LateChanges({ data }: { data: TeamShiftExportResponse }) {
  const count = data.lateChanges.length;
  if (count === 0) return null;
  return (
    <>
      <div className="team-card-inner">
        <Notice tone="warning">
          Изменено после подтверждения дня: {count} {ruPlural(count, "строка", "строки", "строк")}. Уже выгруженный день мог измениться.
        </Notice>
      </div>
      <details className="help team-card-fold">
        <summary>Что изменилось ({count})</summary>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Что</th>
                <th scope="col" className="num">Сумма</th>
                <th scope="col">Чаттер</th>
                <th scope="col">Страница</th>
                <th scope="col">День выплаты</th>
                <th scope="col">Продажа</th>
                <th scope="col">Когда изменено</th>
              </tr>
            </thead>
            <tbody>
              {data.lateChanges.map((late) => (
                <tr key={`${late.change}-${late.username}-${late.saleRef}-${late.at}`}>
                  <td>{late.change === "added" ? "Дописано" : "Снято"}</td>
                  <td className="num">{formatMills(late.creditedMills)}</td>
                  <td>{late.username}</td>
                  <td><PageLink label={late.pageLabel} /></td>
                  <td className="whitespace-nowrap">{late.payDay.slice(8)}.{late.payDay.slice(5, 7)}</td>
                  <td className="whitespace-nowrap">{formatDateTime(late.occurredAt)}</td>
                  <td className="whitespace-nowrap">{formatDateTime(late.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function ExportCard({ from, to, query, problem }: {
  from: string;
  to: string;
  query: ReturnType<typeof useTeamShiftExport>;
  problem: string | null;
}) {
  const { data, isLoading, isFetching, isError, refetch, dataUpdatedAt } = query;
  const [copied, setCopied] = useState(false);
  const days = useMemo(() => daysOf(from, to), [from, to]);
  const current = data !== undefined && data.from === from && data.to === to;
  const rows = current ? pivotOf(data.rows).length : 0;
  const why = problem !== null ? "Проверьте даты"
    : !current || isFetching ? "Выгрузка ещё читается"
      : isError ? "Не удалось обновить: копировать старые суммы нельзя"
        : rows === 0 ? "Нечего копировать: за эти дни нет подтверждённых отчётов" : null;
  const copy = async () => {
    if (!current || why !== null) return;
    try {
      await navigator.clipboard.writeText(sheetText(pivotOf(data.rows), days));
      setCopied(true);
      toast.success(`Скопировано: ${rows} ${ruPlural(rows, "строка", "строки", "строк")}, ${formatDayRange(from, to)}, все страницы`);
    } catch {
      setCopied(false);
      toast.error("Буфер обмена недоступен. Выделите таблицу и скопируйте вручную.");
    }
  };
  let body: ReactNode;
  if (problem !== null) body = <div className="empty"><p className="empty-title">{problem}</p></div>;
  else if (!data) body = isLoading ? <TableSkeleton rows={3} columns={6} /> : <NoAnswerPanel retry={refetch} />;
  else {
    body = (
      <div className={isFetching && !current ? "is-refreshing" : ""}>
        {isError && <div className="team-card-inner"><QueryNotice error stale retry={refetch} at={dataUpdatedAt} /></div>}
        {data.disputedOpen > 0 && (
          <div className="team-card-inner">
            <Notice tone="warning" action={<a href="#disputes" className="btn btn-sm">Решить</a>}>
              Не вошло: {data.disputedOpen} {ruPlural(data.disputedOpen, "продажа", "продажи", "продаж")} в споре.
            </Notice>
          </div>
        )}
        {data.rows.length === 0
          ? (
            <div className="empty">
              <p className="empty-title">Подтверждённых отчётов нет</p>
              <p className="empty-text">За эти дни чаттеры ещё не подтвердили ни одного отчёта смены.</p>
            </div>
          )
          : <SheetTable data={data} days={current ? days : daysOf(data.from, data.to)} />}
        <CommonLine data={data} />
        <OwnAmounts data={data} />
        <LateChanges data={data} />
      </div>
    );
  }
  return (
    <section className="card" aria-labelledby="payouts-export">
      <header className="card-header">
        <div>
          <h2 id="payouts-export" className="card-title">Выгрузка для таблицы выплат</h2>
          <p className="card-description">В выгрузке все страницы. Формат — как в таблице выплат: Fansly до цента, OnlyFans целыми долларами.</p>
        </div>
        <div className="team-copy">
          {why !== null && <span className="team-copy-why">{why}</span>}
          <button type="button" className="btn" disabled={why !== null} onClick={() => void copy()}>
            {copied && why === null ? "Скопировано" : "Скопировать для таблицы"}
          </button>
        </div>
      </header>
      {body}
    </section>
  );
}

export function TeamPayoutsPage() {
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const { data: me } = useAuthMe();
  const owner = me?.user.role === "owner";
  const from = search.get("from") ?? moscowDay(-6);
  const to = search.get("to") ?? moscowDay(0);
  const chatter = search.get("chatter");
  const problem = windowProblem(from, to);
  const today = moscowDay(0);
  const preset = SPANS.find((span) => span.days !== undefined && to === today && problem === null && spanDays(from, to) === span.days);
  const [custom, setCustom] = useState(false);
  const span: Span = custom || !preset ? "custom" : preset.value;
  const exported = useTeamShiftExport({ from, to }, { enabled: problem === null });
  useScrollToAnchor(location.hash.slice(1), location.hash === "#disputes" || location.hash === "#unconfirmed");

  const setWindow = (nextFrom: string, nextTo: string) => {
    const next = new URLSearchParams(search);
    next.set("from", nextFrom);
    next.set("to", nextTo);
    setSearch(next, { replace: true });
  };
  const pick = (value: Span) => {
    if (value === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    const days = SPANS.find((item) => item.value === value)!.days!;
    setWindow(moscowDay(-(days - 1)), moscowDay(0));
  };
  const showAll = () => {
    const next = new URLSearchParams(search);
    next.delete("chatter");
    setSearch(next, { replace: true });
  };

  return (
    <div className="team-screen">
      <PageHeader
        actions={<Segmented className="team-span-picker" label="Окно выгрузки" value={span} onChange={pick} options={SPANS.map(({ value, label }) => ({ value, label }))} />}
        window={problem === null ? formatDayRange(from, to) : undefined}
        fresh={exported.data ? { at: exported.dataUpdatedAt, onRefresh: () => void exported.refetch(), refreshing: exported.isFetching } : undefined}
      />
      {span === "custom" && (
        <div className="team-dates">
          <label className="team-date">
            <span className="field-label">С</span>
            <input type="date" className={`input ${problem ? "input-invalid" : ""}`} value={from} max={today} onChange={(event) => setWindow(event.target.value, to)} />
          </label>
          <label className="team-date">
            <span className="field-label">По</span>
            <input type="date" className={`input ${problem ? "input-invalid" : ""}`} value={to} max={today} onChange={(event) => setWindow(from, event.target.value)} />
          </label>
          {problem && <p className="field-error" role="alert">{problem}</p>}
        </div>
      )}

      <Disputes owner={owner} />

      <section id="unconfirmed" className="card team-anchor" aria-labelledby="payouts-unconfirmed">
        <header className="card-header">
          <div>
            <h2 id="payouts-unconfirmed" className="card-title">Кто не подтвердил</h2>
            <p className="card-description">
              Их продажи не попадут в выгрузку, пока чаттер не подтвердит отчёт в кабинете. Подтвердить можно {SHIFT_REPORT_MAX_DAYS} дней.
            </p>
          </div>
          {exported.data && problem === null && exported.data.unconfirmed.length > 0 && (
            <span className="card-description">
              {new Set(exported.data.unconfirmed.map((shift) => shift.username)).size} {ruPlural(new Set(exported.data.unconfirmed.map((shift) => shift.username)).size, "чаттер", "чаттера", "чаттеров")},
              {" "}{exported.data.unconfirmed.length} {ruPlural(exported.data.unconfirmed.length, "смена", "смены", "смен")}
            </span>
          )}
        </header>
        {problem !== null
          ? <div className="empty"><p className="empty-title">{problem}</p></div>
          : !exported.data
            ? (exported.isLoading ? <TableSkeleton rows={3} columns={3} /> : <NoAnswerPanel retry={exported.refetch} />)
            : <WhoHasNot key={`${exported.data.from}:${exported.data.to}:${chatter ?? ""}`} data={exported.data} chatter={chatter} onAll={showAll} />}
      </section>

      <ExportCard key={`${from}:${to}`} from={from} to={to} query={exported} problem={problem} />

      <Disclosure>
        <p>
          Чаттеры отмечают продажи своих смен в кабинете («моё», «делим», «не моё») и подтверждают отчёт. Сумма чаттеру
          записывается один раз, когда он подтверждает смену, — на день его смены (тот, на который пришлась большая её часть,
          как в таблице выплат), и потом не переезжает; «делим» — пополам, на день первого подтверждения; решение спора
          заменяет прежние суммы продажи.
        </p>
        <p>
          С {formatDay(SALE_RULE_SINCE_DAY)} купленный PPV — того, кто его отправил («долёт отправителю»): он попадает в отчёт
          его смены, а не того, в чью смену его купили. Чаевые под постами и взносы в OnlyFans Campaign — общак: ни в чей
          отчёт, отдельной строкой «Общак». Разовую договорённость (например, 50/50 одной продажи) чаттер вписывает своей суммой.
        </p>
        <p>Показаны споры за {TEAM_SHIFT_DISPUTE_DAYS} день. Утренний отчёт в Telegram считает все нерешённые.</p>
        <p>Выгрузка всегда по всем страницам: фильтр страницы и выбор одного чаттера её не меняют.</p>
      </Disclosure>
    </div>
  );
}

