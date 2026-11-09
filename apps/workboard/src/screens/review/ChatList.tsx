import { useEffect, useRef } from "react";
import { Fan, Tooltip, cx, fanNameCollides, fanText } from "@agency_hub_core/ui";
import { formatTimeOfDay } from "@agency_hub_core/ui/format";
import type { ChatReason, ReasonKind, ReviewChatRow, ReviewFilter, Snippet } from "./data.js";
import { momentText } from "./words.js";

/**
 * The chats of the shift, two lines each (spec §4.2): who and when on the
 * first — the time at the right edge, the name cut with «…» before it — and the
 * one reason it is worth a look on the second, the list's own reasons first;
 * the others are in its hint. While words are searched the second line shows
 * where they stand. The open one is the ink row; a chat named in the address
 * that the list does not hold stays on top, said so. One Tab stop: the open
 * chat; the arrows move the choice and the focus with it.
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
  if (row.kind === "touch") return row.fan === 0 ? "написал первым, фан молчит" : "написал первым";
  if (row.kind === "waiting") return "в смену не писали";
  if (row.kind === "colleague") return "вела коллега";
  return `чаттер ${row.mine}, фан ${row.fan}`;
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

/** The card's one reason, the others in its hint. */
function Why({ row, show }: { row: ReviewChatRow; show: ReviewFilter }) {
  if (row.reasons.length === 0) return <span className="review-chat__line">{plainLine(row)}</span>;
  const [first, ...rest] = reasonsFor(row.reasons, show);
  const line = (
    <span className={cx("review-chat__line review-why", first!.tone === "mark" && "review-why--mark", (first!.kind === "note" || first!.kind === "sample") && "review-why--note")}>
      {first!.text}
    </span>
  );
  if (rest.length === 0) return line;
  return (
    <Tooltip content={rest.map((one) => <span key={one.text} className="review-why__tip">{one.text}</span>)} align="start" delay={500} className="review-chat__tip">
      {line}
    </Tooltip>
  );
}

function ChatCard({ row, show, active, outside, ongoing, shiftStart, showLogin, snippet, onPick }: {
  row: ReviewChatRow;
  show: ReviewFilter;
  shiftStart: number;
  active: boolean;
  outside: boolean;
  ongoing: boolean;
  showLogin: boolean;
  snippet: Snippet | null;
  onPick: () => void;
}) {
  const when = whenOf(row, ongoing, shiftStart);
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
            ? <Fan name={row.fanDisplayName} username={row.fanUsername} fanRef={row.fanRef} showLogin={showLogin} className="review-chat__name" />
            : <span className="review-chat__name">{fanTitle(row)}</span>}
          {when !== "" && <span className="review-chat__when">{when}</span>}
        </span>
        <span className="review-chat__why">
          {outside && <span className="review-chat__outside">не в списке · </span>}
          {snippet
            ? <span className="review-chat__line review-chat__snippet">{snippet.before}<mark className="review-hit">{snippet.hit}</mark>{snippet.after}</span>
            : <Why row={row} show={show} />}
        </span>
      </button>
    </li>
  );
}

export function ChatList({ rows, show, activeKey, outsideKey, ongoing, shiftStart, colliding, query, snippet, onPick }: {
  rows: readonly ReviewChatRow[];
  /** The list shown: its own reasons come first on the cards. */
  show: ReviewFilter;
  shiftStart: number;
  activeKey: string | null;
  /** The chat kept on top though the list does not hold it. */
  outsideKey: string | null;
  ongoing: boolean;
  /** Fan names shown more than once in this shift: those fans get their login beside the name. */
  colliding: ReadonlySet<string>;
  query: string;
  snippet: (key: string, needle: string) => Snippet | null;
  onPick: (key: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
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
          ongoing={ongoing}
          shiftStart={shiftStart}
          showLogin={row.fanRef !== null && fanNameCollides({ name: row.fanDisplayName, fanRef: row.fanRef }, colliding)}
          snippet={needle === "" ? null : snippet(row.key, needle)}
          onPick={() => onPick(row.key)}
        />
      ))}
    </ul>
  );
}
