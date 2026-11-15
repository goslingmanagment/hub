import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeamWinBackApproachSaveBody } from "@agency_hub_core/contracts";
import { kernel } from "@/shared/hub";

/**
 * «Возврат фанов»: the owner's approaches and their one write, apart from data.ts: the tabs every role opens (and a
 * narrow session, tests/narrow-session-screens.test.ts) never reach them; only the team's route of the tab does.
 */

const APPROACHES_KEY = ["sales", "win-back-approaches"] as const;

/** The owner's list, retired ones included; the owner only (Hub checks it too). */
export function useWinBackApproaches(enabled: boolean) {
  return useQuery({
    queryKey: APPROACHES_KEY,
    queryFn: () => kernel.teamWinBackApproaches(),
    enabled,
  });
}

/**
 * The one write of the group, as the console's (api/team.ts:89-98): the same
 * operation and body; the answer is the list itself; the results re-read.
 */
export function useSaveWinBackApproach() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: TeamWinBackApproachSaveBody) => kernel.teamWinBackApproachSave({ body }),
    onSuccess: (data) => {
      queryClient.setQueryData(APPROACHES_KEY, data);
      void queryClient.invalidateQueries({ queryKey: ["sales", "win-back"] });
    },
  });
}
