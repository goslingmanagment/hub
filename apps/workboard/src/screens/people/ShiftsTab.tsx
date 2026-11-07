import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { CHATTER_SHIFT_MIN_MESSAGES, CHATTER_SHIFT_MIN_WORKED_MINUTES, SHIFT_REPORT_MAX_DAYS } from "@agency_hub_core/contracts";
import { millsToNumber, sumMills } from "@agency_hub_core/shared";
import { Button, Duration, EmptyState, LinkButton, Money, Skeleton, StatusDot, Table, type Column } from "@agency_hub_core/ui";
import { formatDuration, formatMills } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { carryParams, shiftPath } from "@/shared/links";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import { usePersonStats, type PersonCard, type PersonShift } from "./data.js";
import { RowBackState } from "./RowBackState.js";
import { SlowFailed } from "./SlowFailed.js";
import { capitalized, dayWords, periodWords, replyText, shareText, timeRange } from "./words.js";

/**
 * «Смены» (spec §4.4): every shift of the period in one table — when, how long,
 * money, per hour, how fast the person answered, who was left waiting at its
 * end, how much the AI wrote. The whole row opens that shift's review, and its
 * «←» comes back here. The slow numbers fill in when Hub has counted them.
 */
export function ShiftsTab({ card, userId }: { card: PersonCard; userId: number }) {
  const location = useLocation();
  const { period, setPeriod } = usePeriod();
  const backLabel = card.person?.username ?? "Человек";
  const numbersFailed = card.quality === "failed";

  const slow = (row: PersonShift, show: (numbers: NonNullable<PersonShift["numbers"]>) => ReactNode) => {
    if (row.numbers === undefined) {
      return numbersFailed
        ? <span className="people-dash" title="Hub не ответил">—</span>
        : <span style={{ display: "inline-flex", justifyContent: "flex-end", width: "100%" }}><Skeleton width={48} /></span>;
    }
    if (row.numbers === null) return <span className="people-dash" title={row.ongoing ? "Смена идёт: числа будут после её конца" : "Нет данных"}>—</span>;
    return show(row.numbers);
  };

  const columns: Column<PersonShift>[] = [
    {
      key: "when",
      header: "Смена",
      sortValue: (row) => row.startedAt,
      sortFirst: "desc",
      cell: (row) => (
        <span className="people-shift">
          <span className="people-shift__day">{dayWords(row.date)}</span>
          <span className="people-shift__hint">
            {row.ongoing && <StatusDot tone="success" label="Идёт сейчас" />}
            {timeRange(row)} · {row.pages.join(", ")}
          </span>
        </span>
      ),
    },
    { key: "worked", header: "Работа", numeric: true, sortValue: (row) => row.workedMinutes, cell: (row) => <Duration minutes={row.workedMinutes} /> },
    {
      key: "sales",
      header: "Продажи",
      numeric: true,
      sortValue: (row) => row.salesNetMills,
      cell: (row) => (
        <span className="people-num">
          <Money mills={row.salesNetMills} strong />
          <span className="people-num__sub">{row.sales} {ruPlural(row.sales, "продажа", "продажи", "продаж")}</span>
        </span>
      ),
    },
    { key: "hour", header: "В час", numeric: true, sortValue: (row) => row.perHourMills, cell: (row) => <Money mills={row.perHourMills} /> },
    {
      key: "reply",
      header: "Ответ, медиана",
      numeric: true,
      title: "Половина ответов ждущим фанам — быстрее этого",
      sortValue: (row) => row.numbers?.replyMedianSeconds ?? null,
      cell: (row) => slow(row, (numbers) => replyText(numbers.replyMedianSeconds)),
    },
    {
      key: "waiting",
      header: "Без ответа в конце",
      numeric: true,
      title: "Сколько фанов ждали ответа, когда смена кончилась",
      sortValue: (row) => row.numbers?.waitingAtEnd ?? null,
      sortFirst: "desc",
      cell: (row) => slow(row, (numbers) => numbers.waitingAtEnd),
    },
    {
      key: "ai",
      header: "Доля ИИ",
      numeric: true,
      title: "Сообщения, написанные кнопками Reply и Fix расширения, из всех",
      sortValue: (row) => row.numbers?.aiShare ?? null,
      cell: (row) => slow(row, (numbers) => shareText(numbers.aiShare)),
    },
  ];

  return (
    <>
      {numbersFailed && <SlowFailed onRetry={card.retryQuality} />}
      <RowBackState label={backLabel}>
        <Table
          label={`Смены ${backLabel}`}
          columns={columns}
          rows={card.shifts}
          rowKey={(row) => row.startedAt}
          rowHref={(row) => shiftPath(userId, row.startedAt, location.search)}
          defaultSort={{ key: "when", direction: "desc" }}
          loading={card.main === "loading"}
          refreshing={card.refreshing}
          skeletonRows={5}
          empty={(
            <EmptyState
              title={`${capitalized(periodWords(period))} смен не было`}
              action={period.spec.kind !== "days" || period.days < 30 ? <Button onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать 30 дней</Button> : undefined}
            />
          )}
        />
      </RowBackState>
      <Below card={card} userId={userId} />
    </>
  );
}

/** Under the table: work outside shifts; what the shift reports confirmed, once anyone confirms. */
function Below({ card, userId }: { card: PersonCard; userId: number }) {
  const { period, today } = usePeriod();
  const location = useLocation();
  const { stats, inPeriod } = usePersonStats(userId, period, today);
  const { page } = usePageFilter();
  const lines: ReactNode[] = [];

  if (card.visits.length > 0) {
    const minutes = card.visits.reduce((sum, visit) => sum + visit.workedMinutes, 0);
    lines.push(
      <p key="visits" className="people-note">
        Вне смен: {card.visits.length} {ruPlural(card.visits.length, "раз", "раза", "раз")}, {formatDuration(minutes)}. Это меньше смены
        (от {formatDuration(CHATTER_SHIFT_MIN_WORKED_MINUTES)} и {CHATTER_SHIFT_MIN_MESSAGES} сообщений): в таблицу и в продажи не входит.
      </p>,
    );
  }

  // The shift reports (week 4): shown only once someone confirms a shift — today nobody does.
  const reported = (stats?.shifts ?? []).filter((shift) => inPeriod(shift.date));
  const confirmed = reported.filter((shift) => shift.confirmedNetMills !== null);
  if (confirmed.length > 0) {
    const now = Date.now();
    const waiting = reported.filter((shift) => !shift.ongoing && shift.confirmedNetMills === null && now - Date.parse(shift.startedAt) <= SHIFT_REPORT_MAX_DAYS * 86_400_000).length;
    const sum = millsToNumber(sumMills(confirmed.map((shift) => shift.confirmedNetMills ?? 0)));
    const params = carryParams(location.search).toString();
    lines.push(
      <div key="reports" className="people-idle">
        <span>
          Подтверждено к выплате: <span className="people-meta__strong">{formatMills(sum)}</span> за {confirmed.length} {ruPlural(confirmed.length, "смену", "смены", "смен")}
          {waiting > 0 && <> · ждут подтверждения: {waiting}</>}
        </span>
        <LinkButton size="sm" to={`/payouts${params ? `?${params}` : ""}`}>Выплаты</LinkButton>
      </div>,
    );
  }
  if (page) {
    lines.push(
      <p key="page" className="people-note">
        Смены и продажи — только по странице {page}. Ответ, «без ответа в конце» и доля ИИ — по всей смене: Hub пока не делит их по страницам.
      </p>,
    );
  }
  if (lines.length === 0) return null;
  return <div className="people-aside">{lines}</div>;
}
