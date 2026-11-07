import { ChevronRight } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Badge, Button, Card, Drawer, EmptyState, LinkButton, Money, Notice, Section, Segmented, Table, TextInput, toast, type Column } from "@agency_hub_core/ui";
import { formatCount, formatPercent } from "@agency_hub_core/ui/format";
import { addDays } from "@agency_hub_core/ui/moscow";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { personPath } from "@/shared/links";
import { useMe } from "@/shared/useMe";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import {
  MAX_DAYS,
  MIN_SAMPLE,
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
import { HowItCounts, LineName, NoAnswer, RateCell, SalesHeader, WindowNotice, panelColumns, SCALE_SAMPLE, scaleOf, useSalesParams, windowWords } from "./parts";

/**
 * Возврат фанов: which approaches of the extension's «Вернуть» bring silent
 * fans back, and with whom. One funnel with one base — the fans a chatter
 * wrote to — and an honest «ещё зреют» instead of empty cells (critic W1–W5).
 * The owner keeps the list of approaches here, with the console's one write.
 */

const replied = (counts: WinBackCounts) => ({ hits: counts.replied72h, of: counts.matured72h });
const bought = (counts: WinBackCounts) => ({ hits: counts.bought7d, of: counts.matured7d });

/** The team's funnel: picked → wrote → answered → bought, and what is still ripening. */
function Funnel({ counts, chatters }: { counts: WinBackCounts; chatters: number }) {
  const left = ripening(counts);
  const steps: Array<{ label: string; value: ReactNode; meta: ReactNode }> = [
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
      meta: counts.matured72h > 0 ? `${formatCount(counts.replied72h)} из ${formatCount(counts.matured72h)}` : "72 часа ещё не прошли",
    },
    {
      label: "Купили за 7 дней",
      value: counts.matured7d > 0 ? formatPercent((100 * counts.bought7d) / counts.matured7d) : "—",
      meta: counts.matured7d > 0 ? `${formatCount(counts.bought7d)} из ${formatCount(counts.matured7d)}` : "7 дней ещё не прошли",
    },
  ];
  return (
    <Card padding="md">
      <div className="sales-funnel" role="list" aria-label="Воронка возврата">
        {steps.map((step, index) => (
          <Fragment key={step.label}>
            {index > 0 && <ChevronRight size={20} strokeWidth={1.5} aria-hidden className="sales-funnel__arrow" />}
            <div className="sales-funnel__step" role="listitem">
              <span className="sales-funnel__value">{step.value}</span>
              <span className="sales-funnel__label">{step.label}</span>
              <span className="sales-funnel__meta">{step.meta}</span>
            </div>
          </Fragment>
        ))}
        {left > 0 && counts.matured7d > 0 && (
          <div className="sales-funnel__step sales-funnel__step--aside" role="listitem">
            <span className="sales-funnel__value">{formatCount(left)}</span>
            <span className="sales-funnel__label">Ещё зреют</span>
            <span className="sales-funnel__meta">покупку ещё ждём</span>
          </div>
        )}
        {counts.matured30d > 0 && (
          <div className="sales-funnel__step sales-funnel__step--aside" role="listitem">
            <span className="sales-funnel__value"><Money mills={counts.spent30dMills} /></span>
            <span className="sales-funnel__label">Потратили за 30 дней</span>
            <span className="sales-funnel__meta">{formatCount(counts.matured30d)} старше 30 дней</span>
          </div>
        )}
      </div>
      <p className="sales-funnel__note">
        Доли — от тех, кому написали и у кого срок уже прошёл. Остальные «зреют»: их ответ или покупку ещё ждём.
      </p>
    </Card>
  );
}

/** «Ещё зреют» says something only when some have ripened and some not: else it repeats «Написали» or is all zeros. */
function showRipening(lines: readonly WinBackLine[]): boolean {
  return lines.some((line) => line.counts.matured7d > 0) && lines.some((line) => ripening(line.counts) > 0);
}

