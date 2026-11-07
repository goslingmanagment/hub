import { ArrowDown, ArrowUp } from "lucide-react";
import { Button, Drawer, KeyValue } from "@agency_hub_core/ui";
import { formatCount, formatTimeOfDay } from "@agency_hub_core/ui/format";
import { ruPlural } from "@agency_hub_core/ui/plural";
import type { ReviewMessage, ReviewTranscript } from "./data.js";
import { fanTitle } from "./ChatList.js";
import { plainAiText, waitText } from "./rules.js";
import { MARK_WORDS, composedWords, featureWord, originOf, originSentence, plainText, wordDiff, type DiffPart, type OriginKey } from "./words.js";

/**
 * Where one of the chatter's texts came from (spec §4.2, the evidence drawer):
 * the verdict in a sentence, what the extension said, the text sent beside the
 * AI's with the words the chatter added and dropped, the chatter's own draft.
 * It replaces the old inline «текст ИИ и черновик» under every bubble. Facts,
 * not a grade: an AI text sent as it came is not bad work by itself.
 */

const TITLES: Record<OriginKey, string> = {
  "ai-raw": "Текст ИИ без правки",
  "ai-edited": "Текст ИИ с правкой",
  "ai-hi": "Приветствие ИИ",
  "ai-command": "Текст ИИ по команде",
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

export function Evidence({ transcript, message, username, onStep, onClose }: {
  transcript: ReviewTranscript;
  message: ReviewMessage;
  username: string;
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
  // The AI's text went out as it came: one block, not the same words twice.
  const same = diff !== null && !added && !dropped;
  const draft = mine.draft?.trim() ? mine.draft.trim() : null;
  const draftLabel = mine.origin === "own" ? "Черновик ближайшего исправления ИИ — не этого сообщения" : "Черновик чаттера";

  const facts = [
    { label: "Как попал в поле", value: composedWords(mine) },
    { label: "Совпало с ИИ", value: mine.aiShare === null ? "не сравнивали" : `${Math.round(mine.aiShare * 100)} % слов` },
  ];
  if (mine.replySeconds !== null) facts.push({ label: "Фан ждал ответа", value: waitText(mine.replySeconds) });
  if (mine.repeats > 0) facts.push({ label: "Тот же текст", value: `ещё в ${formatCount(mine.repeats)} ${ruPlural(mine.repeats, "чате", "чатах", "чатах")} этой смены` });
  if (mine.marks.length > 0) facts.push({ label: "Заметно", value: mine.marks.map((mark) => MARK_WORDS[mark]).join(", ") });

  const step = (delta: 1 | -1) => {
    const next = own[index + delta];
    if (next) onStep(next.ref);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width={480}
      title={origin ? TITLES[origin.key] : "Откуда текст"}
      subtitle={`${username} → ${fanTitle({ fanDisplayName: transcript.chat.fanDisplayName, fanUsername: transcript.chat.fanUsername, fanRef: transcript.chat.fanRef })} · ${transcript.chat.pageLabel} · ${formatTimeOfDay(message.at)}`}
      footer={(
        <div className="review-evidence__foot">
          <span className="review-evidence__count" title="Сообщения чаттера в этом чате">Сообщение {formatCount(index + 1)} из {formatCount(own.length)}</span>
          <Button size="sm" icon={ArrowUp} onClick={() => step(-1)} disabled={index <= 0} title="Предыдущее сообщение чаттера (↑ или K)">Предыдущее</Button>
          <Button size="sm" icon={ArrowDown} onClick={() => step(1)} disabled={index >= own.length - 1} title="Следующее сообщение чаттера (↓ или J)">Следующее</Button>
        </div>
      )}
    >
      <div className="review-evidence">
        <p className="review-evidence__verdict">{originSentence(message)}</p>
        <KeyValue items={facts} />

        <section className="review-evidence__block">
          <h3 className="review-evidence__label">{same ? `Отправлено фану — слово в слово текст ИИ · ${featureWord(mine.aiFeature)}` : "Отправлено фану"}</h3>
          {diff && !same ? <Diffed parts={diff.sent} kind="added" /> : <p className="review-evidence__text">{sent || "без текста"}</p>}
          {diff && added && <p className="review-evidence__hint">Выделено то, чего нет в тексте ИИ.</p>}
        </section>

        {same ? null : ai !== null ? (
          <section className="review-evidence__block">
            <h3 className="review-evidence__label">Ближайший текст ИИ · {featureWord(mine.aiFeature)}</h3>
            {diff ? <Diffed parts={diff.ai} kind="dropped" /> : <p className="review-evidence__text">{ai}</p>}
            {diff && dropped && <p className="review-evidence__hint">Зачёркнуто то, что чаттер убрал.</p>}
          </section>
        ) : (
          <p className="review-evidence__none">Текстов ИИ в этом чате за полтора часа до сообщения нет.</p>
        )}

        {draft !== null && (
          <section className="review-evidence__block">
            <h3 className="review-evidence__label">{draftLabel}</h3>
            <p className="review-evidence__text review-evidence__text--draft">{draft}</p>
          </section>
        )}
      </div>
    </Drawer>
  );
}
