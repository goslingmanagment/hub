import { useMemo, useState } from "react";
import { Button, Card, Disclosure, Drawer, EmptyState, Facts, HeatGrid, Mark, Money, RateBar, Section, Table, TimeMsk, Tooltip, type Column, type HeatStep } from "@agency_hub_core/ui";
import { formatCount, formatDay, formatDuration, formatOf, formatPercent } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { useMe } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import {
  MAX_DAYS,
  MIN_SAMPLE,
  REPLY_NORM_MINUTES,
  coverageView,
  greetingsView,
  readWindow,
  useEmptyHours,
  useGreetings,
  type Broadcast,
  type CoverageView,
  type EmptyHoursLine,
  type GreetingsPage,
  type GreetingsTotals,
  type GreetingsView,
} from "./data";
import { barWidth, HowItCounts, LineName, NoAnswer, SalesHeader, WindowNotice, openColumn, SCALE_SAMPLE, scaleOf, skeletonColumns, useSalesParams, windowWords } from "./parts";

/**
 * Приветствия и охват: are new subscribers greeted by a person and do they buy
 * after; when fans wrote and nobody was on shift (a page × hour heat map); do
 * fans answer broadcasts. Two reads, each shown as soon as it comes: the slow
 * one never holds the other. A row opens the page's full greeting numbers.
 */

const pct = (part: number, whole: number) => (whole > 0 ? formatPercent((100 * part) / whole) : "—");
const notGreeted = (page: GreetingsPage) => Math.max(0, page.newSubscribers - page.greeted);
const minutesOf = (seconds: number) => Math.max(1, Math.round(seconds / 60));

/** A greeting later than this is marked: an hour is six times the owner's reply norm. */
const SLOW_GREETING_SECONDS = 60 * 60;

// ------------------------------------------------------------------ Greetings

function greetingColumns(pages: readonly GreetingsPage[], totals: GreetingsTotals | null): Column<GreetingsPage>[] {
  const teamGreeted = totals && totals.newSubscribers > 0 ? totals.greeted / totals.newSubscribers : null;
  const greetedMax = scaleOf(pages.map((page) => (page.newSubscribers >= SCALE_SAMPLE ? page.greeted / page.newSubscribers : null)).concat(teamGreeted));
  const boughtMax = scaleOf(pages.map((page) => (page.greeted >= SCALE_SAMPLE ? page.boughtGreeted / page.greeted : null)));
  return [
    {
      key: "page",
      header: "Страница",
      cell: (page) => <LineName kind="page" name={page.pageLabel} platform={page.platform} />,
      sortValue: (page) => page.pageLabel,
      grow: true,
    },
    {
      key: "new",
      header: "Новых",
      numeric: true,
      hint: "Подписки, начавшиеся за эти дни, у фанов, которые раньше ничего не покупали и не писали",
      cell: (page) => formatCount(page.newSubscribers),
      sortValue: (page) => page.newSubscribers,
    },
    {
      key: "greeted",
      header: "Лично за сутки",
      hint: "Первое личное сообщение в 24 часа после подписки: написал чаттер, не рассылка и не автоприветствие. Черта — все страницы вместе; отмечено, когда заметно реже",
      cell: (page) => {
        const value = page.newSubscribers > 0 ? page.greeted / page.newSubscribers : null;
        const worse = value !== null && teamGreeted !== null && page.newSubscribers >= MIN_SAMPLE.greetings && value <= teamGreeted - 0.15;
        return <RateBar hits={page.greeted} of={page.newSubscribers} min={MIN_SAMPLE.greetings} max={greetedMax} compare={teamGreeted} compareLabel="все страницы" tone={worse ? "mark" : "neutral"} />;
      },
      sortValue: (page) => (page.newSubscribers > 0 ? page.greeted / page.newSubscribers : null),
      sortFirst: "desc",
      width: barWidth(28, 440),
    },
    {
      key: "median",
      header: "Обычно через",
      numeric: true,
      hint: "Медиана: половина личных приветствий пришла быстрее. Отмечено, когда дольше часа",
      cell: (page) => {
        if (page.greetingMedianSeconds === null) return <span className="sales-quiet">—</span>;
        const text = formatDuration(minutesOf(page.greetingMedianSeconds));
        return page.greetingMedianSeconds > SLOW_GREETING_SECONDS ? <Mark hint="Дольше часа: в шесть раз дольше вашей нормы ответа">{text}</Mark> : text;
      },
      sortValue: (page) => page.greetingMedianSeconds,
      sortFirst: "asc",
    },
    {
      key: "bought",
      header: "Купили с личным",
      hint: "Любая покупка, кроме подписки, в 7 дней после подписки — у поприветствованных лично. Справа — то же у тех, кого лично не поприветствовали",
      cell: (page) => {
        const rest = notGreeted(page);
        const detail = rest === 0 ? "без личного —" : rest < MIN_SAMPLE.greetings ? `без личного ${formatOf(page.boughtNotGreeted, rest)}` : `без личного ${pct(page.boughtNotGreeted, rest)}`;
        return <RateBar hits={page.boughtGreeted} of={page.greeted} min={MIN_SAMPLE.greetings} max={boughtMax} detail={detail} detailWidth={140} />;
      },
      sortValue: (page) => (page.greeted >= MIN_SAMPLE.greetings ? page.boughtGreeted / page.greeted : null),
      sortFirst: "desc",
      width: barWidth(36, 580),
    },
    openColumn<GreetingsPage>(),
  ];
}

