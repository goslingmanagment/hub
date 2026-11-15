import { createContext, useContext } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KernelClient } from "@kernel/sdk";
import type { ShiftReportConfirmResponse, ShiftReportLineBody, ShiftReportOffPlatformBody, ShiftReportResponse } from "@agency_hub_core/contracts";

/**
 * The «Отчёт» board's data: one read (`shiftReport`, its `board`), the writes of the board, all on ONE API client the
 * screen is given — Workboard's cookie session in a tab, the extension's port in the frame (transport.ts). After a
 * write the board is Hub's answer (or Hub's board read again): nothing is counted here. Query keys start with "report".
 */

export const BoardKernel = createContext<KernelClient | null>(null);

function useKernel(): KernelClient {
  const kernel = useContext(BoardKernel);
  if (kernel === null) throw new Error("The board has no API client");
  return kernel;
}

export const reportKey = (shiftId: number) => ["report", shiftId] as const;

/** How often the board looks again: the check every second or three, a running shift every minute. */
function pollOf(report: ShiftReportResponse | undefined): number | false {
  const board = report?.board;
  if (!board) return false;
  if (board.phase === "checking") return import.meta.env.DEV ? 1_000 : 3_000;
  // Counted by Hub's check while Gengar was silent: his reading comes later.
  if (board.phase === "counted" && board.candidate?.gengar.state === "silent") return import.meta.env.DEV ? 3_000 : 30_000;
  return report.shift.ongoing ? 60_000 : false;
}

export function useReport(shiftId: number, seed?: ShiftReportResponse) {
  const kernel = useKernel();
  return useQuery({
    queryKey: reportKey(shiftId),
    queryFn: () => kernel.shiftReport({ params: { shiftId } }),
    ...(seed ? { initialData: seed } : {}),
    staleTime: 10_000,
    refetchInterval: (query) => pollOf(query.state.data),
  });
}

/** `/report` and the frame without a shift: the person's own shift that needs them most. */
export function useCurrentReport(enabled: boolean) {
  const kernel = useKernel();
  return useQuery({
    queryKey: ["report", "current"],
    queryFn: () => kernel.shiftReportCurrent(),
    enabled,
    staleTime: 10_000,
  });
}

export function useClaimable(shiftId: number, enabled: boolean) {
  const kernel = useKernel();
  return useQuery({
    queryKey: [...reportKey(shiftId), "claimable"],
    queryFn: () => kernel.shiftReportClaimable({ params: { shiftId } }),
    enabled,
    staleTime: 30_000,
  });
}

/** One write of the board. Its answer, when it is the board, replaces the read; otherwise the board is read again. */
export type Write =
  | { op: "line"; transactionId: number; body: ShiftReportLineBody }
  | { op: "comment"; comment: string }
  | { op: "ask"; transactionId: number; statement: "mine" | "share"; shareWithUserId: number | null; note: string }
  | { op: "unask"; transactionId: number }
  | { op: "submit" }
  | { op: "confirm"; candidateId: number }
  | { op: "reopen" }
  | { op: "reopenCancel" }
  | { op: "resend"; transactionIds: number[] }
  | { op: "proposal"; proposalId: number; answer: "decline" | "restore" | "accept" }
  | { op: "sighting"; sightingId: number }
  | { op: "claim"; claimId: number; answer: "agree" | "disagree" }
  | { op: "offPlatformAdd"; body: ShiftReportOffPlatformBody }
  | { op: "offPlatformWithdraw"; offPlatformId: number };

function send(kernel: KernelClient, shiftId: number, write: Write): Promise<unknown> {
  const params = { shiftId };
  switch (write.op) {
    case "line": return kernel.shiftReportLineSet({ params: { shiftId, transactionId: write.transactionId }, body: write.body });
    case "comment": return kernel.shiftReportCommentSet({ params, body: { comment: write.comment } });
    case "ask": return kernel.shiftReportAsk({ params, body: { transactionId: write.transactionId, statement: write.statement, shareWithUserId: write.shareWithUserId, note: write.note } });
    case "unask": return kernel.shiftReportAskWithdraw({ params: { shiftId, transactionId: write.transactionId } });
    case "submit": return kernel.shiftReportSubmit({ params });
    case "confirm": return kernel.shiftReportConfirm({ params, body: { candidateId: write.candidateId } });
    case "reopen": return kernel.shiftReportReopen({ params });
    case "reopenCancel": return kernel.shiftReportReopenCancel({ params });
    case "resend": return kernel.shiftReportResend({ params, body: { transactionIds: write.transactionIds } });
    case "proposal": return kernel.shiftReportProposalAnswer({ params: { shiftId, proposalId: write.proposalId }, body: { answer: write.answer } });
    case "sighting": return kernel.shiftReportSightingAdd({ params: { shiftId, sightingId: write.sightingId } });
    case "claim": return kernel.saleClaimAnswer({ params: { claimId: write.claimId }, body: { answer: write.answer, note: null } });
    case "offPlatformAdd": return kernel.shiftReportOffPlatformAdd({ params, body: write.body });
    case "offPlatformWithdraw": return kernel.shiftReportOffPlatformWithdraw({ params: { shiftId, offPlatformId: write.offPlatformId } });
  }
}

const isReport = (value: unknown): value is ShiftReportResponse =>
  typeof value === "object" && value !== null && "shift" in value && "board" in value;

export function useBoardWrite(shiftId: number) {
  const kernel = useKernel();
  const queryClient = useQueryClient();
  return useMutation({
    // The board says a failure itself, in its own toast.
    meta: { suppressGlobalError: true },
    mutationFn: (write: Write) => send(kernel, shiftId, write),
    onSuccess: (answer) => {
      const fresh = isReport(answer) ? answer : isReport((answer as ShiftReportConfirmResponse | null)?.report) ? (answer as ShiftReportConfirmResponse).report : null;
      if (fresh !== null) queryClient.setQueryData(reportKey(shiftId), fresh);
      else void queryClient.invalidateQueries({ queryKey: reportKey(shiftId), exact: true });
      void queryClient.invalidateQueries({ queryKey: ["my-shifts"] });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: reportKey(shiftId), exact: true });
    },
  });
}
