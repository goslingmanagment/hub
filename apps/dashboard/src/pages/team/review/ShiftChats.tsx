import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import type { ShiftReviewChat, ShiftReviewMessage, TeamShiftReviewResponse } from "@agency_hub_core/contracts";
import { normalizeDmMessageText } from "@agency_hub_core/shared";
import { SearchInput } from "@/components/shared/SearchInput";
import { Segmented } from "@/components/ui/Segmented";
import { formatCount, formatDateTime, formatMills, formatSeconds, formatTimeOfDay } from "@/lib/format";
import { buildFanProfileNavigation } from "@/lib/navigation";
import { ruPlural } from "@/lib/plural";
import {
  CHAT_FILTERS,
  GAP_MINUTES,
  REPLY_NORM_SECONDS,
  aiButton,
  chatBusyIn,
  chatMatches,
  chatPasses,
  fanName,
  type ChatFilter,
  type ChatSummary,
} from "./shiftReviewView.js";

/**
 * The chats of the shift: a list on the left (who, how much each side wrote,
 * what is known of the chatter's texts), the transcript of the picked one on
 * the right. Each of the chatter's messages says where its text came from, how
 * long the fan had waited, whether the same text went to other fans; a click
 * on it opens the AI text and the draft beside the message sent.
 */

const FILTER_WORDS: Record<ChatFilter, string> = {
  mine: "Писал",
  ai: "С текстом ИИ",
  waited: "Ждали > 10 мин",
  unanswered: "Без ответа",
  money: "PPV и деньги",
};

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
  hand: "набрано или вставлено",
  unknown: "неизвестно",
};

const MARK_WORDS = { dash: "длинное тире", cyrillic: "кириллица", leak: "служебный текст ИИ" } as const;

function percent(share: number): string {
  return `${Math.round(share * 100)} %`;
}

function SummaryRow({ summary, active, onPick }: { summary: ChatSummary; active: boolean; onPick: () => void }) {
  const { chat } = summary;
  return (
    <li>
      <button type="button" className={`sr-chat${active ? " sr-chat-active" : ""}`} onClick={onPick} aria-pressed={active}>
        <span className="sr-chat-top">
          <span className="sr-chat-name">{fanName(chat)}</span>
          <span className="sr-chat-time">
            {summary.first === null ? "ждал с прошлой смены" : `${formatTimeOfDay(summary.first)}–${formatTimeOfDay(summary.last!)}`}
          </span>
        </span>
        <span className="sr-chat-line">
          <span>чаттер {formatCount(summary.mine)} · фан {formatCount(summary.fan)}</span>
          {summary.others > 0 && <span className="team-faint">другие: {formatCount(summary.others)}</span>}
          {chat.fanLifetimeNetMills !== null && chat.fanLifetimeNetMills > 0 && <span className="team-faint">всего {formatMills(chat.fanLifetimeNetMills)}</span>}
        </span>
        <span className="sr-chat-tags">
          {summary.ai > 0 && <span className="sr-tag sr-tag-ai">ИИ {formatCount(summary.ai)}/{formatCount(summary.mine)}</span>}
          {summary.copied > 0 && <span className="sr-tag sr-tag-ai">мимо кнопки {formatCount(summary.copied)}</span>}
          {summary.fix > 0 && <span className="sr-tag">Fix {formatCount(summary.fix)}</span>}
          {summary.longestWaitSeconds !== null && summary.longestWaitSeconds > REPLY_NORM_SECONDS && (
            <span className="sr-tag sr-tag-wait">ждал ответа {formatSeconds(summary.longestWaitSeconds)}</span>
          )}
          {summary.waitingAtEnd && <span className="sr-tag sr-tag-wait">{summary.waitingSinceBefore ? "ждёт с прошлой смены" : "без ответа"}</span>}
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
    return <span className="sr-tag">сам{mine.aiShare !== null && mine.aiShare > 0.3 ? ` · похоже на ИИ на ${percent(mine.aiShare)}` : ""}</span>;
  }
  if (mine.origin === "fix") return <span className="sr-tag">Fix своего черновика · {percent(mine.aiShare ?? 0)}</span>;
  const feature = FEATURE_WORDS[mine.aiFeature ?? ""] ?? mine.aiFeature ?? "ИИ";
  const viaButton = aiButton(mine.composedWith);
  return (
    <span className="sr-tag sr-tag-ai">
      Текст ИИ: {feature}{mine.aiFeature === "improve-draft" ? " по команде" : ""} · {percent(mine.aiShare ?? 0)}
      {viaButton ? (mine.edited ? " · с правкой" : "") : " · вставлен мимо кнопки"}
    </span>
  );
}

