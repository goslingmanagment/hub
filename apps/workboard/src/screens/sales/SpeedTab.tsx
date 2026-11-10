import { useMemo } from "react";
import { useLocation } from "react-router";
import { Button, Drawer, EmptyState, LinkButton, Mark, RateBar, Section, Table, Tooltip, type Column } from "@agency_hub_core/ui";
import { formatCount, formatOf, formatPercent } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { personPath, useBackState } from "@/shared/links";
import { usePageFilter } from "@/shared/usePageFilter";
import { usePeriod } from "@/shared/usePeriod";
import {
  FAST,
  MAX_DAYS,
  MIN_SAMPLE,
  REPLY_NORM_MINUTES,
  SLOW,
  readWindow,
  repliesIn,
  share,
  speedView,
  useSalesReplies,
  type ReplyCell,
  type ReplyLine,
} from "./data";
import { BACK_LABEL, barWidth, BeyondReach, BySwitch, Folds, HowItCounts, LineName, NoAnswer, SalesHeader, WindowNotice, openColumn, panelColumns, skeletonColumns, useSalesParams, windowWords } from "./parts";

/**
 * Скорость ответа: how fast the pages answered a fan and whether the fan
 * bought within a day after — for the team, then page by page or chatter by
 * chatter (`chatters[]` of the same answer). A share's bar runs from 0 to 100 %.
 */

const boughtRate = (counts: { replies: number; bought: number }) => ({ hits: counts.bought, of: counts.replies });

/** The shape of a line before anything is read: for the skeleton's columns. */
const EMPTY_LINE: ReplyLine = { key: "all", kind: "page", name: "", userId: null, total: { replies: 0, bought: 0 }, byDelay: [] };

const BOUGHT_HINT = "После скольких ответов фан что-то купил в следующие 24 часа: чаевые, сообщение, пост или стрим";

/** «После ответа до 5 минут фан покупал в 17 % случаев, через час и дольше — в 4 %»: only with enough replies on both sides. */
function contrastOf(line: ReplyLine): string | null {
  const fast = repliesIn(line, FAST);
  const slow = repliesIn(line, SLOW);
  if (fast.replies < MIN_SAMPLE.replies || slow.replies < MIN_SAMPLE.replies) return null;
  return `После ответа до 5 минут фан покупал за сутки в ${formatPercent((100 * fast.bought) / fast.replies)} случаев, после ответа через час и дольше — в ${formatPercent((100 * slow.bought) / slow.replies)}.`;
}

function delayColumns(line: ReplyLine, compare?: ReplyLine, compareLabel = "все вместе"): Column<ReplyCell>[] {
  const total = line.total.replies;
  const teamTotal = compare?.total.replies ?? 0;
  const teamOf = (bucket: string) => compare?.byDelay.find((cell) => cell.bucket === bucket);
  return [
    { key: "delay", header: "Ответили через", cell: (cell) => <span className="sales-name__main">{cell.label}</span>, grow: true },
    { key: "replies", header: "Ответов", numeric: true, cell: (cell) => formatCount(cell.replies) },
    {
      key: "share",
      header: "Доля ответов",
      cell: (cell) => {
        const team = teamOf(cell.bucket);
        return <RateBar hits={cell.replies} of={total} min={0} compare={team && teamTotal > 0 ? team.replies / teamTotal : null} compareLabel={compareLabel} />;
      },
      width: barWidth(36, 480),
      className: "sales-bar-col",
    },
    {
      key: "bought",
      header: "Купили за сутки",
      hint: BOUGHT_HINT,
      cell: (cell) => {
        const team = teamOf(cell.bucket);
        return <RateBar {...boughtRate(cell)} min={MIN_SAMPLE.replies} compare={team ? share(boughtRate(team)) : null} compareLabel={compareLabel} />;
      },
      width: barWidth(36, 480),
      className: "sales-bar-col",
    },
  ];
}

function TeamSpeed({ line, onAllPages }: { line: ReplyLine; onAllPages: (() => void) | null }) {
  const columns = delayColumns(line).map((column): Column<ReplyCell> => {
    switch (column.key) {
      case "delay":
        return { ...column, footer: <span className="sales-total">Всего</span> };
      case "replies":
        return { ...column, footer: <span className="sales-total-num">{formatCount(line.total.replies)}</span> };
      case "bought":
        return { ...column, footer: <RateBar value={null} empty={line.total.replies > 0 ? formatPercent((100 * line.total.bought) / line.total.replies) : "—"} className="sales-total-rate" /> };
      default:
        return column;
    }
  });
  const contrast = contrastOf(line);
  return (
    <Section title={onAllPages ? `Как быстро отвечали на ${line.name} и покупали ли после` : "Как быстро отвечали и покупали ли после"} description={contrast ?? "Доля ответов, после которых фан купил что-нибудь за 24 часа."}>
      <Table label="Ответы по скорости" columns={columns} rows={line.byDelay} rowKey={(cell) => cell.bucket} stickyHeader={false} />
      {onAllPages && (
        <div className="sales-after">
          <Button size="sm" variant="ghost" onClick={onAllPages}>Сравнить с другими страницами</Button>
        </div>
      )}
    </Section>
  );
}

