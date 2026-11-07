import { Archive, Copy, Download, KeyRound, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  Bar,
  Button,
  Card,
  Checkbox,
  Chip,
  Confirm,
  CountBadge,
  Delta,
  Disclosure,
  Drawer,
  Duration,
  EmptyState,
  ErrorState,
  Facts,
  Field,
  IconButton,
  Kbd,
  KeyValue,
  LinkButton,
  Mark,
  Menu,
  Modal,
  Money,
  Notice,
  PeriodControl,
  Person,
  SearchInput,
  Section,
  Segmented,
  Select,
  Skeleton,
  SkeletonText,
  StatusDot,
  Table,
  Tabs,
  TextInput,
  TimeMsk,
  Tooltip,
  toast,
  type Column,
  type PersonStatus,
} from "@agency_hub_core/ui";
import { moscowToday } from "@agency_hub_core/ui/moscow";
import { currentWeek, type PeriodSpec } from "@agency_hub_core/ui/period";
import { FanName } from "@/shared/FanName";
import { PageChip, PageChips } from "@/shared/PageChip";
import { ScreenHeader } from "@/shared/ScreenHeader";

/**
 * The specimen of packages/ui: every component in the states a screen uses,
 * with invented numbers. It sets the bar for every screen of Workboard. Demo
 * and dev builds only (src/app/routes.tsx).
 */

interface ChatterRow {
  id: number;
  name: string;
  status: PersonStatus;
  pages: string[];
  shifts: number;
  minutes: number;
  salesMills: number;
  deltaPct: number | null;
  perHourMills: number;
  replySeconds: number;
  unanswered: number;
  aiShare: number;
  wasMills?: number;
}

const CHATTERS: ChatterRow[] = [
  { id: 4, name: "den.s", status: "working", pages: ["nova-1"], shifts: 5, minutes: 2484, salesMills: 2_144_380, deltaPct: -29, perHourMills: 51_790, replySeconds: 74, unanswered: 1, aiShare: 0.42 },
  { id: 2, name: "alex.k", status: "away", pages: ["mia-1", "mia-2"], shifts: 6, minutes: 2815, salesMills: 1_070_150, deltaPct: 18, perHourMills: 22_810, replySeconds: 118, unanswered: 3, aiShare: 0.31 },
  { id: 6, name: "kate.v", status: "away", pages: ["mia-3", "mia-1"], shifts: 4, minutes: 1822, salesMills: 526_270, deltaPct: 0, perHourMills: 17_330, replySeconds: 96, unanswered: 0, aiShare: 0.27 },
  { id: 7, name: "olya.m", status: "working", pages: ["mia-vip-of", "mia-of"], shifts: 3, minutes: 1392, salesMills: 103_960, deltaPct: -85, perHourMills: 4_480, replySeconds: 412, unanswered: 9, aiShare: 0.71 },
  { id: 8, name: "ivan.p", status: "away", pages: ["ivy-2"], shifts: 4, minutes: 739, salesMills: 31_980, deltaPct: 100, perHourMills: 2_590, replySeconds: 205, unanswered: 2, aiShare: 0.18 },
  { id: 9, name: "lena.r", status: "disabled", pages: ["ivy-1"], shifts: 0, minutes: 0, salesMills: 0, deltaPct: null, perHourMills: 0, replySeconds: 0, unanswered: 0, aiShare: 0, wasMills: 419_940 },
];

const TEAM_REPLY_MEDIAN = 112;

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

