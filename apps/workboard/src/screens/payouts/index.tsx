import { ArrowRight, ChevronRight, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button, Disclosure, EmptyState, ErrorState, Money, Notice, PageLabel, Person, Table, TimeMsk, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatDay, formatDayRange } from "@agency_hub_core/ui/format";
import { sheetText } from "@agency_hub_core/ui/payoutSheet";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { carryParams } from "@/shared/links";
import { usePeriod } from "@/shared/usePeriod";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { copySheet } from "./copy";
import { rangeWords } from "./range";
import { PayoutDrawer, SheetDayTable } from "./PayoutDrawer";
import { usePayouts, CONFIRM_MAX_DAYS, EXPORT_MAX_DAYS, type PayoutChatter, type PayoutsView } from "./data";
import "./payouts.css";

/**
 * Выплаты (spec §4.7): confirmed sales per chatter for the payout sheet, for
 * the app's one period; who has not confirmed, with the sales at stake. Every
 * page, on purpose: the export is never cut by a page filter (the console's
 * rule, TeamPayoutsPage.tsx:28-33), so this screen has none. A row opens the
 * chatter's panel (`?chatter=`): their days, their block to copy, their shifts
 * without a confirmation, their own amounts.
 */

/** «3 строки» */
function linesWord(count: number): string {
  return `${count} ${ruPlural(count, "строка", "строки", "строк")}`;
}

