import { useMutation, useQuery } from "@tanstack/react-query";
import type { PeopleMessagePressBody } from "@agency_hub_core/contracts";
import { PeopleMessageSendView } from "@agency_hub_core/ui/people/MessageSend";
import { kernel } from "./hub.js";
import { useMe } from "./useMe.js";

type Who = { person: string; userId?: undefined } | { userId: number; person?: undefined };

/** Сообщения людям (package S): the owner's press beside the payout text (packages/ui people/MessageSend.tsx draws it). */
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
  const state = press.isSuccess ? { state: "done" as const, answer: press.data } : press.isError ? { state: "failed" as const } : { state: press.isPending ? "pending" as const : "idle" as const };
  return <PeopleMessageSendView recipient={recipient.data} press={state} onPress={() => press.mutate()} />;
}
