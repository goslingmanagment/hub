import { Fragment, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { TeamSalesPpvResponse, TeamSalesRepliesResponse } from "@agency_hub_core/contracts";
import { useTeamSalesPpv, useTeamSalesReplies } from "@/api/team-sales";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatMills } from "@/lib/format";

/**
 * Chat Memory week 6 «Продажи» (week-6.md): A — PPV conversion by page, chatter
 * and price (`teamSalesPpv`); B — how fast the page answered against whether
 * the fan bought within 24 hours (`teamSalesReplies`). Read-only; the owner and
 * team leads. A guide, not a basis for pay.
 */

const RANGES = [
  { key: "7", label: "7 дней" },
  { key: "30", label: "30 дней" },
] as const;

const PRICE_LABELS: Record<string, string> = {
  upTo10: "до $10",
  "10to25": "$10–25",
  "25to50": "$25–50",
  "50to100": "$50–100",
  over100: "$100+",
};

const DELAY_LABELS: Record<string, string> = {
  under5m: "до 5 мин",
  "5to15m": "5–15 мин",
  "15to60m": "15–60 мин",
  "1to6h": "1–6 ч",
  over6h: "6 ч и дольше",
};

const HOW_IT_WORKS = [
  "PPV — личное платное сообщение: без рассылок Fansly и без одинакового текста, ушедшего пяти и больше фанам за час "
    + "(так выглядят рассылки OnlyMonster).",
  "Куплено — Fansly отметил покупку, на OnlyFans у сообщения есть время покупки. Сумма — net: на Fansly из статистики "
    + "продаж PPV, на OnlyFans — транзакция покупки этого фана в пределах 3 минут. Свежие PPV ещё могут купить, поэтому "
    + "последние дни занижают конверсию.",
  "Первый PPV — первый платный PPV в чате, который знает Hub: если история чата загружена не целиком, первым может "
    + "оказаться не самый первый.",
  "Ответ — первое личное сообщение страницы после сообщений фана; время ответа считается от первого из них (кто ждал "
    + "больше 3 суток, не считается). Купил — чаевые или покупка сообщения, поста или стрима этим фаном на этой странице "
    + "в 24 часа после ответа; продление подписки не считается. Ответы последних суток ещё не считаются.",
  "По чаттерам — только сообщения, у которых Hub знает автора (расширение 0.9.0 и новее).",
];

const HEAD = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const NUM_HEAD = "whitespace-nowrap px-3 py-2 text-right text-xs font-medium text-text-muted xl:px-4";
const CELL = "whitespace-nowrap px-3 py-2 align-top text-text-primary xl:px-4";
const NUM = "whitespace-nowrap px-3 py-2 align-top text-right tabular-nums text-text-secondary xl:px-4";
const STRONG = `${NUM} font-medium text-text-primary`;

type PpvCounts = TeamSalesPpvResponse["pages"][number]["total"];
type ByPrice = TeamSalesPpvResponse["pages"][number]["byPrice"];
type ReplyCounts = TeamSalesRepliesResponse["pages"][number]["total"];
type ByDelay = TeamSalesRepliesResponse["pages"][number]["byDelay"];

function percentOf(part: number, whole: number): string {
  return `${Math.round((100 * part) / whole)} %`;
}

/** "12 / 40 · 30 %" — bought of sent and the conversion; "—" with nothing sent. */
export function conversionOf(counts: Pick<PpvCounts, "sent" | "bought">): string {
  return counts.sent === 0 ? "—" : `${counts.bought} / ${counts.sent} · ${percentOf(counts.bought, counts.sent)}`;
}

function PpvCell({ counts, strong }: { counts: PpvCounts; strong: boolean }) {
  return (
    <td className={strong ? STRONG : NUM}>
      {conversionOf(counts)}
      {counts.bought > 0 && <span className="block text-xs font-normal text-text-muted">{formatMills(counts.netMills)}</span>}
    </td>
  );
}

function ReplyCell({ counts, strong }: { counts: ReplyCounts; strong: boolean }) {
  if (counts.replies === 0) return <td className={strong ? STRONG : NUM}>—</td>;
  return (
    <td className={strong ? STRONG : NUM}>
      {percentOf(counts.bought, counts.replies)}
      <span className="block text-xs font-normal text-text-muted">{counts.bought} из {counts.replies}</span>
    </td>
  );
}

interface MatrixRow<T> {
  key: string | number;
  label: ReactNode;
  cells: readonly T[];
  total: T;
}

