import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Button, Card, Drawer, EmptyState, LinkButton, Money, Notice, RateBar, Section, Skeleton, Switch, Table, TextInput, cx, toast, type Column } from "@agency_hub_core/ui";
import { formatCount, formatDayRange, formatOf, formatPercent } from "@agency_hub_core/ui/format";
import { addDays } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { personPath, useBackState } from "@/shared/links";
import { useMe } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import {
  MAX_DAYS,
  MIN_SAMPLE,
  NO_COUNTS,
  lastMaturedWindow,
  maturedWeek,
  readWindow,
  ripening,
  share,
  useSaveWinBackApproach,
  useWinBackApproaches,
  useWinBackResults,
  winBackView,
  type Approach,
  type WinBackCounts,
  type WinBackLine,
} from "./data";
import { BACK_LABEL, barWidth, BeyondReach, BySwitch, Folds, HowItCounts, LineName, NoAnswer, SalesHeader, WindowNotice, openColumn, panelColumns, skeletonColumns, useSalesParams, windowWords } from "./parts";

/**
 * Возврат фанов: which approaches of the extension's «Вернуть» bring silent
 * fans back, and with whom. One funnel with its bases said aloud (E4): every
 * share names the written it is of — «17 из 42, у кого 72 часа прошли» — and
 * how many are still waited for, so 42 + 28 = the 70 written. When nothing in
 * the period has matured for 7 days, the last week that has stands next to the
 * funnel as its own block with its dates, never as a step of this one (В1).
 * The owner switches an approach on and off in its own row (the console's one
 * write, the same request); switched-off ones are folded. A share's bar runs
 * from 0 to 100 %.
 */

const replied = (counts: WinBackCounts) => ({ hits: counts.replied72h, of: counts.matured72h });
const bought = (counts: WinBackCounts) => ({ hits: counts.bought7d, of: counts.matured7d });

type MaturedWeek = { from: string; to: string; bought7d: number; matured7d: number };

/** «40 %», or «3 из 8» below the sample: the same rule as the table's bars. Pure. */
function shareWords(rate: { hits: number; of: number }): string {
  return rate.of >= MIN_SAMPLE.winBack ? formatPercent((100 * rate.hits) / rate.of) : formatOf(rate.hits, rate.of);
}

interface Step {
  label: string;
  value: ReactNode;
  /** Quiet lines under the label: the base of a share, how many are still waited for. */
  lines: ReactNode[];
  /** The value is a share of fewer than the sample: pale. */
  weak?: boolean;
}

function FunnelStep({ step }: { step: Step }) {
  return (
    <div className="sales-funnel__step" role="listitem">
      <span className={cx("sales-funnel__value", step.weak && "sales-funnel__value--weak")}>{step.value}</span>
      <span className="sales-funnel__label">{step.label}</span>
      {step.lines.map((line, index) => <span key={index} className="sales-funnel__meta">{line}</span>)}
    </div>
  );
}

/**
 * A result of the written, matured or not: «40 %» of those whose time is over
 * and «17 из 42 · ещё 28 ждём» — the base and the rest, which add up to the
 * written (the section's line says the rule once).
 */
function resultStep(label: string, rate: { hits: number; of: number }, sent: number): Step {
  const waiting = Math.max(0, sent - rate.of);
  if (rate.of === 0) return { label, value: "—", lines: ["срок ещё не прошёл", `ждём ${formatCount(sent)}`] };
  const base = `${formatOf(rate.hits, rate.of)}${waiting > 0 ? ` · ещё ${formatCount(waiting)} ждём` : ""}`;
  return {
    label,
    value: shareWords(rate),
    weak: rate.of < MIN_SAMPLE.winBack,
    lines: rate.of < MIN_SAMPLE.winBack ? [base, "мало, чтобы судить"] : [base],
  };
}

/**
 * The team's funnel: picked › wrote › answered within 72 h › bought within
 * 7 days, each share of the written whose time is over; on the side, as its
 * own block, the last week whose 7 days are over (when none of this period's
 * are) and the money of the 30 days.
 */
