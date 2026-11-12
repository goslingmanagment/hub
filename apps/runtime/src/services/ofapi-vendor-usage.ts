import { createHash } from "node:crypto";
import {
  ofapiUsageResultSchema, ofapiUsageWindowSchema, ofapiKeyScopeSchema,
  type OfapiUsageWindow, type OfapiKeyScopeApply, type OfapiCapability,
} from "@agency_hub_core/contracts";
import { applyOfapiKeyDeclaration, compareOfapiVendorUsage, getOfapiKeyDeclaration, saveOfapiVendorUsage, type Database } from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { ConflictError, ForbiddenError, ServiceUnavailableError } from "./errors.ts";
import { asRecord } from "./ofapi-payloads.ts";

export class OfapiKeyPermissionDeniedError extends ForbiddenError {
  constructor(message: string) { super(message); this.name = "OfapiKeyPermissionDeniedError"; }
}

/** The declaration lookup runs BEFORE any egress. When it cannot complete, nothing
 * was dispatched: this is a local pre-dispatch refusal (retry is safe), never an
 * indeterminate vendor outcome. The command executor maps it to a local verdict. */
export class OfapiKeyScopeUnavailableError extends ServiceUnavailableError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "OfapiKeyScopeUnavailableError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function parseOfapiVendorUsage(body: unknown, window: OfapiUsageWindow) {
  const data = asRecord(asRecord(body)?.data);
  if (!data || !Array.isArray(data.results)) throw new ServiceUnavailableError("OFAPI usage response shape unavailable");
  const parsed = ofapiUsageResultSchema.parse({
    from: data.from, to: data.to, groupBy: data.group_by, includesToday: data.includes_today,
    totals: data.totals,
    results: data.results.map((item: unknown) => {
      const row = asRecord(item);
      return { day: row?.day ?? row?.date ?? null, accountId: row?.account_id ?? null,
        endpoint: row?.endpoint ?? null, creditType: row?.credit_type ?? null,
        credits: row?.credits, requests: row?.requests };
    }),
  });
  if (parsed.from !== window.from || parsed.to !== window.to || parsed.groupBy !== window.groupBy || parsed.includesToday !== window.includeToday) {
    throw new ServiceUnavailableError("OFAPI usage returned a different scope; totals cannot be compared");
  }
  return parsed;
}

function configuredFingerprint(app: Pick<AppContext, "config">) {
  if (!app.config.ofapiApiKey) throw new ServiceUnavailableError("OFAPI credential is not configured");
  return createHash("sha256").update(app.config.ofapiApiKey).digest("hex");
}

export async function getOfapiKeyScope(app: AppContext) {
  const fingerprint = configuredFingerprint(app);
  const declaration = await getOfapiKeyDeclaration(app.db, fingerprint);
  // Preflight is a free identity request. It never infers permissions from visible accounts.
  const preflight = await app.ofapi?.getCredentialPreflight?.();
  return ofapiKeyScopeSchema.parse({
    credentialFingerprint: fingerprint, version: declaration?.version ?? 0,
    capabilities: declaration?.capabilities ?? null, accountIds: declaration?.account_ids ?? null,
    visibility: declaration?.visibility ?? "unknown", updatedAt: declaration?.updated_at ?? null,
    observedTeam: preflight?.observedTeam ?? null, preflightStatus: preflight?.status ?? "unknown",
    source: "owner_declaration_not_vendor_introspection",
  });
}

export async function applyOfapiKeyScope(app: AppContext, input: OfapiKeyScopeApply, actorUserId: number) {
  if (configuredFingerprint(app) !== input.credentialFingerprint) throw new ConflictError("The server credential changed; refresh its scope");
  if (!await applyOfapiKeyDeclaration(app.db, input, actorUserId)) throw new ConflictError("The key scope version changed; refresh before applying");
  return getOfapiKeyScope(app);
}

/**
 * The three writes the `vault` capability lets through, each with the only method and
 * path it may carry: uploading a file into the vault, creating a vault list, adding
 * vault media to a list. A label is trusted only together with its request, so a vault
 * label on a post, message or other upload path is refused before the network.
 */
const VAULT_WRITES: Record<string, { method: string; path: RegExp }> = {
  ofapi_upload_vault: { method: "POST", path: /^\/([^/]+)\/media\/vault$/ },
  ofapi_command_action_vault_list_create: { method: "POST", path: /^\/([^/]+)\/media\/vault\/lists$/ },
  ofapi_command_action_vault_list_add_media: { method: "POST", path: /^\/([^/]+)\/media\/vault\/lists\/[A-Za-z0-9_-]{1,128}\/media$/ },
};

