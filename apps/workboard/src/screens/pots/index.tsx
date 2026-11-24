import { useMemo, useState } from "react";
import { useLocation } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LegacyLedgerPot, PotFormula, PotSummary, PotUnroutedSale } from "@agency_hub_core/contracts";
import { millsFromInteger, sumMills } from "@agency_hub_core/shared";
import {
  Badge,
  Button,
  Confirm,
  EmptyState,
  ErrorState,
  Money,
  Notice,
  PageLabels,
  Segmented,
  Skeleton,
  Table,
  Tabs,
  toast,
  type Column,
} from "@agency_hub_core/ui";
import { formatDay } from "@agency_hub_core/ui/format";
import { kernel } from "@/shared/hub";
import { carryParams } from "@/shared/links";
import { ChainMoney } from "@/shared/saleChain";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { Tiles, type Tile } from "@/shared/Tiles";
import { useMe } from "@/shared/useMe";
import { useSearchParam } from "@/shared/useSearchParam";
import { PotDetailDrawer } from "./PotDetailDrawer";
import { PotFormModal } from "./PotFormModal";
import "./pots.css";

const MONEY_TABS = [
  { value: "debts", label: "Долги" },
  { value: "reports", label: "Отчёты" },
  { value: "pots", label: "Общаки" },
] as const;

type SubView = "pots" | "unrouted" | "archive";

const FORMULA_SHORT: Readonly<Record<PotFormula["kind"], string>> = {
  equal: "Поровну",
  weights: "Веса",
  manual: "Вручную",
};

const UNROUTED_WHY: Readonly<Record<PotUnroutedSale["why"], string>> = {
  no_matching_page_pot: "Нет общака страницы",
  ambiguous_page_pot: "Несколько общаков страницы",
  unknown_code: "Неизвестный код общака",
  closed_or_outside: "Общак закрыт или вне дат",
};

