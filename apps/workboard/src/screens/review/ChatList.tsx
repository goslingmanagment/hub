import { useEffect, useRef } from "react";
import { formatTimeOfDay } from "@agency_hub_core/ui/format";
import type { ReviewChatRow } from "./data.js";
import { momentText } from "./words.js";

/**
 * The chats of the shift, two lines each (spec §4.2): who and when on the
 * first, why it is worth a look on the second. The open one is the ink row; a
 * chat named in the address that the list does not hold stays on top, said so.
 */

export function fanTitle(row: Pick<ReviewChatRow, "fanDisplayName" | "fanUsername" | "fanRef">): string {
  return row.fanDisplayName?.trim() || (row.fanUsername?.trim() ? `@${row.fanUsername.trim()}` : row.fanRef ? `фан ·${row.fanRef.slice(-4)}` : "фан");
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
  if (row.kind === "touch") return row.fan === 0 ? "написал первым, фан пока молчит" : "написал первым";
  if (row.kind === "waiting") return "в смену в чате не писали";
  if (row.kind === "colleague") return "вела коллега";
  return `сообщений: чаттер ${row.mine}, фан ${row.fan}`;
}

function ChatCard({ row, active, outside, showPage, ongoing, shiftStart, onPick }: {
  row: ReviewChatRow;
  shiftStart: number;
  active: boolean;
  outside: boolean;
  showPage: boolean;
  ongoing: boolean;
  onPick: () => void;
}) {
  const reasons = row.reasons.slice(0, 3);
  return (
    <li>
      <button
        type="button"
        className={active ? "review-chat is-active" : "review-chat"}
        aria-current={active ? "true" : undefined}
        data-chat={row.key}
        onClick={onPick}
      >
        <span className="review-chat__top">
          <span className="review-chat__name">{fanTitle(row)}</span>
          {showPage && <span className="review-chat__page">{row.pageLabel}</span>}
          <span className="review-chat__when">{whenOf(row, ongoing, shiftStart)}</span>
        </span>
        <span className="review-chat__why">
          {outside && <span className="review-chat__outside">не в этом списке · </span>}
          {reasons.length === 0
            ? <span>{plainLine(row)}</span>
            : reasons.map((reason, index) => (
              <span key={reason.text} className={reason.strong ? "review-why review-why--strong" : reason.kind === "note" || reason.kind === "sample" ? "review-why review-why--note" : "review-why"}>
                {index > 0 && " · "}{reason.text}
              </span>
            ))}
        </span>
      </button>
    </li>
  );
}

export function ChatList({ rows, activeKey, outsideKey, showPage, ongoing, shiftStart, onPick }: {
  rows: readonly ReviewChatRow[];
  shiftStart: number;
  activeKey: string | null;
  /** The chat kept on top though the list does not hold it. */
  outsideKey: string | null;
  showPage: boolean;
  ongoing: boolean;
  onPick: (key: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  // Keep the open chat in sight inside the list; the page itself does not move.
  useEffect(() => {
    const box = list.current;
    const row = activeKey ? box?.querySelector<HTMLElement>(`[data-chat="${CSS.escape(activeKey)}"]`) : null;
    if (!box || !row) return;
    // The list is the rows' offset parent (position: relative).
    const top = row.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top - 8;
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + row.offsetHeight - box.clientHeight + 8;
  }, [activeKey]);
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
          onPick={() => onPick(row.key)}
        />
      ))}
    </ul>
  );
}
