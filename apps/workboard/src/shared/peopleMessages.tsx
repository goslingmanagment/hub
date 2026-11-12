import { useMutation, useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import type { PeopleMessagePressBody, PeopleMessagePressResponse } from "@agency_hub_core/contracts";
import { Button, Notice, type NoticeTone } from "@agency_hub_core/ui";
import { kernel } from "./hub.js";
import { useMe } from "./useMe.js";
import "./peopleMessages.css";

/**
 * Сообщения людям (package S), the owner's press beside a «Скопировать»: the payout text and the invitation. Nothing
 * is shown while the kind is off or the bot token is not set (Система → «Сообщения людям»): the screens are as they
 * were and the owner sends the text himself. With both on: the button says to whom it goes, or one quiet line says
 * why it cannot (no Telegram id, the person never wrote to the bot). After the press, one sentence says what became
 * of it: sent, held, refused or not known; never a silent success.
 */

type Who = { person: string; userId?: undefined } | { userId: number; person?: undefined };

const TONE: Readonly<Record<PeopleMessagePressResponse["state"], NoticeTone>> = {
  sent: "success",
  held: "warning",
  duplicate: "info",
  sending: "info",
  failed: "danger",
  unknown: "danger",
};

export function PeopleMessageSend({ kind, who, text }: { kind: PeopleMessagePressBody["kind"]; who: Who; text: string }) {
  const { isOwner } = useMe();
  const recipient = useQuery({
    queryKey: ["system", "people-messages", "recipient", kind, who.person ?? null, who.userId ?? null],
    queryFn: () => kernel.peopleMessageRecipient({ query: { kind, ...(who.person !== undefined ? { person: who.person } : { userId: who.userId }) } }),
    enabled: isOwner,
    staleTime: 60_000,
  });
  const press = useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.peopleMessagePress({ body: { kind, ...(who.person !== undefined ? { person: who.person } : { userId: who.userId }), text } }),
  });
  const data = recipient.data;
  if (data === undefined || !data.shown) return null;
  if (press.isSuccess) {
    return <Notice tone={TONE[press.data.state]} role="status" className="people-message-send__result">{press.data.words}</Notice>;
  }
  if (press.isError) {
    return (
      <Notice tone="danger" role="alert" className="people-message-send__result">
        Hub не ответил: неизвестно, ушло ли. Не нажимайте ещё раз, посмотрите «Система», «Сообщения людям».
      </Notice>
    );
  }
  if (!data.sendable) return <p className="people-message-send__why">{data.why}</p>;
  return (
    <Button icon={Send} disabled={press.isPending} onClick={() => press.mutate()}>
      {press.isPending ? "Отправляем…" : data.label}
    </Button>
  );
}
