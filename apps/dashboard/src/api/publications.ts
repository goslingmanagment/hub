import { useCallback } from "react";
import { keepPreviousData, queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicationStatus } from "@agency_hub_core/shared";

import { kernel } from "./sdk.js";

/**
 * Publications: wall posts Hub publishes on the pages (docs/plans/2026-10-23-
 * wall-posts, spec §9). Every route is the owner's cookie session. Nothing
 * here talks to a platform: approving hands a draft to Hub's sender, which
 * puts it on the platform later, by itself.
 */
export const PUBLICATIONS_KEY = ["admin", "publications"] as const;

export interface PublicationListParams {
  pageLabel?: string;
  status?: PublicationStatus;
  /** Publish time window: `from` inclusive, `to` exclusive (ISO). */
  from?: string;
  to?: string;
  limit: number;
}

export function publicationsQueryOptions(params: PublicationListParams) {
  return queryOptions({
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

export function usePublications(params: PublicationListParams) {
  return useQuery(publicationsQueryOptions(params));
}

export function usePublicationSettings() {
  return useQuery({
    queryKey: [...PUBLICATIONS_KEY, "settings"] as const,
    queryFn: () => kernel.adminPublicationSettingsList(),
    meta: { suppressGlobalError: true },
    // Hub stops a page by itself (an autostop): the strip says so within a minute.
    refetchInterval: 60_000,
  });
}

/** The reads behind «Ждут вас»: the same keys as the home's rows (api/waiting.ts), so the counts agree. */
const WAITING_LIMIT = 1000;

/** A count is never the previous filter's rows: the same read without the dimmed placeholder. */
function waitingQueryOptions(params: PublicationListParams) {
  const { placeholderData: _previousRows, ...options } = publicationsQueryOptions(params);
  return options;
}

/** Every draft and every «Исход неизвестен», over all dates and pages; a page is counted in the browser. */
export function usePublicationsWaiting() {
  const [drafts, unknown] = useQueries({
    queries: [
      waitingQueryOptions({ status: "draft", limit: WAITING_LIMIT }),
      waitingQueryOptions({ status: "unknown", limit: WAITING_LIMIT }),
    ],
  });
  return { drafts, unknown };
}

/**
 * «Не вышли»: «Не вышел», «Отклонён» and «Пропущен» read as one list, one
 * read per status (the API takes one status), the rows merged in publish order.
 */
export function usePublicationsNotOut(range: { from?: string; to?: string }, pageLabel: string | null, limit: number, enabled = true) {
  const results = useQueries({
    queries: (["not_published", "rejected", "missed"] as const).map((status) => ({
      ...publicationsQueryOptions({ ...(pageLabel === null ? {} : { pageLabel }), status, ...range, limit }),
      enabled,
    })),
  });
  const answered = results.every((result) => result.data !== undefined);
  const publications = answered
    ? results.flatMap((result) => result.data?.publications ?? []).sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt) || a.id - b.id)
    : undefined;
  const refetch = useCallback(() => Promise.all(results.map((result) => result.refetch())), [results]);
  return {
    data: publications === undefined ? undefined : { publications },
    /** The longest of the three lists: the screen's «первые 500» note reads it. */
    longest: Math.max(0, ...results.map((result) => result.data?.publications.length ?? 0)),
    isLoading: results.some((result) => result.isLoading),
    isError: results.some((result) => result.isError),
    isFetching: results.some((result) => result.isFetching),
    isPlaceholderData: results.some((result) => result.isPlaceholderData),
    dataUpdatedAt: Math.min(...results.map((result) => result.dataUpdatedAt || Number.MAX_SAFE_INTEGER)),
    refetch,
  };
}

/** Reads the whole screen again: after a switch elsewhere changed what the pages may do. */
export function useRereadPublications() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: PUBLICATIONS_KEY }), [qc]);
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
