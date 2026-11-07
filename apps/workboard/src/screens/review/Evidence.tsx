import { ArrowDown, ArrowUp } from "lucide-react";
import { IconButton, SidePanel } from "@agency_hub_core/ui";
import { formatCount, formatPercent, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import { plainAiText, waitText } from "@agency_hub_core/ui/shiftReview";
import type { ReviewMessage, ReviewTranscript } from "./data.js";
import { fanTitle } from "./ChatList.js";
import { MARK_WORDS, composedWords, featureWord, originOf, originSentence, plainText, wordDiff, type DiffPart, type OriginKey } from "./words.js";

/**
 * Where one of the chatter's texts came from (spec §4.2, D7): a column beside
 * the conversation, under the header, the facts and the pulse — it covers
 * neither. The verdict in a sentence; one quiet line of what is known (the
 * button, the share of the AI's words, the wait); then, only when the text was
 * changed, the sent text beside the AI's with the words added and dropped, and
 * the chatter's draft. Facts, not a grade: an AI text sent as it came is not bad
 * work by itself.
 */

const TITLES: Record<OriginKey, string> = {
  "ai-raw": "ИИ без правки",
  "ai-edited": "ИИ с правкой",
  "ai-hi": "Приветствие ИИ",
  "ai-command": "ИИ по команде",
  fix: "Свой черновик, ИИ поправил",
  own: "Свой текст",
  none: "Сообщение без слов",
};

function Diffed({ parts, kind }: { parts: readonly DiffPart[]; kind: "added" | "dropped" }) {
  return (
    <p className="review-evidence__text">
      {parts.map((part, index) => (part.changed ? <span key={index} className={`review-diff review-diff--${kind}`}>{part.text}</span> : <span key={index}>{part.text}</span>))}
    </p>
  );
}

export function Evidence({ transcript, message, onStep, onClose }: {
  transcript: ReviewTranscript;
  message: ReviewMessage;
  onStep: (ref: string) => void;
  onClose: () => void;
}) {
  const mine = message.mine!;
  const origin = originOf(message);
  const own = transcript.chat.messages.filter((one) => one.mine !== null);
  const index = own.findIndex((one) => one.ref === message.ref);
  const sent = plainText(message.text);
  const ai = mine.aiText === null ? null : plainAiText(plainText(mine.aiText));
  const diff = ai !== null && sent !== "" ? wordDiff(sent, ai) : null;
  const added = diff?.sent.some((part) => part.changed) ?? false;
  const dropped = diff?.ai.some((part) => part.changed) ?? false;
  // The AI's text went out as it came: the bubble beside already shows it, word for word.
  const same = diff !== null && !added && !dropped;
  const draft = mine.draft?.trim() ? mine.draft.trim() : null;
  const draftLabel = mine.origin === "own" ? "Черновик ближайшего исправления ИИ — не этого сообщения" : "Черновик чаттера";

  // What is known, in one quiet line.
  const known: string[] = [composedWords(mine)];
  // The verdict says the share for an AI text and for the chatter's own; a Fix's says it here.
  if (mine.aiShare !== null && mine.origin === "fix") known.push(`${formatPercent(mine.aiShare * 100)} слов из текста ИИ`);
  if (mine.replySeconds !== null) known.push(`фан ждал ${waitText(mine.replySeconds)}`);
  if (mine.repeats > 0) known.push(`тот же текст ещё в ${formatCount(mine.repeats)} ${ruPlural(mine.repeats, "чате", "чатах", "чатах")}`);
  if (mine.marks.length > 0) known.push(mine.marks.map((mark) => MARK_WORDS[mark]).join(", "));

  const step = (delta: 1 | -1) => {
    const next = own[index + delta];
    if (next) onStep(next.ref);
  };
  const fan = fanTitle({ fanDisplayName: transcript.chat.fanDisplayName, fanUsername: transcript.chat.fanUsername, fanRef: transcript.chat.fanRef });

  return (
    <SidePanel
      className="review-evidence-panel"
      title={origin ? TITLES[origin.key] : "Откуда текст"}
      subtitle={`Откуда текст · ${fan}, ${formatTimeOfDay(message.at)}`}
      onClose={onClose}
      closeLabel="Закрыть — Esc"
      footer={(
        <div className="review-evidence__foot">
          <span className="review-evidence__count">Сообщение чаттера {formatCount(index + 1)} из {formatCount(own.length)}</span>
          <IconButton icon={ArrowUp} label="Предыдущее сообщение чаттера — ↑ или K" variant="secondary" size="sm" onClick={() => step(-1)} disabled={index <= 0} />
          <IconButton icon={ArrowDown} label="Следующее сообщение чаттера — ↓ или J" variant="secondary" size="sm" onClick={() => step(1)} disabled={index >= own.length - 1} />
        </div>
      )}
    >
      <div className="review-evidence">
        <div className="review-evidence__lead">
          <p className="review-evidence__verdict">{originSentence(message)}</p>
          <p className="review-evidence__known">{known.join(" · ")}</p>
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
            {diff && dropped && <p className="review-evidence__hint">Зачёркнуто то, что чаттер убрал.</p>}
          </section>
        )}

        {draft !== null && (
          <section className="review-evidence__block">
            <h3 className="review-evidence__label">{draftLabel}</h3>
            <p className="review-evidence__text review-evidence__text--draft">{draft}</p>
          </section>
        )}
      </div>
    </SidePanel>
  );
}
