import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { SHIFT_REVIEW_WAIT_HORIZON_HOURS, type ShiftReviewChat, type ShiftReviewMessage, type TeamShiftReviewResponse } from "@agency_hub_core/contracts";
import { normalizeDmMessageText } from "@agency_hub_core/shared";
import { SearchInput } from "@/components/shared/SearchInput";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { formatCount, formatDateTime, formatMills, formatTimeOfDay } from "@/lib/format";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import {
  CHAT_KINDS,
  CHAT_SHOWS,
  CHAT_SORTS,
  GAP_MINUTES,
  REPLY_NORM_SECONDS,
  aiButton,
  cameBack,
  chatBusyIn,
  chatMatches,
  fanName,
  isHi,
  kindPasses,
  plainAiText,
  showPasses,
  sortSummaries,
  waitText,
  type ChatKindFilter,
  type ChatShow,
  type ChatSort,
  type ChatSummary,
  type ReviewWait,
} from "./shiftReviewView.js";

/**
 * The chats of the shift: a list on the left (who, how much each side wrote,
 * what the fan said, where the chatter's texts came from), the transcript of
 * the picked one on the right. Under each of the chatter's messages one line
 * says where its text came from and how long the fan had waited; a click on it
 * opens the AI text and the draft. The bubble's left edge has the colour of
 * where the text came from. What is chosen lives in the address: a link opens
 * the same place.
 */

/** What the list shows; the page keeps it in the address. */
export interface ChatsView {
  chat: string | null;
  kind: ChatKindFilter;
  show: ChatShow;
  sort: ChatSort;
  page: string | null;
}

const KIND_WORDS: Record<ChatKindFilter, string> = {
  dialog: "Диалоги",
  touch: "Первое касание",
  colleague: "Вели другие",
  waiting: "Ждали с прошлых смен",
  all: "Все",
};
const KIND_TITLES: Record<ChatKindFilter, string> = {
  dialog: "Фан писал в смену, или фану, который ждал, в смену ответили",
  touch: "Чаттер написал первым, фан в смену не ответил: Hi, Ping и другие",
  colleague: "Чаттер в них не писал, в смену их вели коллеги: их ожидания не в числах этого разбора",
  waiting: "Фан ждал ответа ещё до смены, в смену не писал, ответа в смену не было",
  all: "Все чаты смены",
};
const SHOW_WORDS: Record<ChatShow, string> = {
  all: "Без отбора",
  waited: `Ждали > ${REPLY_NORM_SECONDS / 60} мин`,
  unanswered: "Без ответа",
  money: "PPV и деньги",
};
const SHOW_TITLES: Record<ChatShow, string> = {
  all: "Все чаты выбранного вида",
  waited: `Фан ждал ответа чаттера дольше ${REPLY_NORM_SECONDS / 60} мин, и ответ в смену был (ждавшие с прошлых смен — с начала смены). Без ответа — в соседнем отборе`,
  unanswered: "Фан писал в смену, ответа чаттера до конца смены не было",
  money: "Чаттер отправил PPV, или продажа фану в смену засчитана смене",
};
const SORT_WORDS: Record<ChatSort, string> = { messages: "Больше сообщений", time: "По времени", wait: "Дольше ждали", money: "Больше денег" };

const FEATURE_WORDS: Record<string, string> = {
  "fast-reply": "Reply",
  "improve-draft": "Fix",
  "coach-chat": "Coach",
  ping: "Ping",
  "hi-greeting": "Hi",
};

const COMPOSED_WORDS: Record<string, string> = {
  reply: "кнопка Reply",
  fix: "кнопка Fix",
  hi: "кнопка Hi",
  ping: "кнопка Ping",
  coach: "кнопка Coach",
  hand: "без кнопки — набрано или вставлено вручную",
  unknown: "кнопка неизвестна",
};

const MARK_WORDS = { dash: "длинное тире", cyrillic: "кириллица", leak: "служебный текст ИИ" } as const;

