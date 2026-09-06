import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

// S-UI (decision #251): the Collection screen talks to the S-POL routes
// declared in packages/contracts/src/routes-ofapi-collection.ts —
// ofapiCollectionGet / ofapiCollectionPreview / ofapiCollectionApply /
// ofapiCollectionJobCreate. The shapes below mirror those Zod schemas field
// for field; once the contract module is merged into this tree they can be
// replaced with `z.output<typeof ofapiCollectionSnapshotSchema>` etc. The
// registry (catalog, supported modes, consumers) is server truth from the GET
// — nothing here decides what a category can do.

export type OfapiCollectionMode = "off" | "on_demand" | "scheduled";

export type OfapiCollectionCategory =
  | "core_messages"
  | "core_payments"
  | "core_audience"
  | "posts_comments"
  | "visitors"
  | "tracking_links"
  | "smart_links"
  | "vault_catalog"
  | "vault_files"
  | "balances"
  | "profile_notifications"
  | "content_history";

export interface OfapiCollectionSettings {
  /** null = the default scope (every OF page without its own override). */
  pageId: number | null;
  category: OfapiCollectionCategory;
  mode: OfapiCollectionMode;
  /** 15..43200 */
  intervalMinutes: number;
  /** 1..100000 */
  dailyCreditLimit: number;
  /** 1..1000 */
  maxCallsPerRun: number;
  includeDetails: boolean;
}

export type OfapiCollectionPolicySource = "page" | "default" | "legacy_baseline" | "default_off";
export type OfapiCollectionPolicyState = "applied" | "baseline";

export interface OfapiCollectionPolicy extends OfapiCollectionSettings {
  /** Effective policies are always resolved per page; pageId is never null here. */
  revision: number;
  source: OfapiCollectionPolicySource;
  state: OfapiCollectionPolicyState;
  backgroundPaused: boolean;
  usage: {
    callsToday: number;
    reservedCreditsToday: number;
    credits30d: number;
    actualCreditsToday: number | null;
  };
  lastCapturedAt: string | null;
  inFlight: number;
}

export interface OfapiCollectionCatalogEntry {
  id: OfapiCollectionCategory;
  label: string;
  modes: OfapiCollectionMode[];
  baseline: boolean;
  consumers: string[];
  supportsOneOff: boolean;
  priceUnit: "calls_and_bytes" | "physical_calls";
  prerequisites: string[];
  scope: "page";
}

export interface OfapiCollectionPage {
  id: number;
  label: string;
  accountId: string | null;
}

export interface OfapiCollectionJob {
  id: string;
  pageId: number;
  category: OfapiCollectionCategory;
  state: string;
  maxCredits: number;
  maxCalls: number;
  maxBytes: number;
  usedCredits: number;
  usedCalls: number;
  usedBytes: number;
  createdAt: string;
  reason: string | null;
}

export interface OfapiCollectionAuditRow {
  revision: number;
  actorUserId: number;
  createdAt: string;
  changes: unknown;
}

export interface OfapiCollectionSnapshot {
  revision: number;
  backgroundPaused: boolean;
  catalog: OfapiCollectionCatalogEntry[];
  pages: OfapiCollectionPage[];
  policies: OfapiCollectionPolicy[];
  jobs: OfapiCollectionJob[];
  audit: OfapiCollectionAuditRow[];
  limitDescription: string;
}

export interface OfapiCollectionChangeBody {
  expectedRevision: number;
  changes: OfapiCollectionSettings[];
  backgroundPaused?: boolean;
}

export interface OfapiCollectionPreview {
  revision: number;
  changes: OfapiCollectionSettings[];
  backgroundPaused: boolean;
  cost: {
    source: "unknown";
    estimatedCredits: null;
    maximumNewCreditsPerDay: number;
  };
  consequences: string[];
  inFlight: number;
}

export interface OfapiCollectionApplyResult {
  revision: number;
  state: "applied";
}

export interface OfapiCollectionJobBody {
  pageId: number;
  category: OfapiCollectionCategory;
  expectedRevision: number;
  maxCredits: number;
  maxCalls: number;
  maxBytes: number;
  from: string | null;
  to: string | null;
  selection: string[];
}

export interface OfapiCollectionJobCreateResult {
  id: string;
  state: "queued";
}

interface OfapiCollectionOperations {
  ofapiCollectionGet(input: { query: { pageId?: number } }): Promise<OfapiCollectionSnapshot>;
  ofapiCollectionPreview(input: { body: OfapiCollectionChangeBody }): Promise<OfapiCollectionPreview>;
  ofapiCollectionApply(input: { body: OfapiCollectionChangeBody }): Promise<OfapiCollectionApplyResult>;
  ofapiCollectionJobCreate(input: { body: OfapiCollectionJobBody }): Promise<OfapiCollectionJobCreateResult>;
}

// The generated client exposes one method per routeSchemas key. The four
// collection operations are typed here by their contract shapes so this module
// compiles before and after the backend merge; the runtime guard turns a
// missing regeneration into one clear error instead of "not a function".
function collectionOperations(): OfapiCollectionOperations {
  const operations = kernel as unknown as Partial<OfapiCollectionOperations>;
  if (typeof operations.ofapiCollectionGet !== "function") {
    throw new Error(
      "Операции ofapiCollection* отсутствуют в SDK: нужен backend S-POL и `pnpm contracts:generate`.",
    );
  }
  return operations as OfapiCollectionOperations;
}

export const OFAPI_COLLECTION_QUERY_KEY = ["admin", "ofapi-collection"] as const;

/** Read-only: the GET reads retained local rows only, never the vendor. */
export function useAdminOfapiCollection() {
  return useQuery({
    queryKey: OFAPI_COLLECTION_QUERY_KEY,
    queryFn: () => collectionOperations().ofapiCollectionGet({ query: {} }),
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
    meta: { suppressGlobalError: true },
  });
}

export function useOfapiCollectionPreview() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: OfapiCollectionChangeBody) =>
      collectionOperations().ofapiCollectionPreview({ body }),
    // A failed preview (409 revision conflict, 400 validation) means the
    // screen's revision or catalog is stale — refresh so the compare view and
    // the retry use the server's current truth.
    onError: () => qc.invalidateQueries({ queryKey: OFAPI_COLLECTION_QUERY_KEY }),
  });
}

export function useOfapiCollectionApply() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: OfapiCollectionChangeBody) =>
      collectionOperations().ofapiCollectionApply({ body }),
    // Refetch after success AND failure: success needs the readback
    // (snapshot.revision reaching the applied one), a 409 needs the new revision.
    onSettled: () => qc.invalidateQueries({ queryKey: OFAPI_COLLECTION_QUERY_KEY }),
  });
}

export function useOfapiCollectionJobCreate() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: OfapiCollectionJobBody) =>
      collectionOperations().ofapiCollectionJobCreate({ body }),
    onSettled: () => qc.invalidateQueries({ queryKey: OFAPI_COLLECTION_QUERY_KEY }),
  });
}

/** Existing owner-session read of the single global webhook registration
 *  (DB-backed, no vendor call). Rendered read-only on the Collection screen;
 *  per-event-group controls wait for their own S2/S3 API. */
export function useAdminOfapiWebhookStatus() {
  return useQuery({
    queryKey: ["admin", "ofapi-webhook", "status"],
    queryFn: () => kernel.adminOfapiWebhookStatus(),
    refetchInterval: 30_000,
    meta: { suppressGlobalError: true },
  });
}
