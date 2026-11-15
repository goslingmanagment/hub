import { Send } from "lucide-react";
import type { KernelOperationResponse, PeopleMessagePressResponse } from "@agency_hub_core/contracts";
import { Button } from "../components/Button.js";
import { Notice, type NoticeTone } from "../components/Notice.js";

/**
 * Сообщения людям (package S), the owner's press beside a «Скопировать»: the payout text (Workboard) and the
 * invitation (Hub «Люди»). One component in both products, the data handed in: each app reads
 * `peopleMessageRecipient` and sends `peopleMessagePress` with its own client. Nothing is shown while the kind is off
 * or the bot token is not set (Система → «Сообщения людям»): the screens are as they were and the owner sends the text
 * himself. With both on: the button says to whom it goes, or one quiet line says why it cannot (no Telegram id, the
 * person never wrote to the bot). After the press, one sentence says what became of it: sent, held, refused or not
 * known; never a silent success. Styles: styles/people-messages.css.
 */

const TONE: Readonly<Record<PeopleMessagePressResponse["state"], NoticeTone>> = {
  sent: "success",
  held: "warning",
  duplicate: "info",
  sending: "info",
  failed: "danger",
  unknown: "danger",
};

export function PeopleMessageSendView({ recipient, press, onPress }: {
  /** `peopleMessageRecipient`'s answer; undefined while it comes (or not asked). */
  recipient: KernelOperationResponse<"peopleMessageRecipient"> | undefined;
  /** The press: not yet, going, answered, or no answer. */
  press: { state: "idle" | "pending" } | { state: "done"; answer: PeopleMessagePressResponse } | { state: "failed" };
  onPress: () => void;
}) {
  if (recipient === undefined || !recipient.shown) return null;
  if (press.state === "done") {
    return <Notice tone={TONE[press.answer.state]} role="status" className="people-message-send__result">{press.answer.words}</Notice>;
  }
  if (press.state === "failed") {
    return (
      <Notice tone="danger" role="alert" className="people-message-send__result">
        Hub не ответил: неизвестно, ушло ли. Не нажимайте ещё раз, посмотрите «Система», «Сообщения людям».
      </Notice>
    );
  }
  if (!recipient.sendable) return <p className="people-message-send__why">{recipient.why}</p>;
  return (
    <Button icon={Send} disabled={press.state === "pending"} onClick={onPress}>
      {press.state === "pending" ? "Отправляем…" : recipient.label}
    </Button>
  );
}
