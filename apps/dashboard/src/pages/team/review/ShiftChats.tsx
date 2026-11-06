import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import type { ShiftReviewChat, ShiftReviewMessage, TeamShiftReviewResponse } from "@agency_hub_core/contracts";
import { normalizeDmMessageText } from "@agency_hub_core/shared";
import { SearchInput } from "@/components/shared/SearchInput";
import { Segmented } from "@/components/ui/Segmented";
import { Switch } from "@/components/ui/Switch";
import { formatCount, formatDateTime, formatMills, formatSeconds, formatTimeOfDay } from "@/lib/format";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import {
  CHAT_KINDS,
  CHAT_SHOWS,
  CHAT_SORTS,
  GAP_MINUTES,
  REPLY_NORM_SECONDS,
  aiButton,
  chatBusyIn,
  chatMatches,
  fanName,
  kindPasses,
  showPasses,
  sortSummaries,
  type ChatKindFilter,
  type ChatShow,
  type ChatSort,
  type ChatSummary,
} from "./shiftReviewView.js";

/**
 * The chats of the shift: a list on the left (who, how much each side wrote,
 * what the fan said, what is known of the chatter's texts), the transcript of
 * the picked one on the right. Each of the chatter's messages says where its
 * text came from, how long the fan had waited, whether the same text went to
 * other fans; a click on it opens the AI text and the draft beside the message
 * sent. What is chosen lives in the address: a link opens the same place.
 */

/** What the list shows; the page keeps it in the address. */
export interface ChatsView {
  chat: string | null;
  kind: ChatKindFilter;
  show: ChatShow;
  sort: ChatSort;
  page: string | null;
}

const KIND_WORDS: Record<ChatKindFilter, string> = { dialog: "Диалоги", touch: "Первое касание", all: "Все" };
const KIND_TITLES: Record<ChatKindFilter, string> = {
  dialog: "Чаты, где фан писал в смену",
  touch: "Писал только чаттер: приветствия и первые сообщения",
  all: "Все чаты смены, и те, где ждали ответа с прошлых смен",
};
const SHOW_WORDS: Record<ChatShow, string> = {
  all: "Все",
  waited: `Ждали > ${REPLY_NORM_SECONDS / 60} мин`,
  unanswered: "Без ответа в смену",
  inherited: "Ждут с прошлых смен",
  money: "PPV и деньги",
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
  reply: "Reply",
  fix: "Fix",
  hi: "Hi",
  ping: "Ping",
  coach: "Coach",
  hand: "набрано или вставлено руками",
  unknown: "кнопка неизвестна",
};

const MARK_WORDS = { dash: "длинное тире", cyrillic: "кириллица", leak: "служебный текст ИИ" } as const;

/** Texts of this many words or fewer are the chatter's unless a button put them there (the server's rule). */
const SHORT_WORDS = 3;

function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