function GreetingsBlock({ view, loading, failed, onRetry, retrying, refreshing, openKey, onOpen }: {
  view: GreetingsView | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  retrying: boolean;
  refreshing: boolean;
  openKey: string | null;
  onOpen: (page: GreetingsPage) => void;
}) {
  const totals = view?.totals ?? null;
  const everyoneRecent = totals !== null && totals.newSubscribers > 0 && totals.recent === totals.newSubscribers;
  return (
    <Section
      title="Приветствия новых подписчиков"
      description={everyoneRecent
        ? "Кого поприветствовали лично, как быстро и купили ли после. У всех подписчиков этих дней 7 дней ещё не прошли: покупки могут добавиться."
        : totals && totals.recent > 0
          ? `Кого поприветствовали лично, как быстро и купили ли после. У ${formatCount(totals.recent)} ${ruPlural(totals.recent, "подписчика", "подписчиков", "подписчиков")} 7 дней ещё не прошли: их покупки могут добавиться.`
          : "Кого поприветствовали лично, как быстро и купили ли после."}
    >
      {!view ? (
        failed ? <NoAnswer onRetry={onRetry} retrying={retrying} /> : <Table label="Приветствия по страницам" columns={skeletonColumns(greetingColumns([], null))} rows={[]} rowKey={(page) => page.pageLabel} loading={loading} skeletonRows={6} />
      ) : view.pages.length === 0 ? (
        <EmptyState title="Новых подписчиков и рассылок нет">За эти дни никто не подписался и рассылок не было.</EmptyState>
      ) : (
        <>
          {totals && totals.newSubscribers > 0 && (
            <Facts
              label="Приветствия вместе"
              items={[
                { label: "Новых подписчиков", value: formatCount(totals.newSubscribers), strong: true },
                { label: "Лично поприветствовали", value: pct(totals.greeted, totals.newSubscribers), hint: `${formatOf(totals.greeted, totals.newSubscribers)} — в 24 часа после подписки` },
                { label: "Купили с личным приветствием", value: pct(totals.boughtGreeted, totals.greeted) },
                { label: "без личного", value: pct(totals.boughtNotGreeted, totals.notGreeted) },
              ]}
            />
          )}
          <Table
            label="Приветствия по страницам"
            columns={greetingColumns(view.pages, totals)}
            rows={view.pages}
            rowKey={(page) => page.pageLabel}
            onRowClick={onOpen}
            selectedKey={openKey}
            defaultSort={{ key: "new", direction: "desc" }}
            refreshing={refreshing}
          />
        </>
      )}
    </Section>
  );
}

