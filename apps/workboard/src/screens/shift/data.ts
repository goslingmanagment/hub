import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ShiftReportOffPlatformBody, ShiftReportResponse, ShiftReportStatement } from "@agency_hub_core/contracts";
import { kernel } from "@/shared/hub";
import { withWord } from "./model.js";

export * from "./model.js";

/**
 * «Смена» — the data layer. One read (`shiftReport`): the shift, its draft
 * (the person's) or the version handed in (a reader's), the versions and the
 * post. Every write is the person's own and is saved at once; a word on a line
 * shows its amount before Hub answers (model.ts `withWord`), then Hub's fresh
 * draft replaces it. Query keys start with "shift".
 */

export const shiftKey = (shiftId: number) => ["shift", shiftId] as const;

export function useShiftReport(shiftId: number) {
  return useQuery({
    queryKey: shiftKey(shiftId),
    queryFn: () => kernel.shiftReport({ params: { shiftId } }),
    staleTime: 30_000,
    // While the shift goes on, sales come: a fresh draft every minute (only while the tab is seen).
    refetchInterval: (state) => (state.state.data?.shift.ongoing ? 60_000 : false),
  });
}

export interface LineWord {
  transactionId: number;
  statement: ShiftReportStatement | null;
  shareWithUserId: number | null;
  shareWithName: string | null;
  note: string | null;
}

/** A word on a line (не моё, делим с…, моё) and its note: shown at once, saved, then Hub's draft read again. */
export function useLineWord(shiftId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (word: LineWord) => kernel.shiftReportLineSet({
      params: { shiftId, transactionId: word.transactionId },
      body: { statement: word.statement, shareWithUserId: word.shareWithUserId, note: word.note },
    }),
    onMutate: async (word) => {
      await queryClient.cancelQueries({ queryKey: shiftKey(shiftId) });
      const before = queryClient.getQueryData<ShiftReportResponse>(shiftKey(shiftId));
      if (before?.view) queryClient.setQueryData<ShiftReportResponse>(shiftKey(shiftId), { ...before, view: withWord(before.view, word.transactionId, word) });
      return { before };
    },
    onError: (_error, _word, context) => {
      if (context?.before) queryClient.setQueryData(shiftKey(shiftId), context.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: shiftKey(shiftId) }),
  });
}

/** «Добавить → продажу»: the sales the person may add by hand, read when the window opens. */
export function useClaimable(shiftId: number, enabled: boolean) {
  return useQuery({
    queryKey: [...shiftKey(shiftId), "claimable"],
    queryFn: () => kernel.shiftReportClaimable({ params: { shiftId } }),
    enabled,
    staleTime: 30_000,
  });
}

/** The comment, saved as typed (the screen waits for a pause). */
export function useComment(shiftId: number) {
  return useMutation({
    mutationFn: (comment: string) => kernel.shiftReportCommentSet({ params: { shiftId }, body: { comment } }),
  });
}

export function useOffPlatform(shiftId: number) {
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (body: ShiftReportOffPlatformBody) => kernel.shiftReportOffPlatformAdd({ params: { shiftId }, body }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: shiftKey(shiftId) }),
  });
  const withdraw = useMutation({
    mutationFn: (offPlatformId: number) => kernel.shiftReportOffPlatformWithdraw({ params: { shiftId, offPlatformId } }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: shiftKey(shiftId) }),
  });
  return { add, withdraw };
}

/** «Сдать смену»: Hub answers the report as it is now, with the new version. */
export function useSubmit(shiftId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => kernel.shiftReportSubmit({ params: { shiftId } }),
    onSuccess: (report) => {
      queryClient.setQueryData(shiftKey(shiftId), report);
      void queryClient.invalidateQueries({ queryKey: ["my-shifts"] });
    },
  });
}