/** One line of a message for the list: spaces folded, cut at `length`. */
function clip(text: string, length = 90): string {
  const flat = normalizeDmMessageText(text).replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function SummaryRow({ summary, active, showPage, onPick }: { summary: ChatSummary; active: boolean; showPage: boolean; onPick: () => void }) {
  const { chat } = summary;
  return (
    <li>
      <button type="button" className={`sr-chat${active ? " sr-chat-active" : ""}`} onClick={onPick} aria-pressed={active} data-chat={chat.key}>
        <span className="sr-chat-top">
          <span className="sr-chat-name">{fanName(chat)}</span>
          <span className="sr-chat-time">
            {summary.first === null ? "ждёт с прошлой смены" : `${formatTimeOfDay(summary.first)}–${formatTimeOfDay(summary.last!)}`}
          </span>
        </span>
        <span className="sr-chat-line">
          {showPage && <span>{chat.pageLabel}</span>}
          <span>чаттер {formatCount(summary.mine)} · фан {formatCount(summary.fan)}</span>
          {summary.others > 0 && <span className="team-faint">другие: {formatCount(summary.others)}</span>}
          {chat.fanLifetimeNetMills !== null && chat.fanLifetimeNetMills > 0 && <span className="team-faint">всего {formatMills(chat.fanLifetimeNetMills)}</span>}
        </span>
        {summary.firstFanText !== null && <span className="sr-chat-quote">«{clip(summary.firstFanText)}»</span>}
        {summary.lastFanText !== null && <span className="sr-chat-quote">…«{clip(summary.lastFanText)}»</span>}
        {summary.firstFanText === null && summary.firstMineText !== null && (
          <span className="sr-chat-quote sr-chat-quote-mine">чаттер: «{clip(summary.firstMineText)}»</span>
        )}
        <span className="sr-chat-tags">
          {summary.hi > 0 && <span className="sr-tag">Hi</span>}
          {summary.ai > 0 && <span className="sr-tag sr-tag-ai">ИИ {formatCount(summary.ai)}/{formatCount(summary.mine)}</span>}
          {summary.copied > 0 && <span className="sr-tag sr-tag-ai">мимо кнопки {formatCount(summary.copied)}</span>}
          {summary.fix > 0 && <span className="sr-tag">Fix {formatCount(summary.fix)}</span>}
          {summary.longestWaitSeconds !== null && summary.longestWaitSeconds > REPLY_NORM_SECONDS && (
            <span className="sr-tag sr-tag-wait">ждал ответа {formatSeconds(summary.longestWaitSeconds)}</span>
          )}
          {summary.unansweredInShift && (
            <span className="sr-tag sr-tag-wait">без ответа{summary.openWaitSeconds !== null && ` ${formatSeconds(summary.openWaitSeconds)}`}</span>
          )}
          {summary.waitingSinceBefore && <span className="sr-tag sr-tag-wait">ждёт с прошлой смены</span>}
          {summary.repeated > 0 && <span className="sr-tag">повторы {formatCount(summary.repeated)}</span>}
          {summary.ppv > 0 && <span className="sr-tag">PPV {formatCount(summary.bought)}/{formatCount(summary.ppv)}</span>}
          {chat.shiftNetMills > 0 && <span className="sr-tag sr-tag-money">{formatMills(chat.shiftNetMills)}</span>}
        </span>
      </button>
    </li>
  );
}

function OriginChip({ message }: { message: ShiftReviewMessage }) {
  const mine = message.mine!;
  if (mine.origin === null) return <span className="sr-tag">без текста</span>;
  if (mine.origin === "own") {
    if (mine.aiShare === null || mine.aiShare === 0) return <span className="sr-tag">не из ИИ хаба</span>;
    const short = message.text.trim().split(/\s+/).length <= SHORT_WORDS;
    return <span className="sr-tag">с ИИ хаба совпало {percent(mine.aiShare)}{short && " · короткий текст"}</span>;
  }
  if (mine.origin === "fix") return <span className="sr-tag">Fix своего черновика · {percent(mine.aiShare ?? 0)}</span>;
  const feature = FEATURE_WORDS[mine.aiFeature ?? ""] ?? mine.aiFeature ?? "ИИ";
  const how = aiButton(mine.composedWith) ? (mine.edited ? " · с правкой" : "")
    : mine.composedWith === "hand" ? " · вставлен мимо кнопки"
      : " · кнопка неизвестна";
  return (
    <span className="sr-tag sr-tag-ai">
      Текст ИИ: {feature}{mine.aiFeature === "improve-draft" ? " по команде" : ""} · {percent(mine.aiShare ?? 0)}{how}
    </span>
  );
}

function MessageDetails({ message }: { message: ShiftReviewMessage }) {
  const mine = message.mine!;
  return (
    <div className="sr-details">
      <p><span className="team-faint">Расширение записало:</span> {COMPOSED_WORDS[mine.composedWith ?? ""] ?? mine.composedWith ?? "ничего"}
        {mine.edited === true && ", правил после вставки"}{mine.edited === false && ", без правки"}
      </p>
      {mine.draft !== null && mine.draft !== "" && (
        <blockquote className="sr-quote"><span className="sr-quote-label">Черновик чаттера для Fix</span>{mine.draft}</blockquote>
      )}
      {mine.aiText !== null && (
        <blockquote className="sr-quote">
          <span className="sr-quote-label">Ближайший текст ИИ ({FEATURE_WORDS[mine.aiFeature ?? ""] ?? mine.aiFeature}){mine.aiShare !== null && ` · совпало ${percent(mine.aiShare)} слов`}</span>
          {mine.aiText}
        </blockquote>
      )}
      {mine.aiText === null && <p className="team-faint">Совпадений с текстами ИИ этого чата за полтора часа до сообщения нет.</p>}
    </div>
  );
}

function Bubble({ message, picked, showDraft }: { message: ShiftReviewMessage; picked: boolean; showDraft: boolean }) {
  const [open, setOpen] = useState(false);
  const fan = message.side === "fan";
  const mine = message.mine;
  const author = message.by === "other" ? `другой: ${message.byName ?? "?"}`
    : message.by === "none" ? "без автора"
      : message.by === "auto" ? "автосообщение"
        : null;
  const classes = ["sr-msg", fan ? "sr-msg-fan" : "sr-msg-page", mine ? "sr-msg-mine" : "", !message.inShift ? "sr-msg-before" : "", picked ? "sr-msg-picked" : ""].join(" ");
  const text = normalizeDmMessageText(message.text);
  const draft = showDraft && mine?.draft ? mine.draft.trim() : "";
  return (
    <div className={classes} data-at={message.at} data-ref={message.ref}>
      <div className="sr-bubble">
        {text !== "" ? <p className="whitespace-pre-wrap break-words">{text}</p> : <p className="team-faint">{message.media > 0 ? "без текста" : "пусто"}</p>}
        {draft !== "" && <p className="sr-draft"><span className="sr-draft-label">черновик:</span> {draft}</p>}
        <div className="sr-meta">
          <span>{message.inShift ? formatTimeOfDay(message.at) : formatDateTime(message.at)}</span>
          {message.media > 0 && <span>{formatCount(message.media)} {ruPlural(message.media, "файл", "файла", "файлов")}</span>}
          {message.priceMills !== null && <span>PPV {formatMills(message.priceMills)} · {message.bought ? "куплено" : "не куплено"}</span>}
          {message.tipMills !== null && <span>чаевые {formatMills(message.tipMills)}</span>}
          {message.mass && <span>рассылка</span>}
          {author && <span>{author}</span>}
        </div>
        {mine && (
          <div className="sr-facts">
            <button type="button" className="sr-facts-toggle" onClick={() => setOpen((was) => !was)} aria-expanded={open}>
              <OriginChip message={message} />
            </button>
            {mine.replySeconds !== null && (
              <span className={`sr-tag${mine.replySeconds > REPLY_NORM_SECONDS ? " sr-tag-wait" : ""}`}>фан ждал {formatSeconds(mine.replySeconds)}</span>
            )}
            {mine.repeats > 0 && <span className="sr-tag">тот же текст ещё в {formatCount(mine.repeats)} {ruPlural(mine.repeats, "чате", "чатах", "чатах")}</span>}
            {mine.marks.map((mark) => <span key={mark} className="sr-tag sr-tag-ai">{MARK_WORDS[mark]}</span>)}
          </div>
        )}
        {mine && open && <MessageDetails message={message} />}
      </div>
    </div>
  );
}

function Transcript({ data, chat, picked, showDrafts, position, onStep }: {
  data: TeamShiftReviewResponse;
  chat: ShiftReviewChat;
  picked: { from: number; to: number } | null;
  showDrafts: boolean;
  position: { index: number; count: number };
  onStep: (delta: number) => void;
}) {
  const location = useLocation();
  const scroller = useRef<HTMLDivElement | null>(null);
  const start = Date.parse(data.shift.startedAt);
  const wait = data.waits.find((one) => one.chat === chat.key && one.by === null);

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const target = picked === null
      ? box.querySelector<HTMLElement>(".sr-shift-start") ?? null
      : [...box.querySelectorAll<HTMLElement>("[data-at]")].find((node) => Date.parse(node.dataset.at!) >= picked.from) ?? null;
    if (target) box.scrollTop = Math.max(0, target.offsetTop - box.offsetTop - 24);
    else box.scrollTop = box.scrollHeight;
  }, [chat.key, picked]);

  const navigation = chat.fanRef === null
    ? null
    : buildFanProfileNavigation(chat.pageLabel, chat.platform, chat.fanRef, `${location.pathname}${location.search}`, fanName(chat));

  const rows: ReactNode[] = [];
  let previous: number | null = null;
  let startShown = false;
  if (chat.earlierHidden > 0) rows.push(<p key="earlier" className="sr-divider">ещё {formatCount(chat.earlierHidden)} {ruPlural(chat.earlierHidden, "сообщение", "сообщения", "сообщений")} раньше</p>);
  for (const message of chat.messages) {
    const at = Date.parse(message.at);
    if (!startShown && message.inShift) {
      rows.push(<p key="start" className="sr-divider sr-shift-start">Начало смены, {formatTimeOfDay(start)}</p>);
      startShown = true;
    } else if (previous !== null && at - previous >= GAP_MINUTES * 60_000) {
      rows.push(<p key={`gap-${message.ref}`} className="sr-divider">тишина {formatSeconds((at - previous) / 1000)}</p>);
    }
    rows.push(<Bubble key={message.ref} message={message} picked={picked !== null && at >= picked.from && at < picked.to} showDraft={showDrafts} />);
    previous = at;
  }
  if (!startShown) rows.push(<p key="start" className="sr-divider sr-shift-start">Смена, {formatTimeOfDay(start)}: сообщений нет</p>);

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
            {chat.fanLifetimeNetMills !== null && <> · потратил на странице {formatMills(chat.fanLifetimeNetMills)}</>}
            {chat.shiftNetMills > 0 && <> · за смену {formatMills(chat.shiftNetMills)}</>}
          </p>
        </div>
        <div className="sr-transcript-nav" aria-label="Соседние чаты">
          <button type="button" className="btn btn-sm" onClick={() => onStep(-1)} disabled={position.index === 0} title="Предыдущий чат (←)">←</button>
          <span className="sr-transcript-pos">{formatCount(position.index + 1)} из {formatCount(position.count)}</span>
          <button type="button" className="btn btn-sm" onClick={() => onStep(1)} disabled={position.index >= position.count - 1} title="Следующий чат (→)">→</button>
        </div>
      </header>
      <div ref={scroller} className="sr-messages">{rows}</div>
      {wait && (
        <p className="sr-waiting-note">
          Фан ждёт ответа с {formatDateTime(wait.since)}{Date.parse(wait.since) < start ? " — ещё до начала смены" : ""}.
        </p>
      )}
    </section>
  );
}