function slowShare(line: ReplyLine): number | null {
  return line.total.replies > 0 ? repliesIn(line, SLOW).replies / line.total.replies : null;
}

function lineColumns(all: ReplyLine, by: "pages" | "chatters"): Column<ReplyLine>[] {
  const fastOf = (line: ReplyLine) => ({ hits: repliesIn(line, FAST).replies, of: line.total.replies });
  const teamFast = share(fastOf(all));
  const teamSlow = slowShare(all);
  const teamBought = share(boughtRate(all.total));
  const together = by === "pages" ? "все страницы" : "вся команда";
  return [
    { key: "name", header: by === "pages" ? "Страница" : "Чаттер", cell: (line) => <LineName kind={line.kind} name={line.name} />, sortValue: (line) => line.name, grow: true },
    { key: "replies", header: "Ответов", numeric: true, cell: (line) => formatCount(line.total.replies), sortValue: (line) => line.total.replies },
    {
      key: "fast",
      header: "Быстрее 5 мин",
      hint: `Доля ответов быстрее 5 минут. Черта — ${together}. Ваша норма — ${REPLY_NORM_MINUTES.from}–${REPLY_NORM_MINUTES.to} минут, но Hub пока делит ответы только на «до 5 мин» и «5–15 мин»`,
      cell: (line) => <RateBar {...fastOf(line)} min={MIN_SAMPLE.replies} compare={teamFast} compareLabel={together} />,
      sortValue: (line) => (line.total.replies >= MIN_SAMPLE.replies ? share(fastOf(line)) : null),
      sortFirst: "desc",
      width: barWidth(28, 440),
      className: "sales-bar-col",
    },
    {
      key: "slow",
      header: "Дольше часа",
      numeric: true,
      cell: (line) => {
        const value = slowShare(line);
        if (value === null) return <span className="sales-quiet">—</span>;
        const text = formatPercent(value * 100);
        if (line.total.replies < MIN_SAMPLE.replies) return <Tooltip content="Мало ответов, чтобы судить"><span className="sales-quiet">{text}</span></Tooltip>;
        const outlier = teamSlow !== null && value >= teamSlow + 0.1;
        return outlier ? <Mark hint={`У ${by === "pages" ? "всех страниц" : "команды"} — ${formatPercent(teamSlow * 100)}`}>{text}</Mark> : text;
      },
      sortValue: (line) => (line.total.replies >= MIN_SAMPLE.replies ? slowShare(line) : null),
    },
    {
      key: "bought",
      header: "Купили за сутки",
      hint: `${BOUGHT_HINT}. Черта — ${together}`,
      cell: (line) => <RateBar {...boughtRate(line.total)} min={MIN_SAMPLE.replies} compare={teamBought} compareLabel={together} />,
      sortValue: (line) => (line.total.replies >= MIN_SAMPLE.replies ? share(boughtRate(line.total)) : null),
      sortFirst: "desc",
      width: barWidth(28, 440),
      className: "sales-bar-col",
    },
    openColumn<ReplyLine>(),
  ];
}

function LineDrawer({ line, all, onClose, windowLabel }: { line: ReplyLine; all: ReplyLine; onClose: () => void; windowLabel: string }) {
  const location = useLocation();
  const back = useBackState(BACK_LABEL);
  const contrast = contrastOf(line);
  const together = line.kind === "chatter" ? "вся команда" : "все страницы";
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={line.name}
      subtitle={`Скорость ответа · ${windowLabel}`}
      {...(line.userId !== null
        ? { footer: <LinkButton to={personPath(line.userId, location.search, "sales")} state={back}>Открыть карточку {line.name}</LinkButton> }
        : {})}
    >
      <div className="sales-drawer">
        <p className="sales-drawer__lead">
          {formatCount(line.total.replies)} {ruPlural(line.total.replies, "ответ", "ответа", "ответов")}; фан покупал за сутки после{" "}
          {line.total.replies >= MIN_SAMPLE.replies ? formatPercent((100 * line.total.bought) / line.total.replies) : formatOf(line.total.bought, line.total.replies)} из них.
          {contrast ? ` ${contrast}` : line.total.replies < MIN_SAMPLE.replies ? " Мало, чтобы судить." : ""}
        </p>
        <Table
          label={`${line.name}: ответы по скорости`}
          columns={panelColumns(delayColumns(line, all, together), { delay: "24%", replies: "14%", share: "31%", bought: "31%" }, { nowrapFirst: true })}
          rows={line.byDelay}
          rowKey={(cell) => cell.bucket}
          stickyHeader={false}
          fit={false}
        />
        <p className="sales-sub">Черта на полосе — {together}.</p>
      </div>
    </Drawer>
  );
}