/** Does a vault-labelled write carry exactly its own method, path and account? */
function vaultWriteMatches(input: { operation: string; method: string; pathname?: string; accountId?: string | null }) {
  const shape = VAULT_WRITES[input.operation];
  if (!shape || input.method !== shape.method || input.pathname === undefined) return false;
  const match = shape.path.exec(input.pathname);
  if (!match) return false;
  let account: string;
  try { account = decodeURIComponent(match[1]!); } catch { return false; }
  return /^acct_[A-Za-z0-9_-]+$/.test(account) && (!input.accountId || input.accountId === account);
}

/**
 * The declared capabilities any one of which lets an OFAPI request through. A vault write
 * is still an upload or a command, and an upload's status read is still an upload, so a key
 * declared for those keeps sending them as before.
 */
export function ofapiAcceptedCapabilities(input: { operation: string; method: string; pathname?: string; accountId?: string | null }): OfapiCapability[] {
  // Reading an upload's status is a read: the outcome of a started upload stays knowable after the key narrows.
  if (input.operation === "ofapi_upload_status" && (input.method === "GET" || input.method === "HEAD")) return ["reads", "uploads"];
  if (vaultWriteMatches(input)) return ["vault", input.operation === "ofapi_upload_vault" ? "uploads" : "commands"];
  return [/webhook/.test(input.operation) ? "webhooks"
    : /export/.test(input.operation) ? "exports"
      : /upload/.test(input.operation) ? "uploads"
        : /smart_link|pixel|postback/.test(input.operation) ? "links"
          : input.method === "GET" || input.method === "HEAD" ? "reads" : "commands"];
}

/** Unknown is observed honestly; explicit restrictions fail before egress, independently of Hub ACL. */
export async function assertOfapiConfiguredAccess(db: Database, fingerprint: string, input: {
  operation: string; accountId?: string | null; method: string; pathname?: string;
}) {
  // Free identity and credit diagnostics remain usable to repair a restricted credential.
  if (["ofapi_credential_preflight", "ofapi_balance_ping", "ofapi_vendor_usage"].includes(input.operation)) return;
  // A vault label is checked against its request for every key, declared or not: a mislabelled
  // request would otherwise pass as a vault write and be counted as one.
  if (input.operation in VAULT_WRITES && !vaultWriteMatches(input)) {
    throw new OfapiKeyPermissionDeniedError(`OFAPI ${input.operation} does not match its method and path`);
  }
  let policy: Awaited<ReturnType<typeof getOfapiKeyDeclaration>>;
  try { policy = await getOfapiKeyDeclaration(db, fingerprint); }
  catch (error) { throw new OfapiKeyScopeUnavailableError("OFAPI key scope declaration unavailable before dispatch", { cause: error }); }
  if (!policy) return;
  const accepted = ofapiAcceptedCapabilities(input);
  if (policy.capabilities && !accepted.some(capability => policy.capabilities!.includes(capability))) {
    throw new OfapiKeyPermissionDeniedError(`OFAPI key declaration does not allow ${accepted.join(" or ")}`);
  }
  if (input.accountId && policy.account_ids && !policy.account_ids.includes(input.accountId)) {
    throw new OfapiKeyPermissionDeniedError("OFAPI key declaration does not allow this account");
  }
}

export async function refreshOfapiVendorUsage(app: AppContext, requested: OfapiUsageWindow) {
  const window = ofapiUsageWindowSchema.parse(requested);
  if (!app.ofapi?.getCreditUsage) throw new ServiceUnavailableError("OFAPI usage transport unavailable");
  const scope = await getOfapiKeyScope(app);
  if (window.accountId && scope.accountIds && !scope.accountIds.includes(window.accountId)) throw new ForbiddenError("Account is outside the declared key scope");
  const response = await app.ofapi.getCreditUsage(window);
  if (!response.evidence) throw new ServiceUnavailableError("OFAPI usage was not durably captured");
  const vendor = parseOfapiVendorUsage(response.body, window);
  const snapshotId = await saveOfapiVendorUsage(app.db, {
    observationId: response.evidence.observationId, fingerprint: scope.credentialFingerprint,
    scope: window, data: vendor, observedAt: response.evidence.receivedAt,
  });
  const local = await compareOfapiVendorUsage(app.db, window);
  // Ledger rows do not prove historical credential/account-generation continuity. A declaration alone
  // cannot promote a comparison to equivalent scope. Keep the difference visible and labelled.
  return { snapshotId, observedAt: response.evidence.receivedAt.toISOString(),
    credentialFingerprint: scope.credentialFingerprint, visibility: scope.visibility,
    accountId: window.accountId, vendor, local,
    difference: vendor.totals.credits - local.recordedCredits, equivalentScope: false,
    explanation: "Vendor and local totals are shown separately. Historical ledger credential scope is not proven; restricted keys include team-wide unattributed spend. Today is provisional. No vendor aggregate is added to the ledger.",
  };
}