function lineColumns(lines: readonly WinBackLine[], all: WinBackCounts, options: { kind: "approach" | "chatter"; showSpent: boolean }): Column<WinBackLine>[] {
  const repliedMax = scaleOf(lines.map((line) => (line.counts.matured72h >= SCALE_SAMPLE ? share(replied(line.counts)) : null)).concat(share(replied(all))));
  const boughtMax = scaleOf(lines.map((line) => (line.counts.matured7d >= SCALE_SAMPLE ? share(bought(line.counts)) : null)).concat(share(bought(all))));
  const columns: Column<WinBackLine>[] = [
    {
      key: "name",
      header: options.kind === "approach" ? "Подход" : "Чаттер",
      cell: (line) => (
        <LineName
          kind={line.kind}
          name={line.name}
          quiet={line.active === false}
          {...(line.kind === "approach" && line.active === false ? { hint: "выключен" } : {})}
        />
      ),
      sortValue: (line) => line.name,
      width: options.showSpent ? "24%" : "28%",
    },
    {
      key: "sent",
      header: "Написали",
      numeric: true,
      title: "Чаттер выбрал подход и в 48 часов написал фану",
      cell: (line) => (
        <span className="sales-stack">
          <span>{formatCount(line.counts.sent)}</span>
          {line.counts.attempts > line.counts.sent && <span className="sales-sub">выбрали {formatCount(line.counts.attempts)}</span>}
        </span>
      ),
      sortValue: (line) => line.counts.sent,
      width: "11%",
    },
    {
      key: "replied",
      header: "Ответили за 72 ч",
      cell: (line) => <RateCell rate={replied(line.counts)} min={MIN_SAMPLE.winBack} max={repliedMax} compare={share(replied(all))} quiet={line.active === false} empty="зреет" emptyTitle="72 часа после сообщения ещё не прошли" />,
      sortValue: (line) => (line.counts.matured72h >= MIN_SAMPLE.winBack ? share(replied(line.counts)) : null),
      sortFirst: "desc",
      width: "22%",
    },
    {
      key: "bought",
      header: "Купили за 7 дней",
      cell: (line) => <RateCell rate={bought(line.counts)} min={MIN_SAMPLE.winBack} max={boughtMax} compare={share(bought(all))} quiet={line.active === false} empty="зреет" emptyTitle="7 дней после сообщения ещё не прошли" />,
      sortValue: (line) => (line.counts.matured7d >= MIN_SAMPLE.winBack ? share(bought(line.counts)) : null),
      sortFirst: "desc",
      width: "22%",
    },
    {
      key: "ripening",
      header: "Ещё зреют",
      numeric: true,
      title: "Написали меньше 7 дней назад: покупку ещё ждём",
      cell: (line) => {
        const left = ripening(line.counts);
        return left > 0 ? formatCount(left) : <span className="sales-quiet">0</span>;
      },
      sortValue: (line) => ripening(line.counts),
      width: "10%",
    },
  ];
  // A column whose every cell would say «зреет» says nothing: the funnel and the notice say it once.
  const hidden = new Set<string>();
  if (!showRipening(lines)) hidden.add("ripening");
  if (lines.length > 0 && !lines.some((line) => line.counts.matured72h > 0)) hidden.add("replied");
  if (lines.length > 0 && !lines.some((line) => line.counts.matured7d > 0)) hidden.add("bought");
  for (const key of hidden) columns.splice(columns.findIndex((column) => column.key === key), 1);
  if (options.showSpent) {
    columns.push({
      key: "spent",
      header: "Потратили за 30 дней",
      numeric: true,
      title: "Сколько заплатили фаны, которым написали 30 и больше дней назад, за 30 дней после сообщения",
      cell: (line) => (line.counts.matured30d > 0
        ? <Money mills={line.counts.spent30dMills} />
        : <span className="sales-quiet" title="30 дней после сообщения ещё не прошли">зреет</span>),
      sortValue: (line) => (line.counts.matured30d > 0 ? line.counts.spent30dMills : null),
      width: "13%",
    });
  }
  return columns;
}

function LineDrawer({ line, onClose, windowLabel }: { line: WinBackLine; onClose: () => void; windowLabel: string }) {
  const location = useLocation();
  const partKind = line.kind === "approach" ? "chatter" : "approach";
  const columns = panelColumns(lineColumns(line.parts, line.counts, { kind: partKind, showSpent: false }), { name: "34%", sent: "14%", replied: "26%", bought: "26%" })
    .map((column) => (column.key === "sent" ? { ...column, cell: (part: WinBackLine) => formatCount(part.counts.sent) } : column));
  const r = replied(line.counts);
  const b = bought(line.counts);
  return (
    <Drawer
      open
      onClose={onClose}
      title={line.name}
      subtitle={`Возврат фанов · ${windowLabel}`}
      width={720}
      {...(line.kind === "chatter"
        ? { footer: <LinkButton to={personPath(line.id, location.search)}>Открыть карточку {line.name}</LinkButton> }
        : {})}
    >
      <div className="sales-drawer">
        <p className="sales-drawer__lead">
          Написали {formatCount(line.counts.sent)} {ruPlural(line.counts.sent, "фану", "фанам", "фанам")}
          {r.of > 0 ? `, ответили ${formatPercent((100 * r.hits) / r.of)}` : ""}
          {b.of > 0 ? `, купили ${formatPercent((100 * b.hits) / b.of)}` : ", покупки ещё зреют"}.
          {" "}Чёрточка на полосе — {line.kind === "approach" ? "этот подход у всех чаттеров вместе" : "все подходы этого чаттера вместе"}.
          {line.kind === "approach" && line.active === false ? " Подход выключен: чаттеры его больше не видят, итоги остаются." : ""}
        </p>
        <Table
          label={`${line.name}: ${line.kind === "approach" ? "по чаттерам" : "по подходам"}`}
          columns={columns}
          rows={line.parts}
          rowKey={(part) => part.key}
          defaultSort={{ key: "sent", direction: "desc" }}
          frame="bare"
          stickyHeader={false}
        />
      </div>
    </Drawer>
  );
}

