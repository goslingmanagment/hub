import { ArrowDown, ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton, SidePanel, Tooltip, cx } from "@agency_hub_core/ui";
import { formatCount, formatPercent, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { REPLY_NORM_SECONDS, plainAiText, waitText } from "@agency_hub_core/ui/shiftReview";
import type { ReviewMessage, ReviewTranscript } from "./data.js";
import { MARK_WORDS, ORIGIN_TITLES, OWN_CAVEAT, buttonWord, featureWord, momentText, originOf, originSentence, plainText, wordDiff, type DiffPart } from "./words.js";

/**
 * Where one of the chatter's texts came from (spec §4.2, D7): a column beside
 * the conversation. The kind of origin as its title (the verdict's sentence in
 * its hint); the fan's message it answered, small; then the way the words went —
 * the draft or the AI's text, and what went to the fan, the words added lit and
 * the words dropped struck; one line of facts under it (the button, how much
 * matched, the wait). ↑ ↓ (J K) step through the chatter's messages of the chat.
 * Facts, not a grade: an AI text sent as it came is not bad work by itself.
 */

function Diffed({ parts, kind }: { parts: readonly DiffPart[]; kind: "added" | "dropped" }) {
  return <>{parts.map((part, index) => (part.changed ? <span key={index} className={`review-diff review-diff--${kind}`}>{part.text}</span> : <span key={index}>{part.text}</span>))}</>;
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

function Block({ label, children, quiet = false }: { label: ReactNode; children: ReactNode; quiet?: boolean }) {
  return (
    <section className="review-evidence__block">
      <h3 className="review-evidence__label">{label}</h3>
      <p className={cx("review-evidence__text", quiet && "review-evidence__text--quiet")}>{children}</p>
    </section>
  );
}

export function Evidence({ transcript, message, shiftStart, position, onStep, onClose }: {
  transcript: ReviewTranscript;
  message: ReviewMessage;
  shiftStart: number;
  /** Where the message stands among the chatter's messages of the chat. */
  position: { index: number; count: number };
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
}) {
  const mine = message.mine!;
  const origin = originOf(message);
  const sent = plainText(message.text);
  const ai = mine.aiText === null ? null : plainAiText(plainText(mine.aiText));
  const diff = ai !== null && sent !== "" ? wordDiff(sent, ai) : null;
  const added = diff?.sent.some((part) => part.changed) ?? false;
  const dropped = diff?.ai.some((part) => part.changed) ?? false;
  const draft = mine.draft?.trim() ? mine.draft.trim() : null;
  const answered = answeredOf(transcript, message);
  const answeredText = answered ? plainText(answered.text) : "";

  // Where the words came from: the chatter's draft (Fix, a command) or the AI's text — only when it differs from what went out.
  const key = origin?.key ?? "none";
  const source = (key === "fix" || key === "ai-command") && draft !== null
    ? { label: key === "fix" ? "Черновик" : "Команда", body: draft, quiet: true }
    : ai !== null && (added || dropped) && key !== "none"
      ? { label: key === "own" ? "Ближайший текст ИИ" : `Текст ИИ · ${featureWord(mine.aiFeature)}`, body: diff ? <Diffed parts={diff.ai} kind="dropped" /> : ai, quiet: false }
      : null;
  const outBody: ReactNode = sent === "" ? (message.media > 0 ? "без текста" : "пусто") : diff && added ? <Diffed parts={diff.sent} kind="added" /> : sent;

  // The facts the title does not already say: the button (unless Fix said it), the edits, how much matched (unless all),
  // a wait past the norm, the repeats and the marks.
  const facts: ReactNode[] = [];
  if (!(key === "fix" && mine.composedWith === "fix")) facts.push(<span key="button">{buttonWord(mine)}</span>);
  if (mine.edited === true) facts.push(<span key="edited">правили после вставки</span>);
  if (mine.aiShare !== null && mine.aiShare < 1) facts.push(<span key="share">совпало {formatPercent(mine.aiShare * 100)}</span>);
  if (mine.replySeconds !== null && mine.replySeconds > REPLY_NORM_SECONDS) facts.push(<span key="wait" className="review-evidence__warm">ждал {waitText(mine.replySeconds)}</span>);
  if (mine.repeats > 0) facts.push(<span key="repeats">ещё в {formatCount(mine.repeats)} {ruPlural(mine.repeats, "чате", "чатах", "чатах")}</span>);
  for (const mark of mine.marks) facts.push(<span key={mark} className="review-evidence__warm">{MARK_WORDS[mark]}</span>);

  const verdict = mine.origin === "own" ? `${originSentence(message)} ${OWN_CAVEAT}` : originSentence(message);

  return (
    <SidePanel
      className="review-evidence-panel"
      title={<Tooltip content={verdict} align="start" side="bottom"><span>{origin ? ORIGIN_TITLES[origin.key] : "Откуда текст"}</span></Tooltip>}
      actions={(
        <span className="review-evidence__nav">
          <IconButton icon={ChevronUp} label="Предыдущее сообщение чаттера — ↑ или K" size="sm" onClick={() => onStep(-1)} disabled={position.index <= 0} />
          <IconButton icon={ChevronDown} label="Следующее сообщение чаттера — ↓ или J" size="sm" onClick={() => onStep(1)} disabled={position.index >= position.count - 1} />
        </span>
      )}
      onClose={onClose}
      closeLabel="Закрыть — Esc"
    >
      <div className="review-evidence">
        {answered && (
          <figure className="review-evidence__fan" aria-label="Сообщение фана">
            <blockquote className={cx(answeredText === "" && "is-empty")}>{answeredText !== "" ? answeredText : answered.media > 0 ? "без текста" : "пусто"}</blockquote>
            <figcaption>{answered.inShift ? formatTimeOfDay(answered.at) : momentText(Date.parse(answered.at), shiftStart)}</figcaption>
          </figure>
        )}
        <div className="review-evidence__flow">
          {source && (
            <>
              <Block label={source.label} quiet={source.quiet}>{source.body}</Block>
              <ArrowDown className="review-evidence__arrow" size={16} strokeWidth={1.75} aria-hidden />
            </>
          )}
          <Block label="Ушло фану">{outBody}</Block>
        </div>
        {facts.length > 0 && <p className="review-evidence__facts">{facts.flatMap((part, index) => (index === 0 ? [part] : [<span key={`s${index}`} aria-hidden> · </span>, part]))}</p>}
      </div>
    </SidePanel>
  );
}