export function PotsScreen() {
  const { isOwner, fullOwner } = useMe();
  const location = useLocation();
  const [search, setParam] = useSearchParam();
  const queryClient = useQueryClient();

  const tab = search.get("tab");
  const subView: SubView = tab === "unrouted" || tab === "archive" ? tab : "pots";
  const [createOpen, setCreateOpen] = useState(false);
  const [pagePotsConfirm, setPagePotsConfirm] = useState(false);

  const testOwner = isOwner && !fullOwner;
  const query = useQuery({
    queryKey: ["pots", "list"] as const,
    queryFn: () => kernel.potsList(),
    enabled: fullOwner,
    staleTime: 30_000,
  });

  const createPagePotsMutation = useMutation({
    mutationFn: () => kernel.potsCreatePagePots({ body: {} }),
    onSuccess: (res) => {
      setPagePotsConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["pots"] });
      toast.success(
        res.created.length > 0
          ? `Создано общаков страниц: ${res.created.length}`
          : "У всех страниц уже есть открытые общаки",
      );
    },
  });

  const carried = carryParams(location.search).toString();
  const tabs = (
    <Tabs
      label="Разделы"
      items={MONEY_TABS.map((option) => ({
        to: { pathname: `/money/${option.value}`, search: carried ? `?${carried}` : "" },
        label: option.label,
      }))}
    />
  );

  const data = query.data;
  const openPotCode = search.get("pot");
  const openPot = useMemo(
    () => (openPotCode && data ? data.pots.find((p) => p.code === openPotCode) ?? null : null),
    [data, openPotCode],
  );

  const tiles = useMemo<Tile[]>(() => {
    if (!data) return [];
    const openPots = data.pots.filter((p) => p.state === "open");
    const totalBalance = sumMills(openPots.map((p) => millsFromInteger(p.balanceMills)));
    const totalPosted = sumMills(data.pots.map((p) => millsFromInteger(p.postedBaseMills)));
    return [
      {
        label: "Баланс в базе",
        value: <Money mills={totalBalance} strong />,
        hint: "Свободный остаток в открытых общаках",
      },
      {
        label: "Проведено",
        value: <Money mills={totalPosted} />,
        hint: "Сумма проведённых раздач в базе",
      },
      {
        label: "Открытых общаков",
        value: String(openPots.length),
        hint: `Всего: ${data.pots.length}`,
      },
      {
        label: "Без общака",
        value: String(data.unroutedCount),
        hint: data.unroutedCount > 0 ? <Money mills={millsFromInteger(data.unroutedBaseMills)} /> : "Все продажи распределены по общакам",
      },
    ];
  }, [data]);

  if (testOwner) {
    return (
      <>
        <ScreenHeader title="Деньги" />
        <div className="wb-content">
          <EmptyState title="В тестовой команде денег нет" className="pots-empty">
            Общаки и раздачи принадлежат боевому контуру агентства.
          </EmptyState>
        </div>
      </>
    );
  }

  if (!isOwner) {
    return (
      <>
        <ScreenHeader title="Деньги" />
        <div className="wb-content">
          <EmptyState title="Общаки видит только владелец" className="pots-empty">
            Управлять общаками, формулами и раздачами может только владелец.
          </EmptyState>
        </div>
      </>
    );
  }

  const potColumns: Column<PotSummary>[] = [
    {
      key: "name",
      header: "Общак",
      grow: true,
      cell: (pot) => (
        <span>
          <strong>{pot.name}</strong>
          <span className="pots-sub">{pot.code} · {pot.modelName}</span>
        </span>
      ),
    },
    {
      key: "pages",
      header: "Страницы",
      cell: (pot) => <PageLabels labels={pot.pageLabels} />,
    },
    {
      key: "rule",
      header: "Правило",
      cell: (pot) => (
        <span className="pots-badges">
          <Badge tone="neutral">{pot.intakeReasons.length > 0 ? "Страницы" : "Событие"}</Badge>
          <Badge tone="neutral">{FORMULA_SHORT[pot.formula.kind]}</Badge>
          {pot.autoPost && <Badge tone="success">Авто</Badge>}
        </span>
      ),
    },
    {
      key: "dates",
      header: "Даты",
      nowrap: true,
      cell: (pot) => `${formatDay(pot.opensOn)} — ${pot.closesOn ? formatDay(pot.closesOn) : "∞"}`,
    },
    {
      key: "balance",
      header: "Баланс (база)",
      numeric: true,
      cell: (pot) => (
        <span>
          <Money mills={millsFromInteger(pot.balanceMills)} strong={pot.balanceMills > 0} muted={pot.balanceMills === 0} />
          <span className="pots-sub">проведено <Money mills={millsFromInteger(pot.postedBaseMills)} /></span>
        </span>
      ),
    },
    {
      key: "state",
      header: "Статус",
      nowrap: true,
      cell: (pot) => (pot.state === "open" ? <Badge tone="success">Открыт</Badge> : <Badge tone="neutral">Закрыт</Badge>),
    },
  ];

  const unroutedColumns: Column<PotUnroutedSale>[] = [
    {
      key: "day",
      header: "День",
      nowrap: true,
      cell: (sale) => formatDay(sale.day),
    },
    {
      key: "page",
      header: "Страница",
      cell: (sale) => (
        <span>
          {sale.pageLabel}
          <span className="pots-sub">{sale.kind} · {sale.reason}</span>
        </span>
      ),
    },
    {
      key: "amount",
      header: "База",
      numeric: true,
      cell: (sale) => (
        <ChainMoney saleId={sale.transactionId}>
          <Money mills={millsFromInteger(sale.remainingBaseMills)} strong />
        </ChainMoney>
      ),
    },
    {
      key: "why",
      header: "Причина",
      grow: true,
      cell: (sale) => (
        <span>
          {UNROUTED_WHY[sale.why]}
          {sale.pot && <span className="pots-sub">код: {sale.pot}</span>}
          {sale.matchingPotCodes.length > 0 && (
            <span className="pots-sub">подходят: {sale.matchingPotCodes.join(", ")}</span>
          )}
        </span>
      ),
    },
  ];

  const archiveColumns: Column<LegacyLedgerPot>[] = [
    {
      key: "name",
      header: "Общак (ledger)",
      grow: true,
      cell: (pot) => (
        <span>
          <strong>{pot.name}</strong>
          <span className="pots-sub">{pot.slug} · {pot.model}</span>
        </span>
      ),
    },
    {
      key: "pages",
      header: "Страницы",
      cell: (pot) => <PageLabels labels={pot.pages} />,
    },
    {
      key: "dates",
      header: "Даты",
      nowrap: true,
      cell: (pot) => `${formatDay(pot.startsAt)} — ${pot.endsAt ? formatDay(pot.endsAt) : "∞"}`,
    },
    {
      key: "sales",
      header: "Продаж",
      numeric: true,
      cell: (pot) => String(pot.sales),
    },
    {
      key: "net",
      header: "База",
      numeric: true,
      cell: (pot) => <Money mills={millsFromInteger(pot.netMills)} />,
    },
    {
      key: "status",
      header: "Статус",
      nowrap: true,
      cell: (pot) => <Badge tone="neutral">{pot.status}</Badge>,
    },
  ];

  return (
    <>
      <ScreenHeader
        title="Деньги"
        tabs={tabs}
        meta={data?.potsFrom ? `в Workboard с ${formatDay(data.potsFrom)}` : "pots_from не включён"}
        {...(query.dataUpdatedAt ? { updatedAt: query.dataUpdatedAt } : {})}
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
        stale={query.isRefetchError}
      />

      <div className="wb-content pots">
        {query.isError && <ErrorState onRetry={() => void query.refetch()} retrying={query.isFetching} />}
        {query.isLoading && <Skeleton height={220} />}

        {data && (
          <>
            {data.potsFrom === null && (
              <Notice tone="warning" title="Общаки в Workboard пока не включены">
                Сначала создайте общаки страниц кнопкой ниже, затем включите дату перехода через CLI <code>pots:from YYYY-MM-DD</code>. До включения продажи общака считаются в ledger.
              </Notice>
            )}

            <Tiles tiles={tiles} label="Сводка общаков" />

            <div className="pots-bar">
              <Segmented<SubView>
                label="Подразделы общаков"
                value={subView}
                onChange={(value) => setParam("tab", value === "pots" ? null : value)}
                options={[
                  { value: "pots", label: `Общаки (${data.pots.length})` },
                  { value: "unrouted", label: `Без общака (${data.unroutedCount})` },
                  { value: "archive", label: `Архив ledger (${data.legacyArchive.pots.length})` },
                ]}
              />
              <div className="pots-bar__actions">
                <Button variant="ghost" onClick={() => setPagePotsConfirm(true)}>
                  Создать общаки страниц
                </Button>
                <Button variant="primary" onClick={() => setCreateOpen(true)} disabled={data.models.length === 0}>
                  + Новый общак
                </Button>
              </div>
            </div>

            {subView === "pots" && (
              <Table
                label="Общаки"
                columns={potColumns}
                rows={data.pots}
                rowKey={(pot) => String(pot.id)}
                onRowClick={(pot) => setParam("pot", pot.code)}
                selectedKey={openPot ? String(openPot.id) : undefined}
                empty={
                  <EmptyState
                    title="Общаков пока нет"
                    action={<Button variant="primary" onClick={() => setPagePotsConfirm(true)}>Создать общаки страниц</Button>}
                  >
                    Создайте общаки страниц одной кнопкой или добавьте событийный общак.
                  </EmptyState>
                }
              />
            )}

            {subView === "unrouted" && (
              <Table
                label="Продажи без общака"
                columns={unroutedColumns}
                rows={data.unrouted}
                rowKey={(sale) => String(sale.transactionId)}
                empty={
                  <EmptyState compact title="Нет продаж без общака">
                    Каждая продажа в общаке после даты включения попала в свой общак.
                  </EmptyState>
                }
              />
            )}

            {subView === "archive" && (
              data.legacyArchive.available ? (
                <Table
                  label="Архив общаков ledger"
                  columns={archiveColumns}
                  rows={data.legacyArchive.pots}
                  rowKey={(pot) => pot.slug}
                  empty={<EmptyState compact title="В архиве ledger общаков нет">Старые общаки до переезда отображаются здесь только для чтения.</EmptyState>}
                />
              ) : (
                <Notice tone="warning" title="Архив ledger недоступен">
                  {data.legacyArchive.error ?? "Не удалось прочитать старые общаки из ledger."}
                </Notice>
              )
            )}
          </>
        )}
      </div>

      {data && openPot && (
        <PotDetailDrawer
          key={openPot.id}
          pot={openPot}
          models={data.models}
          people={data.people}
          onClose={() => setParam("pot", null)}
        />
      )}

      {data && createOpen && (
        <PotFormModal
          mode="create"
          models={data.models}
          people={data.people}
          defaultOpensOn={data.potsFrom}
          closedPageIds={data.pots.filter((p) => p.state === "closed").flatMap((p) => p.pageIds)}
          onClose={() => setCreateOpen(false)}
          onSaved={(saved) => setParam("pot", saved.code)}
        />
      )}

      {pagePotsConfirm && (
        <Confirm
          title="Создать общаки страниц?"
          message="Для каждой страницы без открытого общака страниц будет создан общак (post_tip + campaign, поровну, участники по страницам, автопроведение)."
          tone="primary"
          confirmLabel="Создать"
          pendingLabel="Создаём…"
          isPending={createPagePotsMutation.isPending}
          error={createPagePotsMutation.isError ? (createPagePotsMutation.error instanceof Error ? createPagePotsMutation.error.message : "Ошибка") : undefined}
          onConfirm={() => createPagePotsMutation.mutate()}
          onClose={() => setPagePotsConfirm(false)}
        />
      )}
    </>
  );
}
