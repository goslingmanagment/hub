import { millsFromInteger, type MillsLike } from "@agency_hub_core/shared";
import { changeDirection, formatCount, formatMills, formatSignedMills, formatSignedPercent } from "../format.js";
import type { ReactNode } from "react";
import { cx } from "./cx.js";
import { Tooltip } from "./Tooltip.js";

/**
 * Below this many dollars in the window before (mills), a percent says nothing:
 * «$31.98 / было $16.00» instead of «+100 %» (D13). The shifts grid's own floor.
 */
export const DELTA_SMALL_BASE_MILLS = 50_000;
/** The same floor for counts (shifts, chats, sales): fewer than five before — «было 3». */
export const DELTA_SMALL_BASE_COUNT = 5;

/**
 * What one change against the window before says (D13), worked out once for
 * every screen: a percent, «было $X» (the base was too small or nothing is left),
 * «впервые» (there was nothing before) or nothing at all.
 */
export type DeltaReading =
  | { kind: "pct"; pct: number; direction: "up" | "down" | "flat" }
  | { kind: "was"; previous: number; reason: "small" | "gone" }
  | { kind: "first" }
  | { kind: "none"; reason: "unknown" | "zero" };

export interface DeltaRule {
  /** What the numbers are: money in mills (default) or a plain count. */
  unit?: "mills" | "count";
  /**
   * The amount the small-base rule looks at, when it is not `previous` itself:
   * for a rate («В час»), the money before — a rate of $2.15 from one short shift
   * is no base for a percent.
   */
  base?: MillsLike | number | null | undefined;
  /** Below this base: «было X». Default: $50 for money, 5 for counts. */
  floor?: MillsLike | number;
}

function toNumber(value: MillsLike | number): number {
  return typeof value === "number" ? value : Number(millsFromInteger(value));
}

/**
 * The one rule of a change (D13): no base → «впервые»; a small base or nothing
 * left now → «было X»; otherwise a whole percent. Used by `Delta current/previous`
 * and by any sentence that writes a change in words.
 */
export function readDelta(
  current: MillsLike | number | null | undefined,
  previous: MillsLike | number | null | undefined,
  rule: DeltaRule = {},
): DeltaReading {
  if (previous === null || previous === undefined || current === null || current === undefined) return { kind: "none", reason: "unknown" };
  const now = toNumber(current);
  const before = toNumber(previous);
  if (!Number.isFinite(now) || !Number.isFinite(before)) return { kind: "none", reason: "unknown" };
  if (before <= 0) return now > 0 ? { kind: "first" } : { kind: "none", reason: "zero" };
  if (now <= 0) return { kind: "was", previous: before, reason: "gone" };
  const floor = rule.floor !== undefined ? toNumber(rule.floor) : rule.unit === "count" ? DELTA_SMALL_BASE_COUNT : DELTA_SMALL_BASE_MILLS;
  const base = rule.base !== undefined && rule.base !== null ? toNumber(rule.base) : before;
  if (base < floor) return { kind: "was", previous: before, reason: "small" };
  const pct = ((now - before) / before) * 100;
  const whole = Math.round(pct);
  return { kind: "pct", pct, direction: whole > 0 ? "up" : whole < 0 ? "down" : "flat" };
}

/** The same change as plain words, for a sentence or a menu: «+13 %», «было $16.00», «впервые», «—». */
export function deltaText(reading: DeltaReading, unit: "mills" | "count" = "mills"): string {
  switch (reading.kind) {
    case "pct":
      return formatSignedPercent(reading.pct);
    case "was":
      return `было\u00a0${unit === "count" ? formatCount(reading.previous) : formatMills(reading.previous)}`;
    case "first":
      return "впервые";
    case "none":
      return "—";
  }
}

export interface DeltaProps extends DeltaRule {
  /**
   * The one rule (D13), preferred: the value now and in the window before
   * (money in mills, or counts with `unit="count"`). Delta itself picks «+13 %»,
   * «было $16.00» (small base, or nothing now), «впервые» (nothing before) or «—».
   */
  current?: MillsLike | number | null | undefined;
  previous?: MillsLike | number | null | undefined;
  /**
   * Which way is better (default `up`): `down` for waits and «без ответа» — a
   * rise then wears the «worse» colour.
   */
  better?: "up" | "down";
  /** The change in percent against the period before; null: nothing to compare with («—»). Prefer `current`/`previous`. */
  pct?: number | null | undefined;
  /** The change in money, shown before the percent: «+$880.00 (+64 %)». */
  mills?: MillsLike | null | undefined;
  /**
   * Someone (or something) that had money before and has none now: «было $419.94»
   * instead of a «−100 %». `current`/`previous` decide this by themselves.
   */
  was?: MillsLike | null | undefined;
  /**
   * `gain` (default): rise and fall get their calm colours. `cost`: spending (AI)
   * only — a change in the text's colour, neither good nor bad. Never a way to
   * make people's numbers grey: a person's change is coloured like everyone's.
   */
  kind?: "gain" | "cost";
  /** What it is compared with, on hover (the app's Tooltip): «к 26 окт. – 1 нояб.». */
  title?: ReactNode;
  /**
   * Words instead of «—» when there is nothing to compare with: «не с чем сравнить»,
   * «первая неделя». Quiet, like the dash.
   */
  noneText?: ReactNode;
  className?: string;
}

