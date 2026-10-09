import type { ProxyConfig } from "@agency_hub_core/shared";

// Kernel Stage 26: the egress seam. Every outbound platform call resolves its
// transport through ONE resolver — per-account address consistency becomes
// construction, not convention (platform-safety crown jewel 4). This package
// owns only the SHAPE: the app assembles the resolver from its proxy store,
// dispatcher factories, and the DB-backed pacer. There is deliberately no
// default path — a caller without an egress scope cannot build a client.

/** Priority classes, highest first. `interactive` (gateway reads, presence)
 * must never queue behind `bulk` (sync/backfill) backlog; `bulk` claims its
 * slot at reservation time, so already-scheduled work is never pushed back by
 * later higher-class arrivals (the starvation containment / aging floor). */
export const EGRESS_PRIORITY_CLASSES = ["interactive", "commands", "bulk"] as const;

export type EgressPriorityClass = (typeof EGRESS_PRIORITY_CLASSES)[number];

/**
 * What a caller must present to get a transport:
 * - `page` — platform-account egress: the page's assigned proxy IS the
 *   address identity (Fansly direct-to-platform; OFAPI account-scoped reads).
 * - `page_candidate` — ONE identity check of a page through a candidate proxy
 *   the owner is about to assign it (the check runs before the proxy is
 *   stored); never a fallback after the page proxy failed.
 * - `fansly_candidate` — ONE identity check of a Fansly session that belongs to
 *   no page yet (onboarding, the create-page credentials check) through the
 *   proxy the page will get: Fansly only, the proxy required, never direct.
 * - `fansly_public` — the session-less public account reader (arena "vanished
 *   chat" R5): its own proxy, which no page holds, configured by the owner;
 *   Fansly's API host only; never direct, never a page's proxy. Without that
 *   proxy there is no transport and the reader sends nothing.
 * - `vendor` — vendor-gateway egress with a RECORDED address policy (the
 *   resolver documents whether traffic proxies per-page or goes
 *   vendor-direct; it is never an accident of a bare fetch).
 */
export type EgressScope =
  | { kind: "page"; pageId: number }
  | { kind: "page_candidate"; pageId: number; proxy: ProxyConfig }
  | { kind: "fansly_candidate"; proxy: ProxyConfig }
  | { kind: "fansly_public" }
  | { kind: "vendor"; vendor: string };

export interface EgressContext<TDispatcher> {
  /** Stable identity of the egress address — the rate-limit + telemetry key. */
  egressKey: string;
  /** Transport dispatcher; null = process-default direct egress (only legal
   * for vendor scopes whose recorded policy says vendor-direct). */
  dispatcher: TDispatcher | null;
  /** Class-aware pacing: resolves when the caller may issue the request.
   * Returns the milliseconds actually waited. */
  pace(priorityClass: EgressPriorityClass): Promise<number>;
  close(): Promise<void>;
}

export type EgressResolver<TDispatcher> = (
  scope: EgressScope,
) => Promise<EgressContext<TDispatcher>>;

export function egressScopeKey(scope: EgressScope) {
  switch (scope.kind) {
    case "page":
      return `page:${scope.pageId}`;
    case "page_candidate":
      return `page-candidate:${scope.pageId}`;
    case "fansly_candidate":
      return "fansly-candidate";
    case "fansly_public":
      return "fansly-public";
    case "vendor":
      return `vendor:${scope.vendor}`;
  }
}
