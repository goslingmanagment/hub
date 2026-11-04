import type { OnePageWay, PageFilterMode } from "../../sections.js";

/** What an old component cannot do yet of what lib/sections.ts promises for its screen. */
export interface ScreenGap {
  pageFilter?: PageFilterMode;
  onePageWay?: OnePageWay;
  /** The old screen draws its own period control in its body. */
  periodInBody?: boolean;
  /** The old screen does not read a forced period. */
  noForcedPeriod?: boolean;
}

export type UntilRebuilt = Readonly<Record<string, ScreenGap>>;
