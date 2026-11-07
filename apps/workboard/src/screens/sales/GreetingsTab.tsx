import { useMemo } from "react";
import { Button, Card, Disclosure, EmptyState, Facts, Money, Section, Table, TimeMsk, cx, type Column } from "@agency_hub_core/ui";
import { formatCount, formatDay, formatDuration, formatPercent } from "@agency_hub_core/ui/format";
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
  type GreetingsView,
} from "./data";
import { HowItCounts, LineName, NoAnswer, RateCell, SalesHeader, WindowNotice, SCALE_SAMPLE, scaleOf, windowWords } from "./parts";

/**
 * Приветствия и охват: are new subscribers greeted by a person and do they buy
 * after; when fans wrote and nobody was on shift (a page × hour heat map,
 * critic 4.6); do fans answer broadcasts. Two reads, each shown as soon as it
 * comes: the slow one never holds the other.
 */

const pct = (part: number, whole: number) => (whole > 0 ? formatPercent((100 * part) / whole) : "—");

// ------------------------------------------------------------------ Greetings

function greetingColumns(pages: readonly GreetingsPage[]): Column<GreetingsPage>[] {
  const boughtMax = scaleOf(pages.flatMap((page) => [
    page.greeted >= SCALE_SAMPLE ? page.boughtGreeted / page.greeted : null,
    page.newSubscribers - page.greeted >= SCALE_SAMPLE ? page.boughtNotGreeted / (page.newSubscribers - page.greeted) : null,
  ]));
  return [
    { key: "page", header: "Страница", cell: (page) => <LineName kind="page" name={page.pageLabel} />, sortValue: (page) => page.pageLabel, width: "12%" },
    {
      key: "new",
      header: "Новых",
      numeric: true,
      title: "Подписки, начавшиеся за эти дни, у фанов, которые раньше ничего не покупали и не писали",
      cell: (page) => formatCount(page.newSubscribers),
      sortValue: (page) => page.newSubscribers,
      width: "8%",
    },
    {
      key: "auto",
      header: "Авто",
      numeric: true,
      title: "Страница написала в первые 2 минуты: автоприветствие, не человек",
      cell: (page) => <span className={page.newSubscribers === 0 ? "sales-quiet" : undefined}>{pct(page.autoWelcomed, page.newSubscribers)}</span>,
      sortValue: (page) => (page.newSubscribers > 0 ? page.autoWelcomed / page.newSubscribers : null),
      width: "8%",
    },
    {
      key: "greeted",
      header: "Лично за сутки",
      numeric: true,
      headerWrap: false,
      title: "Первое личное сообщение в 24 часа после подписки: написал чаттер, не рассылка",
      cell: (page) => (page.newSubscribers > 0
        ? <span title={`${formatCount(page.greeted)} из ${formatCount(page.newSubscribers)}`}>{pct(page.greeted, page.newSubscribers)}</span>
        : <span className="sales-quiet">—</span>),
      sortValue: (page) => (page.newSubscribers > 0 ? page.greeted / page.newSubscribers : null),
      sortFirst: "desc",
      width: "11%",
    },
    {
      key: "median",
      header: "Обычно через",
      numeric: true,
      headerWrap: false,
      title: "Медиана: половина личных приветствий пришла быстрее",
      cell: (page) => (page.greetingMedianSeconds === null
        ? <span className="sales-quiet">—</span>
        : formatDuration(Math.max(1, Math.round(page.greetingMedianSeconds / 60)))),
      sortValue: (page) => page.greetingMedianSeconds,
      sortFirst: "asc",
      width: "11%",
    },
    {
      key: "replied",
      header: "Ответили за час",
      numeric: true,
      title: "Фан написал в течение часа после личного приветствия",
      headerWrap: false,
      cell: (page) => (page.greeted > 0
        ? <span title={`${formatCount(page.repliedWithinHour)} из ${formatCount(page.greeted)}`}>{pct(page.repliedWithinHour, page.greeted)}</span>
        : <span className="sales-quiet">—</span>),
      sortValue: (page) => (page.greeted > 0 ? page.repliedWithinHour / page.greeted : null),
      width: "11%",
    },
    {
      key: "boughtGreeted",
      header: "Купили с личным",
      headerWrap: false,
      title: "Любая покупка, кроме подписки, в 7 дней после подписки — у поприветствованных лично",
      cell: (page) => <RateCell rate={{ hits: page.boughtGreeted, of: page.greeted }} min={MIN_SAMPLE.greetings} max={boughtMax} />,
      sortValue: (page) => (page.greeted >= MIN_SAMPLE.greetings ? page.boughtGreeted / page.greeted : null),
      sortFirst: "desc",
      width: "19%",
    },
    {
      key: "boughtNot",
      header: "Купили без личного",
      headerWrap: false,
      title: "То же у тех, кого лично не поприветствовали",
      cell: (page) => <RateCell rate={{ hits: page.boughtNotGreeted, of: Math.max(0, page.newSubscribers - page.greeted) }} min={MIN_SAMPLE.greetings} max={boughtMax} />,
      sortValue: (page) => (page.newSubscribers - page.greeted >= MIN_SAMPLE.greetings ? page.boughtNotGreeted / (page.newSubscribers - page.greeted) : null),
      width: "19%",
    },
  ];
}