/** One page's greetings in full: what the table leaves out (the automatic welcome, answers within an hour). */
function GreetingDrawer({ page, onClose, windowLabel }: { page: GreetingsPage; onClose: () => void; windowLabel: string }) {
  const rest = notGreeted(page);
  return (
    <Drawer open onClose={onClose} title={page.pageLabel} subtitle={`Новые подписчики · ${windowLabel}`}>
      <div className="sales-drawer">
        <Facts
          layout="stacked"
          columns={2}
          label={`${page.pageLabel}: приветствия`}
          items={[
            { label: "Новых подписчиков", value: formatCount(page.newSubscribers), strong: true, ...(page.recent > 0 ? { meta: `у ${formatCount(page.recent)} ещё идут 7 дней` } : {}) },
            { label: "Автоприветствие", value: pct(page.autoWelcomed, page.newSubscribers), meta: `${formatOf(page.autoWelcomed, page.newSubscribers)}, в первые 2 минуты` },
            { label: "Лично за сутки", value: pct(page.greeted, page.newSubscribers), meta: formatOf(page.greeted, page.newSubscribers) },
            { label: "Обычно через", value: page.greetingMedianSeconds === null ? "—" : formatDuration(minutesOf(page.greetingMedianSeconds)), meta: "половина приветствий быстрее" },
            { label: "Фан ответил за час", value: pct(page.repliedWithinHour, page.greeted), meta: `${formatOf(page.repliedWithinHour, page.greeted)} после личного` },
            { label: "Купили с личным", value: pct(page.boughtGreeted, page.greeted), meta: `${formatOf(page.boughtGreeted, page.greeted)}; без личного ${rest > 0 ? pct(page.boughtNotGreeted, rest) : "—"}` },
          ]}
        />
        {page.broadcasts.sent > 0 && (
          <p className="sales-drawer__lead">
            Рассылок {formatCount(page.broadcasts.sent)}, доставок {formatCount(page.broadcasts.deliveries)}: ответили за сутки{" "}
            {pct(page.broadcasts.replied, page.broadcasts.deliveries)}, купили за 7 дней {formatCount(page.broadcasts.bought)}.
          </p>
        )}
      </div>
    </Drawer>
  );
}

// ----------------------------------------------------------------- Empty hours

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));

/** How often an hour was empty, of the days counted: four calm steps of one ink, none for «never». */
function stepOf(value: number, days: number): HeatStep {
  if (value <= 0 || days <= 0) return 0;
  const part = value / days;
  return part <= 0.25 ? 1 : part <= 0.5 ? 2 : part <= 0.75 ? 3 : 4;
}

function HeatMap({ pages }: { pages: readonly EmptyHoursLine[] }) {
  const sorted = [...pages].sort((a, b) => {
    if ((a.shiftsSince === null) !== (b.shiftsSince === null)) return a.shiftsSince === null ? 1 : -1;
    const share = (page: EmptyHoursLine) => (page.hoursWithFans > 0 ? page.emptyHours / page.hoursWithFans : 0);
    return share(b) - share(a);
  });
  const byKey = new Map(sorted.map((page) => [page.pageLabel, page]));
  return (
    <HeatGrid
      label="Пустые часы по страницам и часам суток"
      columns={HOURS}
      rows={sorted.map((page) => ({
        key: page.pageLabel,
        label: page.pageLabel,
        ...(page.shiftsSince === null
          ? { note: "Смен в расширении ещё не было — пустые часы не считаются", total: <span className="sales-quiet">—</span> }
          : {
            values: page.emptyByHour,
            total: (
              <Tooltip content={`${formatCount(page.emptyHours)} пустых из ${formatCount(page.hoursWithFans)} часов, когда фаны писали`} align="end">
                <span>{pct(page.emptyHours, page.hoursWithFans)}</span>
              </Tooltip>
            ),
          }),
      }))}
      stepOf={(value, row) => stepOf(value, byKey.get(row.key)?.daysCounted ?? 1)}
      cellHint={(row, hour, value) => {
        const days = byKey.get(row.key)?.daysCounted ?? 0;
        const next = HOURS[(hour + 1) % 24];
        return `${row.key}, ${HOURS[hour]}:00–${next}:00 — пусто ${formatCount(value ?? 0)} ${ruPlural(value ?? 0, "раз", "раза", "раз")} из ${formatCount(days)} ${ruPlural(days, "дня", "дней", "дней")}`;
      }}
      totalHeader="Пусто"
      legend={{ title: "Час был пустым:", steps: ["ни разу", "редко", "иногда", "часто", "почти всегда"], note: "Время московское" }}
    />
  );
}