/** Texts of this many words or fewer are the chatter's unless a button put them there (the server's rule). */
const SHORT_WORDS = 3;
const HORIZON_DAYS = SHIFT_REVIEW_WAIT_HORIZON_HOURS / 24;

function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

/** One line of a message for the list: spaces folded, cut at `length`. */
function clip(text: string, length = 140): string {
  const flat = normalizeDmMessageText(text).replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/** The Moscow day of an instant (Moscow has no DST). */
function moscowDay(at: number): string {
  return new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
}

/** A moment near the shift: the time alone on the shift's first day, with the date on another. */
function momentText(at: number, shiftStart: number): string {
  return moscowDay(at) === moscowDay(shiftStart) ? formatTimeOfDay(at) : formatDateTime(new Date(at).toISOString());
}

function names(list: ReadonlyArray<{ name: string; messages: number }>): string {
  return list.map((one) => `${one.name} ${formatCount(one.messages)}`).join(", ");
}

/** What the chatter's texts in a chat were made of, in the screen's words. */
function composition(summary: ChatSummary): string {
  const parts: string[] = [];
  if (summary.ai > 0) parts.push(`ИИ ${formatCount(summary.ai)}${summary.copied > 0 ? `, из них без кнопки ${formatCount(summary.copied)}` : ""}`);
  if (summary.fix > 0) parts.push(`Fix своего ${formatCount(summary.fix)}`);
  if (summary.own > 0) parts.push(`с ИИ не совпало ${formatCount(summary.own)}`);
  if (summary.hi > 0) parts.push(summary.hi === 1 ? "Hi" : `Hi ${formatCount(summary.hi)}`);
  return parts.join(" · ");
}

function SummaryRow({ summary, active, showPage, outside, shiftStart, ongoing, onPick }: {
  summary: ChatSummary;
  active: boolean;
  showPage: boolean;
  outside: boolean;
  shiftStart: number;
  ongoing: boolean;
  onPick: () => void;
}) {
  const { chat } = summary;
  const made = composition(summary);
  const slot = summary.first !== null
    ? `${formatTimeOfDay(summary.first)}–${formatTimeOfDay(summary.last!)}`
    : summary.openSince !== null ? `${ongoing ? "ждёт" : "ждал"} с ${momentText(summary.openSince, shiftStart)}` : "";
  return (
    <li>
      <button type="button" className={`sr-chat${active ? " sr-chat-active" : ""}`} onClick={onPick} aria-current={active ? "true" : undefined} data-chat={chat.key}>
        <span className="sr-chat-top">
          <span className="sr-chat-name">{fanName(chat)}</span>
          <span className="sr-chat-time">{slot}</span>
        </span>
        <span className="sr-chat-line">
          {outside && <span className="sr-chat-outside">вне отбора</span>}
          {showPage && <span>{chat.pageLabel}</span>}
          {summary.kind === "colleague" ? <span>у коллег: {names(summary.colleagues)} · фан {formatCount(summary.fan)}</span>
            : summary.kind === "waiting" ? <span>в смену в чате не писали</span>
              : <span>чаттер {formatCount(summary.mine)} · фан {formatCount(summary.fan)}</span>}
          {summary.kind !== "colleague" && summary.colleagues.length > 0 && <span>ещё {names(summary.colleagues)}</span>}
          {chat.fanLifetimeNetMills !== null && chat.fanLifetimeNetMills > 0 && <span>принёс {formatMills(chat.fanLifetimeNetMills)}</span>}
        </span>
        {summary.firstFanText !== null && <span className="sr-chat-quote">«{clip(summary.firstFanText)}»</span>}
        {summary.lastFanText !== null && <span className="sr-chat-quote">…«{clip(summary.lastFanText)}»</span>}
        {summary.firstFanText === null && summary.firstMineText !== null && (
          <span className="sr-chat-quote sr-chat-quote-mine">чаттер: «{clip(summary.firstMineText)}»</span>
        )}
        {summary.lastFanBeforeText !== null && summary.firstMineText === null && (
          <span className="sr-chat-quote">до смены: «{clip(summary.lastFanBeforeText)}»</span>
        )}
        {made !== "" && <span className="sr-chat-made">{made}</span>}
        <span className="sr-chat-tags">
          {summary.longestWaitSeconds !== null && summary.longestWaitSeconds > REPLY_NORM_SECONDS && (
            <span className="sr-tag">
              ждал ответа {waitText(summary.longestWaitSeconds)}{summary.longestWaitInherited && " с начала смены"}
              {summary.longestWaitLastFanSeconds !== null && `, снова писал за ${waitText(summary.longestWaitLastFanSeconds)} до ответа`}
              {summary.longestWaitAnsweredBy !== null && ` · ответил ${summary.longestWaitAnsweredBy}`}
            </span>
          )}
          {summary.unansweredInShift && summary.openWaitSeconds !== null && (
            <span className="sr-tag sr-tag-strong" title={summary.openSince !== null ? `Фан ждал ответа с ${formatDateTime(new Date(summary.openSince).toISOString())}` : undefined}>
              {summary.unansweredLate
                ? ongoing ? `написал ${waitText(summary.openWaitSeconds)} назад` : `написал за ${waitText(summary.openWaitSeconds)} до конца смены`
                : `${ongoing ? "пока " : ""}без ответа ${waitText(summary.openWaitSeconds)}${summary.openSince !== null && summary.openSince < shiftStart ? " с начала смены" : ""}`}
            </span>
          )}
          {summary.openHeldBy !== null && <span className="sr-tag">без ответа после сообщения {summary.openHeldBy} — не в счёте</span>}
          {summary.repeated > 0 && <span className="sr-tag">повторы {formatCount(summary.repeated)}</span>}
          {summary.ppv > 0 && <span className="sr-tag">PPV куплено {formatCount(summary.bought)} из {formatCount(summary.ppv)}</span>}
          {summary.heldNetMills > 0 && <span className="sr-tag">в смену {formatMills(summary.heldNetMills)}</span>}
          {summary.others.length > 0 && <span className="sr-tag sr-tag-faint" title={OTHERS_TITLE}>{othersText(summary)}</span>}
        </span>
      </button>
    </li>
  );
}

const OTHERS_TITLE = "Продажи этому фану в смену, которые не в продажах смены: их засчитали коллеге, который последним писал фану или держал страницу, или ни одной смене";

/** The fan's money in the shift that is not the chatter's: «ещё $303.20 продал Nikita». */
function othersText(summary: ChatSummary): string {
  const parts = summary.others.map((one) => `${formatMills(one.netMills)} ${one.name === null ? "ни в чьей смене" : `продал ${one.name}`}`);
  return `${summary.heldNetMills > 0 ? "ещё " : ""}${parts.join(", ")}`;
}

/** Where the bubble's text came from, for its colour. */
function originKey(mine: NonNullable<ShiftReviewMessage["mine"]>): string {
  if (mine.origin === "ai") return isHi(mine) ? "hi" : "ai";
  return mine.origin ?? "none";
}

/** The one line under the chatter's message: where its text came from. */
function originText(message: ShiftReviewMessage): string {
  const mine = message.mine!;
  const share = mine.aiShare ?? 0;
  const matched = share < 1 && share > 0 ? ` · совпало ${percent(share)}` : "";
  if (mine.origin === null) return message.text.trim() !== "" ? "без слов — не сравнивали" : "без текста";
  if (mine.origin === "own") {
    if (aiButton(mine.composedWith) && share === 0) return `${COMPOSED_WORDS[mine.composedWith!]} — текст ИИ не найден`;
    if (share === 0) return "с ИИ не совпало";
    const short = message.text.trim().split(/\s+/).length <= SHORT_WORDS;
    return `с ИИ совпало ${percent(share)}${short ? " · короткий текст" : " — меньше 70 %"}`;
  }
  if (mine.origin === "fix") return `Fix своего черновика${matched}`;
  const feature = FEATURE_WORDS[mine.aiFeature ?? ""] ?? mine.aiFeature ?? "?";
  const how = aiButton(mine.composedWith) ? (mine.edited ? " · с правкой" : "")
    : mine.composedWith === "hand" ? " · без кнопки"
      : " · кнопка неизвестна";
  return `ИИ: ${feature}${mine.aiFeature === "improve-draft" ? " по команде" : ""}${matched}${how}`;
}

function MessageDetails({ message }: { message: ShiftReviewMessage }) {
  const mine = message.mine!;
  const draftLabel = mine.origin === "own" ? "Черновик ближайшего Fix — не этого сообщения" : "Черновик чаттера для Fix";
  return (
    <div className="sr-details">
      <p><span className="team-faint">Расширение записало:</span> {COMPOSED_WORDS[mine.composedWith ?? ""] ?? mine.composedWith ?? "ничего"}
        {mine.edited === true && ", после вставки текст правили"}{mine.edited === false && ", без правки"}
      </p>
      {mine.draft !== null && mine.draft !== "" && (
        <blockquote className="sr-quote"><span className="sr-quote-label">{draftLabel}</span>{mine.draft}</blockquote>
      )}
      {mine.aiText !== null && (
        <blockquote className="sr-quote">
          <span className="sr-quote-label">Ближайший текст ИИ ({FEATURE_WORDS[mine.aiFeature ?? ""] ?? mine.aiFeature}){mine.aiShare !== null && ` · совпало ${percent(mine.aiShare)} слов`}</span>
          {plainAiText(mine.aiText)}
        </blockquote>
      )}
      {mine.aiText === null && <p className="team-faint">Совпадений с текстами ИИ этого чата за полтора часа до сообщения нет.</p>}
    </div>
  );
}

function Bubble({ message, picked, showDraft, answered, shiftStart, username }: {
  message: ShiftReviewMessage;
  picked: boolean;
  showDraft: boolean;
  /** The wait this message answered. */
  answered: ReviewWait | null;
  shiftStart: number;
  username: string;
}) {
  const [open, setOpen] = useState(false);
  const fan = message.side === "fan";
  const mine = message.mine;
  const author = message.by === "other" ? message.byName ?? "коллега"
    : message.by === "none" ? "автор не записан"
      : message.by === "auto" ? "автосообщение"
        : message.by === "me" && !message.inShift ? `${username}, до смены`
          : null;
  const classes = ["sr-msg", fan ? "sr-msg-fan" : "sr-msg-page", mine ? "sr-msg-mine" : "", !message.inShift ? "sr-msg-before" : "", picked ? "sr-msg-picked" : ""].join(" ");
  const text = normalizeDmMessageText(message.text);
  const fixDraft = mine !== null && (mine.origin === "fix" || (mine.origin === "ai" && mine.aiFeature === "improve-draft"));
  const draft = showDraft && fixDraft && mine?.draft ? mine.draft.trim() : "";
  const lastFanGap = answered === null ? null : (answered.to - answered.lastFanAt) / 1000;
  const again = answered !== null && lastFanGap !== null && cameBack(answered.seconds, lastFanGap, answered.fanQuietSeconds) ? `, снова писал за ${waitText(lastFanGap)} до ответа` : "";
  const waited = mine === null || mine.replySeconds === null ? null
    : answered !== null && answered.inherited ? `фан ждал с ${momentText(answered.since, shiftStart)}, в смену ${waitText(mine.replySeconds)}${again}`
      : `фан ждал ${waitText(mine.replySeconds)}${again}`;
  return (
    <div className={classes} data-at={message.at} data-ref={message.ref} data-origin={mine ? originKey(mine) : undefined}>
      <div className="sr-bubble">
        {text !== "" ? <p className="whitespace-pre-wrap break-words">{text}</p> : <p className="team-faint">{message.media > 0 ? "без текста" : "пусто"}</p>}
        {draft !== "" && <p className="sr-draft"><span className="sr-draft-label">черновик:</span> {draft}</p>}
        <div className="sr-meta">
          <span>{message.inShift ? formatTimeOfDay(message.at) : formatDateTime(message.at)}</span>
          {message.media > 0 && <span>{formatCount(message.media)} {ruPlural(message.media, "файл", "файла", "файлов")}</span>}
          {message.priceMills !== null && <span>PPV {formatMills(message.priceMills)} · {message.bought ? "куплено" : "покупки не видно"}</span>}
          {message.tipMills !== null && <span>чаевые {formatMills(message.tipMills)}</span>}
          {message.mass && <span>рассылка</span>}
          {author && <span>{author}</span>}
        </div>
        {mine && (
          <div className="sr-facts">
            <button type="button" className="sr-fact-line" onClick={() => setOpen((was) => !was)} aria-expanded={open}>
              <span className="sr-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
              {originText(message)}{waited && <> · {waited}</>}
            </button>
            {mine.repeats > 0 && <span className="sr-tag">тот же текст ещё в {formatCount(mine.repeats)} {ruPlural(mine.repeats, "чате", "чатах", "чатах")}</span>}
            {mine.marks.map((mark) => <span key={mark} className="sr-tag">{MARK_WORDS[mark]}</span>)}
          </div>
        )}
        {mine && open && <MessageDetails message={message} />}
      </div>
    </div>
  );
}

function OriginLegend() {
  return (
    <p className="sr-legend" aria-hidden="true">
      <span className="sr-legend-key" data-origin="ai" />ИИ
      <span className="sr-legend-key" data-origin="hi" />Hi
      <span className="sr-legend-key" data-origin="fix" />Fix своего
      <span className="sr-legend-key" data-origin="own" />с ИИ не совпало
      <span className="team-faint"> · клик по строке под сообщением — текст ИИ и черновик</span>
    </p>
  );
}

function Transcript({ data, chat, summary, waits, picked, showDrafts, position, onStep }: {
  data: TeamShiftReviewResponse;
  chat: ShiftReviewChat;
  summary: ChatSummary;
  waits: readonly ReviewWait[];
  picked: { from: number; to: number } | null;
  showDrafts: boolean;
  position: { index: number; count: number };
  onStep: (delta: number) => void;
}) {
  const location = useLocation();
  const scroller = useRef<HTMLDivElement | null>(null);
  const start = Date.parse(data.shift.startedAt);
  const ongoing = data.shift.ongoing;
  const chatWaits = waits.filter((one) => one.chat === chat.key);
  const open = chatWaits.find((one) => one.by === null) ?? null;
  const waitByAnswer = new Map(chatWaits.filter((one) => one.by === "me").map((one) => [one.to, one]));

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const target = picked === null
      ? box.querySelector<HTMLElement>(".sr-shift-start") ?? null
      : [...box.querySelectorAll<HTMLElement>("[data-at]")].find((node) => Date.parse(node.dataset.at!) >= picked.from) ?? null;
    if (target) box.scrollTop = Math.max(0, target.offsetTop - box.offsetTop - 24);
    else box.scrollTop = box.scrollHeight;
    // Primitive deps: a new `picked` object with the same minutes must not throw the reader back.
  }, [chat.key, picked?.from, picked?.to]);

  const navigation = chat.fanRef === null
    ? null
    : buildFanProfileNavigation(chat.pageLabel, chat.platform, chat.fanRef, `${location.pathname}${location.search}`, fanName(chat));

  const rows: ReactNode[] = [];
  let previous: number | null = null;
  let startShown = false;
  if (chat.earlierHidden > 0) {
    rows.push(
      <p key="earlier" className="sr-divider">
        ещё {formatCount(chat.earlierHidden)} {ruPlural(chat.earlierHidden, "сообщение", "сообщения", "сообщений")} за {HORIZON_DAYS} {ruPlural(HORIZON_DAYS, "день", "дня", "дней")} до смены
        {navigation && <> — <Link to={navigation.to} state={navigation.state} className="team-link">вся переписка в профиле фана</Link></>}
      </p>,
    );
  }
  for (const message of chat.messages) {
    const at = Date.parse(message.at);
    if (!startShown && message.inShift) {
      rows.push(<p key="start" className="sr-divider sr-shift-start">Начало смены, {formatTimeOfDay(start)}</p>);
      startShown = true;
      if (at - start >= GAP_MINUTES * 60_000) rows.push(<p key="start-gap" className="sr-divider">тишина {waitText((at - start) / 1000)}</p>);
    } else if (previous !== null && at - previous >= GAP_MINUTES * 60_000) {
      rows.push(<p key={`gap-${message.ref}`} className="sr-divider">тишина {waitText((at - previous) / 1000)}</p>);
    }
    rows.push(
      <Bubble
        key={message.ref}
        message={message}
        picked={picked !== null && at >= picked.from && at < picked.to}
        showDraft={showDrafts}
        answered={message.mine !== null ? waitByAnswer.get(at) ?? null : null}
        shiftStart={start}
        username={data.shift.username}
      />,
    );
    previous = at;
  }
  if (!startShown) rows.push(<p key="start" className="sr-divider sr-shift-start">Смена, {formatTimeOfDay(start)}: сообщений нет</p>);

  const note = open === null ? null
    : ongoing
      ? `Фан ждёт ответа с ${momentText(open.since, start)}${open.inherited ? " — ещё до начала смены" : ""}, на ${formatTimeOfDay(data.serverNow)}.`
      : open.inherited
        ? `К концу смены фан ждал ответа с ${formatDateTime(new Date(open.since).toISOString())} — ещё до её начала.`
        : `К концу смены фан ждал ответа ${waitText(open.seconds)} — с ${formatTimeOfDay(open.since)}.`;
  const holder = open?.heldBy ?? summary.colleagues[0]?.name ?? "коллеги";
  const heldNote = open !== null && !open.his
    ? ` Не в счёте чаттера: перед ожиданием писал(а) ${holder}, и у ${holder} есть сообщения на этой странице в последние ${REPLY_NORM_SECONDS / 60} минут смены.`
    : "";

  return (
    <section className="sr-transcript" aria-label={`Переписка с ${fanName(chat)}`}>
      <header className="sr-transcript-head">
        <div className="min-w-0">
          <h3 className="sr-transcript-title">
            {navigation ? <Link to={navigation.to} state={navigation.state} className="team-link">{fanName(chat)}</Link> : fanName(chat)}
          </h3>
          <p className="team-muted">
            {chat.pageLabel}
            {chat.fanUsername && chat.fanUsername !== fanName(chat) && <> · @{chat.fanUsername}</>}
            {chat.fanLifetimeNetMills !== null && <> · принёс странице за всё время {formatMills(chat.fanLifetimeNetMills)} (после комиссии)</>}
            {summary.heldNetMills > 0 && <> · в смену {formatMills(summary.heldNetMills)}</>}
            {summary.others.length > 0 && <span className="team-faint" title={OTHERS_TITLE}> · {othersText(summary)}</span>}
            {summary.colleagues.length > 0 && <> · в смену писали также {names(summary.colleagues)}</>}
          </p>
        </div>
        <div className="sr-transcript-nav" aria-label="Соседние чаты">
          <button type="button" className="btn btn-sm" onClick={() => onStep(-1)} disabled={position.index === 0} title="Предыдущий чат (←)">←</button>
          <span className="sr-transcript-pos">{formatCount(position.index + 1)} из {formatCount(position.count)}</span>
          <button type="button" className="btn btn-sm" onClick={() => onStep(1)} disabled={position.index >= position.count - 1} title="Следующий чат (→)">→</button>
        </div>
      </header>
      <OriginLegend />
      <div ref={scroller} className="sr-messages">{rows}</div>
      {note && <p className="sr-waiting-note">{note}{heldNote}</p>}
    </section>
  );
}

