import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { applyConfigPatchesInTx, findPageByLabel, getConfigOverrides, isFanslyWsGenerationBlocked,
  lockFanslyWsGeneration, type Database } from "@agency_hub_core/db";
import { resolveFanslyWsHintPolicy } from "@agency_hub_core/shared";
import type { AppContext } from "../bootstrap.ts";
import { applyEffectiveOverrides, loadEffectiveConfig } from "./effective-config.ts";
import { inspectFanslyBinding } from "./egress/fansly-binding-preflight.ts";
import { readFanslyPageGeneration, readProbeSnapshot } from "./egress/fansly-probe-context.ts";
import { assertFanslyPage } from "./fansly-page.ts";
import { fanslyPageSendGuard } from "./fansly-send-guard/index.ts";
import { fanslyAccountRoute, runFanslyIdentityCheck } from "./sync-engine-account.ts";

const POLICY_KEY = "fanslyWsHintsPolicies";
const GATE_KEYS = ["fanslyWsCaptureEnabled", "fanslyWsCapturePageAllowlist", "fanslyWsHintsEnabled",
  "fanslyWsHintsPageAllowlist", "fanslyWsHintsTypeAllowlist", POLICY_KEY] as const;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const proposalSchema = z.object({
  id: z.uuid(), pageLabel: z.string().min(1), pageId: z.number().int().positive(),
  nativeAccountId: z.string().regex(/^[1-9][0-9]{0,31}$/),
  fromGeneration: digest, toGeneration: digest, fingerprint: digest,
  policyVersion: z.number().int().nonnegative(), expiresAt: z.iso.datetime(),
}).strict();
export type FanslyWsRepairProposal = z.infer<typeof proposalSchema>;
type RepairApp = Pick<AppContext, "db" | "config">;
/** The binding check sends a request of the page: it needs the process's send
 *  guards (plan §2.5) and their logger. */
type BindingApp = RepairApp & Pick<AppContext, "logger" | "fanslySendGuards">;

/** Informational only: B1 is additive, so a mismatch must not fail deploy health. */
export async function getFanslyWsHintDiagnostic(app: RepairApp, label: string, config = app.config) {
  const policy = resolveFanslyWsHintPolicy(config, label);
  if (!policy) return { state: "inactive" as const };
  try {
    const generation = await readFanslyPageGeneration(app.db, label);
    return { state: generation === policy.generation ? "matching" as const : "generation_mismatch" as const,
      configuredGeneration: policy.generation, currentGeneration: generation };
  } catch {
    return { state: "generation_unavailable" as const };
  }
}

async function readPolicySnapshot(db: Database, config: AppContext["config"], label: string) {
  const overrides = await getConfigOverrides(db);
  const effective = applyEffectiveOverrides(config, overrides);
  const policy = resolveFanslyWsHintPolicy(effective, label);
  if (!policy) throw new Error("fansly_ws_repair_policy_inactive");
  if (policy.expiresAt !== undefined) throw new Error("fansly_ws_repair_canary_refused");
  const stored = await findPageByLabel(db, label);
  if (!stored || !stored.page.platformAccountId
    || !/^[1-9][0-9]{0,31}$/.test(stored.page.platformAccountId)) throw new Error("fansly_ws_repair_identity_missing");
  assertFanslyPage(stored.page, "fansly_ws_repair_requires_fansly");
  const generation = await readFanslyPageGeneration(db, label);
  const policyVersion = overrides.get(POLICY_KEY)?.version ?? 0;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    pageId: stored.page.id, nativeAccountId: stored.page.platformAccountId, generation,
    gates: GATE_KEYS.map(key => [key, effective[key], overrides.get(key)?.version ?? 0]),
  })).digest("hex");
  return { policy, policyVersion, fingerprint, generation, pageId: stored.page.id,
    nativeAccountId: stored.page.platformAccountId, policiesJson: effective.fanslyWsHintsPolicies ?? "{}" };
}

/** The socket's verified_at is only an auth-shaped frame. Independently check
 * account/me through the exact snapshotted page dispatcher, then close it. The
 * request waits for the page's send guard (source `binding_preflight`). On a
 * live page the check is the engine's (`account.identity` with the stored
 * session as the candidate, paced by the page's actor; step-3 design §3.5
 * item 6); a page being switched refuses (409) before anything is resolved. */
async function inspectBinding(app: BindingApp, label: string) {
  const known = await findPageByLabel(app.db, label);
  if (known && await fanslyAccountRoute(app, known.page) === "engine") return inspectBindingThroughEngine(app, label);
  const context = await readProbeSnapshot(app.db, app.config, label);
  try {
    return { pageId: context.pageId, generation: context.generation,
      ...await inspectFanslyBinding({ session: context.session,
        expectedAccountId: context.expectedAccountId, egress: context.egress,
        sendGuard: fanslyPageSendGuard(app, context.pageId, "binding_preflight") }) };
  } finally { await context.egress.dispatcher?.destroy(); }
}

async function inspectBindingThroughEngine(app: BindingApp, label: string) {
  const context = await readProbeSnapshot(app.db, app.config, label);
  try {
    const checked = await runFanslyIdentityCheck(app, { id: context.pageId, label }, { session: context.session });
    const identityMatched = checked.matches === true && checked.accountId === context.expectedAccountId;
    return {
      pageId: context.pageId, generation: context.generation, identityMatched,
      observedAccountId: checked.accountId, httpStatus: null, restRequests: 1,
      reason: identityMatched ? "matched" as const : checked.matches === false ? "account_mismatch" as const : "request_failed" as const,
    };
  } finally { await context.egress.dispatcher?.destroy(); }
}