function GreetingsBlock({ view, loading, failed, onRetry, retrying, refreshing }: { view: GreetingsView | null; loading: boolean; failed: boolean; onRetry: () => void; retrying: boolean; refreshing: boolean }) {
  const totals = view?.totals;
  const everyoneRecent = totals !== undefined && totals.newSubscribers > 0 && totals.recent === totals.newSubscribers;
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
        failed ? <NoAnswer onRetry={onRetry} retrying={retrying} /> : <Table label="Приветствия по страницам" columns={greetingColumns([])} rows={[]} rowKey={(page) => page.pageLabel} loading={loading} skeletonRows={6} />
      ) : view.pages.length === 0 ? (
        <EmptyState title="Новых подписчиков и рассылок нет">За эти дни никто не подписался и рассылок не было.</EmptyState>
      ) : (
        <>
          {totals && totals.newSubscribers > 0 && (
            <Facts
              label="Приветствия вместе"
              items={[
                { label: "Новых подписчиков", value: formatCount(totals.newSubscribers), strong: true },
                { label: "Лично поприветствовали", value: pct(totals.greeted, totals.newSubscribers) },
                { label: "Купили с личным приветствием", value: pct(totals.boughtGreeted, totals.greeted) },
                { label: "без личного", value: pct(totals.boughtNotGreeted, totals.notGreeted) },
              ]}
            />
          )}
          <Table
            label="Приветствия по страницам"
            columns={greetingColumns(view.pages)}
            rows={view.pages}
            rowKey={(page) => page.pageLabel}
            defaultSort={{ key: "new", direction: "desc" }}
            refreshing={refreshing}
          />
        </>
      )}
    </Section>
  );
}

// ----------------------------------------------------------------- Empty hours

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const hourLabel = (hour: number) => String(hour).padStart(2, "0");

/** How often an hour was empty, of the days counted: five calm steps of one ink, none for «never». */
function stepOf(value: number, days: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || days <= 0) return 0;
  const part = value / days;
  return part <= 0.25 ? 1 : part <= 0.5 ? 2 : part <= 0.75 ? 3 : 4;
}

const STEP_WORDS = ["ни разу", "редко", "иногда", "часто", "почти всегда"] as const;

