import { Fan, Money, PageLabel } from "@agency_hub_core/ui";
import { KIND_OF, shareOf, shareText, type SaleKind } from "@agency_hub_core/ui/people/words";
import { ruPlural } from "@agency_hub_core/ui/plural";
import "./sales-parts.css";

/**
 * What a person's sales are made of and the fans who brought the most: the blocks of a person's card («Команда →
 * Продажи», the lead's) and of a chatter's own «Смены → Мои», one drawing for both. They draw what they are given: the
 * sums are the caller's read (Hub's), never added up here; a share is a part of the given whole. Bars are drawn to
 * 100 %, so 14 % looks like 14 %.
 */

export interface SaleKindsInput {
  /** Each kind's money, in the screens' order (PPV, чаевые, подписки, посты). */
  byKind: ReadonlyArray<{ kind: SaleKind; netMills: number }>;
  /** The whole the parts are of. */
  totalNetMills: number;
  /** Per page; more than one is listed under the kinds. */
  pages: ReadonlyArray<{ pageLabel: string; platform: string | null; netMills: number }>;
}

export interface TopFansInput {
  topFans: ReadonlyArray<{ fanName: string | null; pageLabel: string; netMills: number; sales: number }>;
  /** The other paying fans and their money; count 0 — none, or not told. */
  restFans: { count: number; netMills: number };
}

export function SaleKinds({ sales }: { sales: SaleKindsInput }) {
  if (sales.totalNetMills === 0) return <p className="people-note">Продаж не было.</p>;
  const shown = sales.byKind.filter((part) => part.netMills > 0);
  return (
    <>
      <div className="people-split" role="img" aria-label={shown.map((part) => `${KIND_OF[part.kind].label} ${shareText(shareOf(part.netMills, sales.totalNetMills))}`).join(", ")}>
        {shown.map((part) => (
          <span key={part.kind} style={{ flexGrow: part.netMills, background: KIND_OF[part.kind].color }} />
        ))}
      </div>
      <ul className="people-kinds">
        {sales.byKind.map((part) => (
          <li key={part.kind} className="people-kind">
            <span aria-hidden className="wb-kind-key" style={{ background: KIND_OF[part.kind].color }} />
            <span>{KIND_OF[part.kind].label}</span>
            <Money mills={part.netMills} muted={part.netMills === 0} />
            <span className="people-kind__share">{part.netMills > 0 ? shareText(shareOf(part.netMills, sales.totalNetMills)) : ""}</span>
          </li>
        ))}
        <li className="people-kind people-kind--total">
          <span />
          <span>Всего</span>
          <Money mills={sales.totalNetMills} strong />
          <span />
        </li>
      </ul>
      {sales.pages.length > 1 && (
        <>
          <h3 className="people-subhead">По страницам</h3>
          <ul className="people-kinds" aria-label="По страницам">
            {sales.pages.map((one) => (
              <li key={one.pageLabel} className="people-kind">
                <span />
                <PageLabel label={one.pageLabel} platform={one.platform} className="people-kind__page" />
                <Money mills={one.netMills} />
                <span className="people-kind__share">{shareText(shareOf(one.netMills, sales.totalNetMills))}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function TopFans({ sales, empty = "За смены периода никто не платил." }: { sales: TopFansInput; empty?: string }) {
  if (sales.topFans.length === 0) return <p className="people-note">{empty}</p>;
  return (
    <ol className="people-fans">
      {sales.topFans.map((fan, index) => (
        <li key={`${fan.pageLabel}-${fan.fanName}`} className="people-fan">
          <span className="people-fan__rank">{index + 1}</span>
          <span className="people-fan__who">
            {fan.fanName
              ? <Fan name={fan.fanName} fanRef={`${fan.pageLabel}:${fan.fanName}`} className="people-fan__name" />
              : <span className="people-fan__name people-fan__name--unknown">фан без имени</span>}
            <PageLabel label={fan.pageLabel} />
          </span>
          <span className="people-fan__count">{fan.sales} {ruPlural(fan.sales, "покупка", "покупки", "покупок")}</span>
          <Money mills={fan.netMills} strong />
        </li>
      ))}
      {sales.restFans.count > 0 && (
        <li className="people-fan people-fan--rest">
          <span />
          <span className="people-fan__who">
            Ещё {sales.restFans.count} {ruPlural(sales.restFans.count, "фан", "фана", "фанов")}
          </span>
          <span />
          <Money mills={sales.restFans.netMills} />
        </li>
      )}
    </ol>
  );
}
