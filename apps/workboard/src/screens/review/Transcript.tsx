import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Fan, IconButton, Money, Tooltip, fanNameCollides } from "@agency_hub_core/ui";
import { formatCount, formatDateTime, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { SHIFT_REVIEW_WAIT_HORIZON_HOURS } from "@agency_hub_core/contracts";
import { REPLY_NORM_SECONDS, waitText } from "@agency_hub_core/ui/shiftReview";
import { consoleFanHref } from "@/shared/links";
import type { ReviewChatRow, ReviewMessage, ReviewShift, ReviewTranscript, ReviewWait } from "./data.js";
import { fanTitle } from "./ChatList.js";
import { authorOf, edgeOf, momentText, plainText } from "./words.js";

/**
 * One chat as it went (spec §4.2): the fan on the left, the page on the right;
 * the context before the shift greyed; «Начало смены» and «Конец смены»
 * between messages, a quiet «тишина 54 мин» only past half an hour. It opens
 * where the list's reason is, lit for a moment; «Все» opens at the shift's
 * start. Where the chatter's text came from is the bubble's coloured edge (the
 * legend is one quiet line in the head); a click on the bubble opens its
 * evidence beside. Under a bubble only a wait past the 10-minute norm, and at
 * the end a fan left without an answer.
 */

const HORIZON_DAYS = SHIFT_REVIEW_WAIT_HORIZON_HOURS / 24;
const MINUTE_MS = 60_000;
/** A silence this long between two messages gets its quiet line. */
const SILENCE_LINE_MINUTES = 30;
/** Of the messages before the shift, this many last ones stand open; the rest behind «ещё N до смены». */
const KEEP_BEFORE = 1;
/** How far under the conversation's top its reason opens, px. */
const REASON_OFFSET = 88;
/** How long the place of the reason stays lit. */
const FOCUS_MS = 2_000;

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

/** How much of the conversation's box is in the window: before the sheet is docked, its bottom is under the fold. */
function seenHeight(box: HTMLElement): number {
  return Math.max(120, Math.min(box.clientHeight, window.innerHeight - box.getBoundingClientRect().top));
}

function Divider({ children, strong = false, start = false }: { children: ReactNode; strong?: boolean; start?: boolean }) {
  const classes = ["review-divider", strong && "review-divider--strong", start && "review-divider--start"].filter(Boolean).join(" ");
  return <p className={classes}><span>{children}</span></p>;
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
  const author = authorOf(message, username);
  const text = plainText(message.text);
  const meta: ReactNode[] = [<span key="at">{message.inShift ? formatTimeOfDay(message.at) : momentText(Date.parse(message.at), shiftStart)}</span>];
  if (message.priceMills !== null) meta.push(<span key="price"><Money mills={message.priceMills} /> {message.bought ? "куплено" : "не куплено"}</span>);
  if (message.tipMills !== null && Number(message.tipMills) > 0) meta.push(<span key="tip">чаевые <Money mills={message.tipMills} /></span>);
  if (message.media > 0) meta.push(<span key="media">{formatCount(message.media)} {ruPlural(message.media, "файл", "файла", "файлов")}</span>);

  const waited = mine?.replySeconds ?? null;
  const long = waited !== null && waited > REPLY_NORM_SECONDS
    ? answered !== null && answered.inherited ? `ждал с ${momentText(answered.since, shiftStart)}` : `ждал ${waitText(waited)}`
    : null;

  const classes = [
    "review-msg",
    fan ? "review-msg--fan" : "review-msg--page",
    mine ? "review-msg--mine" : "",
    !message.inShift ? "review-msg--before" : "",
    inSpan ? "is-span" : "",
    open ? "is-open" : "",
  ].filter(Boolean).join(" ");
  const press = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onEvidence();
  };

  return (
    <div className={classes} data-at={message.at} data-ref={message.ref} data-edge={mine ? edgeOf(message) ?? undefined : undefined}>
      {/* Not the reviewed chatter's: whose it is, above the words, before they are read as the chatter's. */}
      {author && <p className="review-msg__author">{author}</p>}
      <div
        className="review-bubble"
        {...(mine ? { role: "button", tabIndex: 0, "aria-expanded": open, "aria-label": `${text.slice(0, 60)} — откуда текст`, onClick: onEvidence, onKeyDown: press } : {})}
      >
        {text !== "" ? <p className="review-bubble__text">{lit(text, query)}</p> : <p className="review-bubble__text review-bubble__text--empty">{message.media > 0 ? "без текста" : "пусто"}</p>}
        <p className="review-bubble__meta">{meta.flatMap((part, index) => (index === 0 ? [part] : [<span key={`s${index}`} aria-hidden> · </span>, part]))}</p>
      </div>
      {long && <p className="review-msg__wait">{long}</p>}
    </div>
  );
}