function MessageDetails({ message }: { message: ShiftReviewMessage }) {
  const mine = message.mine!;
  return (
    <div className="sr-details">
      <p><span className="team-faint">Расширение записало:</span> {COMPOSED_WORDS[mine.composedWith ?? ""] ?? mine.composedWith ?? "ничего (старая версия)"}
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
      {mine.aiText === null && <p className="team-faint">Текстов ИИ в этом чате за полтора часа до сообщения не было.</p>}
    </div>
  );
}

function Bubble({ message, picked }: { message: ShiftReviewMessage; picked: boolean }) {
  const [open, setOpen] = useState(false);
  const fan = message.side === "fan";
  const mine = message.mine;
  const author = message.by === "other" ? `другой: ${message.byName ?? "?"}`
    : message.by === "none" ? "без автора"
      : message.by === "auto" ? "автосообщение"
        : null;
  const classes = ["sr-msg", fan ? "sr-msg-fan" : "sr-msg-page", mine ? "sr-msg-mine" : "", !message.inShift ? "sr-msg-before" : "", picked ? "sr-msg-picked" : ""].join(" ");
  const text = normalizeDmMessageText(message.text);
  return (
    <div className={classes} data-at={message.at}>
      <div className="sr-bubble">
        {text !== "" ? <p className="whitespace-pre-wrap break-words">{text}</p> : <p className="team-faint">{message.media > 0 ? "без текста" : "пусто"}</p>}
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

function Transcript({ data, chat, picked }: { data: TeamShiftReviewResponse; chat: ShiftReviewChat; picked: { from: number; to: number } | null }) {
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
    rows.push(<Bubble key={message.ref} message={message} picked={picked !== null && at >= picked.from && at < picked.to} />);
    previous = at;
  }
  if (!startShown) rows.push(<p key="start" className="sr-divider sr-shift-start">Смена, {formatTimeOfDay(start)}: сообщений нет</p>);

  return (
    <section className="sr-transcript" aria-label={`Переписка с ${fanName(chat)}`}>
      <header className="sr-transcript-head">
        <div>
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

export function ShiftChats({ data, summaries, picked, onClearPick }: {
  data: TeamShiftReviewResponse;
  summaries: readonly ChatSummary[];
  picked: { from: number; to: number } | null;
  onClearPick: () => void;
}) {
  const [filter, setFilter] = useState<ChatFilter>("mine");
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const counts = useMemo(() => new Map(CHAT_FILTERS.map((one) => [one, summaries.filter((summary) => chatPasses(summary, one)).length])), [summaries]);
  const shown = useMemo(() => summaries.filter((summary) => chatPasses(summary, filter)
    && chatMatches(summary.chat, search)
    && (picked === null || chatBusyIn(data, summary.chat, picked.from, picked.to))), [summaries, filter, search, picked, data]);
  const active = shown.find((summary) => summary.chat.key === chosen) ?? shown[0] ?? null;

  const pick = (key: string) => {
    setChosen(key);
    // On a narrow screen the transcript is under the list: bring it up.
    if (window.matchMedia("(max-width: 1023px)").matches) transcriptRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="sr-chats">
      <div className="sr-chats-bar">
        <Segmented
          label="Какие чаты"
          value={filter}
          onChange={(value) => setFilter(value as ChatFilter)}
          options={CHAT_FILTERS.map((one) => ({ value: one, label: FILTER_WORDS[one], count: formatCount(counts.get(one) ?? 0) }))}
        />
        <SearchInput value={search} onChange={setSearch} placeholder="Фан или слово из переписки" />
      </div>
      {picked !== null && (
        <p className="sr-picked">
          Только чаты {formatTimeOfDay(picked.from)}–{formatTimeOfDay(picked.to)}: {formatCount(shown.length)}.
          {" "}<button type="button" className="link" onClick={onClearPick}>Показать всю смену</button>
        </p>
      )}
      {shown.length === 0 ? (
        <div className="empty"><p className="empty-title">Таких чатов нет</p></div>
      ) : (
        <div className="sr-chats-grid">
          <ul className="sr-chat-list" aria-label="Чаты смены">
            {shown.map((summary) => (
              <SummaryRow key={summary.chat.key} summary={summary} active={summary.chat.key === active?.chat.key} onPick={() => pick(summary.chat.key)} />
            ))}
          </ul>
          <div ref={transcriptRef} className="sr-transcript-wrap">
            {active && <Transcript data={data} chat={active.chat} picked={picked} />}
          </div>
        </div>
      )}
    </div>
  );
}
