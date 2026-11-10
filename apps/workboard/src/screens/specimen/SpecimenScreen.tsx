import { Archive, Copy, Download, KeyRound, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Confirm,
  CountBadge,
  Delta,
  Disclosure,
  Drawer,
  Duration,
  EmptyState,
  ErrorState,
  Facts,
  Fan,
  Field,
  HeatGrid,
  Hint,
  IconButton,
  Kbd,
  KeyValue,
  LinkButton,
  Mark,
  Menu,
  Modal,
  Money,
  Notice,
  PageLabel,
  PageLabels,
  PeriodControl,
  Person,
  RateBar,
  SearchInput,
  Section,
  Segmented,
  Select,
  SidePanel,
  Skeleton,
  SkeletonText,
  StatusDot,
  Switch,
  Table,
  Tabs,
  Textarea,
  TextInput,
  TimeMsk,
  Tooltip,
  collidingFanNames,
  fanNameCollides,
  toast,
  type Column,
  type HeatGridRow,
  type PersonStatus,
} from "@agency_hub_core/ui";
import { formatOf, formatPercent } from "@agency_hub_core/ui/format";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { currentWeek, type PeriodSpec } from "@agency_hub_core/ui/period";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { useBackState } from "@/shared/links";
import { METRICS } from "@/shared/metrics";
import { ScreenHeader } from "@/shared/ScreenHeader";
import { RoundTwoSection } from "./RoundTwo.js";

/**
 * The specimen of packages/ui: every component in the states a screen uses,
 * with invented numbers. It sets the bar for every screen of Workboard. Demo
 * and dev builds only (src/app/routes.tsx).
 *
 * The heading rule it shows: a screen of several blocks puts each block in a
 * `Section` (20 px title outside the frame); the frame inside has no title of
 * its own. A `Card` with a title only in a grid of cards.
 */

interface ChatterRow {
  id: number;
  name: string;
  status: PersonStatus;
  pages: string[];
  shifts: number;
  minutes: number;
  salesMills: number;
  /** Sales of the week before; null: nothing to compare with. */
  prevMills: number | null;
  perHourMills: number;
  replySeconds: number | null;
  unanswered: number | null;
  aiShare: number | null;
  team?: boolean;
}

const CHATTERS: ChatterRow[] = [
  { id: 4, name: "den.s", status: "working", pages: ["nova-1"], shifts: 5, minutes: 2484, salesMills: 2_144_380, prevMills: 3_020_000, perHourMills: 51_790, replySeconds: 74, unanswered: 1, aiShare: 0.42 },
  { id: 2, name: "alex.k", status: "away", pages: ["mia-1", "mia-2"], shifts: 6, minutes: 2815, salesMills: 1_070_150, prevMills: 906_900, perHourMills: 22_810, replySeconds: 118, unanswered: 3, aiShare: 0.31 },
  { id: 6, name: "kate.v", status: "away", pages: ["mia-3", "mia-1"], shifts: 4, minutes: 1822, salesMills: 526_270, prevMills: 526_270, perHourMills: 17_330, replySeconds: 96, unanswered: 0, aiShare: 0.27 },
  { id: 7, name: "olya.m", status: "working", pages: ["mia-vip-of", "mia-of", "mia-1", "mia-2"], shifts: 3, minutes: 1392, salesMills: 103_960, prevMills: 693_000, perHourMills: 4_480, replySeconds: 412, unanswered: 9, aiShare: 0.71 },
  { id: 8, name: "ivan.p", status: "away", pages: ["ivy-2"], shifts: 4, minutes: 739, salesMills: 31_980, prevMills: 16_000, perHourMills: 2_590, replySeconds: 205, unanswered: 2, aiShare: 0.18 },
  { id: 9, name: "lena.r", status: "disabled", pages: ["ivy-1"], shifts: 0, minutes: 0, salesMills: 0, prevMills: 419_940, perHourMills: 0, replySeconds: null, unanswered: null, aiShare: null },
];

const TEAM_ROW: ChatterRow = {
  id: 0,
  name: "Вся команда",
  status: "away",
  pages: [],
  shifts: 22,
  minutes: 9252,
  salesMills: 3_876_740,
  prevMills: 5_538_000,
  perHourMills: 25_140,
  replySeconds: 112,
  unanswered: 15,
  aiShare: 0.38,
  team: true,
};

const TEAM_REPLY_MEDIAN = 112;

/** The three numbers of a shift's quality: the app's one module of their words (spec r2, D1). */
const METRIC = { reply: METRICS.reply, unanswered: METRICS.unanswered, ai: METRICS.aiUnedited } as const;

function replyWords(seconds: number): string {
  return seconds < 60 ? `${seconds}\u00a0с` : `${Math.floor(seconds / 60)}\u00a0мин${seconds % 60 ? `\u00a0${seconds % 60}\u00a0с` : ""}`;
}

function ReplyTime({ seconds, team }: { seconds: number | null; team: boolean }) {
  if (seconds === null) return <span className="text-ink-3">—</span>;
  const text = replyWords(seconds);
  return !team && seconds > TEAM_REPLY_MEDIAN * 3 ? <Mark hint={`Втрое дольше, чем у команды (${replyWords(TEAM_REPLY_MEDIAN)})`}>{text}</Mark> : <>{text}</>;
}

interface PriceRow {
  key: string;
  price: string;
  sent: number;
  bought: number;
  perMessageMills: number;
  teamShare: number;
}

const PRICES: PriceRow[] = [
  { key: "lt10", price: "Дешевле $10", sent: 214, bought: 88, perMessageMills: 3_120, teamShare: 0.36 },
  { key: "10-19", price: "$10–19", sent: 131, bought: 41, perMessageMills: 4_840, teamShare: 0.3 },
  { key: "20-39", price: "$20–39", sent: 46, bought: 9, perMessageMills: 5_310, teamShare: 0.17 },
  { key: "40", price: "$40 и дороже", sent: 4, bought: 2, perMessageMills: 21_000, teamShare: 0.11 },
];

