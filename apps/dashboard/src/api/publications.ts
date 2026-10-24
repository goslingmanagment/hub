import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicationStatus } from "@agency_hub_core/shared";

import { kernel } from "./sdk.js";

/**
 * Publications: wall posts Hub publishes on the pages (docs/plans/2026-10-23-
 * wall-posts, spec §9). Every route is the owner's cookie session. Nothing
 * here talks to a platform: approving hands a draft to Hub's sender, which
 * puts it on the platform later, by itself.
 */
const PUBLICATIONS_KEY = ["admin", "publications"] as const;

export interface PublicationListParams {
  pageLabel?: string;
  status?: PublicationStatus;
  /** Publish time window: `from` inclusive, `to` exclusive (ISO). */
  from?: string;
  to?: string;
  limit: number;
}

export function usePublications(params: PublicationListParams) {
  return useQuery({
    queryKey: [...PUBLICATIONS_KEY, "list", params] as const,
    queryFn: () => kernel.adminPublicationList({ query: params }),
    // The screen says in its own words that the list did not load.
    meta: { suppressGlobalError: true },
    // Hub moves statuses by itself (sent, scheduled, went out): a minute is as
    // stale as the schedule gets on screen.
    refetchInterval: 60_000,
    // Switching a filter keeps the previous rows on screen, dimmed, instead of
    // collapsing the list to a skeleton.
    placeholderData: keepPreviousData,
  });
}

export function usePublicationSettings() {
  return useQuery({
    queryKey: [...PUBLICATIONS_KEY, "settings"] as const,
    queryFn: () => kernel.adminPublicationSettingsList(),
    meta: { suppressGlobalError: true },
  });
}

/** One publication with its status journal; null asks for nothing. */
export function usePublicationDetail(id: number | null) {
  return useQuery({
    queryKey: [...PUBLICATIONS_KEY, "detail", id] as const,
    queryFn: () => kernel.adminPublicationGet({ params: { id: id ?? 0 } }),
    enabled: id !== null,
    meta: { suppressGlobalError: true },
  });
}

// Every mutation reads the whole screen again when it settles, not only on
// success: after a refusal the publication may have moved on (approved by
// someone else, sent by Hub), and after a lost answer the change may have
// been recorded. The screen answers refusals itself, in words.

export function useApprovePublications() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (items: Array<{ id: number; version: number }>) => kernel.adminPublicationApprove({ body: { items } }),
    onSettled: () => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }),
  });
}

export function useCancelPublication() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (id: number) => kernel.adminPublicationCancel({ params: { id } }),
    onSettled: () => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }),
  });
}

export type PublicationResolveBody =
  | { outcome: "went_out"; state: "scheduled" | "published"; platformPostRef: string }
  | { outcome: "did_not_go_out" };

export function useResolvePublication() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: { id: number; body: PublicationResolveBody }) =>
      kernel.adminPublicationResolve({ params: { id: input.id }, body: input.body }),
    onSettled: () => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }),
  });
}

export interface PublicationSettingsUpdate {
  pageLabel: string;
  body: {
    enabled: boolean;
    paidPriceMinMills: number | null;
    paidPriceMaxMills: number | null;
    repostThresholdDays: number;
    dailyLimit: number | null;
  };
}

export function useUpdatePublicationSettings() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: PublicationSettingsUpdate) =>
      kernel.adminPublicationSettingsUpdate({ params: { pageLabel: input.pageLabel }, body: input.body }),
    // The findings of every draft depend on the page's range and limits.
    onSettled: () => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }),
  });
}

// --- OnlyFans' own schedule and withdrawal (plan PR 5b) ---------------------

/** The latest read of every OnlyFans page's schedule. Hub reads it by itself; the button asks for a read now. */
export function usePublicationQueues() {
  return useQuery({
    queryKey: [...PUBLICATIONS_KEY, "queue"] as const,
    queryFn: () => kernel.adminPublicationQueueList(),
    meta: { suppressGlobalError: true },
    refetchInterval: 60_000,
  });
}

export function useRefreshPublicationQueue() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (pageLabel: string) => kernel.adminPublicationQueueRefresh({ body: { pageLabel } }),
    onSettled: () => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }),
  });
}

export function useWithdrawPublication() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (id: number) => kernel.adminPublicationWithdraw({ params: { id } }),
    onSettled: () => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }),
  });
}

/** «Удалить с площадки»: a published Fansly post off the wall; the outcome comes as its status. */
export function useDeletePublicationPost() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (id: number) => kernel.adminPublicationDeletePost({ params: { id } }),
    onSettled: () => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }),
  });
}

/** «Снять всё, что поставил Hub» on one page: one command per post, each its own outcome. */
export function useWithdrawPagePublications() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (pageLabel: string) => kernel.adminPublicationWithdrawPage({ body: { pageLabel } }),
    onSettled: () => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }),
  });
}

/** A replacement draft of a withdrawn publication (only after a confirmed withdrawal). */
export function useReplacePublication() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (id: number) => kernel.adminPublicationReplace({ params: { id } }),
    onSettled: () => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }),
  });
}
