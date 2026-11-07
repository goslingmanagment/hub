import { useEffect, useRef } from "react";
import { SidePanel, Tooltip, cx } from "@agency_hub_core/ui";
import { formatCount, formatPercent, formatTimeOfDay, unbreakable } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { REPLY_NORM_SECONDS, plainAiText, waitText } from "@agency_hub_core/ui/shiftReview";
import type { ReviewMessage, ReviewTranscript } from "./data.js";
import { fanTitle } from "./ChatList.js";
import { MARK_WORDS, OWN_CAVEAT, OWN_WORDS, composedWords, featureWord, momentText, originOf, originSentence, plainText, wordDiff, type DiffPart, type OriginKey } from "./words.js";

/**
 * Where one of the chatter's texts came from (spec §4.2, D7): a column beside
 * the conversation, under the header, the facts and the pulse — it covers
 * neither. On top, the fan's message it answered; then the verdict in a
 * sentence with its basis (what was compared, how much matched, the button);
 * then, only when the text was changed, the sent text beside the AI's with the
 * words added and dropped, and the chatter's draft. Below, every message of the
 * chatter in this chat, with its origin and a long wait: the picture of the
 * chat, and the way to the next one by mouse (↑ ↓ and J K by keys). Facts, not
 * a grade: an AI text sent as it came is not bad work by itself.
 */

const TITLES: Record<OriginKey, string> = {
  "ai-raw": "ИИ без правки",
  "ai-edited": "ИИ с правкой",
  "ai-hi": "Приветствие ИИ",
  "ai-command": "ИИ по команде",
  fix: "Свой черновик, ИИ поправил",
  own: OWN_WORDS,
  none: "Сообщение без слов",
};

function Diffed({ parts, kind }: { parts: readonly DiffPart[]; kind: "added" | "dropped" }) {
  return (
    <p className="review-evidence__text">
      {parts.map((part, index) => (part.changed ? <span key={index} className={`review-diff review-diff--${kind}`}>{part.text}</span> : <span key={index}>{part.text}</span>))}
    </p>
  );
}

/** The fan's message the chatter's one answered: the fan's last before it. */
function answeredOf(transcript: ReviewTranscript, message: ReviewMessage): ReviewMessage | null {
  const at = transcript.chat.messages.indexOf(message);
  for (let index = at - 1; index >= 0; index -= 1) {
    const before = transcript.chat.messages[index]!;
    if (before.side === "fan") return before;
  }
  return null;
}