const DAYS = Array.from({ length: 14 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 9, 25 + index));
  return { key: day.toISOString().slice(0, 10), label: `${day.getUTCDate()}.${String(day.getUTCMonth() + 1).padStart(2, "0")}` };
});

interface SheetRow {
  key: string;
  chatter: string;
  page: string;
  days: number[];
}

const SHEET: SheetRow[] = [
  { key: "alex-mia-1", chatter: "alex.k", page: "mia-1", days: DAYS.map((_, index) => (index % 3 === 1 ? 0 : 41_250 + index * 3_410)) },
  { key: "alex-mia-2", chatter: "alex.k", page: "mia-2", days: DAYS.map((_, index) => (index % 4 === 0 ? 18_900 + index * 1_200 : 0)) },
  { key: "den-nova-1", chatter: "den.s", page: "nova-1", days: DAYS.map((_, index) => (index % 2 === 0 ? 96_400 - index * 2_100 : 12_000)) },
  { key: "kate-mia-3", chatter: "kate.v", page: "mia-3", days: DAYS.map((_, index) => (index > 6 ? 27_500 + index * 900 : 0)) },
];

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const HEAT_DAYS = 7;

const HEAT: (HeatGridRow & { empty: number; withFans: number })[] = [
  { key: "mia-of", label: "mia-of", values: HOURS.map((_, hour) => (hour >= 2 && hour <= 8 ? 6 - Math.abs(5 - hour) % 4 : hour % 7 === 0 ? 1 : 0)), empty: 31, withFans: 82, total: "38 %" },
  { key: "nova-1", label: "nova-1", values: HOURS.map((_, hour) => (hour >= 4 && hour <= 7 ? 3 : 0)), empty: 12, withFans: 96, total: "13 %" },
  { key: "mia-1", label: "mia-1", values: HOURS.map((_, hour) => (hour === 6 || hour === 13 ? 1 : 0)), empty: 2, withFans: 120, total: "2 %" },
  { key: "ivy-2", label: "ivy-2", note: "Смен в расширении ещё не было — пустые часы не считаются", empty: 0, withFans: 0, total: <span className="text-ink-3">—</span> },
];

const FANS = [
  { name: "Brandon", username: "brandon_k", fanRef: "298319004417220608" },
  { name: "Sir Lancelot", username: "lance_77", fanRef: "301122994017224448" },
  { name: "Sir Lancelot", username: "knight.of.night", fanRef: "301122994017220120" },
  { name: null, username: "night_owl_77", fanRef: "288775120933380096" },
  { name: null, username: null, fanRef: "288775120933380120" },
];