export async function previewFanslyWsPolicyRepair(app: BindingApp, label: string) {
  const snapshot = await app.db.transaction(tx => readPolicySnapshot(tx as unknown as Database, app.config, label),
    { isolationLevel: "repeatable read", accessMode: "read only" });
  const connection = await app.db.execute(sql`select id, verified_at, last_guard_at, closed_at, stop_reason
    from fansly_ws_connections where page_id=${snapshot.pageId} and generation=${snapshot.generation}
    order by started_at desc limit 1`);
  const blocked = await isFanslyWsGenerationBlocked(app.db, snapshot.pageId, snapshot.generation);
  if (snapshot.policy.generation === snapshot.generation) return {
    state: blocked ? "blocked" : "already_matching", pageLabel: label,
    configuredGeneration: snapshot.policy.generation, currentGeneration: snapshot.generation,
    binding: null, connection: connection.rows[0] ?? null,
    blockers: blocked ? ["auth_refused"] : [], proposal: null,
    effect: "No generation change is needed; no account/me request was made.",
  };
  const binding = await inspectBinding(app, label);
  const blockers = [
    ...(!binding.identityMatched || binding.observedAccountId !== snapshot.nativeAccountId ? [`binding:${binding.reason}`] : []),
    ...(binding.pageId !== snapshot.pageId || binding.generation !== snapshot.generation ? ["generation_changed"] : []),
    ...(blocked ? ["auth_refused"] : []),
  ];
  const proposal: FanslyWsRepairProposal | null = blockers.length ? null : {
    id: randomUUID(), pageId: snapshot.pageId, pageLabel: label, nativeAccountId: snapshot.nativeAccountId,
    fromGeneration: snapshot.policy.generation, toGeneration: snapshot.generation,
    policyVersion: snapshot.policyVersion, fingerprint: snapshot.fingerprint,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  return { state: blockers.length ? "blocked" : proposal ? "ready" : "already_matching",
    pageLabel: label, configuredGeneration: snapshot.policy.generation, currentGeneration: snapshot.generation,
    binding, connection: connection.rows[0] ?? null, blockers, proposal,
    effect: "Only future hint routing; retained disabled receipts and the rolling request budget remain unchanged." };
}

export async function applyFanslyWsPolicyRepair(app: BindingApp, reviewed: unknown) {
  const proposal = proposalSchema.parse(reviewed);
  const binding = await inspectBinding(app, proposal.pageLabel);
  if (!binding.identityMatched || binding.observedAccountId !== proposal.nativeAccountId
    || binding.generation !== proposal.toGeneration || binding.pageId !== proposal.pageId) {
    throw new Error("fansly_ws_repair_binding_changed");
  }
  return app.db.transaction(async tx => {
    const db = tx as unknown as Database;
    await lockFanslyWsGeneration(db, proposal.pageId);
    // Serialize existing gates against the ordinary audited config writer.
    // Serializable isolation also protects absent override rows and rotation.
    await db.execute(sql`select key from config_settings where scope_type='global' and scope_id=0
      and key in ${[...GATE_KEYS]} order by key for update`);
    const current = await readPolicySnapshot(db, app.config, proposal.pageLabel);
    if (current.pageId !== proposal.pageId || current.nativeAccountId !== proposal.nativeAccountId
      || current.generation !== proposal.toGeneration
      || await isFanslyWsGenerationBlocked(db, current.pageId, current.generation)) {
      throw new Error("fansly_ws_repair_generation_changed");
    }
    const note = `fansly_ws_generation_repair:${proposal.fingerprint}`;
    const applied = await db.execute(sql`select 1 from config_audit_log where group_id=${proposal.id}::uuid
      and key=${POLICY_KEY} and scope_type='global' and scope_id=0 and note=${note}
      and new_version=${current.policyVersion} and new_value=${JSON.stringify(current.policiesJson)}::jsonb limit 1`);
    if (applied.rows.length && current.policy.generation === proposal.toGeneration) return { state: "already_applied" as const };
    if (Date.now() >= Date.parse(proposal.expiresAt) || current.fingerprint !== proposal.fingerprint
      || current.policyVersion !== proposal.policyVersion || current.policy.generation !== proposal.fromGeneration) {
      throw new Error("fansly_ws_repair_preview_stale");
    }
    // Parsing was validated by the resolver; preserve sibling entries and
    // every policy field except this one page's generation.
    const policies = JSON.parse(current.policiesJson) as Record<string, Record<string, unknown>>;
    policies[proposal.pageLabel] = { ...policies[proposal.pageLabel], generation: proposal.toGeneration };
    await applyConfigPatchesInTx(db, { patches: [{ key: POLICY_KEY, value: JSON.stringify(policies),
      expectedVersion: proposal.policyVersion }], userId: null, groupId: proposal.id, note });
    return { state: "applied" as const };
  }, { isolationLevel: "serializable" });
}

export async function diagnoseFanslyWsHints(app: RepairApp, label: string) {
  return getFanslyWsHintDiagnostic(app, label, await loadEffectiveConfig(app.db, app.config));
}