function UnconfirmedCell({ chatter }: { chatter: PayoutChatter }) {
  const count = chatter.unconfirmed.length;
  if (count === 0) return <span className="text-ink-3">—</span>;
  const going = chatter.unconfirmed.filter((shift) => shift.ongoing).length;
  const late = chatter.unconfirmed.filter((shift) => shift.tooLate).length;
  return (
    <span>
      {/* Not read is not zero (В-н5): the shifts are known, their sales are not. */}
      {chatter.atStakeMills === null
        ? <Tooltip content="Hub не ответил, сколько продаж в этих сменах: суммы нет, это не ноль. Обновите экран." align="end"><span className="payouts-unknown">нет данных</span></Tooltip>
        : <Money mills={chatter.atStakeMills} />}
      <span className="payouts-sub">
        {[
          `${count} ${ruPlural(count, "смена", "смены", "смен")}`,
          going > 0 && (going === 1 ? "одна ещё идёт" : `${going} ещё идут`),
          late > 0 && `${late} уже нельзя подтвердить`,
        ].filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}

const STAKE_HINT = "Продажи смен, которые чаттер ещё не подтвердил, — по данным Hub, до его отметок. В выгрузку не входят, пока чаттер не подтвердит смену в кабинете.";
const CONFIRMED_HINT = "Подтверждённые чаттером продажи за эти дни — то, что копируется в таблицу выплат. Суммы такие, какими вставятся: Fansly до цента, OnlyFans целыми долларами.";

/** «Итого» of «Ждут подтверждения»: every chatter's, or the known ones' with who is left out (В-н5). */
function StakeTotal({ view }: { view: PayoutsView }) {
  if (view.atStakeMills !== null) return view.atStakeMills > 0n ? <Money mills={view.atStakeMills} /> : null;
  const left = view.atStakeUnknown;
  return (
    <span>
      <Money mills={view.atStakeKnownMills} />
      <span className="payouts-sub">без {left.length <= 2 ? left.join(" и ") : `${left.slice(0, 2).join(", ")} и ещё ${left.length - 2}`}</span>
    </span>
  );
}

function SummaryTable({ view, onOpen, selected }: { view: PayoutsView; onOpen: (username: string) => void; selected: string | null }) {
  // While nobody has confirmed anything, the confirmed columns would be a row of zeros: they wait until the first confirmation.
  const anyConfirmed = view.sheet.length > 0;
  const anyUnconfirmed = view.chatters.some((chatter) => chatter.unconfirmed.length > 0);
  const columns: Column<PayoutChatter>[] = [
    {
      key: "who",
      header: "Чаттер",
      // As wide as the names: the room of a wide screen goes after the pages.
      nowrap: true,
      cell: (row) => <Person name={row.username} hint={row.days > 0 ? `${row.days} ${ruPlural(row.days, "день", "дня", "дней")} с продажами` : null} />,
      sortValue: (row) => row.username,
      // «Итого» only where a total stands beside it.
      ...(anyConfirmed || view.atStakeKnownMills > 0n || view.atStakeUnknown.length > 0 ? { footer: <span className="payouts-total">Итого</span> } : {}),
    },
    ...(anyConfirmed ? [
      {
        key: "confirmed",
        header: "Подтверждено",
        hint: CONFIRMED_HINT,
        numeric: true,
        width: 190,
        cell: (row: PayoutChatter) => (row.confirmedMills > 0n ? (
          <span>
            <Money mills={row.confirmedMills} strong />
            {/* A sum the chatter wrote below Hub's: the owner pays by it, so the row says so (В1). */}
            {row.ownAmounts.length > 0 && <span className="payouts-sub payouts-own">{row.ownAmounts.length} {ruPlural(row.ownAmounts.length, "своя сумма", "своих суммы", "своих сумм")}</span>}
          </span>
        ) : <span className="text-ink-3">—</span>),
        sortValue: (row: PayoutChatter) => row.confirmedMills,
        footer: <Money mills={view.confirmedMills} strong />,
      },
      {
        key: "pages",
        header: "Страницы",
        // The spare width of a wide screen goes after the pages, not between the name and its sum.
        grow: true,
        cell: (row: PayoutChatter) => row.pages.length === 0 ? <span className="text-ink-3">—</span> : (
          <span className="payouts-pages">
            {row.pages.map((page) => (
              <span key={page.pageLabel} className="payouts-page">
                <PageLabel label={page.pageLabel} platform={page.platform} />
                {row.pages.length > 1 && <Money mills={page.mills} />}
              </span>
            ))}
          </span>
        ),
      },
    ] satisfies Column<PayoutChatter>[] : []),
    ...(anyUnconfirmed ? [
      {
        key: "stake",
        header: "Ждут подтверждения",
        headerWrap: false,
        hint: STAKE_HINT,
        numeric: true,
        width: 240,
        cell: (row: PayoutChatter) => <UnconfirmedCell chatter={row} />,
        sortValue: (row: PayoutChatter) => (row.unconfirmed.length === 0 ? null : row.atStakeMills),
        footer: <StakeTotal view={view} />,
      },
    ] satisfies Column<PayoutChatter>[] : []),
    {
      key: "go",
      header: <span className="ui-sr-only">Открыть</span>,
      width: 44,
      cell: () => <ChevronRight size={18} strokeWidth={1.75} aria-hidden className="payouts-go" />,
    },
  ];
  return (
    <Table
      label="Выплаты по чаттерам"
      columns={columns}
      rows={view.chatters}
      rowKey={(row) => row.username}
      onRowClick={(row) => onOpen(row.username)}
      selectedKey={selected}
      skeletonLines={2}
      align="first-line"
      // Nobody confirmed (production today): two columns make a narrow sheet by the width rule (Table «fit»), and the notices
      // over it end where it ends (В6).
      defaultSort={anyConfirmed ? null : { key: "stake", direction: "desc" }}
    />
  );
}

export function PayoutsScreen() {
  const { spec, period, setPeriod } = usePeriod();
  const [search, setSearch] = useSearchParams();
  const payouts = usePayouts(period);
  const { view, exported, problem } = payouts;
  const chatterName = search.get("chatter");
  const openChatter = view?.chatters.find((chatter) => chatter.username === chatterName) ?? null;
  const setChatter = (username: string | null) => setSearch((current) => {
    const next = new URLSearchParams(current);
    if (username === null) next.delete("chatter");
    else next.set("chatter", username);
    return next;
  });
  // «Что изменилось» opens and comes into view from the notice above the table (В4).
  const [lateOpen, setLateOpen] = useState(false);
  const lateRef = useRef<HTMLDivElement>(null);
  const showLate = () => {
    setLateOpen(true);
    window.requestAnimationFrame(() => lateRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const rows = view?.sheet.length ?? 0;
  const words = view ? rangeWords(view, spec.kind === "week") : null;
  const why = problem !== null ? problem
    : view === null || exported.isFetching ? "Выгрузка ещё читается"
      : exported.isError ? "Не удалось обновить: копировать старые суммы нельзя"
        : rows === 0 ? "Нечего копировать: за эти дни нет подтверждённых отчётов" : null;
  const copyAll = () => {
    if (view === null || why !== null || words === null) return;
    void copySheet(
      sheetText(view.sheet, view.days),
      `Скопировано: ${linesWord(rows)}, ${words.range}${words.copyNote}, все страницы`,
    );
  };

  const confirmedNone = view !== null && view.sheet.length === 0 && view.chatters.length > 0;
  const decisionsHref = `/decisions?${carryParams(search).toString()}#disputes`;
  const ownAll = view ? view.chatters.flatMap((chatter) => chatter.ownAmounts) : [];
  const warnings = view ? [
    view.disputedOpen > 0 && {
      key: "disputes",
      text: `Не вошло: ${view.disputedOpen} ${ruPlural(view.disputedOpen, "продажа", "продажи", "продаж")} в споре. Решите спор — и продажа попадёт в выгрузку.`,
      action: <Link to={decisionsHref} className="payouts-notice-link">К спорам <ArrowRight size={14} strokeWidth={1.75} aria-hidden /></Link>,
    },
    view.lateChanges.length > 0 && {
      key: "late",
      text: `Изменено после подтверждения дня: ${linesWord(view.lateChanges.length)}. Уже выгруженный день мог измениться.`,
      action: <button type="button" className="payouts-notice-link" onClick={showLate}>Показать <ArrowRight size={14} strokeWidth={1.75} aria-hidden /></button>,
    },
  ].filter((one) => one !== false) : [];

  return (
    <>
      <ScreenHeader
        title="Выплаты"
        period
        actions={(
          // A verb and an icon in the filter's place (D15): the period stands where it stands on every screen; what is copied is in the
          // line under the title and in the hint.
          <Tooltip content={why ?? "Скопировать для таблицы выплат: блок на чаттера, дни столбцами, Fansly до цента, OnlyFans целыми долларами"} align="end">
            <Button variant="primary" icon={Copy} disabled={why !== null} onClick={copyAll}>
              Скопировать
            </Button>
          </Tooltip>
        )}
        meta={words
          ? <>Подтверждённые продажи за {words.range}{words.note}, все страницы. Копируется в формате таблицы выплат.</>
          : <>Подтверждённые продажи за {period.label}, все страницы. Копируется в формате таблицы выплат.</>}
        updatedAt={exported.dataUpdatedAt}
        onRefresh={payouts.refetch}
        refreshing={exported.isFetching}
      />
      <div className="wb-content">
        {problem !== null ? (
          <EmptyState
            title={problem}
            className="payouts-empty"
            action={<Button onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать последние 30 дней</Button>}
          >
            Таблица выплат берёт до {EXPORT_MAX_DAYS} дня подряд: неделя, 14 и 30 дней подходят всегда.
          </EmptyState>
        ) : view === null ? (
          payouts.loading
            ? <Table label="Выплаты по чаттерам" columns={SKELETON_COLUMNS} rows={[]} rowKey={() => ""} loading skeletonRows={5} skeletonLines={2} />
            : <ErrorState onRetry={payouts.refetch} retrying={exported.isFetching} />
        ) : (
          <>
            {/*
              The notices and the table as one block: a fitted table (Table «fit») makes the block's notices end where the table
              ends (`--ui-section-fit`), so a notice never runs 500 px past the table it is about (В-н6).
            */}
            <div className="ui-section payouts-main">
              <div className="payouts-notices">
                {exported.isError && <Notice tone="warning" role="alert" action={<Button size="sm" onClick={payouts.refetch}>Повторить</Button>}>Не удалось обновить: показаны прежние суммы, копировать их нельзя.</Notice>}
                {/* Two things left out of the copy, one notice: each line with its own way on (В4). */}
                {warnings.length > 0 && (
                  <Notice tone="warning">
                    <ul className="payouts-warnings">
                      {warnings.map((one) => <li key={one.key}><span>{one.text}</span>{one.action}</li>)}
                    </ul>
                  </Notice>
                )}
                {confirmedNone && (
                  <Notice title="Чаттеры ещё не подтвердили ни одной смены за эти дни">
                    Копировать пока нечего. Продажи их смен по данным Hub — в столбце «Ждут подтверждения»; в выгрузку они попадут, когда чаттер
                    подтвердит смену в кабинете.
                  </Notice>
                )}
              </div>

              {view.chatters.length === 0 ? (
                <EmptyState title="За эти дни смен нет" className="payouts-empty">
                  Ни подтверждённых отчётов, ни смен без подтверждения за {formatDayRange(view.from, view.to)}.
                </EmptyState>
              ) : (
                <SummaryTable view={view} onOpen={setChatter} selected={openChatter?.username ?? null} />
              )}
            </div>

            <div className="payouts-folds">
              {view.sheet.length > 0 && (
                <Disclosure size="md" summary="Вся выгрузка по дням" hint={`${linesWord(view.sheet.length)} · по дням, как в таблице выплат`} className="payouts-fold">
                  <SheetDayTable sheet={view.sheet} days={view.days} withChatter />
                </Disclosure>
              )}
              {ownAll.length > 0 && (
                <Disclosure size="md" summary="Своя сумма вместо суммы Hub" hint={String(ownAll.length)} className="payouts-fold">
                  <p className="payouts-note">Чаттер записал продажу «моё» с суммой меньше, чем у Hub. В выгрузку идёт его сумма.</p>
                  <OwnAmountsTable own={ownAll} />
                </Disclosure>
              )}
              {view.lateChanges.length > 0 && (
                <div ref={lateRef} className="payouts-anchor">
                  <Disclosure size="md" summary="Что изменилось" hint={String(view.lateChanges.length)} className="payouts-fold" open={lateOpen} onOpenChange={setLateOpen}>
                    <LateChangesTable changes={view.lateChanges} />
                  </Disclosure>
                </div>
              )}
              <Disclosure summary="Как это считается">
                <p>
                  Чаттеры отмечают продажи своих смен в кабинете («моё», «делим», «не моё») и подтверждают отчёт. Сумма чаттеру
                  записывается один раз, когда он подтверждает смену, — на день его смены (тот, на который пришлась большая её часть,
                  как в таблице выплат), и потом не переезжает; «делим» — пополам, на день первого подтверждения; решение спора
                  заменяет прежние суммы продажи.
                </p>
                <p>
                  «Ждут подтверждения» — продажи смен без подтверждения по данным Hub, до отметок чаттера: столько стоит на кону, в
                  выгрузку они не входят. Подтвердить смену можно {CONFIRM_MAX_DAYS} дней.
                </p>
                <p>Выгрузка всегда по всем страницам: фильтр страницы её не меняет. Fansly — до цента, OnlyFans — целыми долларами.</p>
              </Disclosure>
            </div>
          </>
        )}
      </div>
      {openChatter && view && words && (
        <PayoutDrawer
          key={openChatter.username}
          chatter={openChatter}
          view={view}
          words={words}
          canCopy={why === null || (openChatter.sheet.length > 0 && !exported.isFetching && !exported.isError)}
          onClose={() => setChatter(null)}
        />
      )}
    </>
  );
}

const SKELETON_COLUMNS: Column<never>[] = [
  { key: "who", header: "Чаттер", cell: () => null },
  { key: "confirmed", header: "Подтверждено", numeric: true, width: 190, cell: () => null },
  { key: "pages", header: "Страницы", cell: () => null },
  { key: "stake", header: "Ждут подтверждения", headerWrap: false, numeric: true, width: 240, cell: () => null },
  { key: "go", header: "", width: 44, cell: () => null },
];

function OwnAmountsTable({ own }: { own: PayoutChatter["ownAmounts"] }) {
  const columns: Column<PayoutChatter["ownAmounts"][number]>[] = [
    { key: "who", header: "Чаттер", cell: (row) => row.username, sortValue: (row) => row.username },
    { key: "page", header: "Страница", cell: (row) => row.pageLabel },
    { key: "at", header: "Продажа", nowrap: true, cell: (row) => <TimeMsk at={row.occurredAt} />, sortValue: (row) => row.occurredAt },
    { key: "hub", header: "Сумма Hub", numeric: true, cell: (row) => <Money mills={row.netMills} muted /> },
    { key: "own", header: "Своя сумма", numeric: true, cell: (row) => <Money mills={row.amountMills} strong /> },
  ];
  return <Table label="Своя сумма вместо суммы Hub" columns={columns} rows={own} rowKey={(row) => `${row.username}-${row.saleRef}`} defaultSort={{ key: "at", direction: "desc" }} />;
}

function LateChangesTable({ changes }: { changes: PayoutsView["lateChanges"] }) {
  const columns: Column<PayoutsView["lateChanges"][number]>[] = [
    { key: "what", header: "Что", width: 120, cell: (row) => (row.change === "added" ? "Дописано" : "Снято") },
    { key: "sum", header: "Сумма", numeric: true, width: 120, cell: (row) => <Money mills={row.creditedMills} /> },
    { key: "who", header: "Чаттер", cell: (row) => row.username },
    { key: "page", header: "Страница", cell: (row) => row.pageLabel },
    { key: "day", header: "День выплаты", nowrap: true, cell: (row) => formatDay(row.payDay) },
    { key: "at", header: "Когда изменено", nowrap: true, cell: (row) => <TimeMsk at={row.at} /> },
  ];
  return <Table label="Изменено после подтверждения дня" columns={columns} rows={changes} rowKey={(row) => `${row.change}-${row.username}-${row.saleRef}-${row.at}`} />;
}