/**
 * A change against the last period. A calm green-grey for better and a brown for
 * worse, never the alarm red: a weaker week is not a breakage. No arrows, the
 * sign always. One rule everywhere (D13): give `current` and `previous`, and a
 * small or zero base reads «было $16.00» / «впервые», never «+100 %».
 */
export function Delta({ current, previous, base, floor, unit = "mills", better = "up", pct, mills, was, kind = "gain", title, noneText, className }: DeltaProps) {
  if (current !== undefined || previous !== undefined) {
    const reading = readDelta(current, previous, { unit, base, ...(floor !== undefined ? { floor } : {}) });
    return <DeltaReadingView reading={reading} unit={unit} better={better} kind={kind} title={title} noneText={noneText} className={className} />;
  }
  if (was !== undefined && was !== null) {
    return withHint(<span className={cx("ui-delta ui-delta--was", className)}>было {formatMills(was)}</span>, title);
  }
  const hasPct = pct !== undefined && pct !== null && Number.isFinite(pct);
  const hasMoney = mills !== undefined && mills !== null;
  if (!hasPct && !hasMoney) return noneView(noneText, title, className);
  const rounded = hasPct ? Math.round(pct) : 0;
  const direction = hasPct ? (rounded > 0 ? "up" : rounded < 0 ? "down" : "flat") : changeDirection(mills);
  const text = hasMoney
    ? hasPct ? `${formatSignedMills(mills)} (${formatSignedPercent(pct)})` : formatSignedMills(mills)
    : formatSignedPercent(rounded);
  return withHint(<span className={cx("ui-delta", `ui-delta--${toneOf(direction, better, kind)}`, className)}>{text}</span>, title);
}

function DeltaReadingView({ reading, unit, better, kind, title, noneText, className }: {
  reading: DeltaReading;
  unit: "mills" | "count";
  better: "up" | "down";
  kind: "gain" | "cost";
  title: ReactNode;
  noneText: ReactNode;
  className: string | undefined;
}) {
  switch (reading.kind) {
    case "pct":
      return withHint(
        <span className={cx("ui-delta", `ui-delta--${toneOf(reading.direction, better, kind)}`, className)}>{formatSignedPercent(reading.pct)}</span>,
        title,
      );
    case "was":
      return withHint(
        <span className={cx("ui-delta ui-delta--was", className)}>{deltaText(reading, unit)}</span>,
        joinHint(title, reading.reason === "small"
          ? `Тогда было меньше ${unit === "count" ? formatCount(DELTA_SMALL_BASE_COUNT) : formatMills(DELTA_SMALL_BASE_MILLS)}: процент ничего бы не сказал`
          : "Сейчас — ноль"),
      );
    case "first":
      return withHint(<span className={cx("ui-delta ui-delta--first", className)}>впервые</span>, joinHint(title, "В прошлый раз — ноль"));
    case "none":
      return noneView(noneText, reading.reason === "zero" ? joinHint(title, "И тогда, и сейчас — ноль") : title, className);
  }
}

/** Better / worse colours: the direction against the side that is better; spending stays neutral. */
function toneOf(direction: "up" | "down" | "flat", better: "up" | "down", kind: "gain" | "cost"): "better" | "worse" | "flat" | "neutral" {
  if (direction === "flat") return "flat";
  if (kind === "cost") return "neutral";
  return (direction === "up") === (better === "up") ? "better" : "worse";
}

function noneView(noneText: ReactNode, title: ReactNode, className: string | undefined): ReactNode {
  if (noneText !== undefined) return withHint(<span className={cx("ui-delta ui-delta--none ui-delta--words", className)}>{noneText}</span>, title);
  return withHint(<span className={cx("ui-delta ui-delta--none", className)}>—</span>, title ?? "Сравнивать не с чем");
}

function joinHint(title: ReactNode, reason: string): ReactNode {
  if (title === undefined || title === null || title === "") return reason;
  if (typeof title === "string") return `${title.replace(/\.$/, "")}. ${reason}`;
  return <>{title}. {reason}</>;
}

function withHint(node: ReactNode, words: ReactNode): ReactNode {
  return words === undefined || words === null || words === "" ? node : <Tooltip content={words}>{node}</Tooltip>;
}
