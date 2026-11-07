import { ChevronRight } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Button, Card, Disclosure, Drawer, EmptyState, Hint, LinkButton, Money, Notice, RateBar, Section, Skeleton, Switch, Table, TextInput, toast, type Column } from "@agency_hub_core/ui";
import { formatCount, formatDayRange, formatOf, formatPercent } from "@agency_hub_core/ui/format";
import { addDays } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { personPath, useBackState } from "@/shared/links";
import { useMe } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import {
  LAST_MATURED_DAYS,
  MAX_DAYS,
  MIN_SAMPLE,
  NO_COUNTS,
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
import { BACK_LABEL, barWidth, BySwitch, HowItCounts, LineName, NoAnswer, SalesHeader, WindowNotice, openColumn, panelColumns, SCALE_SAMPLE, scaleOf, skeletonColumns, useSalesParams, windowWords } from "./parts";

/**
 * Возврат фанов: which approaches of the extension's «Вернуть» bring silent
 * fans back, and with whom. One funnel with one base — the fans a chatter
 * wrote to — and an honest «ещё зреют»; when nothing in the period has
 * matured, the last step shows the last matured week with its dates (spec r2).
 * The owner switches an approach on and off in its own row (the console's one
 * write, the same request); switched-off ones are folded.
 */

const replied = (counts: WinBackCounts) => ({ hits: counts.replied72h, of: counts.matured72h });
const bought = (counts: WinBackCounts) => ({ hits: counts.bought7d, of: counts.matured7d });

type MaturedWeek = { from: string; to: string; bought7d: number; matured7d: number };

interface Step {
  label: string;
  value: ReactNode;
  meta: ReactNode;
  hint?: ReactNode;
}

function FunnelStep({ step }: { step: Step }) {
  return (
    <div className="sales-funnel__step" role="listitem">
      <span className="sales-funnel__value">{step.hint ? <Hint content={step.hint} align="start">{step.value}</Hint> : step.value}</span>
      <span className="sales-funnel__label">{step.label}</span>
      <span className="sales-funnel__meta">{step.meta}</span>
    </div>
  );
}

/** The team's funnel: picked → wrote → answered → bought; still ripening and the money on the side. */
function Funnel({ counts, chatters, matured }: { counts: WinBackCounts; chatters: number; matured: MaturedWeek | null | "loading" }) {
  const left = ripening(counts);
  let lastStep: Step;
  if (counts.matured7d > 0) {
    lastStep = {
      label: "Купили за 7 дней",
      value: formatPercent((100 * counts.bought7d) / counts.matured7d),
      meta: formatOf(counts.bought7d, counts.matured7d),
    };
  } else if (matured === "loading") {
    lastStep = { label: "Купили за 7 дней", value: <Skeleton width={64} height={28} />, meta: "последняя неделя, где 7 дней прошли" };
  } else if (matured && matured.matured7d > 0) {
    const dates = formatDayRange(matured.from, matured.to);
    lastStep = {
      label: "Купили за 7 дней",
      value: formatPercent((100 * matured.bought7d) / matured.matured7d),
      meta: `${formatOf(matured.bought7d, matured.matured7d)} · написали ${dates}`,
      hint: `С сообщений этого периода 7 дней ещё не прошли. Здесь — последняя неделя, где прошли: кому написали ${dates}.`,
    };
  } else {
    lastStep = { label: "Купили за 7 дней", value: "—", meta: "7 дней ещё не прошли" };
  }
  const steps: Step[] = [
    {
      label: "Выбрали подход",
      value: formatCount(counts.attempts),
      meta: `${formatCount(chatters)} ${ruPlural(chatters, "чаттер", "чаттера", "чаттеров")}`,
    },
    {
      label: "Написали фану",
      value: formatCount(counts.sent),
      meta: counts.attempts > 0 ? `${formatPercent((100 * counts.sent) / counts.attempts)} выбранных` : "—",
    },
    {
      label: "Ответили за 72 часа",
      value: counts.matured72h > 0 ? formatPercent((100 * counts.replied72h) / counts.matured72h) : "—",
      meta: counts.matured72h > 0 ? formatOf(counts.replied72h, counts.matured72h) : "72 часа ещё не прошли",
    },
    lastStep,
  ];
  const showLeft = left > 0 && counts.matured7d > 0;
  const showSpent = counts.matured30d > 0;
  return (
    <Card padding="md">
      <div className="sales-funnel">
        <div className="sales-funnel__steps" role="list" aria-label="Воронка возврата">
          {steps.map((step, index) => (
            <Fragment key={step.label}>
              {index > 0 && <ChevronRight size={20} strokeWidth={1.5} aria-hidden className="sales-funnel__arrow" />}
              <FunnelStep step={step} />
            </Fragment>
          ))}
        </div>
        {(showLeft || showSpent) && (
          <div className="sales-funnel__aside">
            {showLeft && (
              <div className="sales-funnel__side">
                <span className="sales-funnel__value sales-funnel__value--small">{formatCount(left)}</span>
                <span className="sales-funnel__label">Ещё зреют: покупку ждём</span>
              </div>
            )}
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

function FunnelSkeleton() {
  return (
    <Card padding="md">
      <div className="sales-funnel sales-funnel--skeleton" aria-hidden>
        <div className="sales-funnel__steps">
          {[0, 1, 2, 3].map((index) => (
            <Fragment key={index}>
              {index > 0 && <ChevronRight size={20} strokeWidth={1.5} className="sales-funnel__arrow" />}
              <div className="sales-funnel__step">
                <Skeleton width={56} height={28} />
                <Skeleton width={112} />
                <Skeleton width={72} height={12} />
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

function lineColumns(lines: readonly WinBackLine[], all: WinBackCounts, options: { kind: "approach" | "chatter"; showSpent: boolean; toggle?: Toggle; together: string; open?: boolean }): Column<WinBackLine>[] {
  const repliedMax = scaleOf(lines.map((line) => (line.counts.matured72h >= SCALE_SAMPLE ? share(replied(line.counts)) : null)).concat(share(replied(all))));
  const boughtMax = scaleOf(lines.map((line) => (line.counts.matured7d >= SCALE_SAMPLE ? share(bought(line.counts)) : null)).concat(share(bought(all))));
  const columns: Column<WinBackLine>[] = [
    {
      key: "name",
      header: options.kind === "approach" ? "Подход" : "Чаттер",
      cell: (line) => <LineName kind={line.kind} name={line.name} order={line.order} quiet={line.active === false} />,
      sortValue: (line) => line.name,
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
      hint: `Доля фанов, которые написали в 72 часа после сообщения, из тех, у кого 72 часа прошли. Черта — ${options.together}`,
      cell: (line) => <RateBar {...replied(line.counts)} min={MIN_SAMPLE.winBack} max={repliedMax} compare={share(replied(all))} compareLabel={options.together} quiet={line.active === false} empty={line.counts.sent === 0 ? "—" : "зреет"} emptyHint={line.counts.sent === 0 ? "В этом периоде подход не выбирали" : "72 часа после сообщения ещё не прошли"} />,
      sortValue: (line) => (line.counts.matured72h >= MIN_SAMPLE.winBack ? share(replied(line.counts)) : null),
      sortFirst: "desc",
      width: options.showSpent ? barWidth(16, 400) : barWidth(24, 440),
    },
    {
      key: "bought",
      header: "Купили за 7 дней",
      hint: `Доля фанов, которые заплатили в 7 дней после сообщения, из тех, у кого 7 дней прошли. Черта — ${options.together}`,
      cell: (line) => <RateBar {...bought(line.counts)} min={MIN_SAMPLE.winBack} max={boughtMax} compare={share(bought(all))} compareLabel={options.together} quiet={line.active === false} empty={line.counts.sent === 0 ? "—" : "зреет"} emptyHint={line.counts.sent === 0 ? "В этом периоде подход не выбирали" : "7 дней после сообщения ещё не прошли"} {...(line.counts.matured7d > 0 ? { hint: boughtWords(line.counts, all, options.together) } : {})} />,
      sortValue: (line) => (line.counts.matured7d >= MIN_SAMPLE.winBack ? share(bought(line.counts)) : null),
      sortFirst: "desc",
      width: options.showSpent ? barWidth(16, 400) : barWidth(24, 440),
    },
  ];
  // A column whose every cell would say «зреет» says nothing: the funnel says it once.
  const hidden = new Set<string>();
  if (lines.length > 0 && !lines.some((line) => line.counts.matured72h > 0)) hidden.add("replied");
  if (lines.length > 0 && !lines.some((line) => line.counts.matured7d > 0)) hidden.add("bought");
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
          {r.of > 0 ? `, ответили ${formatPercent((100 * r.hits) / r.of)}` : ""}
          {b.of > 0 ? `, купили ${formatPercent((100 * b.hits) / b.of)}` : line.counts.sent > 0 ? ", покупки ещё зреют" : ""}.
          {line.kind === "approach" && line.active === false ? " Подход выключен: чаттеры его больше не видят, итоги остаются." : ""}
        </p>
        {line.parts.length > 0 ? (
          <>
            <Table
              label={`${line.name}: ${line.kind === "approach" ? "по чаттерам" : "по подходам"}`}
              columns={columns}
              rows={line.parts}
              rowKey={(part) => part.key}
              defaultSort={{ key: "sent", direction: "desc" }}
              stickyHeader={false}
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
  const query = useWinBackResults(window.days);
  const approaches = useWinBackApproaches(isOwner);
  const list = approaches.data?.approaches;
  const view = useMemo(
    () => (query.data ? winBackView(query.data.rows, list, query.data) : null),
    [query.data, list],
  );
  // D9: nothing in the period has matured for 7 days — the last week that has, from one more (cached) read.
  const noneMatured7d = view !== null && view.all.sent > 0 && view.all.matured7d === 0;
  const maturedRead = useWinBackResults(LAST_MATURED_DAYS, noneMatured7d && window.days !== LAST_MATURED_DAYS);
  const matured = !noneMatured7d ? null
    : maturedRead.data ? maturedWeek(maturedRead.data.rows, today)
      : maturedRead.isPending && maturedRead.fetchStatus !== "idle" ? "loading" as const : null;

  const save = useSaveWinBackApproach();
  // An approach switched here stays in its row until the page is opened again: it does not jump into the fold under the pointer.
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set());
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
  const columnsOf = (rows: readonly WinBackLine[]) => lineColumns(rows, view?.all ?? NO_COUNTS, { kind: cut, showSpent, together, ...(cut === "approach" && toggle ? { toggle } : {}) });

  let body;
  if (!view) {
    body = query.isError
      ? <NoAnswer onRetry={() => void query.refetch()} retrying={query.isFetching} />
      : (
        <>
          <Section title="Возвращаются ли фаны" description="Доли — от тех, кому написали и у кого срок уже прошёл.">
            <FunnelSkeleton />
          </Section>
          <Section title={cut === "approach" ? "По подходам" : "По чаттерам"}>
            <Table label="Итоги по подходам" columns={skeletonColumns(lineColumns([], NO_COUNTS, { kind: cut, showSpent: false, together }))} rows={[]} rowKey={(line) => line.key} loading skeletonRows={5} skeletonLines={cut === "chatter" ? 2 : 1} />
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
          <Section title="Возвращаются ли фаны" description="Доли — от тех, кому написали и у кого срок уже прошёл. Остальные «зреют»: их ответ или покупку ещё ждём.">
            <Funnel counts={view.all} chatters={view.chatters.length} matured={matured} />
          </Section>
        )}
        <Section
          title={cut === "approach" ? "По подходам" : "По чаттерам"}
          description={cut === "approach"
            ? isOwner ? "Какие подходы «Вернуть» возвращают фанов. Включённые чаттеры видят в расширении по порядку." : "Какие подходы «Вернуть» возвращают фанов."
            : "Кто пользуется «Вернуть» и что у него выходит."}
          actions={(
            <BySwitch<"approach" | "chatter">
              value={cut}
              onChange={(value) => setBy(value === "chatter" ? "chatters" : "pages")}
              options={[{ value: "approach", label: "По подходам" }, { value: "chatter", label: "По чаттерам" }]}
            />
          )}
        >
          <Table
            label={cut === "approach" ? "Итоги по подходам" : "Итоги по чаттерам"}
            columns={columnsOf(lines)}
            rows={lines}
            rowKey={(line) => line.key}
            onRowClick={(line) => setOpen(line.key)}
            selectedKey={openLine?.key ?? null}
            defaultSort={{ key: "sent", direction: "desc" }}
            rowQuiet={(line) => line.active === false}
            refreshing={query.isPlaceholderData}
            skeletonLines={cut === "chatter" ? 2 : 1}
            empty={<EmptyState compact title="Включённых подходов нет">Чаттеры сейчас не видят ни одного подхода на вкладке «Вернуть».</EmptyState>}
          />
          {offLines.length > 0 && (
            <Disclosure summary="Выключенные подходы" hint={`${formatCount(offLines.length)} · чаттеры их не видят, итоги остаются`}>
              <div className="sales-fold">
                <Table
                  label="Выключенные подходы"
                  columns={columnsOf(offLines)}
                  rows={offLines}
                  rowKey={(line) => line.key}
                  onRowClick={(line) => setOpen(line.key)}
                  selectedKey={openLine?.key ?? null}
                  rowQuiet={() => true}
                  defaultSort={{ key: "sent", direction: "desc" }}
                  stickyHeader={false}
                />
              </div>
            </Disclosure>
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
        meta={view ? `Подходы, выбранные ${label} · все страницы` : "Подходы «Вернуть»"}
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
        <HowItCounts>
          <p>Подход — то, что чаттер выбирает на вкладке «Вернуть» в расширении, когда пишет молчащему фану.</p>
          <p>
            Чаттер выбирает подход одним касанием и пишет фану сам. Hub записывает выбор и считает, что было после первого
            сообщения этого чаттера фану (в течение 48 часов после выбора). «Написали» — основа воронки: выбрал, но не написал —
            не в счёте.
          </p>
          <p>
            «Ответили» — фан написал в течение 72 часов; «Купили» — заплатил в течение 7 дней; «Потратили» — сколько за 30 дней,
            до комиссии платформы (остальные деньги «Что продаёт» — после). Итог считается, только когда его срок прошёл:
            «3 из 5» — из пяти созревших. Пока срок не прошёл, попытка «зреет». Если в периоде 7 дней не прошли ни у кого,
            воронка показывает последнюю неделю, где прошли, с её датами. Меньше 10 созревших — слишком мало, чтобы судить:
            такие строки бледнее.
          </p>
          <p>
            Возврат считается по всем страницам сразу. Hub не назначает подходы и не засчитывает продажи: только записывает и
            считает. «Потратили за 30 дней» видно у попыток старше 30 дней.{" "}
            <Button size="sm" variant="ghost" onClick={() => setPeriod({ kind: "range", from: addDays(today, -(MAX_DAYS.winBack - 1)), to: today })}>
              Показать 90 дней
            </Button>
          </p>
        </HowItCounts>
      </div>
      {openLine && view && <LineDrawer line={openLine} onClose={() => setOpen(null)} windowLabel={label} />}
    </>
  );
}
