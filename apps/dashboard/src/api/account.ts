import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChangePasswordBody } from "@agency_hub_core/contracts";
import { MOSCOW_TIME_ZONE, toBusinessDate } from "@agency_hub_core/shared";

import { kernel } from "./sdk.js";

// The chatter's own surface — the invitation page (/join, public)
// and the cabinet (/account, any live session). Everything goes through the
// generated SDK, like every other domain module (dashboard-sdk-ban).
//
// The invitation secret only ever travels in the POST body: it is passed in as
// an argument, never stored in a query key, never appended to a URL.

export function useInspectAccountLink() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { token: string }) =>
      kernel.authInspectAccountLink({ body: input }),
  });
}

export function useRedeemAccountLink() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { token: string; password: string }) =>
      kernel.authRedeemAccountLink({ body: input }),
  });
}

export function useMyDevices(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["account", "devices"],
    queryFn: () => kernel.authListDevices(),
    enabled: options.enabled ?? true,
  });
}

export function useRevokeMyDevice() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (deviceId: number) =>
      kernel.authRevokeDevice({ params: { deviceId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account", "devices"] }),
  });
}

export function useRevokeMyDevices() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.authRevokeAllDevices(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account", "devices"] }),
  });
}

export function useChangeMyPassword() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: ChangePasswordBody) =>
      kernel.authChangePassword({ body }),
  });
}

export function useMyUsage(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ["account", "usage", params],
    queryFn: () => kernel.authMyUsage({ query: params }),
  });
}

const DAY_MS = 86_400_000;

/** The last `days` Moscow days, today included. */
function lastDays(days: number): { from: string; to: string } {
  const to = toBusinessDate(new Date(), MOSCOW_TIME_ZONE);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  return { from, to };
}

/** The caller's own shift reports from the agency ledger (`accountReports`): the cabinet's «Отчёт смены». */
export function useMyReports(days: number) {
  return useQuery({
    queryKey: ["account", "reports", days],
    queryFn: () => kernel.accountReports({ query: lastDays(days) }),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
  });
}

/** The caller's own statistics (`accountChatterStats`): the cabinet's «Статистика». */
export function useMyStats(days: number) {
  return useQuery({
    queryKey: ["account", "stats", days],
    queryFn: () => kernel.accountChatterStats({ query: { days } }),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
    // While a shift goes on its numbers move: a fresh read every two minutes.
    refetchInterval: (query) => (query.state.data?.shifts[0]?.ongoing ? 120_000 : false),
  });
}
