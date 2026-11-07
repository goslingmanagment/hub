import { FanName } from "@/shared/FanName";
import type { KnownFan } from "./data";

const PLATFORM: Readonly<Record<string, string>> = { fansly: "Fansly", onlyfans: "OnlyFans", telegram: "Telegram" };

/**
 * A fan in a queue's row: the name (never the 18 digits) and, under it, the
 * page and its platform — one column instead of two, so the row's own words
 * (what was ordered, what was sent) get the width.
 */
export function FanCell({ fan, fanRef, pageLabel, platform }: { fan: KnownFan | undefined; fanRef: string | null; pageLabel: string; platform: string | undefined }) {
  return (
    <span>
      {fanRef === null ? <span className="text-ink-3">фан неизвестен</span> : <FanName {...(fan ?? {})} fanRef={fanRef} />}
      <span className="decisions-sub">{pageLabel}{platform ? ` · ${PLATFORM[platform] ?? platform}` : ""}</span>
    </span>
  );
}