/** Every message of the chatter in this chat, one line of what and one of the words; the open one lit. */
function MineList({ messages, open, username, shiftStart, onPick }: {
  messages: readonly ReviewMessage[];
  open: string;
  username: string;
  shiftStart: number;
  onPick: (ref: string) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  // The open one stays in sight as the keys walk the messages.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-mine="${CSS.escape(open)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open]);
  return (
    <section className="review-evidence__block review-mine">
      <h3 className="review-evidence__label review-mine__head">
        <span>Сообщения {username} в чате · {formatCount(messages.length)}</span>
        <Tooltip content="Соседнее сообщение — ↑ ↓ или J K" align="end">
          <span className="review-mine__keys" aria-hidden>↑ ↓</span>
        </Tooltip>
      </h3>
      <ol ref={list} className="review-mine__list">
        {messages.map((one) => {
          const origin = originOf(one);
          const current = one.ref === open;
          const wait = one.mine?.replySeconds ?? null;
          const text = plainText(one.text);
          return (
            <li key={one.ref}>
              <button
                type="button"
                className={cx("review-mine__item", current && "is-current", origin?.key === "ai-raw" && "is-raw")}
                aria-current={current ? "true" : undefined}
                data-mine={one.ref}
                onClick={() => onPick(one.ref)}
              >
                <span className="review-mine__top">
                  <span className="review-mine__at">{one.inShift ? formatTimeOfDay(one.at) : momentText(Date.parse(one.at), shiftStart)}</span>
                  <span className="review-mine__origin">{one.mass ? "рассылка" : origin?.short ?? "—"}</span>
                  {wait !== null && wait > REPLY_NORM_SECONDS && <span className="review-mine__wait">ждал {waitText(wait)}</span>}
                </span>
                <span className={cx("review-mine__text", text === "" && "is-empty")}>{text !== "" ? text : one.media > 0 ? "без текста" : "пусто"}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function Evidence({ transcript, message, username, shiftStart, onPick, onClose }: {
  transcript: ReviewTranscript;
  message: ReviewMessage;
  username: string;
  shiftStart: number;
  /** Open another message of the chatter in this chat. */
  onPick: (ref: string) => void;
  onClose: () => void;
}) {
  const mine = message.mine!;
  const origin = originOf(message);
  const own = transcript.chat.messages.filter((one) => one.mine !== null);
  const sent = plainText(message.text);
  const ai = mine.aiText === null ? null : plainAiText(plainText(mine.aiText));
  const diff = ai !== null && sent !== "" ? wordDiff(sent, ai) : null;
  const added = diff?.sent.some((part) => part.changed) ?? false;
  const dropped = diff?.ai.some((part) => part.changed) ?? false;
  // The AI's text went out as it came: the bubble beside already shows it, word for word.
  const same = diff !== null && !added && !dropped;
  const draft = mine.draft?.trim() ? mine.draft.trim() : null;
  const draftLabel = mine.origin === "own" ? "Черновик ближайшего исправления ИИ — не этого сообщения" : "Черновик чаттера";
  const answered = answeredOf(transcript, message);

  // What is known, in one quiet line: the button and the edits, the wait, the repeats.
  const known: string[] = [composedWords(mine)];
  // The verdict says the share for an AI text and for a text without one; a Fix's says it here.
  if (mine.aiShare !== null && mine.origin === "fix") known.push(`${formatPercent(mine.aiShare * 100)} слов из текста ИИ`);
  if (mine.replySeconds !== null) known.push(`фан ждал ${waitText(mine.replySeconds)}`);
  if (mine.repeats > 0) known.push(`тот же текст ещё в ${formatCount(mine.repeats)} ${ruPlural(mine.repeats, "чате", "чатах", "чатах")}`);
  if (mine.marks.length > 0) known.push(mine.marks.map((mark) => MARK_WORDS[mark]).join(", "));

  const fan = fanTitle({ fanDisplayName: transcript.chat.fanDisplayName, fanUsername: transcript.chat.fanUsername, fanRef: transcript.chat.fanRef });
  const answeredText = answered ? plainText(answered.text) : "";

  return (
    <SidePanel
      className="review-evidence-panel"
      title={origin ? TITLES[origin.key] : "Откуда текст"}
      subtitle={`Откуда текст · ${fan}, ${formatTimeOfDay(message.at)}`}
      onClose={onClose}
      closeLabel="Закрыть — Esc"
    >
      <div className="review-evidence">
        {answered && (
          <figure className="review-evidence__quote">
            <figcaption className="review-evidence__quote-head">Ответ на сообщение фана · {answered.inShift ? formatTimeOfDay(answered.at) : momentText(Date.parse(answered.at), shiftStart)}</figcaption>
            <blockquote className={cx("review-evidence__quote-text", answeredText === "" && "is-empty")}>
              {answeredText !== "" ? answeredText : answered.media > 0 ? "без текста" : "пусто"}
            </blockquote>
          </figure>
        )}

        <div className="review-evidence__lead">
          <p className="review-evidence__verdict">{originSentence(message)}</p>
          {mine.origin === "own" && <p className="review-evidence__known">{OWN_CAVEAT}</p>}
          {/* The short facts after the first never break inside: «фан ждал 1 ч 46 мин» stays one piece. */}
          <p className="review-evidence__known">{known.map((part, index) => (index === 0 ? part : unbreakable(part))).join(" · ")}</p>
        </div>

        {/* The sent text is the bubble beside: it is repeated only to light the words the chatter added. */}
        {diff && added && (
          <section className="review-evidence__block">
            <h3 className="review-evidence__label">Отправлено фану</h3>
            <Diffed parts={diff.sent} kind="added" />
            <p className="review-evidence__hint">Выделено то, чего нет в тексте ИИ.</p>
          </section>
        )}

        {ai !== null && !same && (
          <section className="review-evidence__block">
            <h3 className="review-evidence__label">Ближайший текст ИИ · {featureWord(mine.aiFeature)}</h3>
            {diff ? <Diffed parts={diff.ai} kind="dropped" /> : <p className="review-evidence__text">{ai}</p>}
            {diff && dropped && <p className="review-evidence__hint">{mine.origin === "own" ? "Зачёркнуто то, чего нет в отправленном." : "Зачёркнуто то, что чаттер убрал."}</p>}
          </section>
        )}

        {draft !== null && (
          <section className="review-evidence__block">
            <h3 className="review-evidence__label">{draftLabel}</h3>
            <p className="review-evidence__text review-evidence__text--draft">{draft}</p>
          </section>
        )}

        {own.length > 1 && <MineList messages={own} open={message.ref} username={username} shiftStart={shiftStart} onPick={onPick} />}
      </div>
    </SidePanel>
  );
}