export function ShiftChats({ data, summaries, picked, onClearPick, view, onView }: {
  data: TeamShiftReviewResponse;
  summaries: readonly ChatSummary[];
  picked: { from: number; to: number } | null;
  onClearPick: () => void;
  view: ChatsView;
  onView: (change: Partial<ChatsView>) => void;
}) {
  const [search, setSearch] = useState("");
  const [showDrafts, setShowDrafts] = useState(true);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const pages = data.shift.pages;

  // Every count follows what narrows the list: the page, the search, the picked minutes.
  const base = useMemo(() => summaries.filter((summary) => (view.page === null || summary.chat.pageLabel === view.page)
    && chatMatches(summary.chat, search)
    && (picked === null || chatBusyIn(data, summary.chat, picked.from, picked.to))), [summaries, view.page, search, picked, data]);
  const kindCounts = useMemo(() => new Map(CHAT_KINDS.map((one) => [one, base.filter((summary) => kindPasses(summary, one)).length])), [base]);
  const ofKind = useMemo(() => base.filter((summary) => kindPasses(summary, view.kind)), [base, view.kind]);
  const showCounts = useMemo(() => new Map(CHAT_SHOWS.map((one) => [one, ofKind.filter((summary) => showPasses(summary, one)).length])), [ofKind]);
  const shown = useMemo(() => sortSummaries(ofKind.filter((summary) => showPasses(summary, view.show)), view.sort), [ofKind, view.show, view.sort]);
  const found = shown.findIndex((summary) => summary.chat.key === view.chat);
  const activeIndex = found >= 0 ? found : 0;
  const active = shown[activeIndex] ?? null;

  const pick = (key: string) => {
    onView({ chat: key });
    // On a narrow screen the transcript is under the list: bring it up.
    if (window.matchMedia("(max-width: 1023px)").matches) transcriptRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const step = (delta: number) => {
    const next = shown[activeIndex + delta];
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
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      stepRef.current(event.key === "ArrowRight" ? 1 : -1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Keep the chosen row in sight inside the list; the page itself does not move.
  useEffect(() => {
    const list = listRef.current;
    const row = active ? list?.querySelector<HTMLElement>(`[data-chat="${CSS.escape(active.chat.key)}"]`) : null;
    if (!list || !row) return;
    const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (delta < 0) list.scrollTop += delta;
    else if (delta + row.offsetHeight > list.clientHeight) list.scrollTop += delta + row.offsetHeight - list.clientHeight;
  }, [active]);

  const narrowed = view.show !== "all" || view.page !== null || search.trim() !== "";

  return (
    <div className="sr-chats">
      <div className="sr-chats-bar">
        <Segmented
          label="Какие чаты"
          value={view.kind}
          onChange={(value) => onView({ kind: value, chat: null })}
          options={CHAT_KINDS.map((one) => ({ value: one, label: KIND_WORDS[one], title: KIND_TITLES[one], count: formatCount(kindCounts.get(one) ?? 0) }))}
        />
        <Segmented
          label="Что в них было"
          value={view.show}
          onChange={(value) => onView({ show: value, chat: null })}
          options={CHAT_SHOWS.map((one) => ({ value: one, label: SHOW_WORDS[one], count: formatCount(showCounts.get(one) ?? 0) }))}
        />
      </div>
      <div className="sr-chats-bar">
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
        <label className="sr-switch">
          <Switch checked={showDrafts} onChange={setShowDrafts} label="Черновики Fix под сообщениями" />
          <span>Черновики Fix</span>
        </label>
      </div>
      {picked !== null && (
        <p className="sr-picked">
          Только чаты {formatTimeOfDay(picked.from)}–{formatTimeOfDay(picked.to)}: {formatCount(shown.length)}.
          {" "}<button type="button" className="link" onClick={onClearPick}>Показать всю смену</button>
        </p>
      )}
      {shown.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Таких чатов нет</p>
          {narrowed && (
            <button type="button" className="btn btn-sm" onClick={() => { setSearch(""); onView({ show: "all", page: null, chat: null }); }}>Сбросить фильтры</button>
          )}
        </div>
      ) : (
        <div className="sr-chats-grid">
          <ul ref={listRef} className="sr-chat-list" aria-label="Чаты смены">
            {shown.map((summary) => (
              <SummaryRow key={summary.chat.key} summary={summary} active={summary.chat.key === active?.chat.key} showPage={pages.length > 1 && view.page === null} onPick={() => pick(summary.chat.key)} />
            ))}
          </ul>
          <div ref={transcriptRef} className="sr-transcript-wrap">
            {active && (
              <Transcript
                data={data}
                chat={active.chat}
                picked={picked}
                showDrafts={showDrafts}
                position={{ index: activeIndex, count: shown.length }}
                onStep={step}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