function pageNumberColumns(): Column<EmptyHoursLine>[] {
  return [
    { key: "page", header: "Страница", cell: (page) => <LineName kind="page" name={page.pageLabel} platform={page.platform} /> },
    { key: "fans", header: "Писали в пустые часы", numeric: true, cell: (page) => formatCount(page.fans), sortValue: (page) => page.fans },
    { key: "payers", header: "Из них платили", numeric: true, hint: "Платили на странице за последние 30 дней", cell: (page) => formatCount(page.payers), sortValue: (page) => page.payers },
    {
      key: "waited",
      header: "Ждали больше часа",
      numeric: true,
      hint: `Личный ответ пришёл позже чем через час или его ещё нет — в шесть раз дольше вашей нормы (${REPLY_NORM_MINUTES.from}–${REPLY_NORM_MINUTES.to} минут)`,
      cell: (page) => formatCount(page.waitedOverHour),
      sortValue: (page) => page.waitedOverHour,
    },
    {
      key: "money",
      header: "Их траты за 30 дней",
      numeric: true,
      hint: "Сколько ждавшие потратили на странице за 30 дней, после комиссии: кто ждал, а не потерянные деньги",
      cell: (page) => (page.waitedOverHour > 0 ? <Money mills={page.waitedNetMills} /> : <span className="sales-quiet">—</span>),
      sortValue: (page) => page.waitedNetMills,
    },
    { key: "since", header: "Смены в расширении с", numeric: true, cell: (page) => (page.shiftsSince ? formatDay(page.shiftsSince) : <span className="sales-quiet">не было</span>) },
  ];
}

