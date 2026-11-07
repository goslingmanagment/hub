import { useEffect, useRef } from "react";
import { Fan, Tooltip, cx, fanNameCollides, fanText } from "@agency_hub_core/ui";
import { formatTimeOfDay } from "@agency_hub_core/ui/format";
import type { ReviewChatRow, Snippet } from "./data.js";
import { momentText } from "./words.js";

/**
 * The chats of the shift, two lines each (spec §4.2): who and when on the
 * first, why it is worth a look on the second — at most two reasons, the
 * strong ones first, and «+1». While words are searched the second line shows
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
  if (row.kind === "touch") return row.fan === 0 ? "чаттер написал первым, фан пока молчит" : "чаттер написал первым";
  if (row.kind === "waiting") return "в смену в чате не писали";
  if (row.kind === "colleague") return "вела коллега";
  return `сообщений: чаттер ${row.mine}, фан ${row.fan}`;
}

const SHOWN_REASONS = 2;

function Why({ row }: { row: ReviewChatRow }) {
  if (row.reasons.length === 0) return <span>{plainLine(row)}</span>;
  const shown = row.reasons.slice(0, SHOWN_REASONS);
  const rest = row.reasons.slice(SHOWN_REASONS);
  return (
    <>
      {shown.map((reason, index) => (
        <span
          key={reason.text}
          className={cx("review-why", reason.tone === "mark" && "review-why--mark", reason.look && "review-why--strong", (reason.kind === "note" || reason.kind === "sample") && "review-why--note")}
        >
          {/* The dot ends the reason before: a wrapped line starts with words, not with «·». */}
          {index > 0 && " "}{reason.text}{index < shown.length - 1 && " ·"}
          {/* «+1» stays with the last words: never alone on a line. */}
          {index === shown.length - 1 && rest.length > 0 && (
            <Tooltip content={rest.map((one) => one.text).join(" · ")} align="start">
              <span className="review-why--more">{`\u00a0·\u00a0+${rest.length}`}</span>
            </Tooltip>
          )}
        </span>
      ))}
    </>
  );
}

function ChatCard({ row, active, outside, showPage, ongoing, shiftStart, showLogin, snippet, onPick }: {
  row: ReviewChatRow;
  shiftStart: number;
  active: boolean;
  outside: boolean;
  showPage: boolean;
  ongoing: boolean;
  showLogin: boolean;
  snippet: Snippet | null;
  onPick: () => void;
}) {
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
          {showPage && <span className="review-chat__page">{row.pageLabel}</span>}
          <span className="review-chat__when">{whenOf(row, ongoing, shiftStart)}</span>
        </span>
        <span className="review-chat__why">
          {outside && <span className="review-chat__outside">не в этом списке · </span>}
          {snippet
            ? <span className="review-chat__snippet">{snippet.before}<mark className="review-hit">{snippet.hit}</mark>{snippet.after}</span>
            : <Why row={row} />}
        </span>
      </button>
    </li>
  );
}

export function ChatList({ rows, activeKey, outsideKey, showPage, ongoing, shiftStart, colliding, query, snippet, onPick }: {
  rows: readonly ReviewChatRow[];
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
          active={row.key === activeKey}
          outside={row.key === outsideKey}
          showPage={showPage}
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
