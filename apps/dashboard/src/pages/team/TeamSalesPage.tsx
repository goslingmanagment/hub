import type { ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { TeamSalesPpvResponse } from "@agency_hub_core/contracts";
import { useTeamSalesPpv } from "@/api/team-sales";
import { FilterButtons } from "@/components/shared/FilterButtons";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { TableSkeleton } from "@/components/shared/TableSkeleton";
import { formatMills } from "@/lib/format";

/**
 * Chat Memory week 6 «Продажи» (week-6.md): A — PPV conversion by page, chatter
 * and price (`teamSalesPpv`). Read-only; the owner and team leads. A guide, not
 * a basis for pay.
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

const HOW_IT_WORKS = [
  "PPV — личное платное сообщение: без рассылок Fansly и без одинакового текста, ушедшего пяти и больше фанам за час "
    + "(так выглядят рассылки OnlyMonster).",
  "Куплено — Fansly отметил покупку, на OnlyFans у сообщения есть время покупки. Сумма — net: на Fansly из статистики "
    + "продаж PPV, на OnlyFans — транзакция покупки этого фана в пределах 3 минут.",
  "По чаттерам — только PPV, у которых Hub знает автора (расширение 0.9.0 и новее). Свежие PPV ещё могут купить, "
    + "поэтому последние дни занижают конверсию.",
  "Первый PPV — первый платный PPV в чате, который знает Hub: если история чата загружена не целиком, первым может "
    + "оказаться не самый первый.",
];

const HEAD = "whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-text-muted xl:px-4";
const NUM_HEAD = "whitespace-nowrap px-3 py-2 text-right text-xs font-medium text-text-muted xl:px-4";
const CELL = "whitespace-nowrap px-3 py-2 align-top text-text-primary xl:px-4";
const NUM = "whitespace-nowrap px-3 py-2 align-top text-right tabular-nums text-text-secondary xl:px-4";

type Counts = TeamSalesPpvResponse["pages"][number]["total"];
type ByPrice = TeamSalesPpvResponse["pages"][number]["byPrice"];

/** "12 / 40 · 30 %" — bought of sent and the conversion; "—" with nothing sent. */
export function conversionOf(counts: Pick<Counts, "sent" | "bought">): string {
  if (counts.sent === 0) return "—";
  return `${counts.bought} / ${counts.sent} · ${Math.round((100 * counts.bought) / counts.sent)} %`;
}

function CountsCell({ counts, strong }: { counts: Counts; strong?: boolean }) {
  return (
    <td className={strong ? `${NUM} font-medium text-text-primary` : NUM}>
      {conversionOf(counts)}
      {counts.bought > 0 && <span className="block text-xs text-text-muted">{formatMills(counts.netMills)}</span>}
    </td>
  );
}

interface MatrixRow {
  key: string | number;
  label: ReactNode;
  byPrice: ByPrice;
  total: Counts;
}

function PriceMatrix({ title, note, rows }: { title: string; note?: string; rows: MatrixRow[] }) {
  const buckets = rows[0]?.byPrice.map((cell) => cell.bucket) ?? [];
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      {note && <p className="max-w-3xl text-sm text-text-secondary">{note}</p>}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className={HEAD}>&nbsp;</th>
              {buckets.map((bucket) => <th key={bucket} className={NUM_HEAD}>{PRICE_LABELS[bucket] ?? bucket}</th>)}
              <th className={NUM_HEAD}>Всего</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-border last:border-b-0">
                <td className={CELL}>{row.label}</td>
                {row.byPrice.map((cell) => <CountsCell key={cell.bucket} counts={cell} />)}
                <CountsCell counts={row.total} strong />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function sumOf(byPrice: ByPrice): Counts {
  return byPrice.reduce((total, cell) => ({
    sent: total.sent + cell.sent, bought: total.bought + cell.bought, netMills: total.netMills + cell.netMills,
  }), { sent: 0, bought: 0, netMills: 0 });
}

function PpvBlock({ data }: { data: TeamSalesPpvResponse }) {
  if (data.pages.length === 0) {
    return <StatusPanel title="PPV не было" description="За это время страницы не отправили ни одного личного PPV." />;
  }
  return (
    <div className="flex flex-col gap-6">
      <PriceMatrix
        title="PPV по страницам: куплено / отправлено · конверсия, net"
        rows={data.pages.map((page) => ({
          key: page.pageLabel,
          label: (
            <>
              {page.pageLabel}
              {page.withoutAuthor > 0 && <span className="block text-xs text-text-muted">без автора: {page.withoutAuthor}</span>}
            </>
          ),
          byPrice: page.byPrice,
          total: page.total,
        }))}
      />
      <PriceMatrix
        title="Первый PPV в чате"
        note="Купил ли фан свой первый PPV — по цене этого PPV."
        rows={data.pages.map((page) => ({ key: page.pageLabel, label: page.pageLabel, byPrice: page.firstPpv, total: sumOf(page.firstPpv) }))}
      />
      {data.chatters.length === 0
        ? <StatusPanel title="PPV с автором нет" description="За это время никто не отправил PPV из расширения под своим входом." />
        : (
          <PriceMatrix
            title="PPV по чаттерам"
            note="Только PPV, у которых Hub знает автора."
            rows={data.chatters.map((chatter) => ({ key: chatter.userId, label: chatter.username, byPrice: chatter.byPrice, total: chatter.total }))}
          />
        )}
    </div>
  );
}

export function TeamSalesPage() {
  const [search, setSearch] = useSearchParams();
  const range = RANGES.some((item) => item.key === search.get("days")) ? search.get("days")! : "30";
  const ppv = useTeamSalesPpv(Number(range));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="max-w-3xl text-sm text-text-secondary">
          Как продают PPV: по страницам, чаттерам и цене. Это ориентир, а не основание для оплаты.
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
      {ppv.data
        ? <PpvBlock data={ppv.data} />
        : ppv.isLoading
          ? <TableSkeleton rows={6} columns={7} />
          : (
            <StatusPanel
              title="PPV не загрузились"
              description="Hub не ответил. Попробуйте ещё раз."
              tone="error"
              action={<button type="button" onClick={() => void ppv.refetch()} disabled={ppv.isFetching} className="btn btn-sm">Повторить</button>}
            />
          )}
    </div>
  );
}
