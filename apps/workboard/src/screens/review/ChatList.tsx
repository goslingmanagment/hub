import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Fan, Tooltip, cx, fanNameCollides, fanText } from "@agency_hub_core/ui";
import { formatTimeOfDay } from "@agency_hub_core/ui/format";
import type { ChatReason, ReasonKind, ReviewChatRow, ReviewFilter, Snippet } from "./data.js";
import { momentText } from "./words.js";

/**
 * The chats of the shift, two lines each (spec §4.2): who and when on the
 * first — the time always at the right edge, the name cut with «…» before it —
 * and why it is worth a look on the second: as many reasons as fit the line,
 * the strong ones first, and «+N» for the rest. While words are searched the
 * second line shows where they stand. The open one is the ink row; a chat named
 * in the address that the list does not hold stays on top, said so. One Tab
 * stop: the open chat; the arrows move the choice and the focus with it.
 */

/** A fan as words for a label or a subtitle: the name, else @login, else «фан ·0120». */
export function fanTitle(row: Pick<ReviewChatRow, "fanDisplayName" | "fanUsername" | "fanRef">): string {
  return row.fanRef ? fanText({ name: row.fanDisplayName, username: row.fanUsername, fanRef: row.fanRef }) : row.fanDisplayName?.trim() || (row.fanUsername ? `@${row.fanUsername}` : "фан");
}

/** When the chat was busy in the shift: «10:38–13:00», one time, or since when a fan waits. */
function whenOf(row: ReviewChatRow, ongoing: boolean, shiftStart: number): string {
  if (row.firstAt !== null && row.lastAt !== null) {
    const first = formatTimeOfDay(row.firstAt);
    const last = formatTimeOfDay(row.lastAt);
    return first === last ? first : `${first}–${last}`;
  }
  if (row.waitingSince !== null) return `${ongoing ? "ждёт" : "ждал"} с ${momentText(row.waitingSince, shiftStart)}`;
  return "";
}

/** The second line when nothing stands out: what kind of chat it was. */
function plainLine(row: ReviewChatRow): string {
  if (row.kind === "touch") return row.fan === 0 ? "чаттер написал первым, фан пока молчит" : "чаттер написал первым";
  if (row.kind === "waiting") return "в смену в чате не писали";
  if (row.kind === "colleague") return "вела коллега";
  return `сообщений: чаттер ${row.mine}, фан ${row.fan}`;
}

/** The reasons a list is about come first on its cards: «Платные» shows the money before a repeat. */
const LIST_KINDS: Partial<Record<ReviewFilter, readonly ReasonKind[]>> = {
  unanswered: ["unanswered"],
  waited: ["unanswered", "waited"],
  paid: ["paid", "offer"],
};

function reasonsFor(reasons: readonly ChatReason[], show: ReviewFilter): readonly ChatReason[] {
  const first = LIST_KINDS[show];
  if (!first) return reasons;
  return [...reasons.filter((reason) => first.includes(reason.kind)), ...reasons.filter((reason) => !first.includes(reason.kind))];
}

/** At most this many reasons on a card; fewer when they do not fit its line. */
const MOST_REASONS = 2;
const DOT = " · ";

/** Widths of words in the list's own font, from one canvas: what fits a card's line is known before it is drawn. */
interface Measure {
  /** The width of a card's text, px. */
  width: (text: string, size: number, weight: number) => number;
  /** A card's inner width, px; null before the list is laid out. */
  inner: number | null;
  /** The narrow list beside the evidence: no page, no time on the cards. */
  compact: boolean;
}

function useMeasure(list: RefObject<HTMLUListElement | null>): Measure {
  const [box, setBox] = useState<{ inner: number; family: string; fonts: number; compact: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    let fonts = 0;
    const read = () => {
      const card = element.querySelector<HTMLElement>(".review-chat");
      const style = card ? getComputedStyle(card) : null;
      const padding = style ? Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) : 32;
      const time = card?.querySelector<HTMLElement>(".review-chat__when");
      const compact = time ? getComputedStyle(time).display === "none" : false;
      setBox({ inner: element.clientWidth - padding, family: getComputedStyle(element).fontFamily, fonts, compact });
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    // The font arrives after the first paint: measure again with it.
    let alive = true;
    void document.fonts?.ready.then(() => {
      fonts += 1;
      if (alive) read();
    });
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [list]);
  const context = useMemo(() => document.createElement("canvas").getContext("2d"), []);
  const cache = useRef(new Map<string, number>());
  const family = box?.family ?? "sans-serif";
  const fonts = box?.fonts ?? 0;
  const width = useCallback((text: string, size: number, weight: number) => {
    const font = `${weight} ${size}px ${family}`;
    const key = `${fonts}|${font}|${text}`;
    let value = cache.current.get(key);
    if (value === undefined) {
      if (context) context.font = font;
      value = context ? context.measureText(text).width : text.length * size * 0.55;
      cache.current.set(key, value);
    }
    return value;
  }, [context, family, fonts]);
  return { width, inner: box?.inner ?? null, compact: box?.compact ?? false };
}

/** How many of the card's reasons fit its one line, with «· +N» for the rest (at least one: it is cut with «…»). */
function reasonsThatFit(reasons: readonly ChatReason[], measure: Measure): number {
  const most = Math.min(MOST_REASONS, reasons.length);
  if (measure.inner === null) return most;
  const weight = (reason: ChatReason) => (reason.tone === "mark" ? 500 : 400);
  for (let shown = most; shown > 1; shown -= 1) {
    const rest = reasons.length - shown;
    let used = (shown - 1) * measure.width(DOT, 14, 400);
    for (const reason of reasons.slice(0, shown)) used += measure.width(reason.text, 14, weight(reason));
    if (rest > 0) used += measure.width(`${DOT}+${rest}`, 14, 400);
    if (used <= measure.inner) return shown;
  }
  return 1;
}

