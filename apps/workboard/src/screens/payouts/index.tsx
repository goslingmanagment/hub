import { Copy } from "lucide-react";
import { useSearchParams } from "react-router";
import { Button, Disclosure, EmptyState, ErrorState, LinkButton, Money, Notice, Person, Table, TimeMsk, type Column } from "@agency_hub_core/ui";
import { formatDayRange } from "@agency_hub_core/ui/format";
import { sheetText } from "@agency_hub_core/ui/payoutSheet";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { carryParams } from "@/shared/links";
import { usePeriod } from "@/shared/usePeriod";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { copySheet } from "./copy";
import { PayoutDrawer, SheetDayTable } from "./PayoutDrawer";
import { usePayouts, CONFIRM_MAX_DAYS, EXPORT_MAX_DAYS, type PayoutChatter, type PayoutsView } from "./data";
import "./payouts.css";

/**
 * Выплаты (spec §4.7): confirmed sales per chatter for the payout sheet, for
 * the app's one period; who has not confirmed, with the sales at stake. Every
 * page, on purpose: the export is never cut by a page filter (the console's
 * rule, TeamPayoutsPage.tsx:28-33), so this screen has none. A row opens the
 * chatter's panel (`?chatter=`): their days, their block to copy, their shifts
 * without a confirmation.
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
      {count} {ruPlural(count, "смена", "смены", "смен")}
      {(going > 0 || late > 0) && (
        <span className="payouts-sub">
          {[going > 0 && (going === 1 ? "одна ещё идёт" : `${going} ещё идут`), late > 0 && `${late} уже нельзя подтвердить`].filter(Boolean).join(" · ")}
        </span>
      )}
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
      cell: (row) => <Person name={row.username} {...(row.days > 0 ? { hint: `${row.days} ${ruPlural(row.days, "день", "дня", "дней")} с продажами` } : {})} />,
      sortValue: (row) => row.username,
    },
    ...(anyConfirmed ? [
      {
        key: "confirmed",
        header: "Подтверждено",
        title: "Подтверждённые чаттером продажи за период: то, что копируется в таблицу выплат",
        numeric: true,
        width: 180,
        cell: (row: PayoutChatter) => (row.confirmedMills > 0n ? <Money mills={row.confirmedMills} strong /> : <span className="text-ink-3">—</span>),
        sortValue: (row: PayoutChatter) => row.confirmedMills,
        footer: <Money mills={view.confirmedMills} strong />,
      },
      {
        key: "pages",
        header: "Страницы",
        cell: (row: PayoutChatter) => row.pages.length === 0 ? <span className="text-ink-3">—</span> : (
          <span className="payouts-pages">
            {row.pages.map((page) => (
              <span key={page.pageLabel} className="payouts-page">
                <span className="payouts-page__label">{page.pageLabel}</span>
                {row.pages.length > 1 && <Money mills={page.mills} />}
              </span>
            ))}
          </span>
        ),
      },
    ] satisfies Column<PayoutChatter>[] : []),
    ...(anyUnconfirmed ? [
      {
        key: "unconfirmed",
        header: "Без подтверждения",
        headerWrap: false,
        width: 220,
        cell: (row: PayoutChatter) => <UnconfirmedCell chatter={row} />,
        sortValue: (row: PayoutChatter) => row.unconfirmed.length,
        sortFirst: "desc" as const,
      },
      {
        key: "stake",
        header: "Продажи этих смен",
        headerWrap: false,
        numeric: true,
        width: 200,
        title: "Продажи смен без подтверждения по данным Hub, до отметок чаттера. В выгрузку не входят, пока чаттер не подтвердит смену.",
        cell: (row: PayoutChatter) => (row.unconfirmed.length === 0 ? <span className="text-ink-3">—</span> : <Money mills={row.atStakeMills} />),
        sortValue: (row: PayoutChatter) => row.atStakeMills,
        footer: view.atStakeMills !== null && view.atStakeMills > 0n ? <Money mills={view.atStakeMills} /> : undefined,
      },
    ] satisfies Column<PayoutChatter>[] : []),
  ];
  return (
    <Table
      label="Выплаты по чаттерам"
      columns={columns}
      rows={view.chatters}
      rowKey={(row) => row.username}
      onRowClick={(row) => onOpen(row.username)}
      selectedKey={selected}
      defaultSort={anyConfirmed ? null : { key: "stake", direction: "desc" }}
    />
  );
}

export function PayoutsScreen() {
  const { period, setPeriod } = usePeriod();
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

  const rows = view?.sheet.length ?? 0;
  const why = problem !== null ? problem
    : view === null || exported.isFetching ? "Выгрузка ещё читается"
      : exported.isError ? "Не удалось обновить: копировать старые суммы нельзя"
        : rows === 0 ? "Нечего копировать: за эти дни нет подтверждённых отчётов" : null;
  const copyAll = () => {
    if (view === null || why !== null) return;
    void copySheet(sheetText(view.sheet, view.days), `Скопировано: ${linesWord(rows)}, ${formatDayRange(view.from, view.to)}, все страницы`);
  };

  const confirmedNone = view !== null && view.sheet.length === 0 && view.chatters.length > 0;
  const decisionsHref = `/decisions?${carryParams(search).toString()}`;

  return (
    <>
      <ScreenHeader
        title="Выплаты"
        period
        actions={(
          <Button variant="primary" icon={Copy} disabled={why !== null} title={why ?? "Таблица по дням: блок на чаттера, Fansly до цента, OnlyFans целыми долларами"} onClick={copyAll}>
            Скопировать для таблицы
          </Button>
        )}
        meta={<>Подтверждённые продажи за {period.label}, все страницы. Копируется в формате таблицы выплат.</>}
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
            ? <Table label="Выплаты по чаттерам" columns={SKELETON_COLUMNS} rows={[]} rowKey={() => ""} loading skeletonRows={5} />
            : <ErrorState onRetry={payouts.refetch} retrying={exported.isFetching} />
        ) : (
          <>
            <div className="payouts-notices">
            {exported.isError && <Notice tone="warning" role="alert" action={<Button size="sm" onClick={payouts.refetch}>Повторить</Button>}>Не удалось обновить: показаны прежние суммы, копировать их нельзя.</Notice>}
            {view.disputedOpen > 0 && (
              <Notice tone="warning" action={<LinkButton size="sm" to={decisionsHref}>К спорам</LinkButton>}>
                Не вошло: {view.disputedOpen} {ruPlural(view.disputedOpen, "продажа", "продажи", "продаж")} в споре. Решите спор — и продажа попадёт в выгрузку.
              </Notice>
            )}
            {view.lateChanges.length > 0 && (
              <Notice tone="warning" title={`Изменено после подтверждения дня: ${linesWord(view.lateChanges.length)}`}>
                Уже выгруженный день мог измениться. Что именно — внизу, в «Что изменилось».
              </Notice>
            )}
            {confirmedNone && (
              <Notice tone="off" title="Чаттеры ещё не подтвердили ни одной смены за эти дни">
                Копировать пока нечего. Продажи их смен по данным Hub — в последнем столбце; в выгрузку они попадут, когда чаттер подтвердит смену в кабинете.
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

            <div className="payouts-folds">
            {view.sheet.length > 0 && (
              <Disclosure size="md" summary="Вся выгрузка по дням" hint={`${linesWord(view.sheet.length)} · как вставится в таблицу`} className="payouts-fold">
                <SheetDayTable sheet={view.sheet} days={view.days} withChatter />
              </Disclosure>
            )}
            {view.lateChanges.length > 0 && (
              <Disclosure size="md" summary="Что изменилось" hint={String(view.lateChanges.length)} className="payouts-fold">
                <LateChangesTable changes={view.lateChanges} />
              </Disclosure>
            )}
            <Disclosure summary="Как это считается">
              <p>
                Чаттеры отмечают продажи своих смен в кабинете («моё», «делим», «не моё») и подтверждают отчёт. Сумма чаттеру
                записывается один раз, когда он подтверждает смену, — на день его смены (тот, на который пришлась большая её часть,
                как в таблице выплат), и потом не переезжает; «делим» — пополам, на день первого подтверждения; решение спора
                заменяет прежние суммы продажи.
              </p>
              <p>
                «Продажи этих смен» — продажи смен без подтверждения по данным Hub, до отметок чаттера: столько стоит на кону, в
                выгрузку они не входят. Подтвердить смену можно {CONFIRM_MAX_DAYS} дней.
              </p>
              <p>Выгрузка всегда по всем страницам: фильтр страницы её не меняет. Fansly — до цента, OnlyFans — целыми долларами.</p>
            </Disclosure>
            </div>
          </>
        )}
      </div>
      {openChatter && view && (
        <PayoutDrawer key={openChatter.username} chatter={openChatter} view={view} canCopy={why === null || (openChatter.sheet.length > 0 && !exported.isFetching && !exported.isError)} onClose={() => setChatter(null)} />
      )}
    </>
  );
}

const SKELETON_COLUMNS: Column<never>[] = [
  { key: "who", header: "Чаттер", cell: () => null },
  { key: "confirmed", header: "Подтверждено", numeric: true, width: 180, cell: () => null },
  { key: "pages", header: "Страницы", cell: () => null },
  { key: "unconfirmed", header: "Без подтверждения", headerWrap: false, width: 220, cell: () => null },
  { key: "stake", header: "Продажи этих смен", headerWrap: false, numeric: true, width: 200, cell: () => null },
];

function LateChangesTable({ changes }: { changes: PayoutsView["lateChanges"] }) {
  const columns: Column<PayoutsView["lateChanges"][number]>[] = [
    { key: "what", header: "Что", width: 120, cell: (row) => (row.change === "added" ? "Дописано" : "Снято") },
    { key: "sum", header: "Сумма", numeric: true, width: 120, cell: (row) => <Money mills={row.creditedMills} /> },
    { key: "who", header: "Чаттер", cell: (row) => row.username },
    { key: "page", header: "Страница", cell: (row) => row.pageLabel },
    { key: "day", header: "День выплаты", nowrap: true, cell: (row) => <TimeMsk at={row.payDay} show="date" /> },
    { key: "at", header: "Когда изменено", nowrap: true, cell: (row) => <TimeMsk at={row.at} /> },
  ];
  return <Table label="Изменено после подтверждения дня" columns={columns} rows={changes} rowKey={(row) => `${row.change}-${row.username}-${row.saleRef}-${row.at}`} />;
}