function Swatch({ name, token, text }: { name: string; token: string; text?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="size-9 flex-none rounded-md border border-line"
        style={text ? { background: "var(--ui-surface)", color: `var(${token})`, display: "grid", placeItems: "center", fontWeight: 600 } : { background: `var(${token})` }}
      >
        {text ? "Аа" : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-15 font-medium">{name}</span>
        <code className="text-14 text-ink-3">{token}</code>
      </span>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-6 border-t border-line-soft py-4 first:border-t-0 first:pt-0 last:pb-0">
      <span className="text-14 text-ink-2">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export function SpecimenScreen() {
  const today = moscowToday();
  const back = useBackState("Образец");
  const [period, setPeriod] = useState<PeriodSpec>(currentWeek(today));
  const [filter, setFilter] = useState<"worth" | "unanswered" | "waited" | "paid" | "all">("worth");
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState<"md" | "lg" | null>(null);
  const [modal, setModal] = useState<"form" | "long" | null>(null);
  const [confirm, setConfirm] = useState<"idle" | "open" | "pending" | "error">("idle");
  const [tableState, setTableState] = useState<"rows" | "loading" | "empty" | "error">("rows");
  const [selected, setSelected] = useState<string | null>(null);
  const [modelPages, setModelPages] = useState<Record<string, boolean>>({ "mia-1": true, "mia-2": true, "mia-3": false, "mia-of": false });
  const [approaches, setApproaches] = useState<Record<string, boolean>>({ soft: true, discount: false });
  const [pendingApproach, setPendingApproach] = useState<string | null>(null);
  const [invitee, setInvitee] = useState("");
  const [reason, setReason] = useState("");
  const [onlyPage, setOnlyPage] = useState<string | null>(null);
  const [panel, setPanel] = useState(true);

  const pagesTicked = Object.values(modelPages).filter(Boolean).length;
  const pagesAll = Object.keys(modelPages).length;
  const colliding = useMemo(() => collidingFanNames(FANS), []);

  const columns = useMemo<Column<ChatterRow>[]>(() => [
    {
      key: "name",
      header: "Чаттер",
      sortValue: (row) => row.name,
      cell: (row) => row.team ? (
        <span className="text-15">Вся команда</span>
      ) : (
        <Person
          name={row.name}
          status={row.status}
          hint={row.shifts > 0 ? `${row.shifts} ${ruPlural(row.shifts, "смена", "смены", "смен")} · ${Math.round(row.minutes / 60)} ч` : "смен не было"}
        />
      ),
    },
    { key: "pages", header: "Страницы", cell: (row) => (row.team ? null : <PageLabels labels={row.pages} />) },
    {
      key: "sales",
      header: "Продажи",
      numeric: true,
      hint: "Личные сообщения за смены, после комиссии площадки. Рассылки не входят.",
      sortValue: (row) => row.salesMills,
      cell: (row) => <Money mills={row.salesMills} strong />,
    },
    {
      key: "delta",
      header: "К прошлой неделе",
      numeric: true,
      sortValue: (row) => (row.prevMills ? (row.salesMills - row.prevMills) / row.prevMills : null),
      // One rule (D13): Delta itself picks «−29 %», «было $16.00» (a base under $50) or «было $419.94» (nothing now).
      cell: (row) => <Delta current={row.salesMills} previous={row.prevMills} noneText="не с чем сравнить" title="К 26 окт. – 1 нояб., на то же время" />,
    },
    { key: "hour", header: "В час", numeric: true, sortValue: (row) => row.perHourMills, cell: (row) => <Money mills={row.perHourMills} /> },
    { key: "reply", header: METRIC.reply.label, hint: METRIC.reply.hint, numeric: true, sortValue: (row) => row.replySeconds, cell: (row) => <ReplyTime seconds={row.replySeconds} team={!!row.team} /> },
    {
      key: "unanswered",
      header: METRIC.unanswered.label,
      hint: METRIC.unanswered.hint,
      numeric: true,
      sortValue: (row) => row.unanswered,
      cell: (row) => row.unanswered === null ? <span className="text-ink-3">—</span> : !row.team && row.unanswered > 5 ? <Mark hint="Втрое больше, чем обычно у команды (3)">{row.unanswered}</Mark> : row.unanswered,
    },
    {
      key: "ai",
      header: METRIC.ai.label,
      hint: METRIC.ai.hint,
      numeric: true,
      sortValue: (row) => row.aiShare,
      cell: (row) => (row.aiShare === null ? <span className="text-ink-3">—</span> : formatPercent(row.aiShare * 100)),
    },
  ], []);

  const best = PRICES.reduce((top, row) => (row.sent >= 5 && row.perMessageMills > top.perMessageMills ? row : top), PRICES[0]!);
  const priceColumns = useMemo<Column<PriceRow>[]>(() => [
    { key: "price", header: "Цена", cell: (row) => row.price, nowrap: true },
    { key: "sent", header: "Отправлено", numeric: true, cell: (row) => row.sent, sortValue: (row) => row.sent },
    {
      key: "bought",
      header: "Купили",
      hint: "Сколько из отправленных купили. Черта — команда на тех же страницах.",
      cell: (row) => <RateBar hits={row.bought} of={row.sent} min={10} max={0.5} compare={row.teamShare} />,
      sortValue: (row) => row.bought / row.sent,
      sortFirst: "desc",
    },
    {
      key: "money",
      header: "Денег на сообщение",
      numeric: true,
      hint: "Сколько в среднем приносит одно отправленное платное сообщение этой цены.",
      cell: (row) => row.key === best.key ? (
        <span className="inline-flex items-baseline gap-2"><span className="text-14 text-ink-2">больше всего</span><Mark tone="best"><Money mills={row.perMessageMills} /></Mark></span>
      ) : <Money mills={row.perMessageMills} muted={row.sent < 10} />,
      sortValue: (row) => row.perMessageMills,
    },
  ], [best.key]);

  const sheetColumns = useMemo<Column<SheetRow>[]>(() => [
    { key: "chatter", header: "Чаттер", cell: (row) => <Person name={row.chatter} />, nowrap: true },
    { key: "page", header: "Страница", cell: (row) => <PageLabel label={row.page} platform="fansly" />, nowrap: true },
    { key: "total", header: "Итого", numeric: true, cell: (row) => <Money mills={row.days.reduce((sum, value) => sum + value, 0)} strong /> },
    ...DAYS.map((day, index): Column<SheetRow> => ({
      key: day.key,
      header: day.label,
      numeric: true,
      cell: (row) => (row.days[index] ? <Money mills={row.days[index]} /> : <span className="text-ink-3">—</span>),
    })),
  ], []);

  const rows = tableState === "empty" ? [] : [TEAM_ROW, ...CHATTERS].filter((row) => row.team || !query || `${row.name} ${row.pages.join(" ")}`.includes(query.trim()));

  return (
    <>
      <ScreenHeader
        title="Образец"
        documentTitle="Образец компонентов"
        period
        pageFilter
        actions={<Button variant="primary" icon={UserPlus} onClick={() => setModal("form")}>Пригласить</Button>}
        updatedAt={Date.now() - 4 * 60_000}
        onRefresh={() => toast.success("Обновлено: 6 чаттеров, 22 смены.")}
      />
      <div className="wb-content">
        <Notice title="Это образец дизайн-системы Workboard" action={<LinkButton size="sm" to="/shifts">К сменам</LinkButton>}>
          Каждый компонент из packages/ui в состояниях, которые встречаются на экранах. Числа выдуманы.
        </Notice>

        <RoundTwoSection />

        <Section
          title="Таблица"
          description="Одна таблица на всё приложение. Строка 52 px, с подписью — 64. Итоговая строка сверху остаётся сверху при сортировке; сортировка по умолчанию держится и после загрузки. Пунктир у заголовка — определение по наведению."
          actions={(
            <>
              <Segmented
                label="Состояние таблицы"
                value={tableState}
                onChange={setTableState}
                options={[
                  { value: "rows", label: "Данные", count: CHATTERS.length },
                  { value: "loading", label: "Загрузка" },
                  { value: "empty", label: "Пусто" },
                  { value: "error", label: "Ошибка" },
                ]}
              />
              <SearchInput value={query} onChange={setQuery} placeholder="Чаттер или страница" slashShortcut width={280} />
            </>
          )}
        >
          {tableState === "error" ? (
            <Card><ErrorState onRetry={() => setTableState("rows")} /></Card>
          ) : (
            <Table
              label="Чаттеры за неделю"
              columns={columns}
              rows={rows}
              rowKey={(row) => String(row.id)}
              rowHref={(row) => (row.team ? undefined : `/people/${row.id}`)}
              rowState={() => back}
              rowEmphasis={(row) => !!row.team}
              rowQuiet={(row) => row.status === "disabled"}
              selectedKey={selected}
              defaultSort={{ key: "sales", direction: "desc" }}
              loading={tableState === "loading"}
              skeletonLines={2}
              align="first-line"
              empty={<EmptyState compact title="За эту неделю смен нет">Последняя смена была 24 окт. Покажите 30 дней, чтобы увидеть её.</EmptyState>}
            />
          )}
          <div className="flex flex-wrap items-center gap-3 text-14 text-ink-2">
            <span>Выделить строку как открытую в панели:</span>
            <Segmented
              size="sm"
              label="Открытая строка"
              value={selected ?? "none"}
              onChange={(value) => setSelected(value === "none" ? null : value)}
              options={[{ value: "none", label: "Нет" }, { value: "2", label: "alex.k" }, { value: "7", label: "olya.m" }]}
            />
          </div>
        </Section>

        <div className="grid gap-8 2xl:grid-cols-2">
          <Section title="Доли и лучшее" description="RateBar — доля в ячейке: полоса, число, черта команды. Малая выборка бледная и пишет «2 из 4». Лучшее — жирным и словом, без жёлтого.">
            <Table
              label="Цена платных сообщений"
              columns={priceColumns}
              rows={PRICES}
              rowKey={(row) => row.key}
              defaultSort={null}
            />
          </Section>
          <Section title="Выгрузка шире рамки" description="Первые столбцы стоят на месте, остальное листается вбок; край затухает и говорит, сколько ещё.">
            <Table
              label="Продажи по дням"
              columns={sheetColumns}
              rows={SHEET}
              rowKey={(row) => row.key}
              stickyColumns={3}
              moreLabel={(hidden) => `ещё ${hidden} ${ruPlural(hidden, "день", "дня", "дней")}`}
            />
          </Section>
        </div>

        <div className="grid gap-8 2xl:grid-cols-2">
          <Section title="Кнопки и действия" description="Одна главная кнопка на экран. Остальное — обычные кнопки или меню «Ещё».">
            <Card>
              <Row label="Варианты">
                <Button variant="primary" icon={Plus}>Пригласить чаттера</Button>
                <Button icon={Download}>Скачать CSV</Button>
                <Button variant="ghost">Отмена</Button>
                <Button variant="danger-outline" icon={Trash2}>Снять доступ</Button>
                <Button variant="danger">Отключить</Button>
              </Row>
              <Row label="Размеры">
                <Button size="sm">Маленькая 32</Button>
                <Button>Обычная 36</Button>
                <Button size="lg" variant="primary">Крупная 44</Button>
              </Row>
              <Row label="Состояния">
                <Button variant="primary" loading>Сохраняем…</Button>
                <Button disabled title="Нечего сохранять">Сохранить</Button>
                <LinkButton to="/decisions">Открыть решения</LinkButton>
              </Row>
              <Row label="Значки и меню">
                <IconButton icon={Pencil} label="Изменить" variant="secondary" />
                <IconButton icon={Copy} label="Скопировать ссылку" />
                <Menu
                  label="Действия с alex.k"
                  items={[
                    { label: "Открыть карточку", onSelect: () => toast("Открываем alex.k") },
                    { label: "Скопировать ссылку", icon: Copy, hint: "⌘C", onSelect: () => toast.success("Ссылка скопирована.") },
                    { label: "Доступ к страницам", icon: KeyRound, onSelect: () => setDrawer("md") },
                    { separator: true },
                    { label: "В архив", icon: Archive, disabled: true, title: "Сначала завершите смену", onSelect: () => undefined },
                    { label: "Отключить доступ", icon: Trash2, danger: true, onSelect: () => setConfirm("open") },
                  ]}
                />
                <LazyMenu />
              </Row>
            </Card>
          </Section>
          <Section title="Люди, фаны, страницы" description="Один вид человека, фана и страницы везде. Страница — тихий текст; чип — только когда это фильтр.">
            <Card>
              <Row label="Человек">
                <Person name="den.s" status="working" hint="на смене с 21:00" />
                <Person name="alex.k" hint="был 2 ч назад" />
                <Person name="lena.r" status="disabled" hint="отключена" />
                <Person name="new.chatter" status="invited" hint="" />
              </Row>
              <Row label="Крупно">
                <Person name="alex.k" status="working" size="lg" hint="Чаттер · mia-1, mia-2" />
              </Row>
              <Row label="Фан">
                {FANS.map((fan) => (
                  <Fan key={fan.fanRef} {...fan} showLogin={fanNameCollides(fan, colliding)} />
                ))}
              </Row>
              <Row label="Страница">
                <span className="text-15">Смена на <PageLabel label="mia-1" platform="fansly" /></span>
                <PageLabels labels={["mia-1", "mia-2", "mia-3", "nova-1", "ivy-1"]} />
              </Row>
              <Row label="Страница-фильтр">
                {["mia-1", "mia-2"].map((label) => (
                  <PageLabel
                    key={label}
                    label={label}
                    selected={onlyPage === label}
                    onClick={() => setOnlyPage((current) => (current === label ? null : label))}
                    hint={onlyPage === label ? `Показаны только чаты ${label}. Нажмите, чтобы показать все` : `Только чаты ${label}`}
                  />
                ))}
              </Row>
              <Row label="Бейджи">
                <Badge tone="success">На смене</Badge>
                <Badge tone="warning">Просрочен на 2 дня</Badge>
                <Badge tone="danger">Нужен вход</Badge>
                <Badge tone="off">Отключён</Badge>
                <Badge tone="info">Ждёт регистрации</Badge>
                <Badge tone="accent">Ждёт решения</Badge>
              </Row>
              <Row label="Точки и счётчики">
                <span className="inline-flex items-center gap-2 text-15"><StatusDot tone="success" /> работает</span>
                <span className="inline-flex items-center gap-2 text-15"><StatusDot tone="off" /> выключено</span>
                <CountBadge value={3} label="Ждут решения: 3" />
                <CountBadge value={12} quiet />
              </Row>
              <Row label="Свойства">
                <KeyValue
                  items={[
                    { label: "Роль", value: "Чаттер" },
                    { label: "Страницы", value: <PageLabels labels={["mia-1", "mia-2", "mia-3", "nova-1", "ivy-1"]} /> },
                    { label: "Лимит ИИ", value: <><Money mills={5_000} /> в день</> },
                    { label: "Последний вход", value: <TimeMsk at={new Date(Date.now() - 50 * 60_000).toISOString()} show="datetime-ago" /> },
                  ]}
                />
              </Row>
            </Card>
          </Section>
        </div>

        <Section title="Выбор и фильтры" description="Сегменты — фильтр одного списка. Вкладки — разделы с адресом. Период и страница — только в шапке.">
          <Card>
            <Row label="Сегменты">
              <Segmented
                label="Какие чаты"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "worth", label: "Стоит посмотреть", count: 10 },
                  { value: "unanswered", label: "Без ответа", count: 3 },
                  { value: "waited", label: "Долго ждали", count: 4 },
                  { value: "paid", label: "Платные", count: 2 },
                  { value: "all", label: "Все", count: 41 },
                ]}
              />
            </Row>
            <Row label="Вкладки">
              <div className="w-full">
                <Tabs
                  label="Разделы карточки"
                  items={[
                    { to: "/__specimen", label: "Работа", end: true },
                    { to: "/people/2/sales", label: "Продажи" },
                    { to: "/people/2/access", label: "Доступ" },
                  ]}
                />
              </div>
            </Row>
            <Row label="Период">
              <PeriodControl value={period} today={today} onChange={setPeriod} />
            </Row>
            <Row label="Поиск и клавиши">
              <SearchInput value={query} onChange={setQuery} placeholder="Фан или текст" width={260} />
              <span className="text-14 text-ink-2">Чаты: <Kbd>J</Kbd> <Kbd>K</Kbd> или <Kbd>↑</Kbd> <Kbd>↓</Kbd>, закрыть — <Kbd>Esc</Kbd></span>
            </Row>
          </Card>
        </Section>

        <Section title="Числа, деньги, время" description="Деньги как на площадках, всегда с центами. Изменение — спокойным цветом, без красного. Время — московское.">
          <Card>
            <Row label="Деньги">
              <Money mills={11_183_600} strong />
              <Money mills={-2_193_640} />
              <Money mills={25_140} muted hint="Меньше пяти продаж — не судите по этой сумме" />
              <Money mills={null} />
              <Money microUsd={39_880_000} />
              <Money microUsd={4_200} />
            </Row>
            <Row label="Изменение">
              <Delta current={1_130_000} previous={1_000_000} />
              <Delta current={710_000} previous={1_000_000} />
              <Delta current={1_000_000} previous={1_000_000} />
              <Delta current={31_980} previous={16_000} />
              <Delta current={52_000} previous={0} />
              <Delta current={null} previous={null} noneText="не с чем сравнить" />
              <Delta mills={4_104_210} pct={64} />
              <Delta pct={22} kind="cost" title="Траты на ИИ: рост не хорош и не плох" />
            </Row>
            <Row label="Хуже и лучшее">
              <Mark hint="Втрое дольше, чем у команды (1 мин 52 с)">6 мин 52 с</Mark>
              <span className="inline-flex items-baseline gap-2 text-15"><Mark tone="best"><Money mills={21_000} /></Mark><span className="text-ink-2">больше всего денег на сообщение</span></span>
            </Row>
            <Row label="Длительность">
              <Duration minutes={448} />
              <Duration minutes={47} />
              <Duration minutes={40_170} />
              <Duration minutes={3_120} days />
            </Row>
            <Row label="Время, Москва">
              <TimeMsk at={new Date(Date.now() - 2 * 3_600_000).toISOString()} show="time" />
              <TimeMsk at={new Date(Date.now() - 2 * 3_600_000).toISOString()} show="datetime" />
              <TimeMsk at={new Date(Date.now() - 26 * 3_600_000).toISOString()} show="weekday" />
              <TimeMsk at={new Date(Date.now() - 5 * 60_000).toISOString()} show="datetime-ago" />
            </Row>
            <Row label="Факты в строку">
              <Facts
                label="Смена alex.k"
                items={[
                  { label: "Продажи", value: <Money mills={412_500} />, strong: true },
                  { label: "Сообщений", value: "214" },
                  { label: "Чатов", value: "41" },
                  { label: METRIC.reply.label, value: "1 мин 58 с", hint: METRIC.reply.hint },
                  { label: METRIC.unanswered.label, value: "3", hint: METRIC.unanswered.hint },
                  { label: METRIC.ai.label, value: "31 %", hint: METRIC.ai.hint },
                ]}
              />
            </Row>
            <Row label="Плитки сеткой">
              <div className="w-full">
                <Facts
                  layout="stacked"
                  columns={3}
                  items={[
                    { label: "Продажи за неделю", value: <Money mills={3_876_750} />, meta: <Delta current={3_876_750} previous={5_538_000} title="К прошлой неделе на то же время" /> },
                    { label: "В час работы", value: <Money mills={25_140} />, meta: <Delta current={25_140} previous={34_900} base={5_538_000} /> },
                    { label: "Смен", value: "22", meta: "154 ч 12 мин, из них 3 ночные смены дольше десяти часов" },
                    { label: METRIC.reply.perShift, value: "1 мин 52 с", hint: METRIC.reply.hint },
                    { label: METRIC.unanswered.perShift, value: "2,1", hint: METRIC.unanswered.hint },
                    { label: METRIC.ai.perShift, value: "38 %", hint: METRIC.ai.hint },
                  ]}
                />
              </div>
            </Row>
            <Row label="Доли">
              <div className="grid w-full max-w-[560px] gap-3">
                <RateBar hits={88} of={214} max={0.5} compare={0.36} detail="команда 36 %" />
                <RateBar hits={41} of={131} max={0.5} compare={0.3} detail="команда 30 %" />
                <RateBar hits={2} of={4} min={10} max={0.5} detail="мало, чтобы судить" />
                <RateBar of={0} empty="зреет" emptyHint="Купил ли фан за 72 часа, станет видно 10 нояб." />
              </div>
            </Row>
            <Row label="Неразрывно">
              <span className="text-15">{formatOf(2, 3)} · {formatOf(1_420, 9_840)} — «из» не уходит на другую строку</span>
            </Row>
          </Card>
        </Section>

        <Section title="Пустые часы" description="HeatGrid: страницы × часы, пять спокойных ступеней одного цвета. Подсказка — общим Tooltip по наведению на клетку.">
          <Card>
            <HeatGrid
              label="Пустые часы по страницам и часам суток"
              columns={HOURS}
              rows={HEAT}
              stepOf={(value) => (value <= 0 ? 0 : value === 1 ? 1 : value <= 3 ? 2 : value <= 5 ? 3 : 4)}
              cellHint={(row, hour, value) => `${row.key}, ${HOURS[hour]}:00–${HOURS[(hour + 1) % 24]}:00 — пусто ${value ?? 0} ${ruPlural(value ?? 0, "раз", "раза", "раз")} из ${HEAT_DAYS} дней`}
              totalHeader="Пусто"
              legend={{ title: "Час был пустым:", steps: ["ни разу", "редко", "иногда", "часто", "почти всегда"], note: "Время московское" }}
            />
          </Card>
        </Section>

        <div className="grid gap-8 2xl:grid-cols-2">
          <Section title="Плашки, пусто, ошибка" description="Не больше двух плашек на экран. Нет ответа — не ноль.">
            <div className="grid gap-3">
              <Notice tone="warning" title="Не удалось обновить. Показаны данные на 23:15." action={<Button size="sm">Повторить</Button>} />
              <Notice tone="danger" title="nova-1: Fansly просит войти заново" action={<Button size="sm">Войти в Fansly</Button>} />
              <Notice tone="off">Ledger ещё не прислал отчёты за эти дни: они появятся, когда чаттеры отправят их в «Отчётность».</Notice>
              <div className="max-w-[420px]">
                <Notice tone="warning" title="Ссылка входа истекла" actionPlacement="below" action={<><Button size="sm" variant="primary">Сделать новую ссылку</Button><Button size="sm" variant="ghost">Позже</Button></>}>
                  В узкой панели кнопки встают под текст, и слова не сжимаются.
                </Notice>
              </div>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card><EmptyState title="Всё решено">Споров, неотданных кастомов и зависших отправок нет.</EmptyState></Card>
              <Card><ErrorState onRetry={() => toast("Повторяем")} /></Card>
            </div>
          </Section>
          <Section title="Загрузка и раскрытие" description="Скелет той же формы, без блика. «Как это считается» — внизу, свёрнуто.">
            <Card>
              <div className="grid gap-4">
                <div className="flex items-center gap-4">
                  <Skeleton width={28} height={28} radius="50%" />
                  <Skeleton width={160} />
                  <Skeleton width={72} style={{ marginLeft: "auto" }} />
                </div>
                <SkeletonText lines={3} />
                <Disclosure summary="Как это считается">
                  <p className="wb-readable text-15 text-ink-2">
                    Продажи смены — личные сообщения чаттера за время смены, после комиссии площадки. Рассылки не входят. Неделя — с понедельника по воскресенье по Москве.
                  </p>
                </Disclosure>
                <Disclosure summary="Сегодняшние смены" hint="3 смены" size="md">
                  <p className="text-15 text-ink-2">Медленный блок, который не нужен каждый раз.</p>
                </Disclosure>
              </div>
            </Card>
          </Section>
        </div>

        <Section
          title="Правило заголовков"
          description="У экрана из нескольких блоков каждый блок — Section: заголовок 20 px над рамкой, у рамки своего заголовка нет. Card с заголовком — только в сетке карточек, как здесь."
        >
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Из чего продажи" description="За 2–8 нояб.">
              <Facts items={[{ label: "Платные", value: <Money mills={812_400} /> }, { label: "Чаевые", value: <Money mills={210_350} /> }]} />
            </Card>
            <Card title="Лучшие фаны" description="Кто больше всех принёс за смены периода">
              <ol className="grid gap-2 text-15">
                <li className="flex justify-between gap-4"><Fan name="Brandon" username="brandon_k" fanRef="298319004417220608" /><Money mills={240_000} strong /></li>
                <li className="flex justify-between gap-4"><Fan name="Sir Lancelot" username="lance_77" fanRef="301122994017224448" /><Money mills={112_500} /></li>
              </ol>
            </Card>
            <Card title="Скорость ответа" description="Купил ли фан в течение суток после ответа">
              <div className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 text-15">
                <span className="text-ink-2">до 5 мин</span>
                <RateBar hits={31} of={52} compare={0.48} />
                <span className="text-ink-2">дольше часа</span>
                <RateBar hits={9} of={40} compare={0.29} tone="mark" hint="23 % — хуже команды (29 %)" />
              </div>
            </Card>
          </div>
        </Section>

        <div className="grid gap-8 2xl:grid-cols-2">
          <Section title="Окна и подсказки" description="Панель справа — посмотреть запись, не теряя список. Окно — вопрос или короткая форма; кнопки окна всегда видны. Подтверждение — с фокусом на «Отмена».">
            <Card>
              <Row label="Панель справа">
                <Button onClick={() => setDrawer("md")}>Обычная, 560</Button>
                <Button onClick={() => setDrawer("lg")}>Широкая, 760</Button>
              </Row>
              <Row label="Окно">
                <Button onClick={() => setModal("form")}>С формой</Button>
                <Button onClick={() => setModal("long")}>Длинное</Button>
                <Button variant="danger-outline" onClick={() => setConfirm("open")}>Подтверждение</Button>
              </Row>
              <Row label="Всплывашки">
                <Button onClick={() => toast.success("Приглашение создано: alex.k, 2 страницы.")}>Успех</Button>
                <Button onClick={() => toast.error("Не удалось снять доступ: Hub не ответил. Доступ остался.")}>Ошибка</Button>
              </Row>
              <Row label="Подсказка">
                <Tooltip content="Писала коллега — не в счёте этой смены">
                  <span className="text-15 text-ink-2" tabIndex={0}>коллега</span>
                </Tooltip>
                <span className="text-15">Ответ <Hint content={METRIC.reply.hint}>1 мин 58 с</Hint></span>
              </Row>
            </Card>
          </Section>
          <Section title="Поля" description="Подпись сверху, подсказка и ошибка снизу. 36 px, фокус — чернильная рамка. Одна галочка везде.">
            <Card>
              <div className="grid gap-6 md:grid-cols-2">
                <Field label="Логин" hint="Латиница, без пробелов: так человек войдёт в расширение.">
                  {(control) => <TextInput {...control} value={invitee} onChange={(event) => setInvitee(event.target.value)} placeholder="alex.k" />}
                </Field>
                <Field label="Роль">
                  {(control) => (
                    <Select {...control} defaultValue="chatter">
                      <option value="chatter">Чаттер</option>
                      <option value="team_lead">Тимлид</option>
                    </Select>
                  )}
                </Field>
                <Field label="Почему" hint="Одна-две фразы: их увидят в истории решения.">
                  {(control) => <Textarea {...control} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Фан купил у коллеги, а не у alex.k" />}
                </Field>
                <Field label="Лимит ИИ в день" error="Не больше $50.00 в день.">
                  {(control) => <TextInput {...control} defaultValue="75" inputMode="decimal" />}
                </Field>
                <div className="grid content-start gap-3">
                  <Checkbox
                    checked={pagesTicked === pagesAll}
                    indeterminate={pagesTicked > 0 && pagesTicked < pagesAll}
                    onChange={(value) => setModelPages(Object.fromEntries(Object.keys(modelPages).map((key) => [key, value])))}
                    label="Вся модель Mia Hart"
                    hint={`${pagesTicked} из ${pagesAll} страниц — и новые страницы модели`}
                  />
                  <div className="grid gap-2 pl-7">
                    {Object.entries(modelPages).map(([label, on]) => (
                      <Checkbox key={label} checked={on} onChange={(value) => setModelPages((current) => ({ ...current, [label]: value }))} label={label} />
                    ))}
                  </div>
                  <Checkbox checked={false} onChange={() => undefined} label="nova-1" disabled hint="Уже открыта" />
                </div>
                <div className="grid content-start gap-4">
                  {[{ id: "soft", label: "Мягкое «скучаю»" }, { id: "discount", label: "Скидка на прошлый альбом" }].map((item) => (
                    <Switch
                      key={item.id}
                      checked={approaches[item.id] ?? false}
                      pending={pendingApproach === item.id}
                      label={item.label}
                      hint={approaches[item.id] ? "В расширении" : "Выключен"}
                      onChange={(value) => {
                        setPendingApproach(item.id);
                        window.setTimeout(() => {
                          setApproaches((current) => ({ ...current, [item.id]: value }));
                          setPendingApproach(null);
                        }, 600);
                      }}
                    />
                  ))}
                </div>
              </div>
            </Card>
          </Section>
        </div>

        <Section title="Панель в потоке" description="SidePanel — колонка рядом с содержимым (доказательства в разборе): шапка и список не перекрываются, содержимое сужается.">
          <div className="grid gap-4" style={{ gridTemplateColumns: panel ? "minmax(0, 1fr) 380px" : "minmax(0, 1fr)", height: 320 }}>
            <Card>
              <div className="grid gap-3 text-16">
                <p className="m-0">Фан: «Привет, ты тут?»</p>
                <p className="m-0">Чаттер: «Тут, малыш. Скучала по тебе» <button type="button" className="text-14 text-ink-2 underline decoration-dotted underline-offset-4" onClick={() => setPanel(true)}>ИИ без правки</button></p>
                <p className="m-0 text-ink-3">тишина 54 мин</p>
              </div>
            </Card>
            {panel && (
              <SidePanel title="ИИ без правки" subtitle="alex.k → Brandon · mia-1 · 14:05" onClose={() => setPanel(false)} footer={<Button size="sm" onClick={() => setPanel(false)}>Закрыть</Button>}>
                <div className="grid gap-3 text-15">
                  <span className="text-14 text-ink-2">Текст ИИ</span>
                  <p className="m-0">Тут, малыш. Скучала по тебе</p>
                  <span className="text-14 text-ink-2">Отправлено</span>
                  <p className="m-0">Тут, малыш. Скучала по тебе</p>
                </div>
              </SidePanel>
            )}
          </div>
        </Section>

        <Section title="Цвета и шрифт" description="Тёплые нейтральные поверхности, одни чернила, спокойные состояния. Тёплая подложка — только «хуже команды». Inter 400/500/600, ничего меньше 13 px.">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card>
              <div className="grid gap-5 sm:grid-cols-2 2xl:grid-cols-3">
                <Swatch name="Фон" token="--ui-bg" />
                <Swatch name="Лист" token="--ui-surface" />
                <Swatch name="Наведение" token="--ui-hover" />
                <Swatch name="Линия" token="--ui-line-strong" />
                <Swatch name="Текст" token="--ui-text" text />
                <Swatch name="Второстепенный" token="--ui-text-2" text />
                <Swatch name="Приглушённый" token="--ui-text-3" text />
                <Swatch name="Чернила" token="--ui-accent-fill" />
                <Swatch name="Хорошо" token="--ui-good" />
                <Swatch name="Внимание" token="--ui-warn" />
                <Swatch name="Сломано" token="--ui-bad" />
                <Swatch name="Хуже команды" token="--ui-mark-soft" />
                <Swatch name="Лучше" token="--ui-up" text />
                <Swatch name="Хуже" token="--ui-down" text />
              </div>
            </Card>
            <Card>
              <div className="grid gap-3">
                <span className="text-32 font-semibold tracking-[-0.02em]">$11,183.60 · 32</span>
                <span className="text-24 font-semibold">Заголовок экрана · 24</span>
                <span className="text-20 font-semibold">Раздел · 20</span>
                <span className="text-16">Разговор и чтение · 16</span>
                <span className="text-15">Основной текст, ячейки, кнопки · 15</span>
                <span className="text-14 text-ink-2">Подписи, шапка таблицы, вторая строка · 14</span>
                <span className="text-13 text-ink-3">Оси графиков и клавиши · 13 — меньше не бывает</span>
              </div>
            </Card>
          </div>
        </Section>
      </div>

      <Drawer
        open={drawer !== null}
        onClose={() => setDrawer(null)}
        size={drawer ?? "md"}
        title="alex.k"
        subtitle="Чаттер · mia-1, mia-2 · был 2 ч назад"
        footer={<><Button variant="ghost" onClick={() => setDrawer(null)}>Закрыть</Button><Button variant="primary">Сохранить доступ</Button></>}
      >
        <div className="grid gap-6">
          <Facts items={[{ label: "Продажи", value: <Money mills={1_070_150} />, strong: true }, { label: "В час", value: <Money mills={22_810} /> }, { label: "Смен", value: "6" }]} />
          <KeyValue
            items={[
              { label: "Страницы", value: <PageLabels labels={["mia-1", "mia-2"]} /> },
              { label: "Устройства", value: "2 входа: Firefox на Windows, Chrome на macOS" },
              { label: "Ссылка входа", value: "Действует до 9 нояб., 14:00" },
            ]}
          />
          {drawer === "lg" && (
            <Table
              label="Цена платных сообщений"
              columns={priceColumns}
              rows={PRICES}
              rowKey={(row) => row.key}
              frame="framed"
            />
          )}
          <Notice tone="info">Под панелью лёгкая подложка; страница листается, нажатие мимо закрывает панель.</Notice>
          <SkeletonText lines={4} />
        </div>
      </Drawer>

      {modal === "form" && (
        <Modal
          title="Пригласить человека"
          onClose={() => setModal(null)}
          actions={<><Button variant="ghost" onClick={() => setModal(null)}>Отмена</Button><Button variant="primary" disabled={!invitee.trim()} onClick={() => { setModal(null); toast.success(`Приглашение для ${invitee} создано.`); }}>Создать приглашение</Button></>}
        >
          <Field label="Логин" hint="Так человек войдёт в расширение.">
            {(control) => <TextInput {...control} value={invitee} onChange={(event) => setInvitee(event.target.value)} placeholder="alex.k" />}
          </Field>
          <Checkbox
            checked={pagesTicked === pagesAll}
            indeterminate={pagesTicked > 0 && pagesTicked < pagesAll}
            onChange={(value) => setModelPages(Object.fromEntries(Object.keys(modelPages).map((key) => [key, value])))}
            label="Вся модель Mia Hart"
            hint="Четыре страницы и новые страницы модели"
          />
        </Modal>
      )}

      {modal === "long" && (
        <Modal
          title="Разобрать отправку"
          onClose={() => setModal(null)}
          actions={<><Button variant="ghost" onClick={() => setModal(null)}>Отмена</Button><Button variant="primary" onClick={() => setModal(null)}>Записать</Button></>}
        >
          <p className="ui-modal__text">Откройте чат с фаном на Fansly и посмотрите, есть ли там это сообщение около 18:30. Шапка и кнопки окна стоят на месте; листается только середина.</p>
          {Array.from({ length: 9 }, (_, index) => (
            <Field key={index} label={`Поле ${index + 1}`}>
              {(control) => <TextInput {...control} placeholder="…" />}
            </Field>
          ))}
        </Modal>
      )}

      {confirm !== "idle" && (
        <Confirm
          title="Отключить доступ alex.k?"
          message="alex.k больше не сможет войти в расширение и консоль. Смены и продажи останутся в отчётах."
          facts={[
            { label: "Кого", value: "alex.k, чаттер" },
            { label: "Страницы", value: "mia-1, mia-2" },
            { label: "Устройства", value: "2 входа закончатся сразу" },
            { label: "Отменить", value: "Можно: «Восстановить» в карточке" },
          ]}
          confirmLabel="Отключить доступ"
          pendingLabel="Отключаем…"
          isPending={confirm === "pending"}
          error={confirm === "error" ? "Hub не ответил: неизвестно, отключён ли доступ. Откройте карточку и проверьте." : undefined}
          onConfirm={() => {
            setConfirm("pending");
            window.setTimeout(() => setConfirm("error"), 900);
          }}
          onClose={() => setConfirm("idle")}
        />
      )}
    </>
  );
}

/** A menu whose items load when it opens (`onOpenChange`): it finds its place again when it grows. */
function LazyMenu() {
  const [items, setItems] = useState<string[] | null>(null);
  return (
    <Menu
      trigger="button"
      label="Другая смена"
      onOpenChange={(open) => {
        if (!open || items) return;
        window.setTimeout(() => setItems(["пт 6 нояб., 09:16–18:53", "чт 5 нояб., 10:02–19:40", "ср 4 нояб., 21:00–06:12", "вт 3 нояб., 09:05–17:31"]), 500);
      }}
      items={items === null
        ? [{ label: "Загружаем…", disabled: true, onSelect: () => undefined }]
        : items.map((label) => ({ label, onSelect: () => toast(`Открываем смену ${label}`) }))}
    />
  );
}