/** The origin edges, one quiet line: what each colour of a bubble's edge means. */
function Legend() {
  return (
    <span className="review-legend" aria-hidden>
      <Tooltip content="Текст ИИ ушёл фану как есть" side="bottom"><span><i className="review-edge review-edge--raw" />ИИ без правки</span></Tooltip>
      <Tooltip content="Текст ИИ, чаттер поправил" side="bottom"><span><i className="review-edge review-edge--edited" />с правкой</span></Tooltip>
      <Tooltip content="Свой черновик, ИИ перевёл и поправил кнопкой Fix" side="bottom"><span><i className="review-edge review-edge--fix" />Fix</span></Tooltip>
    </span>
  );
}

export function Transcript({ shift, transcript, row, colliding, position, onStep, span, focus, query, openMessage, onEvidence }: {
  shift: ReviewShift;
  transcript: ReviewTranscript;
  row: ReviewChatRow;
  colliding: ReadonlySet<string>;
  position: { index: number; count: number };
  onStep: (delta: 1 | -1) => void;
  /** The span picked on the pulse, ms. */
  span: { from: number; to: number } | null;
  /** The message of the list's reason: the chat opens there. */
  focus: string | null;
  query: string;
  openMessage: string | null;
  onEvidence: (ref: string) => void;
}) {
  const { chat, waits } = transcript;
  const scroller = useRef<HTMLDivElement>(null);
  const [openedBefore, setOpenedBefore] = useState<string | null>(null);
  const start = shift.start;
  const open = waits.find((wait) => wait.by === null) ?? null;
  const byAnswer = new Map(waits.filter((wait) => wait.by === "me").map((wait) => [wait.to, wait]));

  // A new chat opens at the words searched, at its reason (lit for a moment), at the span's first message, or at the shift's start.
  const searching = query.trim() !== "";
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const hits = searching ? [...box.querySelectorAll<HTMLElement>(".review-hit")].map((hit) => hit.closest<HTMLElement>("[data-ref]")).filter((node) => node !== null) : [];
    const hit = hits.find((node) => !node.classList.contains("review-msg--before")) ?? hits[0] ?? null;
    const reason = hit ?? (span === null && focus !== null ? box.querySelector<HTMLElement>(`[data-ref="${CSS.escape(focus)}"]`) : null);
    const target = reason
      ?? (span === null
        ? box.querySelector<HTMLElement>(".review-divider--start")
        : [...box.querySelectorAll<HTMLElement>("[data-at]")].find((node) => Date.parse(node.dataset.at!) >= span.from) ?? null);
    if (!target) {
      box.scrollTop = box.scrollHeight;
      return;
    }
    // The reason near the top, the message that led to it in sight above (the sheet may still be half under the fold).
    box.scrollTop = Math.max(0, target.offsetTop - (reason ? Math.min(REASON_OFFSET, seenHeight(box) / 4) : 16));
    if (!reason) return;
    reason.classList.add("is-focus");
    const timer = window.setTimeout(() => reason.classList.remove("is-focus"), FOCUS_MS);
    return () => {
      window.clearTimeout(timer);
      reason.classList.remove("is-focus");
    };
    // Primitive deps: a new span object with the same minutes must not throw the reader back.
  }, [chat.key, focus, searching, span?.from, span?.to]);

  // The message whose evidence is open stays in sight.
  useEffect(() => {
    const box = scroller.current;
    if (!box || openMessage === null) return;
    const node = box.querySelector<HTMLElement>(`[data-ref="${CSS.escape(openMessage)}"]`);
    if (!node) return;
    const seen = seenHeight(box);
    if (node.offsetTop < box.scrollTop || node.offsetTop + node.offsetHeight > box.scrollTop + seen) {
      box.scrollTop = Math.max(0, node.offsetTop - Math.min(REASON_OFFSET, seen / 3));
    }
  }, [openMessage]);

  const rows: ReactNode[] = [];
  const fanHref = chat.fanRef ? consoleFanHref(chat.pageLabel, chat.platform, chat.fanRef) : null;
  // The context before the shift: its last message open, the rest a click away — unless the reason, the open
  // evidence or the search stands among them.
  const before = chat.messages.filter((message) => !message.inShift && Date.parse(message.at) < start);
  const folded = before.slice(0, Math.max(0, before.length - KEEP_BEFORE));
  const unfold = openedBefore === chat.key || searching || folded.some((message) => message.ref === focus || message.ref === openMessage);
  const hidden = new Set(unfold ? [] : folded.map((message) => message.ref));
  // The whole conversation is in the fan's card: the fan's name in the head leads there.
  const cardLink = fanHref && <> · <a className="ui-link" href={fanHref}>карточка фана</a></>;
  if (hidden.size > 0) {
    rows.push(
      <Divider key="earlier">
        <button type="button" className="review-linkish" onClick={() => setOpenedBefore(chat.key)}>ещё {formatCount(hidden.size)} до смены</button>
      </Divider>,
    );
  } else if (chat.earlierHidden > 0) {
    rows.push(
      <Divider key="earlier">
        ещё {formatCount(chat.earlierHidden)} за {HORIZON_DAYS} {ruPlural(HORIZON_DAYS, "день", "дня", "дней")} до смены
        {cardLink}
      </Divider>,
    );
  }
  let previous: number | null = null;
  let started = false;
  for (const message of chat.messages) {
    if (hidden.has(message.ref)) continue;
    const at = Date.parse(message.at);
    if (!started && message.inShift) {
      rows.push(<Divider key="start" strong start>Начало смены, {formatTimeOfDay(start)}</Divider>);
      started = true;
      if (at - start >= SILENCE_LINE_MINUTES * MINUTE_MS) rows.push(<Divider key="start-gap">тишина {waitText((at - start) / 1000)}</Divider>);
    } else if (started && previous !== null && at - previous >= SILENCE_LINE_MINUTES * MINUTE_MS) {
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

  // A fan left waiting at the end: under the last messages, on the fan's side. A colleague's wait or the shift's last
  // minutes are said without the warning's colour.
  if (open !== null) {
    const theirs = !open.his;
    const late = !shift.ongoing && open.since >= shift.end - REPLY_NORM_SECONDS * 1000;
    const words = shift.ongoing ? `ждёт ответа ${waitText(open.seconds)}` : `без ответа ${waitText(open.seconds)}`;
    const holder = open.heldBy ?? row.colleagues[0]?.name ?? "коллега";
    const hint = theirs
      ? `Не в счёте ${shift.username}: перед ожиданием писал(а) ${holder}.`
      : late ? `Фан написал за ${waitText(open.seconds)} до конца смены: в счёте, хотя ответить было почти некогда.`
        : open.inherited ? `Ждал ещё с прошлой смены, с ${formatDateTime(new Date(open.since).toISOString())}.`
          : `С ${formatTimeOfDay(open.since)} до ${shift.ongoing ? "сейчас" : "конца смены"}.`;
    rows.push(
      <p key="open" className={theirs || late ? "review-open" : "review-open is-long"}>
        <Tooltip content={hint} align="start"><span>{words}{theirs && ` · ${holder}`}</span></Tooltip>
      </p>,
    );
  }
  if (!started) rows.push(<Divider key="start" strong start>Смена с {formatTimeOfDay(start)}: в ней сообщений нет</Divider>);
  else rows.push(<Divider key="end" strong>{shift.ongoing ? `Смена идёт, ${formatTimeOfDay(shift.serverNow)}` : `Конец смены, ${formatTimeOfDay(shift.end)}`}</Divider>);

  const about: ReactNode[] = [<span key="page" className="review-page-text">{chat.pageLabel}</span>];
  if (row.lifetimeNetMills !== null) about.push(row.lifetimeNetMills > 0 ? <span key="life">всего <Money mills={row.lifetimeNetMills} /></span> : <span key="life">не платил</span>);
  if (row.shiftNetMills > 0) about.push(<span key="shift">в смену <Money mills={row.shiftNetMills} /></span>);
  if (row.colleagues.length > 0) {
    const colleagues = row.colleagues.map((one) => `${one.name} (${formatCount(one.messages)})`).join(", ");
    about.push(<span key="colleagues" className={row.mine === 0 ? "review-transcript__nobody" : undefined}>{row.mine === 0 ? `только ${colleagues}` : `ещё ${colleagues}`}</span>);
  } else if (row.mine === 0 && row.kind !== "waiting") {
    about.push(<span key="nobody" className="review-transcript__nobody">сообщений {shift.username} нет</span>);
  }

  return (
    <section className="review-transcript" aria-label={`Переписка с ${fanTitle(row)}`}>
      <header className="review-transcript__head">
        <div className="review-transcript__who">
          <h2 className="review-transcript__fan">
            {chat.fanRef
              ? (
                <Fan
                  name={chat.fanDisplayName}
                  username={chat.fanUsername}
                  fanRef={chat.fanRef}
                  showLogin={fanNameCollides({ name: chat.fanDisplayName, fanRef: chat.fanRef }, colliding)}
                  {...(fanHref ? { href: fanHref, hint: "Карточка фана в Hub" } : {})}
                />
              )
              : fanTitle(row)}
          </h2>
          <p className="review-transcript__about">
            {about.flatMap((part, index) => (index === 0 ? [part] : [<span key={`s${index}`} aria-hidden> · </span>, part]))}
          </p>
        </div>
        <div className="review-transcript__side">
          <Legend />
          <div className="review-transcript__nav" aria-label="Соседние чаты">
            <IconButton icon={ChevronUp} label="Предыдущий чат — ↑ или K" size="sm" onClick={() => onStep(-1)} disabled={position.index <= 0} />
            <span className="review-transcript__pos">{formatCount(position.index + 1)} / {formatCount(position.count)}</span>
            <IconButton icon={ChevronDown} label="Следующий чат — ↓ или J" size="sm" onClick={() => onStep(1)} disabled={position.index >= position.count - 1} />
          </div>
        </div>
      </header>
      <div ref={scroller} className="review-transcript__scroll">
        <div className="review-transcript__messages">{rows}</div>
      </div>
    </section>
  );
}
