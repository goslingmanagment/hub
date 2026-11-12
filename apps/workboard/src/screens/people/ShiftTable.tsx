import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Duration, Money, PageLabels, Skeleton, StatusDot, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatMills } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { shiftDurationHint, shiftWhen, type ShiftWhen } from "@agency_hub_core/ui/shiftWhen";
import { shiftPath, useRowBackState } from "@/shared/links";
import { formatAiUnedited, formatReplyMedian, formatUnanswered, METRICS, UNANSWERED_NOW_LABEL } from "@/shared/metrics";
import { usePageFilter } from "@/shared/usePageFilter";
import type { PersonCard, PersonShift } from "./data.js";
import { Head } from "./Head.js";

/** The pages of a shift in one order everywhere (the header, the table, the ribbon's hint): by name. */
export function pagesInOrder(pages: readonly string[]): string[] {
  return [...pages].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
}

/**
 * The person's shifts of the period, one line each, the newest first (D2):
 * when — said as everywhere (`shiftWhen`, D12: a night is «вс, 1–2 нояб.
 * 21:00–05:49») — how long it worked, money, per hour and the review's three
 * numbers of that very shift (D1: the same as in its review and in «Журнал
 * смен»). The pages only when the shifts differ in them: the header says the
 * person's pages already. Under a page filter the headers say which numbers it
 * narrows (money: that page) and which it cannot (the review's three: the whole
 * shift, E1). The whole row opens the review for the owner; its «←» comes back
 * here.
 */
export function ShiftTable({ card, userId, canOpen }: { card: PersonCard; userId: number; canOpen: boolean }) {
  const location = useLocation();
  const { page } = usePageFilter();
  const backLabel = card.person?.username ?? "Человек";
  const rowState = useRowBackState(backLabel);
  const numbersFailed = card.quality === "failed";

  const whens = useMemo(() => new Map(card.shifts.map((row) => [row.startedAt, shiftWhen(row)])), [card.shifts]);
  // The longest day labels stand invisibly in every cell, so the times start on one line whatever the day's length.
  const sizers = useMemo(() => {
    const distinct = [...new Set([...whens.values()].map((when) => when.days))];
    return distinct.sort((a, b) => b.length - a.length).slice(0, 3);
  }, [whens]);
  const pagesVary = new Set(card.shifts.map((row) => pagesInOrder(row.pages).join(","))).size > 1;

  const slow = (row: PersonShift, show: (numbers: NonNullable<PersonShift["numbers"]>) => ReactNode) => {
    if (row.numbers === undefined) {
      return numbersFailed
        ? <Tooltip content="Hub не ответил" align="end"><span className="people-dash">—</span></Tooltip>
        : <span className="people-pending"><Skeleton width={48} /></span>;
    }
    if (row.numbers === null) return <Tooltip content="Для этой смены чисел нет" align="end"><span className="people-dash">—</span></Tooltip>;
    return show(row.numbers);
  };
  const whenOf = (row: PersonShift): ShiftWhen => whens.get(row.startedAt) ?? shiftWhen(row);
  // Under a page filter each header says its scope. The long labels over short numbers break in two where a line
  // would leave a hole (D18): on 1920 (a whole-line header over «2» left 250 px empty) and on 1440 with the pages column.
  const header = (label: string, scope: "page" | "shift", split?: readonly [string, string]) => {
    const sub = page === null ? undefined : scope === "page" ? page : "вся смена";
    return <Head lines={split ?? [label]} {...(sub ? { sub } : {})} />;
  };

  const columns: Column<PersonShift>[] = [
    {
      key: "when",
      header: "Смена",
      nowrap: true,
      sortValue: (row) => row.startedAt,
      sortFirst: "desc",
      cell: (row) => {
        const when = whenOf(row);
        return (
          <span className="people-shift">
            <span className="people-shift__day">
              {sizers.map((text) => <span key={text} aria-hidden className="people-shift__sizer">{text}</span>)}
              <span>{when.days}</span>
            </span>
            <span className={row.ongoing ? "people-shift__time people-shift__time--now" : "people-shift__time"}>
              {row.ongoing && <StatusDot tone="success" label="Идёт сейчас" />}
              {when.time}
            </span>
          </span>
        );
      },
    },
    ...(pagesVary ? [{
      key: "pages",
      header: "Страницы",
      cell: (row: PersonShift) => <PageLabels labels={pagesInOrder(row.pages)} max={3} />,
    } satisfies Column<PersonShift>] : []),
    {
      key: "worked",
      header: "Длительность",
      numeric: true,
      hint: "Время работы без пауз. Если были паузы, их длина в подсказке у числа.",
      sortValue: (row) => row.workedMinutes,
      cell: (row) => {
        const when = whenOf(row);
        const duration = <Duration minutes={row.workedMinutes} />;
        return when.withPauses ? <Tooltip content={shiftDurationHint(when)} align="end"><span>{duration}</span></Tooltip> : duration;
      },
    },
    {
      key: "sales",
      header: header("Продажи", "page"),
      headerWrap: false,
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
      header: header("В час", "page"),
      headerWrap: false,
      numeric: true,
      sortValue: (row) => row.perHourMills,
      cell: (row) => <Money mills={row.perHourMills} />,
    },
    {
      key: "reply",
      header: header(METRICS.reply.label, "shift", ["Ответ,", "медиана"]),
      headerWrap: false,
      numeric: true,
      hint: METRICS.reply.hint,
      sortValue: (row) => row.numbers?.replyMedianSeconds ?? null,
      sortFirst: "desc",
      cell: (row) => slow(row, (numbers) => formatReplyMedian(numbers.replyMedianSeconds)),
    },
    {
      key: "unanswered",
      header: header(METRICS.unanswered.label, "shift", ["Без ответа", "к концу"]),
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
      header: header(METRICS.aiUnedited.label, "shift", ["ИИ без", "правки"]),
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
      className={pagesVary ? "people-shifts" : "people-shifts people-shifts--oneline"}
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
