import { createHash } from "node:crypto";
import {
  ofapiUsageResultSchema, ofapiUsageWindowSchema, ofapiKeyScopeSchema,
  type OfapiUsageWindow, type OfapiKeyScopeApply,
} from "@agency_hub_core/contracts";
import { applyOfapiKeyDeclaration, compareOfapiVendorUsage, getOfapiKeyDeclaration, saveOfapiVendorUsage, type Database } from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { ConflictError, ForbiddenError, ServiceUnavailableError } from "./errors.ts";
import { asRecord } from "./ofapi-payloads.ts";

export class OfapiKeyPermissionDeniedError extends ForbiddenError {
  constructor(message: string) { super(message); this.name = "OfapiKeyPermissionDeniedError"; }
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

/** Unknown is observed honestly; explicit restrictions fail before egress, independently of Hub ACL. */
export async function assertOfapiConfiguredAccess(db: Database, fingerprint: string, input: {
  operation: string; accountId?: string | null; method: string;
}) {
  // Free identity and credit diagnostics remain usable to repair a restricted credential.
  if (["ofapi_credential_preflight", "ofapi_balance_ping", "ofapi_vendor_usage"].includes(input.operation)) return;
  const policy = await getOfapiKeyDeclaration(db, fingerprint);
  if (!policy) return;
  const capability = /webhook/.test(input.operation) ? "webhooks"
    : /export/.test(input.operation) ? "exports"
      : /upload/.test(input.operation) ? "uploads"
        : /smart_link|pixel|postback/.test(input.operation) ? "links"
          : input.method === "GET" ? "reads" : "commands";
  if (policy.capabilities && !policy.capabilities.includes(capability)) throw new OfapiKeyPermissionDeniedError(`OFAPI key declaration does not allow ${capability}`);
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
