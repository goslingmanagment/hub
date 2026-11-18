import type { OfLinkFansResponse } from "@agency_hub_core/contracts";
import { moscowDayOf, type MoscowDay } from "@agency_hub_core/ui/moscow";
import { formatMills } from "@/lib/format";
import { ruPlural } from "@/lib/plural";
import { workboardHref } from "@/lib/workboard";
import { dayMonth, fansWord } from "./trafficDays.js";

// «Фаны» of the page of one link: one line a fan, from the walks of the link's
// lists (`ofLinkFansGet`), 20 at a time. Pure.

export interface LinkFanLine {
  key: string;
  name: string | null;
  username: string | null;
  fanRef: string;
  /** The fan's card in Workboard «Фаны»; null for a deleted account. */
  href: string | null;
  /** «с 12 ноября»; «раньше 12 ноября» when he came before the link's first walk. */
  since: string;
  left: boolean;
  /** «$45.00», «не платил», «—» (unknown); null when the link's money is not known for anyone (a trial link). */
  money: string | null;
}

export interface LinkFansView {
  /** Never read: the one quiet line, and nothing else. */
  neverRead: boolean;
  /** «22 фана, 3 платят, по обходу 17 ноября». */
  head: string;
  lines: LinkFanLine[];
  /** «Показать ещё 20»; null when every fan is shown. */
  more: string | null;
}

export function linkFansView(pages: readonly OfLinkFansResponse[], pageLabel: string | null, today: MoscowDay): LinkFansView {
  const first = pages[0];
  if (first === undefined || (first.walkedAt === null && first.total === 0)) {
    return { neverRead: true, head: "", lines: [], more: null };
  }
  const fans = pages.flatMap((page) => page.fans);
  const moneyKnown = first.paying !== null;
  const parts = [
    first.total === 0 ? "Фанов нет" : fansWord(first.total),
    ...(first.paying !== null && first.total > 0 ? [`${first.paying.toLocaleString("ru-RU")} ${ruPlural(first.paying, "платит", "платят", "платят")}`] : []),
    first.walkedAt === null ? "обход ещё не закончен" : `по обходу ${dayMonth(moscowDayOf(first.walkedAt), today)}`,
  ];
  const remaining = first.total - fans.length;
  return {
    neverRead: false,
    head: parts.join(", "),
    lines: fans.map((fan) => ({
      key: String(fan.fanId),
      name: fan.name,
      username: fan.username,
      fanRef: fan.fanRef,
      href: fan.deleted || pageLabel === null ? null : workboardHref(`fans/${encodeURIComponent(pageLabel)}/onlyfans/${encodeURIComponent(fan.fanRef)}`),
      since: fan.subscribedAt !== null
        ? `с ${dayMonth(moscowDayOf(fan.subscribedAt), today)}`
        : `раньше ${dayMonth(moscowDayOf(fan.firstSeenAt), today)}`,
      left: fan.status === "left",
      money: !moneyKnown ? null : fan.paidMills === null ? "—" : fan.paidMills > 0 ? formatMills(fan.paidMills) : "не платил",
    })),
    more: remaining > 0 ? `Показать ещё ${Math.min(remaining, 20)}` : null,
  };
}