function Why({ row, show, measure }: { row: ReviewChatRow; show: ReviewFilter; measure: Measure }) {
  if (row.reasons.length === 0) return <span className="review-chat__line">{plainLine(row)}</span>;
  const reasons = reasonsFor(row.reasons, show);
  const count = reasonsThatFit(reasons, measure);
  const shown = reasons.slice(0, count);
  const rest = reasons.slice(count);
  return (
    <>
      <span className="review-chat__line">
        {shown.map((reason, index) => (
          <span
            key={reason.text}
            className={cx("review-why", reason.tone === "mark" && "review-why--mark", reason.look && "review-why--strong", (reason.kind === "note" || reason.kind === "sample") && "review-why--note")}
          >
            {index > 0 && DOT}{reason.text}
          </span>
        ))}
      </span>
      {/* «+N» stands outside the cut: it is never lost to the «…». */}
      {rest.length > 0 && (
        <Tooltip content={rest.map((one) => one.text).join(" · ")} align="start">
          <span className="review-why--more">{`\u00a0·\u00a0+${rest.length}`}</span>
        </Tooltip>
      )}
    </>
  );
}

function ChatCard({ row, show, active, outside, showPage, ongoing, shiftStart, showLogin, snippet, measure, onPick }: {
  row: ReviewChatRow;
  show: ReviewFilter;
  shiftStart: number;
  active: boolean;
  outside: boolean;
  showPage: boolean;
  ongoing: boolean;
  showLogin: boolean;
  snippet: Snippet | null;
  measure: Measure;
  onPick: () => void;
}) {
  const when = whenOf(row, ongoing, shiftStart);
  // A name cut with «…» says itself in full on hover (with the login, when it is shown beside).
  const name = row.fanRef ? fanText({ name: row.fanDisplayName, username: row.fanUsername, fanRef: row.fanRef }, { withLogin: showLogin }) : fanTitle(row);
  const beside = measure.compact ? 0 : (showPage ? measure.width(row.pageLabel, 14, 400) + 8 : 0) + (when !== "" ? measure.width(when, 14, 400) + 8 : 0);
  const cut = measure.inner !== null && measure.width(name, 15, 500) > measure.inner - beside;
  return (
    <li>
      <button
        type="button"
        className={active ? "review-chat is-active" : "review-chat"}
        aria-current={active ? "true" : undefined}
        tabIndex={active ? 0 : -1}
        data-chat={row.key}
        onClick={onPick}
      >
        <span className="review-chat__top">
          {row.fanRef
            ? <Fan name={row.fanDisplayName} username={row.fanUsername} fanRef={row.fanRef} showLogin={showLogin} className="review-chat__name" {...(cut ? { hint: name } : {})} />
            : <span className="review-chat__name">{fanTitle(row)}</span>}
          {showPage && <span className="review-chat__page">{row.pageLabel}</span>}
          {when !== "" && <span className="review-chat__when">{when}</span>}
        </span>
        <span className="review-chat__why">
          {outside && <span className="review-chat__outside">не в этом списке · </span>}
          {snippet
            ? <span className="review-chat__line review-chat__snippet">{snippet.before}<mark className="review-hit">{snippet.hit}</mark>{snippet.after}</span>
            : <Why row={row} show={show} measure={measure} />}
        </span>
      </button>
    </li>
  );
}

export function ChatList({ rows, show, activeKey, outsideKey, showPage, ongoing, shiftStart, colliding, query, snippet, onPick }: {
  rows: readonly ReviewChatRow[];
  /** The list shown: its own reasons come first on the cards. */
  show: ReviewFilter;
  shiftStart: number;
  activeKey: string | null;
  /** The chat kept on top though the list does not hold it. */
  outsideKey: string | null;
  showPage: boolean;
  ongoing: boolean;
  /** Fan names shown more than once in this shift: those fans get their login beside the name. */
  colliding: ReadonlySet<string>;
  query: string;
  snippet: (key: string, needle: string) => Snippet | null;
  onPick: (key: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const measure = useMeasure(list);
  // Keep the open chat in sight inside the list (the page itself does not move); the focus follows the choice.
  useEffect(() => {
    const box = list.current;
    const row = activeKey ? box?.querySelector<HTMLElement>(`[data-chat="${CSS.escape(activeKey)}"]`) : null;
    if (!box || !row) return;
    if (box.contains(document.activeElement) && document.activeElement !== row) row.focus({ preventScroll: true });
    // The list is the rows' offset parent (position: relative).
    const top = row.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top - 8;
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + row.offsetHeight - box.clientHeight + 8;
  }, [activeKey]);
  const needle = query.trim();
  return (
    <ul ref={list} className="review-chats" aria-label="Чаты смены">
      {rows.map((row) => (
        <ChatCard
          key={row.key}
          row={row}
          show={show}
          active={row.key === activeKey}
          outside={row.key === outsideKey}
          showPage={showPage}
          ongoing={ongoing}
          shiftStart={shiftStart}
          showLogin={row.fanRef !== null && fanNameCollides({ name: row.fanDisplayName, fanRef: row.fanRef }, colliding)}
          snippet={needle === "" ? null : snippet(row.key, needle)}
          measure={measure}
          onPick={() => onPick(row.key)}
        />
      ))}
    </ul>
  );
}
