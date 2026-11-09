import { ChevronRight } from "lucide-react";
import { Fan, collidingFanNames, fanNameCollides, platformWord, type Column, type FanLike } from "@agency_hub_core/ui";
import type { FanRefOnPage, KnownFan } from "./data";

/** «nova-1 · Fansly»: a page in a decision, the same words in a row, a panel and a question (Р7). */
export function pageWords(pageLabel: string, platform: string | null | undefined): string {
  const word = platformWord(platform);
  return word ? `${pageLabel} · ${word}` : pageLabel;
}

/**
 * A fan in a queue's row: the name (never the 18 digits; @login on hover, or
 * beside the name when two fans of the list share it) and, under it, the page
 * — one column instead of two, so the row's own words get the width.
 */
export function FanCell({ fan, fanRef, pageLabel, platform, showLogin = false }: {
  fan: KnownFan | undefined;
  fanRef: string | null;
  pageLabel: string;
  platform: string | null | undefined;
  showLogin?: boolean;
}) {
  return (
    <span className="decisions-fan">
      {fanRef === null
        ? <span className="text-ink-3">фан неизвестен</span>
        : <Fan name={fan?.name ?? null} username={fan?.username ?? null} fanRef={fanRef} showLogin={showLogin} />}
      <span className="decisions-sub">{pageWords(pageLabel, platform)}</span>
    </span>
  );
}

/** The fans of one list whose names collide: those show their @login beside the name (D6). */
export function collidingIn<Row extends { fanRef: string | null; pageLabel: string }>(
  rows: readonly Row[],
  fanOf: (fan: FanRefOnPage) => KnownFan | undefined,
): (row: Row) => boolean {
  const colliding = collidingFanNames(rows.flatMap((row): FanLike[] => {
    if (row.fanRef === null) return [];
    const known = fanOf({ pageLabel: row.pageLabel, fanRef: row.fanRef });
    return [{ name: known?.name ?? null, username: known?.username ?? null, fanRef: row.fanRef }];
  }));
  return (row) => {
    if (row.fanRef === null) return false;
    const known = fanOf({ pageLabel: row.pageLabel, fanRef: row.fanRef });
    return fanNameCollides({ name: known?.name ?? null, fanRef: row.fanRef }, colliding);
  };
}

/**
 * The quiet «›» at the end of a row that opens a panel (Р3, В8): the whole row
 * is the target, so no column of identical buttons; the arrow only says so.
 */
export function goColumn<Row>(): Column<Row> {
  return {
    key: "go",
    header: <span className="ui-sr-only">Открыть</span>,
    width: 44,
    cell: () => <ChevronRight size={18} strokeWidth={1.75} aria-hidden className="decisions-go" />,
  };
}