function Matrix<T>({ title, note, columns, rows, cell }: {
  title: string;
  note?: string;
  columns: readonly string[];
  rows: readonly MatrixRow<T>[];
  cell: (counts: T, strong: boolean) => ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      {note && <p className="max-w-3xl text-sm text-text-secondary">{note}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className={HEAD}>&nbsp;</th>
              {columns.map((column) => <th key={column} className={NUM_HEAD}>{column}</th>)}
              <th className={NUM_HEAD}>Всего</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-border last:border-b-0">
                <td className={CELL}>{row.label}</td>
                {row.cells.map((counts, index) => <Fragment key={columns[index] ?? index}>{cell(counts, false)}</Fragment>)}
                {cell(row.total, true)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ppvTotalOf(byPrice: ByPrice): PpvCounts {
  return byPrice.reduce((total, cell) => ({
    sent: total.sent + cell.sent, bought: total.bought + cell.bought, netMills: total.netMills + cell.netMills,
  }), { sent: 0, bought: 0, netMills: 0 });
}

function PpvBlock({ data }: { data: TeamSalesPpvResponse }) {
  if (data.pages.length === 0) {
    return <StatusPanel title="PPV не было" description="За это время страницы не отправили ни одного личного PPV." />;
  }
  const columns = (data.pages[0]?.byPrice ?? []).map((cell) => PRICE_LABELS[cell.bucket] ?? cell.bucket);
  const ppvCell = (counts: PpvCounts, strong: boolean) => <PpvCell counts={counts} strong={strong} />;
  return (
    <div className="flex flex-col gap-5">
      <Matrix
        title="По страницам: куплено / отправлено · конверсия, net"
        columns={columns}
        cell={ppvCell}
        rows={data.pages.map((page) => ({
          key: page.pageLabel,
          label: (
            <>
              {page.pageLabel}
              {page.withoutAuthor > 0 && <span className="block text-xs text-text-muted">без автора: {page.withoutAuthor}</span>}
            </>
          ),
          cells: page.byPrice,
          total: page.total,
        }))}
      />
      <Matrix
        title="Первый PPV в чате"
        note="Купил ли фан свой первый PPV — по цене этого PPV."
        columns={columns}
        cell={ppvCell}
        rows={data.pages.map((page) => ({ key: page.pageLabel, label: page.pageLabel, cells: page.firstPpv, total: ppvTotalOf(page.firstPpv) }))}
      />
      {data.chatters.length === 0
        ? <StatusPanel title="PPV с автором нет" description="За это время никто не отправил PPV из расширения под своим входом." />
        : (
          <Matrix
            title="По чаттерам"
            note="Только PPV, у которых Hub знает автора."
            columns={columns}
            cell={ppvCell}
            rows={data.chatters.map((chatter) => ({ key: chatter.userId, label: chatter.username, cells: chatter.byPrice, total: chatter.total }))}
          />
        )}
    </div>
  );
}

function sumByDelay(tables: readonly ByDelay[]): ByDelay {
  return (tables[0] ?? []).map((cell, index) => ({
    bucket: cell.bucket,
    replies: tables.reduce((sum, table) => sum + (table[index]?.replies ?? 0), 0),
    bought: tables.reduce((sum, table) => sum + (table[index]?.bought ?? 0), 0),
  }));
}

function RepliesBlock({ data }: { data: TeamSalesRepliesResponse }) {
  if (data.pages.length === 0) {
    return <StatusPanel title="Ответов нет" description="За это время страницы не ответили ни одному фану (ответы последних суток ещё не считаются)." />;
  }
  const columns = (data.pages[0]?.byDelay ?? []).map((cell) => DELAY_LABELS[cell.bucket] ?? cell.bucket);
  const replyCell = (counts: ReplyCounts, strong: boolean) => <ReplyCell counts={counts} strong={strong} />;
  const all = sumByDelay(data.pages.map((page) => page.byDelay));
  const allTotal = all.reduce((total, cell) => ({ replies: total.replies + cell.replies, bought: total.bought + cell.bought }), { replies: 0, bought: 0 });
  return (
    <div className="flex flex-col gap-5">
      <Matrix
        title="По страницам: доля ответов, после которых фан купил за 24 часа"
        columns={columns}
        cell={replyCell}
        rows={[
          ...(data.pages.length > 1 ? [{ key: "all", label: <span className="font-medium">Все страницы</span>, cells: all, total: allTotal }] : []),
          ...data.pages.map((page) => ({ key: page.pageLabel, label: page.pageLabel, cells: page.byDelay, total: page.total })),
        ]}
      />
      {data.chatters.length === 0
        ? <StatusPanel title="Ответов с автором нет" description="За это время никто не ответил фану из расширения под своим входом." />
        : (
          <Matrix
            title="По чаттерам"
            note="Только ответы, у которых Hub знает автора."
            columns={columns}
            cell={replyCell}
            rows={data.chatters.map((chatter) => ({ key: chatter.userId, label: chatter.username, cells: chatter.byDelay, total: chatter.total }))}
          />
        )}
    </div>
  );
}

function Loaded<T>({ query, columns, children }: {
  query: { data: T | undefined; isLoading: boolean; isFetching: boolean; refetch: () => unknown };
  columns: number;
  children: (data: T) => ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isLoading) return <TableSkeleton rows={6} columns={columns} />;
  return (
    <StatusPanel
      title="Цифры не загрузились"
      description="Hub не ответил. Попробуйте ещё раз."
      tone="error"
      action={<button type="button" onClick={() => void query.refetch()} disabled={query.isFetching} className="btn btn-sm">Повторить</button>}
    />
  );
}

export function TeamSalesPage() {
  const [search, setSearch] = useSearchParams();
  const range = RANGES.some((item) => item.key === search.get("days")) ? search.get("days")! : "30";
  const ppv = useTeamSalesPpv(Number(range));
  const replies = useTeamSalesReplies(Number(range));

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="max-w-3xl text-sm text-text-secondary">
          Как продают PPV и как скорость ответа связана с покупками: по страницам и чаттерам. Это ориентир, а не основание
          для оплаты.
        </p>
        <details className="help mt-1">
          <summary>Как это считается</summary>
          <div className="help-body">
            {HOW_IT_WORKS.map((line) => <p key={line}>{line}</p>)}
          </div>
        </details>
        <div className="mt-4">
          <FilterButtons
            filters={RANGES.map(({ key, label }) => ({ key, label }))}
            active={range}
            onChange={(key) => setSearch((current) => {
              const next = new URLSearchParams(current);
              next.set("days", key);
              return next;
            })}
          />
        </div>
      </div>
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-text-primary">PPV: конверсия по цене</h2>
        <Loaded query={ppv} columns={7}>{(data) => <PpvBlock data={data} />}</Loaded>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-text-primary">Скорость ответа и покупки</h2>
        <Loaded query={replies} columns={7}>{(data) => <RepliesBlock data={data} />}</Loaded>
      </section>
    </div>
  );
}