export function ShiftChats({ data, summaries, waits, picked, onClearPick, onReset, view, onView }: {
  data: TeamShiftReviewResponse;
  summaries: readonly ChatSummary[];
  waits: readonly ReviewWait[];
  picked: { from: number; to: number } | null;
  onClearPick: () => void;
  /** Drops every narrowing at once: the filter, the page, the picked minutes. */
  onReset: () => void;
  view: ChatsView;
  onView: (change: Partial<ChatsView>) => void;
}) {
  const [search, setSearch] = useState("");
  const [showDrafts, setShowDrafts] = useState(true);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const pages = data.shift.pages;
  const start = Date.parse(data.shift.startedAt);
  const pickFrom = picked?.from ?? null;
  const pickTo = picked?.to ?? null;

  // Every count follows what narrows the list: the page, the search, the picked minutes.
  const base = useMemo(() => summaries.filter((summary) => (view.page === null || summary.chat.pageLabel === view.page)
    && chatMatches(summary.chat, search)
    && (pickFrom === null || pickTo === null || chatBusyIn(summary.chat, waits, pickFrom, pickTo))), [summaries, waits, view.page, search, pickFrom, pickTo]);
  const kindCounts = useMemo(() => new Map(CHAT_KINDS.map((one) => [one, base.filter((summary) => kindPasses(summary, one)).length])), [base]);
  const touchHi = useMemo(() => base.filter((summary) => summary.kind === "touch" && summary.hi > 0).length, [base]);
  const ofKind = useMemo(() => base.filter((summary) => kindPasses(summary, view.kind)), [base, view.kind]);
  const showCounts = useMemo(() => new Map(CHAT_SHOWS.map((one) => [one, ofKind.filter((summary) => showPasses(summary, one)).length])), [ofKind]);
  const shown = useMemo(() => sortSummaries(ofKind.filter((summary) => showPasses(summary, view.show)), view.sort), [ofKind, view.show, view.sort]);
  // A chat named in the address that the filters hide stays open, on top, marked.
  const pinned = view.chat !== null && !shown.some((summary) => summary.chat.key === view.chat)
    ? summaries.find((summary) => summary.chat.key === view.chat) ?? null
    : null;
  const list = pinned ? [pinned, ...shown] : shown;
  const found = list.findIndex((summary) => summary.chat.key === view.chat);
  const activeIndex = found >= 0 ? found : 0;
  const active = list[activeIndex] ?? null;
  // Kinds a shift has none of are not offered; the chosen one always is.
  const kinds = CHAT_KINDS.filter((one) => one === "dialog" || one === "all" || one === view.kind || summaries.some((summary) => summary.kind === one));

  const pick = (key: string) => {
    onView({ chat: key });
    // On a narrow screen the transcript is under the list: bring it up.
    if (window.matchMedia("(max-width: 1023px)").matches) transcriptRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const step = (delta: number) => {
    const next = list[activeIndex + delta];
    if (next) onView({ chat: next.chat.key });
  };

  // ← and → walk the list, unless the keys are typing somewhere.
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], dialog, [role='application']")) return;
      event.preventDefault();
      stepRef.current(event.key === "ArrowRight" ? 1 : -1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Keep the chosen row in sight inside the list; the page itself does not move.
  const activeKey = active?.chat.key ?? null;
  useEffect(() => {
    const box = listRef.current;
    const row = activeKey ? box?.querySelector<HTMLElement>(`[data-chat="${CSS.escape(activeKey)}"]`) : null;
    if (!box || !row) return;
    const delta = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (delta < 0) box.scrollTop += delta;
    else if (delta + row.offsetHeight > box.clientHeight) box.scrollTop += delta + row.offsetHeight - box.clientHeight;
  }, [activeKey]);

  const narrowed = view.show !== "all" || view.page !== null || search.trim() !== "" || picked !== null;

  return (
    <div className="sr-chats">
      <div className="sr-chats-bar">
        <Segmented
          label="Какие чаты"
          value={view.kind}
          onChange={(value) => onView({ kind: value, chat: null })}
          options={kinds.map((one) => ({
            value: one,
            label: KIND_WORDS[one],
            title: one === "touch" && touchHi > 0 ? `${KIND_TITLES.touch}. С Hi — ${formatCount(touchHi)}` : KIND_TITLES[one],
            count: one === "touch" && touchHi > 0 ? `${formatCount(kindCounts.get(one) ?? 0)} · Hi ${formatCount(touchHi)}` : formatCount(kindCounts.get(one) ?? 0),
          }))}
        />
      </div>
      <div className="sr-chats-bar">
        <Segmented
          label="Отбор"
          value={view.show}
          onChange={(value) => onView({ show: value, chat: null })}
          options={CHAT_SHOWS.map((one) => ({ value: one, label: SHOW_WORDS[one], title: SHOW_TITLES[one], count: one === "all" ? undefined : formatCount(showCounts.get(one) ?? 0) }))}
        />
        <select className="select w-auto" aria-label="Порядок чатов" value={view.sort} onChange={(event) => onView({ sort: event.target.value as ChatSort })}>
          {CHAT_SORTS.map((one) => <option key={one} value={one}>{SORT_WORDS[one]}</option>)}
        </select>
        {pages.length > 1 && (
          <select className="select w-auto" aria-label="Страница" value={view.page ?? ""} onChange={(event) => onView({ page: event.target.value === "" ? null : event.target.value, chat: null })}>
            <option value="">Все страницы</option>
            {pages.map((page) => <option key={page.pageLabel} value={page.pageLabel}>{page.pageLabel}</option>)}
          </select>
        )}
        <SearchInput value={search} onChange={setSearch} placeholder="Фан или слово из переписки" />
        <label className="sr-switch" title="Русский черновик чаттера над текстом, который сделал из него Fix">
          <Switch checked={showDrafts} onChange={setShowDrafts} label="Черновики Fix под сообщениями" />
          <span>Черновики Fix</span>
        </label>
      </div>
      {picked !== null && (
        <p className="sr-picked">
          Только чаты {formatTimeOfDay(picked.from)}–{formatTimeOfDay(picked.to)}: в этом виде {formatCount(shown.length)}.
          {" "}<button type="button" className="link" onClick={onClearPick}>Показать всю смену</button>
        </p>
      )}
      {list.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Таких чатов нет</p>
          {narrowed && (
            <button type="button" className="btn btn-sm" onClick={() => { setSearch(""); onReset(); }}>Сбросить отбор</button>
          )}
        </div>
      ) : (
        <div className="sr-chats-grid">
          <ul ref={listRef} className="sr-chat-list" aria-label="Чаты смены">
            {list.map((summary) => (
              <SummaryRow
                key={summary.chat.key}
                summary={summary}
                active={summary.chat.key === active?.chat.key}
                showPage={pages.length > 1 && view.page === null}
                outside={summary === pinned}
                shiftStart={start}
                ongoing={data.shift.ongoing}
                onPick={() => pick(summary.chat.key)}
              />
            ))}
          </ul>
          <div ref={transcriptRef} className="sr-transcript-wrap">
            {active && (
              <Transcript
                data={data}
                chat={active.chat}
                summary={active}
                waits={waits}
                picked={picked}
                showDrafts={showDrafts}
                position={{ index: activeIndex, count: list.length }}
                onStep={step}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