function CoverageBlock({ view, loading, failed, onRetry, retrying, refreshing, onAllPages, page }: { view: CoverageView | null; loading: boolean; failed: boolean; onRetry: () => void; retrying: boolean; refreshing: boolean; onAllPages: () => void; page: string | null }) {
  const totals = view?.totals;
  const counted = view?.pages.filter((one) => one.shiftsSince !== null) ?? [];
  return (
    <Section
      title="Пустые часы"
      description={`Когда фаны писали, а на странице никого не было на смене: ответить за вашу норму, ${REPLY_NORM_MINUTES.from}–${REPLY_NORM_MINUTES.to} минут, в такой час некому.`}
    >
      {!view ? (
        failed ? <NoAnswer onRetry={onRetry} retrying={retrying} /> : loading ? <Card><div className="sales-heat-skeleton" aria-hidden /></Card> : null
      ) : view.pages.length === 0 ? (
        page !== null
          ? <EmptyState title={`На ${page} за эти дни фаны не писали`} action={<Button onClick={onAllPages}>Показать все страницы</Button>} />
          : <EmptyState title="Фаны не писали">За эти дни ни на одну страницу не пришло сообщений.</EmptyState>
      ) : (
        <>
          {totals && counted.length > 0 && (
            <Facts
              label="Пустые часы вместе"
              items={[
                { label: "Пусто", value: `${pct(totals.emptyHours, totals.hoursWithFans)} часов`, strong: true, hint: `${formatCount(totals.emptyHours)} из ${formatCount(totals.hoursWithFans)} часов, когда фаны писали` },
                { label: "Писали в пустые часы", value: `${formatCount(totals.fans)} ${ruPlural(totals.fans, "фан", "фана", "фанов")}` },
                { label: "Ждали ответа больше часа", value: formatCount(totals.waitedOverHour), hint: "В шесть раз дольше вашей нормы: Hub пока считает только «больше часа»" },
                { label: "Их траты за 30 дней", value: <Money mills={totals.waitedNetMills} />, hint: "Это кто ждал, а не потерянные деньги" },
              ]}
            />
          )}
          <Card padding="md" className={refreshing ? "sales-refreshing" : undefined}>
            <HeatMap pages={view.pages} />
          </Card>
          <Disclosure summary="Числа по страницам" hint="кто писал в пустые часы и ждал">
            <div className="sales-fold">
              <Table label="Пустые часы: числа по страницам" columns={pageNumberColumns()} rows={view.pages} rowKey={(one) => one.pageLabel} defaultSort={{ key: "waited", direction: "desc" }} stickyHeader={false} />
            </div>
          </Disclosure>
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Broadcasts

const DAY_MS = 86_400_000;
/** How many of the latest broadcasts the fold shows before «Показать все». */
const BROADCASTS_SHOWN = 10;

function broadcastColumns(now: number): Column<Broadcast>[] {
  const age = (cast: Broadcast) => now - Date.parse(cast.sentAt);
  return [
    {
      key: "when",
      header: "Когда и где",
      cell: (cast) => (
        <span className="sales-stack">
          <TimeMsk at={cast.sentAt} show="datetime" />
          <span className="sales-sub">{cast.pageLabel} · {cast.massMessage ? "рассылка Fansly" : "один текст многим"}</span>
        </span>
      ),
      sortValue: (cast) => cast.sentAt,
      sortFirst: "desc",
      nowrap: true,
    },
    {
      key: "text",
      header: "Текст",
      cell: (cast) => (
        <span className="sales-stack">
          {cast.preview ? <span className="sales-clamp">{cast.preview}</span> : <span className="sales-quiet">без текста</span>}
          {cast.files > 0 && <span className="sales-sub">{formatCount(cast.files)} {ruPlural(cast.files, "файл", "файла", "файлов")}</span>}
        </span>
      ),
      grow: true,
    },
    { key: "price", header: "Цена", numeric: true, cell: (cast) => (cast.priceMills === null ? <span className="sales-quiet">бесплатно</span> : <Money mills={cast.priceMills} />) },
    { key: "deliveries", header: "Доставок", numeric: true, cell: (cast) => formatCount(cast.deliveries), sortValue: (cast) => cast.deliveries },
    {
      key: "replied",
      header: "Ответили за сутки",
      numeric: true,
      cell: (cast) => (age(cast) < DAY_MS
        ? <Tooltip content="Сутки после рассылки ещё не прошли" align="end"><span className="sales-quiet">зреет</span></Tooltip>
        : <Tooltip content={formatOf(cast.replied, cast.deliveries)} align="end"><span>{pct(cast.replied, cast.deliveries)}</span></Tooltip>),
      sortValue: (cast) => (cast.deliveries > 0 && age(cast) >= DAY_MS ? cast.replied / cast.deliveries : null),
    },
    {
      key: "bought",
      header: "Купили за 7 дней",
      numeric: true,
      cell: (cast) => {
        const bought = (
          <span className="sales-stack">
            <span className={age(cast) < 7 * DAY_MS ? "sales-quiet" : undefined}>{formatCount(cast.bought)}</span>
            {cast.priceMills !== null && <span className="sales-sub">именно её: {formatCount(cast.ppvBought)}</span>}
          </span>
        );
        // Not final yet: pale, like a small sample; the hint says why.
        return age(cast) < 7 * DAY_MS ? <Tooltip content="7 дней после рассылки ещё не прошли: число растёт" align="end">{bought}</Tooltip> : bought;
      },
      sortValue: (cast) => cast.bought,
    },
  ];
}

function BroadcastsBlock({ view, owner }: { view: GreetingsView; owner: boolean }) {
  const [all, setAll] = useState(false);
  const now = Date.now();
  const sending = view.pages.filter((page) => page.broadcasts.sent > 0);
  const columns: Column<GreetingsPage>[] = [
    { key: "page", header: "Страница", cell: (page) => <LineName kind="page" name={page.pageLabel} platform={page.platform} /> },
    { key: "sent", header: "Рассылок", numeric: true, cell: (page) => formatCount(page.broadcasts.sent), sortValue: (page) => page.broadcasts.sent },
    { key: "deliveries", header: "Доставок", numeric: true, cell: (page) => formatCount(page.broadcasts.deliveries), sortValue: (page) => page.broadcasts.deliveries },
    { key: "replied", header: "Ответили за сутки", numeric: true, cell: (page) => pct(page.broadcasts.replied, page.broadcasts.deliveries), sortValue: (page) => (page.broadcasts.deliveries > 0 ? page.broadcasts.replied / page.broadcasts.deliveries : null) },
    { key: "bought", header: "Купили за 7 дней", numeric: true, cell: (page) => formatCount(page.broadcasts.bought), sortValue: (page) => page.broadcasts.bought },
  ];
  const shown = all ? view.broadcasts : view.broadcasts.slice(0, BROADCASTS_SHOWN);
  return (
    <Disclosure size="md" summary="Рассылки: отвечают ли" hint={`${formatCount(view.broadcasts.length)} за эти дни`}>
      <div className="sales-fold">
        {sending.length === 0 ? <p className="sales-quiet">Рассылок не было.</p> : (
          <Table label="Рассылки по страницам" columns={columns} rows={sending} rowKey={(page) => page.pageLabel} defaultSort={{ key: "deliveries", direction: "desc" }} stickyHeader={false} />
        )}
        {view.broadcasts.length > 0 && (
          <>
            <Table label="Последние рассылки" columns={broadcastColumns(now)} rows={shown} rowKey={(cast) => `${cast.pageLabel}:${cast.sentAt}:${cast.priceMills ?? 0}`} stickyHeader={false} />
            {view.broadcasts.length > BROADCASTS_SHOWN && (
              <div className="sales-after">
                <p>{all ? `Все ${formatCount(view.broadcasts.length)}` : `Последние ${BROADCASTS_SHOWN} из ${formatCount(view.broadcasts.length)}`}{view.broadcasts.length >= 100 ? " (Hub отдаёт не больше 100)" : ""}.</p>
                <Button size="sm" variant="ghost" onClick={() => setAll((value) => !value)}>{all ? "Свернуть" : "Показать все"}</Button>
              </div>
            )}
          </>
        )}
        <p className="sales-quiet">
          Рассылки Fansly и один текст пяти и больше фанам за час: ответили ли за сутки, купили ли за 7 дней.
          {owner ? " Рассылки по данным Fansly — на карточке страницы в Hub, вкладка «Рассылки»: там другие числа." : ""}
        </p>
      </div>
    </Disclosure>
  );
}

// -------------------------------------------------------------------- The tab

export function GreetingsTab() {
  const { period, today } = usePeriod();
  const { page, setPage } = usePageFilter();
  const { open, setOpen } = useSalesParams();
  const { isOwner } = useMe();
  const window = readWindow(period, today, MAX_DAYS.coverage);
  const greetings = useGreetings(window.days);
  const hours = useEmptyHours(window.days);
  const greetingsShown = useMemo(() => (greetings.data ? greetingsView(greetings.data, page) : null), [greetings.data, page]);
  const coverage = useMemo(() => (hours.data ? coverageView(hours.data, page) : null), [hours.data, page]);
  const label = hours.data ? windowWords(hours.data.from, hours.data.to) : greetings.data ? windowWords(greetings.data.from, greetings.data.to) : "";
  const updatedAt = Math.min(...[greetings.dataUpdatedAt, hours.dataUpdatedAt].filter((at) => at > 0));
  const openPage = greetingsShown?.pages.find((one) => `page:${one.pageLabel}` === open) ?? null;

  return (
    <>
      <SalesHeader
        meta={label ? `Подписки, рассылки и часы ${label}${page ? ` · ${page}` : " · все страницы"}` : "Приветствия и пустые часы"}
        updatedAt={Number.isFinite(updatedAt) ? updatedAt : undefined}
        onRefresh={() => {
          void greetings.refetch();
          void hours.refetch();
        }}
        refreshing={greetings.isFetching || hours.isFetching}
      />
      <div className="wb-content">
        <WindowNotice window={window} maxDays={MAX_DAYS.coverage} {...(label ? { shown: label } : {})} />
        <GreetingsBlock
          view={greetingsShown}
          loading={greetings.isLoading}
          failed={greetings.isError}
          onRetry={() => void greetings.refetch()}
          retrying={greetings.isFetching}
          refreshing={greetings.isPlaceholderData}
          openKey={openPage?.pageLabel ?? null}
          onOpen={(one) => setOpen(`page:${one.pageLabel}`)}
        />
        <CoverageBlock
          view={coverage}
          loading={hours.isLoading}
          failed={hours.isError}
          onRetry={() => void hours.refetch()}
          retrying={hours.isFetching}
          refreshing={hours.isPlaceholderData}
          onAllPages={() => setPage(null)}
          page={page}
        />
        {greetingsShown && greetingsShown.pages.length > 0 && <BroadcastsBlock view={greetingsShown} owner={isOwner} />}
        <HowItCounts>
          <p>
            Новые подписчики — подписки, начавшиеся за эти дни, у фанов, которые раньше ничего не покупали на странице и не
            переписывались с ней: продление и возвращение не считаются. Сообщение страницы в первые 2 минуты после подписки
            без автора из команды — автоприветствие. Личное приветствие — первое сообщение за 24 часа после подписки,
            написанное чаттером или пришедшее позже 2 минут, не рассылка Fansly и не один текст пяти и больше фанам за час.
          </p>
          <p>
            «Ответили за час» — фан написал в течение часа после личного приветствия. «Купили» — любая покупка, кроме
            подписки, в 7 дней после подписки: отдельно у поприветствованных лично и у остальных. У подписавшихся в последние
            7 дней срок ещё идёт. Автоприветствие и «ответили за час» — в панели страницы.
          </p>
          <p>
            Час пустой, если фаны в нём писали, а на этой странице ни одной минуты никто из команды не был на смене: расширение
            ChatGoose открыто, и чаттер что-то делал на странице не больше часа назад. Расширение, забытое открытым на ночь,
            смены не делает. Считается с первой смены страницы в расширении: раньше Hub не отличит пустой час от работы с
            телефона. Цвет клетки — сколько дней из этих этот час был пустым.
          </p>
          <p>
            «Ждали больше часа» — после сообщения в пустой час личный ответ пришёл позже чем через час или его ещё нет
            (рассылка Fansly и один текст пяти и больше фанам за час ответом не считаются). Час — в шесть раз дольше вашей
            нормы ответа, {REPLY_NORM_MINUTES.from}–{REPLY_NORM_MINUTES.to} минут: точнее Hub пока не считает. Траты — сколько
            фан потратил на этой странице за последние 30 дней, после комиссии: это кто ждал, а не потерянные деньги.
          </p>
          <p>
            Рассылки — массовые сообщения Fansly и один текст пяти и больше фанам за час, одна строка на текст и день.
            «Ответили» — фан написал в 24 часа после неё, «купили» — любая покупка, кроме подписки, за 7 дней; у платной —
            купил ли фан её саму. Пока сутки (или 7 дней) не прошли, число ещё растёт.
          </p>
          <p>Это ориентир, а не основание для оплаты.</p>
        </HowItCounts>
      </div>
      {openPage && <GreetingDrawer page={openPage} onClose={() => setOpen(null)} windowLabel={label} />}
    </>
  );
}
