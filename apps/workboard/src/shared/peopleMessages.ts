import { useMutation, useQuery } from "@tanstack/react-query";
import type { PeopleMessagePressBody, PeopleMessagePressResponse } from "@agency_hub_core/contracts";
import { toast } from "@agency_hub_core/ui";
import { kernel } from "./hub.js";
import { useMe } from "./useMe.js";

/**
 * Сообщения людям (package S), the owner's press beside a «Скопировать»: the payout text and the invitation. The
 * button is there only while the kind is on and the bot token is set (Система → «Сообщения людям»); until then the
 * screens are as they were, and the owner sends the text himself.
 */
export function usePeopleMessageSendable(kind: PeopleMessagePressBody["kind"]): boolean {
  const { isOwner } = useMe();
  const query = useQuery({
    queryKey: ["system", "people-messages"],
    queryFn: () => kernel.peopleMessages(),
    enabled: isOwner,
    staleTime: 60_000,
  });
  return query.data?.tokenSet === true && query.data.kinds.some((one) => one.kind === kind && one.on);
}

const SAID: Readonly<Record<PeopleMessagePressResponse["state"], "success" | "error" | "message">> = {
  sent: "success",
  held: "message",
  duplicate: "message",
  sending: "message",
  failed: "error",
  unknown: "error",
};

/** One press, one request: the answer says what became of the message, nothing repeats by itself. */
export function usePeopleMessagePress() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: PeopleMessagePressBody) => kernel.peopleMessagePress({ body }),
    onSuccess: (answer) => {
      const how = SAID[answer.state];
      if (how === "success") toast.success(answer.words);
      else if (how === "error") toast.error(answer.words);
      else toast.message(answer.words);
    },
    onError: () => toast.error("Hub не ответил: неизвестно, ушло ли. Не нажимайте ещё раз, посмотрите «Сообщения людям»."),
  });
}
