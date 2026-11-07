import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { Duration, Money, PageLabels, Skeleton, StatusDot, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatMills } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftPath, useRowBackState } from "@/shared/links";
import { formatAiUnedited, formatReplyMedian, formatUnanswered, METRICS, UNANSWERED_NOW_LABEL } from "@/shared/metrics";
import type { PersonCard, PersonShift } from "./data.js";
import { Head } from "./Head.js";
import { dayWords, timeRange } from "./words.js";

/**
 * The person's shifts of the period, one line each, the newest first (D2):
 * when, the pages, how long, money, per hour and the review's three numbers
 * of that very shift (D1: the same as in its review and in «Журнал смен»).
 * The whole row opens the review for the owner; its «←» comes back here.
 */
export function ShiftTable({ card, userId, canOpen }: { card: PersonCard; userId: number; canOpen: boolean }) {
  const location = useLocation();
  const backLabel = card.person?.username ?? "Человек";
  const rowState = useRowBackState(backLabel);
  const numbersFailed = card.quality === "failed";

  const slow = (row: PersonShift, show: (numbers: NonNullable<PersonShift["numbers"]>) => ReactNode) => {
    if (row.numbers === undefined) {
      return numbersFailed
        ? <Tooltip content="Hub не ответил" align="end"><span className="people-dash">—</span></Tooltip>
        : <span className="people-pending"><Skeleton width={48} /></span>;
    }
    if (row.numbers === null) return <Tooltip content="Для этой смены чисел нет" align="end"><span className="people-dash">—</span></Tooltip>;
    return show(row.numbers);
  };

  const columns: Column<PersonShift>[] = [
    {
      key: "when",
      header: "Смена",
      nowrap: true,
      sortValue: (row) => row.startedAt,
      sortFirst: "desc",
      cell: (row) => (
        <span className="people-shift">
          <span className="people-shift__day">{dayWords(row.date)}</span>
          <span className={row.ongoing ? "people-shift__time people-shift__time--now" : "people-shift__time"}>
            {row.ongoing && <StatusDot tone="success" label="Идёт сейчас" />}
            {timeRange(row)}
          </span>
        </span>
      ),
    },
    {
      key: "pages",
      header: "Страницы",
      grow: true,
      cell: (row) => <PageLabels labels={row.pages} max={3} />,
    },
    {
      key: "worked",
      header: "Отработал",
      numeric: true,
      hint: "Смена без пауз",
      sortValue: (row) => row.workedMinutes,
      cell: (row) => <Duration minutes={row.workedMinutes} />,
    },
    {
      key: "sales",
      header: "Продажи",
      numeric: true,
      sortValue: (row) => row.salesNetMills,
      cell: (row) => (
        <Money
          mills={row.salesNetMills}
          strong
          hint={`${row.sales} ${ruPlural(row.sales, "продажа", "продажи", "продаж")}${row.overlapNetMills > 0 ? `; из них ${formatMills(row.overlapNetMills)} видны и у коллеги: страницу вели двое, этим фанам никто из них не писал` : ""}`}
        />
      ),
    },
    {
      key: "hour",
      header: "В час",
      numeric: true,
      sortValue: (row) => row.perHourMills,
      cell: (row) => <Money mills={row.perHourMills} />,
    },
    {
      key: "reply",
      header: <Head lines={["Ответ,", "медиана"]} />,
      headerWrap: false,
      numeric: true,
      hint: METRICS.reply.hint,
      sortValue: (row) => row.numbers?.replyMedianSeconds ?? null,
      sortFirst: "desc",
      cell: (row) => slow(row, (numbers) => formatReplyMedian(numbers.replyMedianSeconds)),
    },
    {
      key: "unanswered",
      header: <Head lines={["Без ответа", "к концу"]} />,
      headerWrap: false,
      numeric: true,
      hint: METRICS.unanswered.hint,
      sortValue: (row) => row.numbers?.unansweredAtEnd ?? null,
      sortFirst: "desc",
      cell: (row) => slow(row, (numbers) => (row.ongoing
        ? <Tooltip content={`${UNANSWERED_NOW_LABEL}: смена идёт`} align="end"><span>{formatUnanswered(numbers.unansweredAtEnd)}</span></Tooltip>
        : formatUnanswered(numbers.unansweredAtEnd))),
    },
    {
      key: "ai",
      header: <Head lines={["ИИ без", "правки"]} />,
      headerWrap: false,
      numeric: true,
      hint: METRICS.aiUnedited.hint,
      sortValue: (row) => row.numbers?.aiUneditedShare ?? null,
      sortFirst: "desc",
      cell: (row) => slow(row, (numbers) => formatAiUnedited(numbers.aiUneditedShare)),
    },
  ];

  return (
    <Table
      label={`Смены ${backLabel}`}
      className="people-shifts"
      columns={columns}
      rows={card.shifts}
      rowKey={(row) => row.startedAt}
      {...(canOpen ? { rowHref: (row: PersonShift) => shiftPath(userId, row.startedAt, location.search), rowState } : {})}
      defaultSort={{ key: "when", direction: "desc" }}
      loading={card.main === "loading"}
      refreshing={card.refreshing}
      skeletonRows={5}
    />
  );
}