export function SpeedTab() {
  const { period, today } = usePeriod();
  const { page, setPage } = usePageFilter();
  const { by, open, setBy, setOpen } = useSalesParams();
  const window = readWindow(period, today, MAX_DAYS.sales);
  const query = useSalesReplies(window);
  const view = useMemo(() => (query.data ? speedView(query.data, page) : null), [query.data, page]);
  const lines = view ? (by === "pages" ? view.pages : view.chatters) : [];
  const openLine = view ? [...view.pages, ...view.chatters].find((line) => line.key === open) ?? null : null;
  const label = view ? windowWords(view.from, view.to) : "";
  // The replies of the last 24 hours wait for their day: the line under the title says so only when they belong to the period.
  const lastDayOut = view !== null && window.to === today;

  let body;
  if (window.beyond) {
    body = <BeyondReach maxDays={MAX_DAYS.sales} />;
  } else if (!view) {
    body = query.isError
      ? <NoAnswer onRetry={() => void query.refetch()} retrying={query.isFetching} />
      : (
        <>
          <Section title="Как быстро отвечали и покупали ли после" description="Считаем ответы и покупки после них…">
            <Table label="Ответы по скорости" columns={delayColumns(EMPTY_LINE)} rows={[]} rowKey={(cell) => cell.bucket} fit={false} loading skeletonRows={6} stickyHeader={false} />
          </Section>
          {page === null && (
            <Section title={by === "pages" ? "По страницам" : "По чаттерам"} actions={<BySwitch value={by} onChange={setBy} />}>
              <Table label="Скорость ответа по страницам" columns={skeletonColumns(lineColumns(EMPTY_LINE, by))} rows={[]} rowKey={(line) => line.key} fit={false} loading skeletonRows={6} />
            </Section>
          )}
        </>
      );
  } else if (view.all.total.replies === 0) {
    body = (
      <EmptyState
        title={page ? `На ${page} за ${label} ответов не было` : `За ${label} ответов не было`}
        action={page ? <Button onClick={() => setPage(null)}>Показать все страницы</Button> : undefined}
      >
        Ответы последних суток ещё не считаются: у них не прошли 24 часа на покупку.
      </EmptyState>
    );
  } else {
    body = (
      <>
        <TeamSpeed line={view.all} onAllPages={page !== null ? () => setPage(null) : null} />
        {page === null && (
          <Section
            title={by === "pages" ? "По страницам" : "По чаттерам"}
            {...(by === "chatters" ? { description: "Только ответы, у которых Hub знает автора." } : {})}
            actions={<BySwitch value={by} onChange={setBy} />}
          >
            <Table
              label={by === "pages" ? "Скорость ответа по страницам" : "Скорость ответа по чаттерам"}
              columns={lineColumns(view.all, by)}
              rows={lines}
              rowKey={(line) => line.key}
              onRowClick={(line) => setOpen(line.key)}
              selectedKey={openLine?.key ?? null}
              defaultSort={{ key: "replies", direction: "desc" }}
              refreshing={query.isPlaceholderData}
              empty={<EmptyState compact title={by === "pages" ? "Ответов по страницам нет" : "Ответов с известным автором нет"}>За эти дни Hub не нашёл таких ответов.</EmptyState>}
            />
          </Section>
        )}
      </>
    );
  }

  return (
    <>
      <SalesHeader
        {...(lastDayOut ? { meta: `Ответы ${label}: последние сутки ещё не считаются` } : {})}
        updatedAt={query.dataUpdatedAt}
        stale={query.isRefetchError}
        onRefresh={() => void query.refetch()}
        refreshing={query.isFetching}
      />
      <div className="wb-content">
        <WindowNotice window={window} maxDays={MAX_DAYS.sales} {...(label ? { shown: label } : {})} />
        {body}
        <Folds>
          <HowItCounts>
            <p>
              Ответ — первое личное сообщение страницы после сообщений фана; время ответа считается от первого из них. Кто ждал
              больше 3 суток, не считается.
            </p>
            <p>
              Купил — чаевые или покупка сообщения, поста или стрима этим фаном на этой странице в 24 часа после ответа;
              продление подписки не считается. Поэтому ответы последних суток ещё не считаются: у них не прошли 24 часа.
            </p>
            <p>
              Ваша норма ответа — {REPLY_NORM_MINUTES.from}–{REPLY_NORM_MINUTES.to} минут, как в «Разборе смены». Hub пока делит
              ответы на «до 5 мин» и «5–15 мин», поэтому граница нормы, 10 минут, лежит внутри второй строки, а сравнение по
              чаттерам — «быстрее 5 минут». «Дольше часа» отмечено, когда у страницы или чаттера таких ответов заметно больше,
              чем у всех вместе.
            </p>
            <p>
              Меньше {MIN_SAMPLE.replies} ответов — слишком мало, чтобы судить: такие строки бледнее и показаны как «3 из 12».
              Полоса доли — от 0 до 100 %; черта на полосе — все страницы (или вся команда) вместе. По чаттерам — только ответы,
              у которых Hub знает автора. Это ориентир, а не основание для оплаты.
            </p>
          </HowItCounts>
        </Folds>
      </div>
      {openLine && view && <LineDrawer line={openLine} all={view.all} onClose={() => setOpen(null)} windowLabel={label} />}
    </>
  );
}
