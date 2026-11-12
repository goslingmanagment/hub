import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PeopleMessageKindView, PeopleMessageSwitchBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

const PEOPLE_MESSAGES_KEY = ["system", "people-messages"] as const;

/** Система → «Сообщения людям»: every kind, its template and example, on or off, and what was held. */
export function usePeopleMessages() {
  return useQuery({
    queryKey: PEOPLE_MESSAGES_KEY,
    queryFn: () => kernel.peopleMessages(),
    refetchInterval: 60_000,
    meta: { suppressGlobalError: true },
  });
}

/** One kind on or off: the owner's word, audited on the server. */
export function usePeopleMessageSwitch() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { kind: PeopleMessageKindView["kind"]; body: PeopleMessageSwitchBody }) =>
      kernel.peopleMessageSwitch({ params: { kind: input.kind }, body: input.body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PEOPLE_MESSAGES_KEY }),
  });
}