function HeatMap({ pages }: { pages: readonly EmptyHoursLine[] }) {
  const rows = [...pages].sort((a, b) => {
    if ((a.shiftsSince === null) !== (b.shiftsSince === null)) return a.shiftsSince === null ? 1 : -1;
    const share = (page: EmptyHoursLine) => (page.hoursWithFans > 0 ? page.emptyHours / page.hoursWithFans : 0);
    return share(b) - share(a);
  });
  return (
    <div className="sales-heat-wrap">
      <table className="sales-heat" aria-label="Пустые часы по страницам и часам суток">
        <thead>
          <tr>
            <th scope="col" className="sales-heat__label"><span className="ui-sr-only">Страница</span></th>
            {HOURS.map((hour) => <th key={hour} scope="col" className="sales-heat__hour">{hourLabel(hour)}</th>)}
            <th scope="col" className="sales-heat__total">Пусто</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((page) => (
            <tr key={page.pageLabel}>
              <th scope="row" className="sales-heat__label">{page.pageLabel}</th>
              {page.shiftsSince === null ? (
                <td colSpan={24} className="sales-heat__note">Смен в расширении ещё не было — пустые часы не считаются</td>
              ) : HOURS.map((hour) => {
                const value = page.emptyByHour[hour] ?? 0;
                const step = stepOf(value, page.daysCounted);
                const words = `${page.pageLabel}, ${hourLabel(hour)}:00–${hourLabel((hour + 1) % 24)}:00 — пусто ${value} ${ruPlural(value, "раз", "раза", "раз")} из ${page.daysCounted} ${ruPlural(page.daysCounted, "дня", "дней", "дней")}`;
                return (
                  <td key={hour} className="sales-heat__cell" title={words} aria-label={words}>
                    <span className={cx("sales-heat__swatch", `sales-heat__swatch--${step}`)} />
                  </td>
                );
              })}
              <td className="sales-heat__total">
                {page.shiftsSince === null ? <span className="sales-quiet">—</span> : (
                  <span title={`${page.emptyHours} пустых из ${page.hoursWithFans} часов, когда фаны писали`}>
                    {pct(page.emptyHours, page.hoursWithFans)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sales-heat__legend" aria-hidden>
        <span>Час был пустым:</span>
        {STEP_WORDS.map((word, step) => (
          <span key={word} className="sales-heat__key">
            <span className={cx("sales-heat__swatch", `sales-heat__swatch--${step}`)} />
            {word}
          </span>
        ))}
        <span className="sales-heat__legend-note">Время московское</span>
      </div>
    </div>
  );
}

function pageNumberColumns(): Column<EmptyHoursLine>[] {
  return [
    { key: "page", header: "Страница", cell: (page) => <LineName kind="page" name={page.pageLabel} />, width: "18%" },
    { key: "fans", header: "Писали в пустые часы", numeric: true, cell: (page) => formatCount(page.fans), sortValue: (page) => page.fans },
    { key: "payers", header: "Из них платили", numeric: true, title: "Платили на странице за последние 30 дней", cell: (page) => formatCount(page.payers), sortValue: (page) => page.payers },
    { key: "waited", header: "Ждали больше часа", numeric: true, cell: (page) => formatCount(page.waitedOverHour), sortValue: (page) => page.waitedOverHour },
    {
      key: "money",
      header: "Их траты за 30 дней",
      numeric: true,
      title: "Сколько ждавшие потратили на странице за 30 дней: кто ждал, а не потерянные деньги",
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
      description={`Когда фаны писали, а на странице никого не было на смене. Ваша норма — ответ за ${REPLY_NORM_MINUTES.from}–${REPLY_NORM_MINUTES.to} минут: в пустой час её не выполнить, фан ждёт, пока кто-то придёт.`}
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
                { label: "Пусто", value: `${pct(totals.emptyHours, totals.hoursWithFans)} часов`, strong: true, title: `${totals.emptyHours} из ${totals.hoursWithFans} часов, когда фаны писали` },
                { label: "Писали в пустые часы", value: `${formatCount(totals.fans)} ${ruPlural(totals.fans, "фан", "фана", "фанов")}` },
                { label: "Ждали ответа больше часа", value: formatCount(totals.waitedOverHour) },
                { label: "Их траты за 30 дней", value: <Money mills={totals.waitedNetMills} />, title: "Это кто ждал, а не потерянные деньги" },
              ]}
            />
          )}
          <Card padding="none" className={refreshing ? "sales-refreshing" : undefined}>
            <HeatMap pages={view.pages} />
          </Card>
          <Disclosure summary="Числа по страницам" hint="кто писал в пустые часы и ждал">
            <Table label="Пустые часы: числа по страницам" columns={pageNumberColumns()} rows={view.pages} rowKey={(one) => one.pageLabel} defaultSort={{ key: "waited", direction: "desc" }} stickyHeader={false} />
          </Disclosure>
        </>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ Broadcasts

function broadcastColumns(): Column<Broadcast>[] {
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
      width: "22%",
    },
    {
      key: "text",
      header: "Текст",
      cell: (cast) => (
        <span className="sales-stack">
          {cast.preview ? <span className="sales-clamp" title={cast.preview}>{cast.preview}</span> : <span className="sales-quiet">без текста</span>}
          {cast.files > 0 && <span className="sales-sub">{formatCount(cast.files)} {ruPlural(cast.files, "файл", "файла", "файлов")}</span>}
        </span>
      ),
      width: "32%",
    },
    { key: "price", header: "Цена", numeric: true, cell: (cast) => (cast.priceMills === null ? <span className="sales-quiet">бесплатно</span> : <Money mills={cast.priceMills} />), width: "10%" },
    { key: "deliveries", header: "Доставок", numeric: true, cell: (cast) => formatCount(cast.deliveries), sortValue: (cast) => cast.deliveries, width: "10%" },
    {
      key: "replied",
      header: "Ответили за сутки",
      numeric: true,
      headerWrap: false,
      cell: (cast) => <span title={`${formatCount(cast.replied)} из ${formatCount(cast.deliveries)}`}>{pct(cast.replied, cast.deliveries)}</span>,
      sortValue: (cast) => (cast.deliveries > 0 ? cast.replied / cast.deliveries : null),
      width: "12%",
    },
    {
      key: "bought",
      header: "Купили за 7 дней",
      numeric: true,
      cell: (cast) => (
        <span className="sales-stack">
          <span>{formatCount(cast.bought)}</span>
          {cast.priceMills !== null && <span className="sales-sub">именно её: {formatCount(cast.ppvBought)}</span>}
        </span>
      ),
      headerWrap: false,
      sortValue: (cast) => cast.bought,
      width: "12%",
    },
  ];
}

function BroadcastsBlock({ view, owner }: { view: GreetingsView; owner: boolean }) {
  const sending = view.pages.filter((page) => page.broadcasts.sent > 0);
  const columns: Column<GreetingsPage>[] = [
    { key: "page", header: "Страница", cell: (page) => <LineName kind="page" name={page.pageLabel} />, width: "20%" },
    { key: "sent", header: "Рассылок", numeric: true, cell: (page) => formatCount(page.broadcasts.sent), sortValue: (page) => page.broadcasts.sent },
    { key: "deliveries", header: "Доставок", numeric: true, cell: (page) => formatCount(page.broadcasts.deliveries), sortValue: (page) => page.broadcasts.deliveries },
    { key: "replied", header: "Ответили за сутки", numeric: true, cell: (page) => pct(page.broadcasts.replied, page.broadcasts.deliveries), sortValue: (page) => (page.broadcasts.deliveries > 0 ? page.broadcasts.replied / page.broadcasts.deliveries : null) },
    { key: "bought", header: "Купили за 7 дней", numeric: true, cell: (page) => formatCount(page.broadcasts.bought), sortValue: (page) => page.broadcasts.bought },
  ];
  return (
    <Disclosure size="md" summary="Рассылки: отвечают ли" hint={`${formatCount(view.broadcasts.length)} за эти дни`}>
      <div className="sales-fold">
        {sending.length === 0 ? <p className="sales-quiet">Рассылок не было.</p> : (
          <Table label="Рассылки по страницам" columns={columns} rows={sending} rowKey={(page) => page.pageLabel} defaultSort={{ key: "deliveries", direction: "desc" }} stickyHeader={false} />
        )}
        {view.broadcasts.length > 0 && (
          <Table label="Последние рассылки" columns={broadcastColumns()} rows={view.broadcasts} rowKey={(cast) => `${cast.pageLabel}:${cast.sentAt}:${cast.priceMills ?? 0}`} stickyHeader={false} />
        )}
        <p className="sales-quiet">
          Рассылки Fansly и один текст пяти и больше фанам за час: ответили ли за сутки, купили ли за 7 дней.
          {view.broadcasts.length >= 100 ? " Показаны последние 100." : ""}
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
  const { isOwner } = useMe();
  const window = readWindow(period, today, MAX_DAYS.coverage);
  const greetings = useGreetings(window.days);
  const hours = useEmptyHours(window.days);
  const greetingsShown = useMemo(() => (greetings.data ? greetingsView(greetings.data, page) : null), [greetings.data, page]);
  const coverage = useMemo(() => (hours.data ? coverageView(hours.data, page) : null), [hours.data, page]);
  const label = hours.data ? windowWords(hours.data.from, hours.data.to) : greetings.data ? windowWords(greetings.data.from, greetings.data.to) : "";
  const updatedAt = Math.min(...[greetings.dataUpdatedAt, hours.dataUpdatedAt].filter((at) => at > 0));

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
            7 дней срок ещё идёт.
          </p>
          <p>
            Час пустой, если фаны в нём писали, а на этой странице ни одной минуты никто из команды не был на смене: расширение
            ChatGoose открыто, и чаттер что-то делал на странице не больше часа назад. Расширение, забытое открытым на ночь,
            смены не делает. Считается с первой смены страницы в расширении: раньше Hub не отличит пустой час от работы с
            телефона. Цвет клетки — сколько дней из этих этот час был пустым.
          </p>
          <p>
            «Ждали больше часа» — после сообщения в пустой час личный ответ пришёл позже чем через час или его ещё нет
            (рассылка Fansly и один текст пяти и больше фанам за час ответом не считаются). Траты — сколько фан потратил на
            этой странице за последние 30 дней, после комиссии: это кто ждал, а не потерянные деньги.
          </p>
          <p>
            Рассылки — массовые сообщения Fansly и один текст пяти и больше фанам за час, одна строка на текст и день.
            «Ответили» — фан написал в 24 часа после неё, «купили» — любая покупка, кроме подписки, за 7 дней; у платной —
            купил ли фан её саму.
          </p>
          <p>Это ориентир, а не основание для оплаты.</p>
        </HowItCounts>
      </div>
    </>
  );
}
