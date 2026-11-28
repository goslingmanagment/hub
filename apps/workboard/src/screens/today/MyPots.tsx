import { Facts, Money, Skeleton, type FactItem } from "@agency_hub_core/ui";
import { formatMills } from "@agency_hub_core/ui/format";
import type { AccountPot } from "@agency_hub_core/contracts";
import { useTodayPots } from "./data";
// The sheet's look (`mym`) is «Мои деньги»'s own.
import "../my-shifts/my-money.css";

/**
 * «Общак» on «Сегодня»: the person's own share of the pots in the week — their lines of the pots' distributions (a
 * share of the pot's sales that counts into their sales) and their share still to come. Base, never pay or a rate;
 * for every person, no switch. Nothing while pots are off or the person has no pot; a failed poll keeps the last
 * answer. Each pot (page, sum, the split) only in the hint.
 */

/** How the caller's latest distribution of a pot was split, in the words of its line («поровну на 3», «вручную»). */
function splitWords(pot: AccountPot): string | null {
  if (pot.lastFormula === "equal") return pot.lastSplit === null ? "поровну" : `поровну на ${pot.lastSplit}`;
  if (pot.lastFormula === "weights") return "по весам";
  if (pot.lastFormula === "manual") return "вручную";
  return null;
}

/** A pot a line under the hint's one line of what it is: its pages, the sum, and how the latest was split. */
function PotLines({ pots, mills, split }: { pots: readonly AccountPot[]; mills: (pot: AccountPot) => number; split: boolean }) {
  const shown = pots.filter((pot) => mills(pot) > 0);
  if (shown.length === 0) return null;
  return (
    <ul className="today-pots">
      {shown.map((pot) => {
        const how = split ? splitWords(pot) : null;
        return <li key={pot.code}>{[pot.pageLabels.join(", "), formatMills(mills(pot)), ...(how === null ? [] : [how])].join(" · ")}</li>;
      })}
    </ul>
  );
}

export function MyPotsBlock({ window }: { window: { from: string; to: string } }) {
  const read = useTodayPots(window);
  const answer = read.data !== undefined && read.data.from === window.from && read.data.to === window.to ? read.data : null;
  if (answer === null) return read.isPending ? <Skeleton height={88} radius={12} /> : null;
  if (!answer.on || answer.pots.length === 0) return null;
  const items: FactItem[] = [
    {
      label: "Из общака",
      strong: true,
      value: <Money mills={answer.totalMills} strong />,
      meta: "в ваши продажи за неделю",
      hint: (
        <>
          Доля продаж в общак: идёт в ваши продажи, платится по вашей ставке.
          <PotLines pots={answer.pots} mills={(pot) => pot.mineMills} split />
        </>
      ),
    },
  ];
  if (answer.pendingMills > 0) {
    items.push({
      label: "Ещё придёт",
      value: <Money mills={answer.pendingMills} />,
      hint: (
        <>
          Ваша доля продаж в общак, которые ещё не раздали.
          <PotLines pots={answer.pots} mills={(pot) => pot.pendingMills} split={false} />
        </>
      ),
    });
  }
  return (
    <section className="mym" aria-label="Общак">
      <span className="mym__title">Общак</span>
      <Facts items={items} layout="stacked" columns={3} label="Общак" className="mym__facts" />
    </section>
  );
}
