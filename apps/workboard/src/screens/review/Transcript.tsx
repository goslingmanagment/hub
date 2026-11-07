import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { IconButton, Money } from "@agency_hub_core/ui";
import { formatCount, formatDateTime, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { SHIFT_REVIEW_WAIT_HORIZON_HOURS } from "@agency_hub_core/contracts";
import { FanName } from "@/shared/FanName";
import { consoleFanHref } from "@/shared/links";
import type { ReviewChatRow, ReviewMessage, ReviewShift, ReviewTranscript, ReviewWait } from "./data.js";
import { fanTitle } from "./ChatList.js";
import { GAP_MINUTES, REPLY_NORM_SECONDS, cameBack, waitText } from "./rules.js";
import { MARK_WORDS, authorOf, momentText, originOf, plainText } from "./words.js";

/**
 * One chat as it went (spec §4.2): the fan on the left, the page on the right,
 * 16 px; the context before the shift greyed; «Начало смены» and «тишина 54 мин»
 * between messages. Under each of the chatter's messages one quiet line says
 * where its text came from and how long the fan had waited; it opens the
 * evidence panel. Honest notes stay: a colleague's wait is not the chatter's.
 */

const HORIZON_DAYS = SHIFT_REVIEW_WAIT_HORIZON_HOURS / 24;
const MINUTE_MS = 60_000;

/** The search words lit in a text. */
function lit(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (needle === "") return text;
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const out: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(target); at >= 0; at = lower.indexOf(target, from)) {
    if (at > from) out.push(text.slice(from, at));
    out.push(<mark key={at} className="review-hit">{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

function Divider({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return <p className={strong ? "review-divider review-divider--strong" : "review-divider"}><span>{children}</span></p>;
}

function Bubble({ message, username, shiftStart, answered, query, inSpan, open, onEvidence }: {
  message: ReviewMessage;
  username: string;
  shiftStart: number;
  /** The wait this message answered. */
  answered: ReviewWait | null;
  query: string;
  inSpan: boolean;
  open: boolean;
  onEvidence: () => void;
}) {
  const fan = message.side === "fan";
  const mine = message.mine;
  const origin = originOf(message);
  const author = authorOf(message, username);
  const text = plainText(message.text);
  const meta: ReactNode[] = [<span key="at">{message.inShift ? formatTimeOfDay(message.at) : formatDateTime(message.at)}</span>];
  if (message.priceMills !== null) {
    meta.push(<span key="price">платное <Money mills={message.priceMills} />, {message.bought ? "куплено" : "не куплено"}</span>);
  }
  if (message.tipMills !== null && Number(message.tipMills) > 0) meta.push(<span key="tip">чаевые <Money mills={message.tipMills} /></span>);
  if (message.media > 0) meta.push(<span key="media">{formatCount(message.media)} {ruPlural(message.media, "файл", "файла", "файлов")}</span>);
  if (author) meta.push(<span key="by">{author}</span>);

  const lastFanGap = answered === null ? null : (answered.to - answered.lastFanAt) / 1000;
  const again = answered !== null && lastFanGap !== null && cameBack(answered.seconds, lastFanGap) ? `, снова писал за ${waitText(lastFanGap)} до ответа` : "";
  const waitedSeconds = mine?.replySeconds ?? null;
  const waited = waitedSeconds === null ? null
    : answered !== null && answered.inherited ? `фан ждал с ${momentText(answered.since, shiftStart)}, в смену ${waitText(waitedSeconds)}${again}`
      : `фан ждал ${waitText(waitedSeconds)}${again}`;
  const long = waitedSeconds !== null && waitedSeconds > REPLY_NORM_SECONDS;

  const classes = [
    "review-msg",
    fan ? "review-msg--fan" : "review-msg--page",
    mine ? "review-msg--mine" : "",
    !message.inShift ? "review-msg--before" : "",
    inSpan ? "is-span" : "",
    open ? "is-open" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={classes} data-at={message.at} data-ref={message.ref} data-origin={origin?.key}>
      <div className="review-bubble">
        {text !== "" ? <p className="review-bubble__text">{lit(text, query)}</p> : <p className="review-bubble__text review-bubble__text--empty">{message.media > 0 ? "без текста" : "пусто"}</p>}
        <p className="review-bubble__meta">{meta.flatMap((part, index) => (index === 0 ? [part] : [<span key={`s${index}`} aria-hidden> · </span>, part]))}</p>
      </div>
      {mine && origin && (
        <div className="review-origin-row">
          <button type="button" className="review-origin" onClick={onEvidence} aria-expanded={open} title="Откуда текст: ИИ, черновик, совпадение">
            <span>{origin.label}</span>
            {waited && <span className={long ? "review-origin__wait is-long" : "review-origin__wait"}>{waited}</span>}
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
          </button>
          {mine.repeats > 0 && <span className="review-tag">тот же текст ещё в {formatCount(mine.repeats)} {ruPlural(mine.repeats, "чате", "чатах", "чатах")}</span>}
          {mine.marks.map((mark) => <span key={mark} className="review-tag">{MARK_WORDS[mark]}</span>)}
        </div>
      )}
    </div>
  );
}

export function Transcript({ shift, transcript, row, position, onStep, span, query, openMessage, onEvidence }: {
  shift: ReviewShift;
  transcript: ReviewTranscript;
  row: ReviewChatRow;
  position: { index: number; count: number };
  onStep: (delta: 1 | -1) => void;
  /** The span picked on the pulse, ms. */
  span: { from: number; to: number } | null;
  query: string;
  openMessage: string | null;
  onEvidence: (ref: string) => void;
}) {
  const { chat, waits } = transcript;
  const scroller = useRef<HTMLDivElement>(null);
  const start = shift.start;
  const open = waits.find((wait) => wait.by === null) ?? null;
  const byAnswer = new Map(waits.filter((wait) => wait.by === "me").map((wait) => [wait.to, wait]));

  // A new chat (or a new span) opens at the shift's start, or at the span's first message.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const target = span === null
      ? box.querySelector<HTMLElement>(".review-divider--start")
      : [...box.querySelectorAll<HTMLElement>("[data-at]")].find((node) => Date.parse(node.dataset.at!) >= span.from) ?? null;
    if (target) box.scrollTop = Math.max(0, target.offsetTop - 16);
    else box.scrollTop = box.scrollHeight;
    // Primitive deps: a new span object with the same minutes must not throw the reader back.
  }, [chat.key, span?.from, span?.to]);

  // The message whose evidence is open stays in sight.
  useEffect(() => {
    const box = scroller.current;
    if (!box || openMessage === null) return;
    const node = box.querySelector<HTMLElement>(`[data-ref="${CSS.escape(openMessage)}"]`);
    if (!node) return;
    if (node.offsetTop < box.scrollTop || node.offsetTop + node.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, node.offsetTop - box.clientHeight / 3);
    }
  }, [openMessage]);

  const rows: ReactNode[] = [];
  const fanHref = chat.fanRef ? consoleFanHref(chat.pageLabel, chat.platform, chat.fanRef) : null;
  if (chat.earlierHidden > 0) {
    rows.push(
      <Divider key="earlier">
        ещё {formatCount(chat.earlierHidden)} {ruPlural(chat.earlierHidden, "сообщение", "сообщения", "сообщений")} за {HORIZON_DAYS} {ruPlural(HORIZON_DAYS, "день", "дня", "дней")} до смены
        {fanHref && <> · <a className="ui-link" href={fanHref}>вся переписка в карточке фана</a></>}
      </Divider>,
    );
  }
  let previous: number | null = null;
  let started = false;
  for (const message of chat.messages) {
    const at = Date.parse(message.at);
    if (!started && message.inShift) {
      rows.push(<p key="start" className="review-divider review-divider--start review-divider--strong"><span>Начало смены, {formatTimeOfDay(start)}</span></p>);
      started = true;
      if (at - start >= GAP_MINUTES * MINUTE_MS) rows.push(<Divider key="start-gap">тишина {waitText((at - start) / 1000)}</Divider>);
    } else if (previous !== null && at - previous >= GAP_MINUTES * MINUTE_MS) {
      rows.push(<Divider key={`gap-${message.ref}`}>тишина {waitText((at - previous) / 1000)}</Divider>);
    }
    rows.push(
      <Bubble
        key={message.ref}
        message={message}
        username={shift.username}
        shiftStart={start}
        answered={message.mine !== null ? byAnswer.get(at) ?? null : null}
        query={query}
        inSpan={span !== null && message.inShift && at >= span.from && at < span.to}
        open={openMessage === message.ref}
        onEvidence={() => onEvidence(message.ref)}
      />,
    );
    previous = at;
  }
  if (!started) rows.push(<p key="start" className="review-divider review-divider--start review-divider--strong"><span>Смена с {formatTimeOfDay(start)}: в ней сообщений нет</span></p>);
  else rows.push(<Divider key="end" strong>{shift.ongoing ? `Смена идёт · ${formatTimeOfDay(shift.serverNow)}` : `Конец смены, ${formatTimeOfDay(shift.end)}`}</Divider>);

  const note = open === null ? null
    : shift.ongoing
      ? `Фан ждёт ответа с ${momentText(open.since, start)}${open.inherited ? " — ещё с прошлой смены" : ""}.`
      : open.inherited
        ? `К концу смены фан ждал ответа с ${formatDateTime(new Date(open.since).toISOString())} — ещё с прошлой смены.`
        : `К концу смены фан ждал ответа ${waitText(open.seconds)} — с ${formatTimeOfDay(open.since)}.`;
  const holder = open?.heldBy ?? row.colleagues[0]?.name ?? "коллега";
  const theirs = open !== null && !open.his;

  const about: ReactNode[] = [];
  if (chat.fanUsername && chat.fanDisplayName) about.push(`@${chat.fanUsername}`);
  about.push(chat.pageLabel);
  if (row.lifetimeNetMills !== null) about.push(row.lifetimeNetMills > 0 ? <>принёс за всё время <Money mills={row.lifetimeNetMills} /></> : "ещё не платил");
  if (row.shiftNetMills > 0) about.push(<>в смену <Money mills={row.shiftNetMills} strong /> после комиссии</>);
  if (row.colleagues.length > 0) about.push(`писали также ${row.colleagues.map((one) => `${one.name} ${formatCount(one.messages)}`).join(", ")}`);

  return (
    <section className="review-transcript" aria-label={`Переписка с ${fanTitle(row)}`}>
      <header className="review-transcript__head">
        <div className="review-transcript__who">
          <h2 className="review-transcript__fan">
            {chat.fanRef
              ? <FanName name={chat.fanDisplayName} username={chat.fanUsername} fanRef={chat.fanRef} pageLabel={chat.pageLabel} platform={chat.platform} />
              : fanTitle(row)}
          </h2>
          <p className="review-transcript__about">
            {about.flatMap((part, index) => (index === 0 ? [<span key={index}>{part}</span>] : [<span key={`s${index}`} aria-hidden> · </span>, <span key={index}>{part}</span>]))}
          </p>
        </div>
        <div className="review-transcript__nav" aria-label="Соседние чаты">
          <IconButton icon={ChevronUp} label="Предыдущий чат (↑ или K)" variant="secondary" size="sm" onClick={() => onStep(-1)} disabled={position.index <= 0} />
          <span className="review-transcript__pos">{formatCount(position.index + 1)} из {formatCount(position.count)}</span>
          <IconButton icon={ChevronDown} label="Следующий чат (↓ или J)" variant="secondary" size="sm" onClick={() => onStep(1)} disabled={position.index >= position.count - 1} />
        </div>
      </header>
      <div ref={scroller} className="review-transcript__scroll">
        <div className="review-transcript__messages">{rows}</div>
      </div>
      {note && (
        <p className={theirs ? "review-transcript__note" : "review-transcript__note review-transcript__note--open"}>
          {note}
          {theirs && ` Не в счёте ${shift.username}: перед ожиданием писал(а) ${holder}, и у ${holder} есть сообщения на этой странице в последние ${REPLY_NORM_SECONDS / 60} минут смены.`}
        </p>
      )}
    </section>
  );
}