function Funnel({ counts, chatters, matured }: { counts: WinBackCounts; chatters: number; matured: MaturedWeek | null | "loading" }) {
  const steps: Step[] = [
    { label: "Выбрали подход", value: formatCount(counts.attempts), lines: [`${formatCount(chatters)} ${ruPlural(chatters, "чаттер", "чаттера", "чаттеров")}`] },
    { label: "Написали фану", value: formatCount(counts.sent), lines: [counts.attempts > 0 ? `${formatPercent((100 * counts.sent) / counts.attempts)} выбранных` : "—"] },
    resultStep("Ответили за 72 часа", replied(counts), counts.sent),
    resultStep("Купили за 7 дней", bought(counts), counts.sent),
  ];
  const showWeek = counts.matured7d === 0 && matured !== null;
  const showSpent = counts.matured30d > 0;
  return (
    <Card padding="md" className="sales-funnel-card">
      <div className="sales-funnel">
        <div className="sales-funnel__steps" role="list" aria-label="Воронка возврата">
          {steps.map((step, index) => (
            <Fragment key={step.label}>
              {index > 0 && <ChevronRight size={20} strokeWidth={1.5} aria-hidden className="sales-funnel__arrow" />}
              <FunnelStep step={step} />
            </Fragment>
          ))}
        </div>
        {(showWeek || showSpent) && (
          <div className="sales-funnel__aside">
            {showWeek && <MaturedWeekBlock matured={matured} />}
            {showSpent && (
              <div className="sales-funnel__side">
                <span className="sales-funnel__value sales-funnel__value--small"><Money mills={counts.spent30dMills} /></span>
                <span className="sales-funnel__label">Потратили за 30 дней</span>
                <span className="sales-funnel__meta">до комиссии · {formatCount(counts.matured30d)} {ruPlural(counts.matured30d, "фан", "фана", "фанов")}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** The last week whose 7 days are over: its own dates, its own written — another group of fans than the funnel's. */
function MaturedWeekBlock({ matured }: { matured: MaturedWeek | "loading" | null }) {
  if (matured === null) return null;
  if (matured === "loading") {
    return (
      <div className="sales-funnel__side" aria-busy>
        <span className="sales-funnel__kicker">Последняя неделя, где 7 дней прошли</span>
        <Skeleton width={64} height={28} />
        <Skeleton width={160} />
      </div>
    );
  }
  const dates = formatDayRange(matured.from, matured.to);
  return (
    <div className="sales-funnel__side">
      <span className="sales-funnel__kicker">Неделя {dates}</span>
      {matured.matured7d > 0 ? (
        <>
          <span className="sales-funnel__value sales-funnel__value--small">{shareWords({ hits: matured.bought7d, of: matured.matured7d })}</span>
          <span className="sales-funnel__label">купили за 7 дней</span>
          <span className="sales-funnel__meta">{formatOf(matured.bought7d, matured.matured7d)} написанных тогда</span>
        </>
      ) : (
        <>
          <span className="sales-funnel__value sales-funnel__value--small">—</span>
          <span className="sales-funnel__label">тогда подходы не выбирали</span>
        </>
      )}
    </div>
  );
}

function FunnelSkeleton() {
  return (
    <Card padding="md" className="sales-funnel-card">
      <div className="sales-funnel sales-funnel--skeleton" aria-hidden>
        <div className="sales-funnel__steps">
          {[0, 1, 2, 3].map((index) => (
            <Fragment key={index}>
              {index > 0 && <ChevronRight size={20} strokeWidth={1.5} className="sales-funnel__arrow" />}
              <div className="sales-funnel__step">
                <Skeleton width={56} height={28} />
                <Skeleton width={112} />
                <Skeleton width={136} height={14} />
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** «13 % — 22 из 167, ещё 26 ждём; все подходы 12 %»: the share of the bought, and how many are still ripening. */
function boughtWords(counts: WinBackCounts, all: WinBackCounts, together: string): string {
  const left = ripening(counts);
  const team = share(bought(all));
  const small = counts.matured7d < MIN_SAMPLE.winBack ? ". Мало, чтобы судить" : "";
  return `${formatPercent((100 * counts.bought7d) / counts.matured7d)} — ${formatOf(counts.bought7d, counts.matured7d)}${left > 0 ? `, ещё ${formatCount(left)} ждём` : ""}${team !== null ? `; ${together} ${formatPercent(team * 100)}` : ""}${small}`;
}

interface Toggle {
  /** The one approach whose request is under way. */
  pendingId: number | null;
  busy: boolean;
  onToggle: (approach: Approach) => void;
}

interface LineOptions {
  kind: "approach" | "chatter";
  showSpent: boolean;
  toggle?: Toggle;
  together: string;
  open?: boolean;
  /**
   * The rows whose results decide which columns show: every row of the cut —
   * the folded switched-off ones too — so both tables share one set of columns
   * (В7). Default: the rows themselves.
   */
  shape?: readonly WinBackLine[];
  /** Before the rows come: the columns the period will show (В6). */
  hide?: { replied: boolean; bought: boolean };
}

function lineColumns(lines: readonly WinBackLine[], all: WinBackCounts, options: LineOptions): Column<WinBackLine>[] {
  const columns: Column<WinBackLine>[] = [
    {
      key: "name",
      header: options.kind === "approach" ? "Подход" : "Чаттер",
      cell: (line) => <LineName kind={line.kind} name={line.name} order={line.order} quiet={line.active === false} />,
      // Approaches stand in the extension's order (the number before the name), as the chatters see them (В4).
      sortValue: (line) => (line.kind === "approach" && line.order !== null ? line.order : line.name),
      sortFirst: "asc",
      grow: true,
    },
    {
      key: "sent",
      header: "Написали",
      numeric: true,
      hint: "Чаттер выбрал подход и в 48 часов написал фану. Ниже — сколько раз выбрали, если не всем написали",
      cell: (line) => (
        <span className="sales-stack">
          <span>{formatCount(line.counts.sent)}</span>
          {line.counts.attempts > line.counts.sent && <span className="sales-sub">выбрали {formatCount(line.counts.attempts)}</span>}
        </span>
      ),
      sortValue: (line) => line.counts.sent,
    },
    {
      key: "replied",
      header: "Ответили за 72 ч",
      cell: (line) => <RateBar {...replied(line.counts)} min={MIN_SAMPLE.winBack} compare={share(replied(all))} compareLabel={options.together} quiet={line.active === false} empty={line.counts.sent === 0 ? "—" : "зреет"} emptyHint={line.counts.sent === 0 ? "В этом периоде подход не выбирали" : "72 часа после сообщения ещё не прошли"} />,
      sortValue: (line) => (line.counts.matured72h >= MIN_SAMPLE.winBack ? share(replied(line.counts)) : null),
      sortFirst: "desc",
      width: options.showSpent ? barWidth(16, 400) : barWidth(24, 440),
      className: "sales-bar-col",
    },
    {
      key: "bought",
      header: "Купили за 7 дней",
      cell: (line) => <RateBar {...bought(line.counts)} min={MIN_SAMPLE.winBack} compare={share(bought(all))} compareLabel={options.together} quiet={line.active === false} empty={line.counts.sent === 0 ? "—" : "зреет"} emptyHint={line.counts.sent === 0 ? "В этом периоде подход не выбирали" : "7 дней после сообщения ещё не прошли"} {...(line.counts.matured7d > 0 ? { hint: boughtWords(line.counts, all, options.together) } : {})} />,
      sortValue: (line) => (line.counts.matured7d >= MIN_SAMPLE.winBack ? share(bought(line.counts)) : null),
      sortFirst: "desc",
      width: options.showSpent ? barWidth(16, 400) : barWidth(24, 440),
      className: "sales-bar-col",
    },
  ];
  // A column whose every cell would say «зреет» says nothing: the funnel says it once.
  const shape = options.shape ?? lines;
  const hidden = new Set<string>();
  if (options.hide?.replied || (shape.length > 0 && !shape.some((line) => line.counts.matured72h > 0))) hidden.add("replied");
  if (options.hide?.bought || (shape.length > 0 && !shape.some((line) => line.counts.matured7d > 0))) hidden.add("bought");
  for (const key of hidden) columns.splice(columns.findIndex((column) => column.key === key), 1);
  if (options.showSpent) {
    columns.push({
      key: "spent",
      header: "Потратили за 30 дней",
      numeric: true,
      headerWrap: true,
      hint: "Сколько заплатили фаны, которым написали 30 и больше дней назад, за 30 дней после сообщения. До комиссии платформы",
      cell: (line) => (line.counts.matured30d > 0
        ? <Money mills={line.counts.spent30dMills} />
        : <span className="sales-quiet">{line.counts.sent === 0 ? "—" : "зреет"}</span>),
      sortValue: (line) => (line.counts.matured30d > 0 ? line.counts.spent30dMills : null),
    });
  }
  const toggle = options.toggle;
  if (toggle) {
    columns.push({
      key: "on",
      header: "В расширении",
      numeric: true,
      hint: "Чаттеры видят включённые подходы на вкладке «Вернуть», по порядку — число перед названием. Выключенный пропадает из расширения, его итоги остаются",
      cell: (line) => (line.approach ? (
        <span className="sales-switch">
          <Switch
            checked={line.approach.active}
            onChange={() => toggle.onToggle(line.approach!)}
            label={`«${line.name}» в расширении`}
            labelHidden
            variant="quiet"
            pending={toggle.pendingId === line.id}
            disabled={toggle.busy && toggle.pendingId !== line.id}
          />
        </span>
      ) : null),
      width: 124,
    });
  }
  if (options.open !== false) columns.push(openColumn<WinBackLine>());
  return columns;
}

function LineDrawer({ line, onClose, windowLabel }: { line: WinBackLine; onClose: () => void; windowLabel: string }) {
  const location = useLocation();
  const back = useBackState(BACK_LABEL);
  const partKind = line.kind === "approach" ? "chatter" : "approach";
  const together = line.kind === "approach" ? "этот подход у всех" : "все подходы чаттера";
  const columns = panelColumns(lineColumns(line.parts, line.counts, { kind: partKind, showSpent: false, together, open: false }), { name: "36%", sent: "14%", replied: "25%", bought: "25%" })
    .map((column) => (column.key === "sent" ? { ...column, cell: (part: WinBackLine) => formatCount(part.counts.sent) } : column));
  const r = replied(line.counts);
  const b = bought(line.counts);
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={line.name}
      subtitle={`Возврат фанов · ${windowLabel}`}
      {...(line.kind === "chatter"
        ? { footer: <LinkButton to={personPath(line.id, location.search)} state={back}>Открыть карточку {line.name}</LinkButton> }
        : {})}
    >
      <div className="sales-drawer">
        <p className="sales-drawer__lead">
          Написали {formatCount(line.counts.sent)} {ruPlural(line.counts.sent, "фану", "фанам", "фанам")}
          {r.of > 0 ? `, ответили ${shareWords(r)}` : ""}
          {b.of > 0 ? `, купили ${shareWords(b)}` : line.counts.sent > 0 ? ", покупки ещё зреют" : ""}.
          {(r.of > 0 && r.of < MIN_SAMPLE.winBack) || (b.of > 0 && b.of < MIN_SAMPLE.winBack) ? " Мало, чтобы судить." : ""}
          {line.kind === "approach" && line.active === false ? " Подход выключен: чаттеры его больше не видят, итоги остаются." : ""}
        </p>
        {line.parts.length > 0 ? (
          <>
            <Table
              label={`${line.name}: ${line.kind === "approach" ? "по чаттерам" : "по подходам"}`}
              columns={columns}
              rows={line.parts}
              rowKey={(part) => part.key}
              defaultSort={partKind === "approach" ? { key: "name", direction: "asc" } : { key: "sent", direction: "desc" }}
              stickyHeader={false}
              fit={false}
            />
            <p className="sales-sub">Черта на полосе — {together} вместе.</p>
          </>
        ) : (
          <EmptyState compact title="В этом периоде подход не выбирали">Итоги появятся, когда чаттеры выберут его на вкладке «Вернуть».</EmptyState>
        )}
      </div>
    </Drawer>
  );
}

/** A new approach at the end of the list: the console's form and body as they are (TeamWinBackPage.tsx:171-189). */
function AddApproach({ saving, onAdd }: { saving: "new" | "other" | null; onAdd: (label: string, done: () => void) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="sales-add"
      onSubmit={(event) => {
        event.preventDefault();
        const label = draft.trim();
        if (label === "") return;
        onAdd(label, () => setDraft(""));
      }}
    >
      <TextInput
        aria-label="Новый подход"
        placeholder="Новый подход, например «Голосовое с именем»"
        maxLength={80}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button type="submit" variant={draft.trim() === "" ? "secondary" : "primary"} loading={saving === "new"} disabled={saving !== null || draft.trim() === ""}>
        {saving === "new" ? "Добавляем…" : "Добавить"}
      </Button>
    </form>
  );
}

export function WinBackTab() {
  const { period, today, setPeriod } = usePeriod();
  const { page, setPage } = usePageFilter();
  const { isOwner } = useMe();
  const { by, open, setBy, setOpen } = useSalesParams();
  const window = readWindow(period, today, MAX_DAYS.winBack);
  const query = useWinBackResults(window);
  const approaches = useWinBackApproaches(isOwner);
  const list = approaches.data?.approaches;
  const view = useMemo(
    () => (query.data ? winBackView(query.data.rows, list, query.data) : null),
    [query.data, list],
  );
  // D9: nothing in the period has matured for 7 days — the last week that has, from one more (cached) read.
  const noneMatured7d = view !== null && view.all.sent > 0 && view.all.matured7d === 0;
  const maturedWindow = lastMaturedWindow(today);
  const sameRead = window.days === maturedWindow.days && window.minusDays === null;
  const maturedRead = useWinBackResults(maturedWindow, noneMatured7d && !sameRead);
  const matured = !noneMatured7d ? null
    : maturedRead.data ? maturedWeek(maturedRead.data.rows, today)
      : maturedRead.isPending && maturedRead.fetchStatus !== "idle" ? "loading" as const : null;

  const save = useSaveWinBackApproach();
  // An approach switched here stays in its row until the page is opened again: it does not jump into the fold under the pointer.
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set());
  const [showOff, setShowOff] = useState(false);
  const pendingId = save.isPending ? save.variables?.id ?? null : null;
  const saving: "new" | "other" | null = save.isPending ? (save.variables?.id === undefined ? "new" : "other") : null;
  function submit(body: Parameters<typeof save.mutate>[0], done?: () => void) {
    save.mutate(body, {
      onSuccess: () => done?.(),
      onError: () => toast.error("Не сохранилось: такое название уже есть или Hub не ответил."),
    });
  }
  const toggle: Toggle | undefined = isOwner && list
    ? {
      pendingId,
      busy: save.isPending,
      // The console's body as it is: { id, label, sortOrder, active: !active } (TeamWinBackPage.tsx:163).
      onToggle: (approach) => {
        setTouched((current) => new Set(current).add(approach.id));
        submit({ id: approach.id, label: approach.label, sortOrder: approach.sortOrder, active: !approach.active });
      },
    }
    : undefined;

  const cut = by === "chatters" ? "chatter" : "approach";
  const allLines = view ? (cut === "approach" ? view.approaches : view.chatters) : [];
  // The owner's switched-off approaches fold under the table (spec r2); a team lead does not know which are off.
  const folded = (line: WinBackLine) => line.active === false && !touched.has(line.id);
  const lines = cut === "approach" ? allLines.filter((line) => !folded(line)) : allLines;
  const offLines = cut === "approach" ? allLines.filter(folded) : [];
  const openLine = view ? [...view.approaches, ...view.chatters].find((line) => line.key === open) ?? null : null;
  const label = view ? windowWords(view.from, view.to) : "";
  const showSpent = view ? view.all.matured30d > 0 : false;
  const together = cut === "approach" ? "все подходы" : "вся команда";
  const columnsOf = (rows: readonly WinBackLine[]) => lineColumns(rows, view?.all ?? NO_COUNTS, { kind: cut, showSpent, together, shape: allLines, ...(cut === "approach" && toggle ? { toggle } : {}) });
  // The owner's approaches stand in the extension's order; without the list (a team lead) the most written first.
  const defaultSort = cut === "approach" && isOwner ? { key: "name", direction: "asc" as const } : { key: "sent", direction: "desc" as const };
  const bySwitch = (
    <BySwitch<"approach" | "chatter">
      value={cut}
      onChange={(value) => setBy(value === "chatter" ? "chatters" : "pages")}
      options={[{ value: "approach", label: "По подходам" }, { value: "chatter", label: "По чаттерам" }]}
    />
  );
  const cutTitle = cut === "approach" ? "По подходам" : "По чаттерам";
  const cutDescription = cut === "approach"
    ? isOwner ? "Какие подходы «Вернуть» возвращают фанов. Включённые чаттеры видят в расширении по порядку." : "Какие подходы «Вернуть» возвращают фанов."
    : "Кто пользуется «Вернуть» и что у него выходит.";
  const funnelDescription = "Каждая доля — от написанных, у кого срок уже прошёл; остальных ещё ждём.";

  let body;
  if (window.beyond) {
    body = <BeyondReach maxDays={MAX_DAYS.winBack} />;
  } else if (!view) {
    // The skeleton has the columns the period will have (В6): a read up to today of a week or less has nothing 7 days old.
    const fresh = window.minusDays === null;
    const skeleton = lineColumns([], NO_COUNTS, {
      kind: cut,
      showSpent: window.days > 30,
      together,
      hide: { replied: fresh && window.days <= 3, bought: fresh && window.days <= 7 },
      ...(cut === "approach" && isOwner ? { toggle: { pendingId: null, busy: true, onToggle: () => undefined } } : {}),
    });
    body = query.isError
      ? <NoAnswer onRetry={() => void query.refetch()} retrying={query.isFetching} />
      : (
        <>
          <Section title="Возвращаются ли фаны" description={funnelDescription}>
            <FunnelSkeleton />
          </Section>
          <Section title={cutTitle} description={cutDescription} actions={bySwitch}>
            <Table label="Итоги по подходам" columns={skeletonColumns(skeleton)} rows={[]} rowKey={(line) => line.key} fit={false} loading skeletonRows={5} skeletonLines={cut === "chatter" ? 2 : 1} />
          </Section>
        </>
      );
  } else if (view.all.attempts === 0 && !(cut === "approach" && list && list.length > 0)) {
    body = (
      <EmptyState title={`За ${label} подходы не выбирали`}>
        Как только чаттеры начнут выбирать подход на вкладке «Вернуть» в расширении, здесь появятся итоги.
      </EmptyState>
    );
  } else {
    body = (
      <>
        {view.all.attempts > 0 && (
          <Section title="Возвращаются ли фаны" description={funnelDescription}>
            <Funnel counts={view.all} chatters={view.chatters.length} matured={matured} />
          </Section>
        )}
        <Section title={cutTitle} description={cutDescription} actions={bySwitch}>
          <Table
            label={cut === "approach" ? "Итоги по подходам" : "Итоги по чаттерам"}
            columns={columnsOf(lines)}
            rows={showOff ? [...lines, ...offLines] : lines}
            rowKey={(line) => line.key}
            onRowClick={(line) => setOpen(line.key)}
            selectedKey={openLine?.key ?? null}
            defaultSort={defaultSort}
            rowQuiet={(line) => line.active === false}
            refreshing={query.isPlaceholderData}
            skeletonLines={cut === "chatter" ? 2 : 1}
            empty={<EmptyState compact title="Включённых подходов нет">Чаттеры сейчас не видят ни одного подхода на вкладке «Вернуть».</EmptyState>}
          />
          {/* Switched-off approaches join the same table, quiet, at the end: one set of columns, one geometry (В7). */}
          {offLines.length > 0 && (
            <button type="button" className="sales-toggle" aria-expanded={showOff} onClick={() => setShowOff((value) => !value)}>
              {showOff ? <ChevronUp size={16} strokeWidth={2} aria-hidden /> : <ChevronDown size={16} strokeWidth={2} aria-hidden />}
              <span className="sales-toggle__label">{showOff ? "Скрыть выключенные подходы" : "Выключенные подходы"}</span>
              <span className="sales-toggle__hint">{formatCount(offLines.length)} · чаттеры их не видят, итоги остаются</span>
            </button>
          )}
          {cut === "approach" && isOwner && (
            list
              ? <AddApproach saving={saving} onAdd={(text, done) => submit({ label: text, sortOrder: list.length + 1, active: true }, done)} />
              : approaches.isError
                ? (
                  <div className="sales-after">
                    <p>Список подходов не загрузился: включать, выключать и добавлять пока нельзя.</p>
                    <Button size="sm" variant="ghost" loading={approaches.isFetching} onClick={() => void approaches.refetch()}>Повторить</Button>
                  </div>
                )
                : null
          )}
        </Section>
      </>
    );
  }

  return (
    <>
      <SalesHeader
        updatedAt={query.dataUpdatedAt}
        onRefresh={() => {
          void query.refetch();
          if (isOwner) void approaches.refetch();
        }}
        refreshing={query.isFetching}
      />
      <div className="wb-content">
        {page !== null && (
          <Notice
            title="Возврат фанов считается по всем страницам"
            action={<Button size="sm" onClick={() => setPage(null)}>Показать все страницы</Button>}
          >
            Hub пока не делит возврат по страницам: выбор {page} здесь не действует.
          </Notice>
        )}
        <WindowNotice window={window} maxDays={MAX_DAYS.winBack} {...(label ? { shown: label } : {})} />
        {body}
        <Folds>
          <HowItCounts>
            <p>Подход — то, что чаттер выбирает на вкладке «Вернуть» в расширении, когда пишет молчащему фану.</p>
            <p>
              Чаттер выбирает подход одним касанием и пишет фану сам. Hub записывает выбор и считает, что было после первого
              сообщения этого чаттера фану (в течение 48 часов после выбора). «Написали» — основа воронки: выбрал, но не
              написал — не в счёте.
            </p>
            <p>
              «Ответили» — фан написал в течение 72 часов; «Купили» — заплатил в течение 7 дней; «Потратили» — сколько за 30
              дней, до комиссии платформы (остальные деньги «Что продаёт» — после). Итог считается, только когда его срок
              прошёл: «17 из 42, у кого 72 часа прошли» — из 42 написанных, чьи 72 часа уже позади; остальных «ждём». Пока
              срок не прошёл, попытка «зреет». Если в периоде 7 дней не прошли ни у кого, рядом с воронкой стоит последняя
              неделя, где прошли, — это другие фаны, с её датами. Меньше {MIN_SAMPLE.winBack} созревших — мало, чтобы судить:
              такие доли бледнее и показаны как «3 из 8». Полоса доли — от 0 до 100 %.
            </p>
            <p>
              Возврат считается по всем страницам сразу. Hub не назначает подходы и не засчитывает продажи: только
              записывает и считает. «Потратили за 30 дней» видно у попыток старше 30 дней.{" "}
              <Button size="sm" variant="ghost" onClick={() => setPeriod({ kind: "range", from: addDays(today, -(MAX_DAYS.winBack - 1)), to: today })}>
                Показать 90 дней
              </Button>
            </p>
          </HowItCounts>
        </Folds>
      </div>
      {openLine && view && <LineDrawer line={openLine} onClose={() => setOpen(null)} windowLabel={label} />}
    </>
  );
}
