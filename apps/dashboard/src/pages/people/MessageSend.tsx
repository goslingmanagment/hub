import { useMutation, useQuery } from "@tanstack/react-query";
import type { PeopleMessagePressBody } from "@agency_hub_core/contracts";
import { PeopleMessageSendView } from "@agency_hub_core/ui/people/MessageSend";
import { kernel } from "@/api/sdk";

/** Сообщения людям (package S): the owner's press beside the invitation's text (packages/ui people/MessageSend.tsx draws it). */
export function PeopleMessageSend({ kind, who, text }: { kind: PeopleMessagePressBody["kind"]; who: { userId: number }; text: string }) {
  const recipient = useQuery({
    queryKey: ["system", "people-messages", "recipient", kind, null, who.userId],
    queryFn: () => kernel.peopleMessageRecipient({ query: { kind, userId: who.userId } }),
    staleTime: 60_000,
    meta: { suppressGlobalError: true },
  });
  const press = useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.peopleMessagePress({ body: { kind, userId: who.userId, text } }),
  });
  const state = press.isSuccess ? { state: "done" as const, answer: press.data } : press.isError ? { state: "failed" as const } : { state: press.isPending ? "pending" as const : "idle" as const };
  return <PeopleMessageSendView recipient={recipient.data} press={state} onPress={() => press.mutate()} />;
}