function ReplyTime({ seconds }: { seconds: number }) {
  if (seconds === 0) return <span className="text-ink-3">—</span>;
  const text = seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60 ? `${seconds % 60} с` : ""}`.trim();
  return seconds > TEAM_REPLY_MEDIAN * 3 ? <Mark title="Втрое дольше медианы команды">{text}</Mark> : <>{text}</>;
}

export function SpecimenScreen() {
  const today = moscowToday();
  const [period, setPeriod] = useState<PeriodSpec>(currentWeek(today));
  const [filter, setFilter] = useState<"worth" | "unanswered" | "waited" | "paid" | "all">("worth");
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState<"idle" | "open" | "pending" | "error">("idle");
  const [tableState, setTableState] = useState<"rows" | "loading" | "empty" | "error">("rows");
  const [selected, setSelected] = useState<string | null>(null);
  const [wholeModel, setWholeModel] = useState(true);
  const [invitee, setInvitee] = useState("");

  const columns = useMemo<Column<ChatterRow>[]>(() => [
    {
      key: "name",
      header: "Чаттер",
      sortValue: (row) => row.name,
      cell: (row) => (
        <Person
          name={row.name}
          status={row.status}
          hint={row.shifts > 0 ? `${row.shifts} смен · ${Math.round(row.minutes / 60)} ч` : "смен не было"}
        />
      ),
    },
    { key: "pages", header: "Страницы", cell: (row) => <PageChips labels={row.pages} /> },
    {
      key: "sales",
      header: "Продажи",
      numeric: true,
      sortValue: (row) => row.salesMills,
      cell: (row) => <Money mills={row.salesMills} strong />,
      footer: <Money mills={CHATTERS.reduce((sum, row) => sum + row.salesMills, 0)} strong />,
    },
    {
      key: "delta",
      header: "К прошлой неделе",
      numeric: true,
      sortValue: (row) => row.deltaPct,
      cell: (row) => <Delta pct={row.deltaPct} was={row.wasMills} title="к 26 окт. – 1 нояб. на то же время" />,
      footer: <Delta pct={-30} />,
    },
    { key: "hour", header: "В час", numeric: true, sortValue: (row) => row.perHourMills, cell: (row) => <Money mills={row.perHourMills} />, footer: <Money mills={25_140} /> },
    { key: "reply", header: "Ответ, медиана", numeric: true, sortValue: (row) => row.replySeconds || null, cell: (row) => <ReplyTime seconds={row.replySeconds} /> },
    { key: "unanswered", header: "Без ответа в конце", numeric: true, sortValue: (row) => row.unanswered, cell: (row) => row.unanswered > 5 ? <Mark>{row.unanswered}</Mark> : row.unanswered },
    { key: "ai", header: "Доля ИИ", numeric: true, sortValue: (row) => row.aiShare, cell: (row) => (row.shifts ? `${Math.round(row.aiShare * 100)}\u00a0%` : <span className="text-ink-3">—</span>) },
  ], []);

  return (
    <>
      <ScreenHeader
        title="Образец"
        documentTitle="Образец компонентов"
        period
        pageFilter
        actions={<Button variant="primary" icon={UserPlus} onClick={() => setModal(true)}>Пригласить</Button>}
        updatedAt={Date.now() - 4 * 60_000}
        onRefresh={() => toast.success("Обновлено: 6 чаттеров, 22 смены.")}
      />
      <div className="wb-content">
        <Notice title="Это образец дизайн-системы Workboard" action={<LinkButton size="sm" to="/shifts">К сменам</LinkButton>}>
          Каждый компонент из packages/ui в состояниях, которые встречаются на экранах. Числа выдуманы.
        </Notice>

        <Section title="Таблица" description="Одна таблица на всё приложение: удобные строки, числа справа, шапка липнет под шапкой экрана, сортировка по столбцу, вся строка — ссылка.">
          <div className="flex flex-wrap items-center justify-between gap-4">
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
            <SearchInput value={query} onChange={setQuery} placeholder="Чаттер или страница" slashShortcut width={320} />
          </div>
          {tableState === "error" ? (
            <Card><ErrorState onRetry={() => setTableState("rows")} /></Card>
          ) : (
            <Table
              label="Чаттеры за неделю"
              columns={columns}
              rows={tableState === "empty" ? [] : CHATTERS.filter((row) => !query || `${row.name} ${row.pages.join(" ")}`.includes(query.trim()))}
              rowKey={(row) => String(row.id)}
              rowHref={(row) => `/people/${row.id}`}
              rowQuiet={(row) => row.status === "disabled"}
              selectedKey={selected}
              defaultSort={{ key: "sales", direction: "desc" }}
              loading={tableState === "loading"}
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
                    { label: "Доступ к страницам", icon: KeyRound, onSelect: () => setDrawer(true) },
                    { separator: true },
                    { label: "В архив", icon: Archive, disabled: true, title: "Сначала завершите смену", onSelect: () => undefined },
                    { label: "Отключить доступ", icon: Trash2, danger: true, onSelect: () => setConfirm("open") },
                  ]}
                />
                <Menu trigger="button" label="Ещё" items={[{ label: "Скачать CSV", icon: Download, onSelect: () => undefined }, { label: "Как это считается", onSelect: () => undefined }]} />
              </Row>
            </Card>
          </Section>
          <Section title="Люди, фаны, состояния" description="Один вид человека и фана везде. Цвет — событие: зелёная точка, янтарь «посмотреть», красный «сломано».">
            <Card>
              <Row label="Человек">
                <Person name="den.s" status="working" hint="на смене с 21:00" />
                <Person name="alex.k" hint="был 2 ч назад" />
                <Person name="lena.r" status="disabled" hint="отключена" />
                <Person name="new.chatter" status="invited" hint="ждёт регистрации" />
              </Row>
              <Row label="Крупно">
                <Person name="alex.k" status="working" size="lg" hint="Чаттер · mia-1, mia-2" />
              </Row>
              <Row label="Фан">
                <FanName name="Brandon" fanRef="298319004417220608" />
                <FanName username="night_owl_77" fanRef="301122994017224448" />
                <FanName fanRef="288775120933380096" />
              </Row>
              <Row label="Бейджи">
                <Badge tone="success">На смене</Badge>
                <Badge tone="warning">Просрочен на 2 дня</Badge>
                <Badge tone="danger">Нужен вход</Badge>
                <Badge tone="off">Отключён</Badge>
                <Badge tone="info">Ждёт регистрации</Badge>
                <Badge tone="accent">Ждёт решения</Badge>
                <Badge>VIP</Badge>
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
                    { label: "Страницы", value: <PageChips labels={["mia-1", "mia-2", "mia-3", "nova-1", "ivy-1"]} max={3} /> },
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
                  { value: "worth", label: "Стоит посмотреть", count: 7 },
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
                    { to: "/people/2/shifts", label: "Смены" },
                    { to: "/people/2/sales", label: "Продажи" },
                    { to: "/people/2/access", label: "Доступ" },
                  ]}
                />
              </div>
            </Row>
            <Row label="Период">
              <PeriodControl value={period} today={today} onChange={setPeriod} />
            </Row>
            <Row label="Чипы">
              <PageChip label="mia-1" platform="fansly" />
              <PageChip label="nova-1" platform="fansly" />
              <PageChip label="mia-of" platform="onlyfans" />
              <Chip size="md" selected onRemove={() => toast("Фильтр снят")} removeLabel="Показать все страницы">mia-1</Chip>
              <Chip size="md" onClick={() => undefined}>Все страницы</Chip>
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
              <Money mills={25_140} muted />
              <Money mills={null} />
              <Money microUsd={39_880_000} />
              <Money microUsd={4_200} />
            </Row>
            <Row label="Изменение">
              <Delta pct={13} />
              <Delta pct={-29} />
              <Delta pct={0} />
              <Delta pct={null} />
              <Delta mills={880_000} />
              <Delta mills={4_104_210} pct={64} />
              <Delta was={419_940} />
              <Delta pct={22} kind="cost" title="Траты на ИИ: рост не хорош и не плох" />
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
                  { label: "Ответ", value: "1 мин 58 с" },
                  { label: "Без ответа в конце", value: "3" },
                  { label: "ИИ", value: "31\u00a0%" },
                ]}
              />
            </Row>
            <Row label="Полоса чисел">
              <Facts
                layout="stacked"
                items={[
                  { label: "Продажи за неделю", value: <Money mills={3_876_750} />, meta: <Delta pct={-30} title="к прошлой неделе на то же время" /> },
                  { label: "В час работы", value: <Money mills={25_140} />, meta: <Delta pct={-28} /> },
                  { label: "Смен", value: "22", meta: "154 ч 12 мин" },
                ]}
              />
            </Row>
            <Row label="Полосы">
              <div className="grid w-full max-w-[520px] gap-3">
                {[
                  { price: "$5–9", share: 0.41, team: 0.33 },
                  { price: "$10–19", share: 0.27, team: 0.3 },
                  { price: "$20+", share: 0.09, team: 0.12 },
                ].map((item) => (
                  <div key={item.price} className="grid grid-cols-[72px_minmax(0,1fr)_56px] items-center gap-4 text-15">
                    <span className="text-ink-2">{item.price}</span>
                    <Bar value={item.share} compare={item.team} label={`${Math.round(item.share * 100)} % купили, команда ${Math.round(item.team * 100)} %`} />
                    <span className="ui-num text-right">{Math.round(item.share * 100)}&nbsp;%</span>
                  </div>
                ))}
                <div className="grid grid-cols-[72px_minmax(0,1fr)_56px] items-center gap-4 text-15">
                  <span className="text-ink-3">$40+</span>
                  <Bar value={0.5} tone="muted" label="Мало продаж, чтобы судить" />
                  <span className="ui-num text-right text-ink-3">2 из 4</span>
                </div>
              </div>
            </Row>
          </Card>
        </Section>

        <div className="grid gap-8 2xl:grid-cols-2">
          <Section title="Плашки, пусто, ошибка" description="Не больше двух плашек на экран. Нет ответа — не ноль.">
            <div className="grid gap-3">
              <Notice tone="warning" title="Не удалось обновить. Показаны данные на 23:15." action={<Button size="sm">Повторить</Button>} />
              <Notice tone="danger" title="nova-1: Fansly просит войти заново" action={<Button size="sm">Войти в Fansly</Button>} />
              <Notice tone="off">Подтверждение смен чаттерами пока не включено: выплаты появятся, когда первый чаттер подтвердит смену.</Notice>
              <Notice tone="success">Приглашение создано: ссылка скопирована.</Notice>
            </div>
            <div className="grid gap-4 xl:grid-cols-2">
              <Card><EmptyState title="Всё решено">Споров, неотданных кастомов и зависших отправок нет.</EmptyState></Card>
              <Card><ErrorState onRetry={() => toast("Повторяем")} /></Card>
            </div>
          </Section>
          <Section title="Загрузка и раскрытие" description="Скелет той же формы, без блика. «Как это считается» — внизу, свёрнуто.">
            <Card title="Неделя" description="Продажи за смены по дням, после комиссии">
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

        <div className="grid gap-8 2xl:grid-cols-2">
          <Section title="Окна и подсказки" description="Панель справа — посмотреть, не теряя список. Окно — вопрос или короткая форма. Подтверждение — с фокусом на «Отмена».">
            <Card>
              <Row label="Открыть">
                <Button onClick={() => setDrawer(true)}>Панель справа</Button>
                <Button onClick={() => setModal(true)}>Окно с формой</Button>
                <Button variant="danger-outline" onClick={() => setConfirm("open")}>Подтверждение</Button>
              </Row>
              <Row label="Всплывашки">
                <Button onClick={() => toast.success("Приглашение создано: alex.k, 2 страницы.")}>Успех</Button>
                <Button onClick={() => toast.error("Не удалось снять доступ: Hub не ответил. Доступ остался.")}>Ошибка</Button>
              </Row>
              <Row label="Подсказка">
                <Tooltip content="Втрое дольше медианы команды (1 мин 52 с)">
                  <Mark>6 мин 52 с</Mark>
                </Tooltip>
                <Tooltip content="Писала коллега — не в счёте этой смены">
                  <span className="text-15 text-ink-2 underline decoration-line-strong decoration-dotted underline-offset-4" tabIndex={0}>коллега</span>
                </Tooltip>
              </Row>
            </Card>
          </Section>
          <Section title="Поля" description="Подпись сверху, подсказка и ошибка снизу. 36 px, фокус — чернильная рамка.">
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
                <Field label="Лимит ИИ в день" error="Не больше $50.00 в день.">
                  {(control) => <TextInput {...control} defaultValue="75" inputMode="decimal" />}
                </Field>
                <div className="grid content-start gap-3">
                  <Checkbox checked={wholeModel} onChange={setWholeModel} label="Вся модель Mia Hart" hint="mia-1, mia-2, mia-3, mia-of, mia-vip-of — и новые страницы модели" />
                  <Checkbox checked={false} onChange={() => undefined} label="nova-1" disabled hint="Уже открыта" />
                </div>
              </div>
            </Card>
          </Section>
        </div>

        <Section title="Цвета и шрифт" description="Тёплые нейтральные поверхности, одни чернила, спокойные состояния. Inter 400/500/600, ничего меньше 13 px.">
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
                <Swatch name="Выброс" token="--ui-mark-soft" />
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
        open={drawer}
        onClose={() => setDrawer(false)}
        title="alex.k"
        subtitle="Чаттер · mia-1, mia-2 · был 2 ч назад"
        footer={<><Button variant="ghost" onClick={() => setDrawer(false)}>Закрыть</Button><Button variant="primary">Сохранить доступ</Button></>}
      >
        <div className="grid gap-6">
          <Facts items={[{ label: "Продажи", value: <Money mills={1_070_150} />, strong: true }, { label: "В час", value: <Money mills={22_810} /> }, { label: "Смен", value: "6" }]} />
          <KeyValue
            items={[
              { label: "Страницы", value: <PageChips labels={["mia-1", "mia-2"]} /> },
              { label: "Устройства", value: "2 входа: Firefox на Windows, Chrome на macOS" },
              { label: "Ссылка входа", value: "Действует до 9 нояб., 14:00" },
            ]}
          />
          <Notice tone="info">Панель не закрывает список: можно листать его и открывать другие строки.</Notice>
          <SkeletonText lines={6} />
        </div>
      </Drawer>

      {modal && (
        <Modal
          title="Пригласить человека"
          onClose={() => setModal(false)}
          actions={<><Button variant="ghost" onClick={() => setModal(false)}>Отмена</Button><Button variant="primary" disabled={!invitee.trim()} onClick={() => { setModal(false); toast.success(`Приглашение для ${invitee} создано.`); }}>Создать приглашение</Button></>}
        >
          <Field label="Логин" hint="Так человек войдёт в расширение.">
            {(control) => <TextInput {...control} value={invitee} onChange={(event) => setInvitee(event.target.value)} placeholder="alex.k" />}
          </Field>
          <Checkbox checked={wholeModel} onChange={setWholeModel} label="Вся модель Mia Hart" hint="Пять страниц и новые страницы модели" />
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
