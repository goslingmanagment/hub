import { sql } from "drizzle-orm";
import type { OfapiKeyScopeApply, OfapiUsageResult, OfapiUsageWindow } from "@agency_hub_core/shared";
import type { Database } from "../client.ts";

export async function getOfapiKeyDeclaration(db: Database, fingerprint: string) {
  const result = await db.execute<{
    version: number; capabilities: string[] | null; account_ids: string[] | null;
    visibility: "unknown" | "declared_team" | "declared_restricted"; updated_at: string;
  }>(sql`select d.version, d.capabilities, d.account_ids, d.visibility, d.updated_at::text
    from ofapi_key_scope_declarations d where d.credential_fingerprint = ${fingerprint}`);
  return result.rows[0] ?? null;
}

export async function applyOfapiKeyDeclaration(db: Database, input: OfapiKeyScopeApply, actorUserId: number) {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.credentialFingerprint}, 956))`);
    const current = await getOfapiKeyDeclaration(tx as Database, input.credentialFingerprint);
    if ((current?.version ?? 0) !== input.expectedVersion) return false;
    const version = input.expectedVersion + 1;
    await tx.execute(sql`insert into ofapi_key_scope_declarations
      (credential_fingerprint, version, capabilities, account_ids, visibility, actor_user_id)
      values (${input.credentialFingerprint}, ${version}, ${JSON.stringify(input.capabilities)}::jsonb,
        ${JSON.stringify(input.accountIds)}::jsonb, ${input.visibility}, ${actorUserId})
      on conflict (credential_fingerprint) do update set version = excluded.version,
        capabilities = excluded.capabilities, account_ids = excluded.account_ids,
        visibility = excluded.visibility, actor_user_id = excluded.actor_user_id, updated_at = clock_timestamp()`);
    await tx.execute(sql`insert into ofapi_key_scope_audit (credential_fingerprint, version, declaration, actor_user_id)
      values (${input.credentialFingerprint}, ${version}, ${JSON.stringify(input)}::jsonb, ${actorUserId})`);
    return true;
  });
}

export async function saveOfapiVendorUsage(db: Database, input: {
  observationId: number; fingerprint: string; scope: OfapiUsageWindow; data: OfapiUsageResult; observedAt: Date;
}) {
  const result = await db.execute<{ id: string }>(sql`insert into ofapi_vendor_usage_snapshots
    (observation_id, credential_fingerprint, scope, data, observed_at)
    values (${input.observationId}, ${input.fingerprint}, ${JSON.stringify(input.scope)}::jsonb,
      ${JSON.stringify(input.data)}::jsonb, ${input.observedAt}) returning id::text`);
  return Number(result.rows[0]!.id);
}

export async function compareOfapiVendorUsage(db: Database, window: OfapiUsageWindow) {
  const result = await db.execute<{ recorded: string; estimated: string; external: string }>(sql`
    select coalesce(sum(l.credits) filter (where l.source not in ('external','refill')), 0)::text as recorded,
      coalesce(sum(l.credits) filter (where l.estimated and l.source not in ('external','refill')), 0)::text as estimated,
      coalesce(sum(l.credits) filter (where l.source = 'external'), 0)::text as external
    from ofapi_credit_ledger l where l.occurred_at >= ${window.from}::date
      and l.occurred_at < (${window.to}::date + interval '1 day')
      and (${window.accountId}::text is null or exists (
        select 1 from pages p where p.id = l.page_id and (p.ofapi_account_id = ${window.accountId}
          or exists (select 1 from ofapi_account_bindings b where b.page_id = p.id and b.account_id = ${window.accountId}))
      ))`);
  const row = result.rows[0]!;
  return { recordedCredits: Number(row.recorded), estimatedCredits: Number(row.estimated), externalResidualCredits: Number(row.external) };
}