/**
 * The owner's list of approaches: on/off with one press (reversible, no
 * confirmation, as in the console), a new one at the end. The console's logic
 * as it is: apps/dashboard/src/pages/team/TeamWinBackPage.tsx:136-193.
 */
function ApproachesCard({ approaches, loading, failed, onRetry, retrying }: { approaches: readonly Approach[] | undefined; loading: boolean; failed: boolean; onRetry: () => void; retrying: boolean }) {
  const save = useSaveWinBackApproach();
  const [draft, setDraft] = useState("");
  const pendingId = save.isPending ? save.variables?.id ?? "new" : null;

  function submit(body: Parameters<typeof save.mutate>[0], done?: () => void) {
    save.mutate(body, {
      onSuccess: () => done?.(),
      onError: () => toast.error("Не сохранилось: такое название уже есть или Hub не ответил."),
    });
  }

  const on = approaches?.filter((approach) => approach.active).length ?? 0;
  return (
    <Card
      title="Подходы в расширении"
      description="Чаттеры видят включённые, по порядку, на вкладке «Вернуть». Выключенный подход пропадает из расширения, его итоги остаются."
      {...(approaches ? { actions: <span className="sales-quiet">{formatCount(on)} {ruPlural(on, "включён", "включено", "включено")}</span> } : {})}
    >
      {!approaches ? (
        failed ? <NoAnswer onRetry={onRetry} retrying={retrying} /> : loading ? <p className="sales-quiet">Загружаем список…</p> : null
      ) : (
        <ol className="sales-approaches">
          {approaches.map((approach, index) => (
            <li key={approach.id} className="sales-approaches__row">
              <span className="sales-approaches__index">{index + 1}</span>
              <span className={approach.active ? "sales-approaches__label" : "sales-approaches__label sales-approaches__label--off"}>{approach.label}</span>
              {!approach.active && <Badge tone="off">Выключен</Badge>}
              <Button
                size="sm"
                variant="secondary"
                className="sales-approaches__action"
                loading={pendingId === approach.id}
                disabled={save.isPending}
                onClick={() => submit({ id: approach.id, label: approach.label, sortOrder: approach.sortOrder, active: !approach.active })}
              >
                {pendingId === approach.id ? "Сохраняем…" : approach.active ? "Выключить" : "Включить"}
              </Button>
            </li>
          ))}
        </ol>
      )}
      <form
        className="sales-approaches__add"
        onSubmit={(event) => {
          event.preventDefault();
          const label = draft.trim();
          // The order is the list's length + 1: no adding before the list is in.
          if (label === "" || !approaches) return;
          submit({ label, sortOrder: approaches.length + 1, active: true }, () => setDraft(""));
        }}
      >
        <TextInput
          aria-label="Новый подход"
          placeholder="Новый подход, например «Голосовое с именем»"
          maxLength={80}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="primary" loading={pendingId === "new"} disabled={save.isPending || draft.trim() === "" || !approaches}>
          {pendingId === "new" ? "Добавляем…" : "Добавить"}
        </Button>
      </form>
    </Card>
  );
}

export function WinBackTab() {
  const { period, today, setPeriod } = usePeriod();
  const { page } = usePageFilter();
  const { isOwner } = useMe();
  const { by, open, setBy, setOpen } = useSalesParams();
  const window = readWindow(period, today, MAX_DAYS.winBack);
  const query = useWinBackResults(window.days);
  const approaches = useWinBackApproaches(isOwner);
  const view = useMemo(
    () => (query.data ? winBackView(query.data.rows, approaches.data?.approaches, query.data) : null),
    [query.data, approaches.data],
  );
  const cut = by === "chatters" ? "chatter" : "approach";
  const lines = view ? (cut === "approach" ? view.approaches : view.chatters) : [];
  const openLine = view ? [...view.approaches, ...view.chatters].find((line) => line.key === open) ?? null : null;
  const label = view ? windowWords(view.from, view.to) : "";
  const showSpent = view ? view.all.matured30d > 0 : false;
  const noneMatured7d = view !== null && view.all.sent > 0 && view.all.matured7d === 0;

  let body;
  if (!view) {
    body = query.isError
      ? <NoAnswer onRetry={() => void query.refetch()} retrying={query.isFetching} />
      : (
        <Section title="По подходам">
          <Table label="Итоги по подходам" columns={lineColumns([], { attempts: 0, sent: 0, matured72h: 0, replied72h: 0, matured7d: 0, bought7d: 0, matured30d: 0, spent30dMills: 0 }, { kind: "approach", showSpent: false })} rows={[]} rowKey={(line) => line.key} loading skeletonRows={5} />
        </Section>
      );
  } else if (view.all.attempts === 0) {
    body = (
      <EmptyState title={`За ${label} подходы не выбирали`}>
        Как только чаттеры начнут выбирать подход на вкладке «Вернуть» в расширении, здесь появятся итоги.
      </EmptyState>
    );
  } else {
    body = (
      <>
        {noneMatured7d && (
          <Notice
            title="Покупки ещё зреют"
            action={<Button size="sm" onClick={() => setPeriod({ kind: "days", days: 30 })}>Показать 30 дней</Button>}
          >
            Покупку считаем через 7 дней после сообщения, а с сообщений этого периода неделя ещё не прошла.
          </Notice>
        )}
        <Funnel counts={view.all} chatters={view.chatters.length} />
        <Section
          title={cut === "approach" ? "По подходам" : "По чаттерам"}
          description={cut === "approach"
            ? "Нажмите на строку — этот подход по чаттерам. Чёрточка на полосе — все подходы вместе."
            : "Кто пользуется «Вернуть» и что у него выходит. Нажмите на строку — подходы этого чаттера."}
          actions={(
            <Segmented<"approach" | "chatter">
              label="Как разбить"
              value={cut}
              onChange={(value) => setBy(value === "chatter" ? "chatters" : "pages")}
              options={[{ value: "approach", label: "По подходам" }, { value: "chatter", label: "По чаттерам" }]}
            />
          )}
        >
          <Table
            label={cut === "approach" ? "Итоги по подходам" : "Итоги по чаттерам"}
            columns={lineColumns(lines, view.all, { kind: cut, showSpent })}
            rows={lines}
            rowKey={(line) => line.key}
            onRowClick={(line) => setOpen(line.key)}
            selectedKey={openLine?.key ?? null}
            rowQuiet={(line) => line.active === false}
            defaultSort={{ key: "sent", direction: "desc" }}
            refreshing={query.isPlaceholderData}
          />
          {!showSpent && !noneMatured7d && (
            <div className="sales-after">
              <span>«Потратили за 30 дней» появится у попыток старше 30 дней — в этом периоде таких нет.</span>
              <Button size="sm" variant="ghost" onClick={() => setPeriod({ kind: "range", from: addDays(today, -(MAX_DAYS.winBack - 1)), to: today })}>Показать 90 дней</Button>
            </div>
          )}
        </Section>
      </>
    );
  }

  return (
    <>
      <SalesHeader
        meta={view
          ? `Подходы, выбранные ${label} · все страницы${page ? `: Hub пока не делит возврат по страницам` : ""}`
          : "Подходы «Вернуть»"}
        updatedAt={query.dataUpdatedAt}
        onRefresh={() => {
          void query.refetch();
          if (isOwner) void approaches.refetch();
        }}
        refreshing={query.isFetching}
      />
      <div className="wb-content">
        <WindowNotice window={window} maxDays={MAX_DAYS.winBack} {...(label ? { shown: label } : {})} />
        {body}
        {isOwner && (
          <ApproachesCard
            approaches={approaches.data?.approaches}
            loading={approaches.isLoading}
            failed={approaches.isError}
            onRetry={() => void approaches.refetch()}
            retrying={approaches.isFetching}
          />
        )}
        <HowItCounts>
          <p>Подход — то, что чаттер выбирает на вкладке «Вернуть» в расширении, когда пишет молчащему фану.</p>
          <p>
            Чаттер выбирает подход одним касанием и пишет фану сам. Hub записывает выбор и считает, что было после первого
            сообщения этого чаттера фану (в течение 48 часов после выбора). «Написали» — основа воронки: выбрал, но не написал —
            не в счёте.
          </p>
          <p>
            «Ответили» — фан написал в течение 72 часов; «Купили» — заплатил в течение 7 дней; «Потратили» — сколько за 30 дней.
            Итог считается, только когда его срок прошёл: «3 из 5» — из пяти созревших. Пока срок не прошёл, попытка «зреет».
            Меньше 10 созревших — слишком мало, чтобы судить: такие строки бледнее.
          </p>
          <p>Возврат считается по всем страницам сразу. Hub не назначает подходы и не засчитывает продажи: только записывает и считает.</p>
        </HowItCounts>
      </div>
      {openLine && view && <LineDrawer line={openLine} onClose={() => setOpen(null)} windowLabel={label} />}
    </>
  );
}
