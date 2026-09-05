import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

export interface OfapiBindingPage extends Record<string, unknown> {
  id: number;
  label: string;
  account_id: string | null;
  generation: number;
  creator_id: string | null;
  metadata_creator_id: string | null;
}

export async function getOfapiBindingPage(db: Database, pageId: number) {
  const result = await db.execute<OfapiBindingPage>(sql`
    select p.id, p.label, p.ofapi_account_id as account_id, p.ofapi_binding_generation as generation,
      p.external_page_id as creator_id, p.metadata->>'onlyfansUserId' as metadata_creator_id
    from pages p where p.id = ${pageId} and p.platform = 'onlyfans' and p.status = 'active'
  `);
  const row = result.rows[0];
  return row ? { ...row, id: Number(row.id) } : null;
}

/** An account remains resolvable after retirement, including a redelivery received
 * today. Current-only callers must keep using findPageByOfapiAccountId. */
export async function findHistoricalPageByOfapiAccountId(db: Database, accountId: string) {
  const result = await db.execute<{ id: number; label: string; platform: "onlyfans" }>(sql`
    select p.id, p.label, p.platform from pages p
    where p.platform = 'onlyfans' and (
      p.ofapi_account_id = ${accountId} or exists (
        select 1 from ofapi_account_bindings b where b.account_id = ${accountId} and b.page_id = p.id
      )
    ) limit 2
  `);
  return result.rows.length === 1 ? { ...result.rows[0]!, id: Number(result.rows[0]!.id) } : null;
}

export async function withOfapiBindingLock<T>(db: Database, pageId: number, run: (tx: Database) => Promise<T>) {
  return db.transaction(async tx => {
    const database = tx as Database;
    // Lock is shared by replacement, account-health and command dispatch.
    await database.execute(sql`select pg_advisory_xact_lock(9003010, ${pageId}::integer)`);
    return run(database);
  });
}

export async function listOfapiBindingRecoveryCandidates(db: Database, pageId: number, generation: number) {
  const result = await db.execute<{ stream: string; version: string; code: string }>(sql`
    select s.stream, s.updated_at::text as version, s.blocker_code as code
    from page_sync_states s where s.page_id = ${pageId}
      and s.blocker_ofapi_generation = ${generation}
      and s.blocker_kind = 'auth' and not s.ofapi_user_paused
      and s.blocker_code in ('ofapi_authentication_failed','ofapi_otp_code_required','ofapi_face_otp_required',
        'ofapi_disconnected','ofapi_account_not_found')
    order by s.stream
  `);
  return result.rows;
}

export async function applyVerifiedOfapiBinding(db: Database, input: {
  pageId: number; expectedAccountId: string | null; expectedGeneration: number;
  accountId: string; creatorId: string; evidence: Record<string, unknown>;
  historicalAccountIds: string[];
  recovery: Array<{ stream: string; version: string; code: string }>;
}) {
  return withOfapiBindingLock(db, input.pageId, async tx => {
    // Serialize cross-page claims before testing historical ownership.
    await tx.execute(sql`select pg_advisory_xact_lock(9003011)`);
    const page = await getOfapiBindingPage(tx, input.pageId);
    if (!page || page.account_id !== input.expectedAccountId || page.generation !== input.expectedGeneration) return false;
    const currentIdentities = [page.creator_id, page.metadata_creator_id].filter(Boolean);
    if (currentIdentities.some(id => id !== input.creatorId)) return false;
    const ids = [...new Set([input.accountId, ...(page.account_id ? [page.account_id] : []), ...input.historicalAccountIds])];
    const conflicts = await tx.execute(sql`
      select 1 from ofapi_account_bindings b where b.account_id = any(array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::text[])
        and (b.page_id <> ${input.pageId} or (b.creator_id is not null and b.creator_id <> ${input.creatorId}))
      union all select 1 from pages p where p.id <> ${input.pageId} and p.ofapi_account_id = any(array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::text[])
    `);
    if (conflicts.rows.length) return false;
    // Do not clear a newer blocker that appeared after preview.
    const recovery = await listOfapiBindingRecoveryCandidates(tx, input.pageId, page.generation);
    if (JSON.stringify(recovery) !== JSON.stringify(input.recovery)) return false;
    const generation = page.generation + 1;
    for (const id of ids) {
      await tx.execute(sql`
        insert into ofapi_account_bindings(account_id,page_id,creator_id,generation,valid_from,valid_to,evidence)
        values (${id},${input.pageId},${input.creatorId},${id === input.accountId ? generation : null},
          ${id === input.accountId ? new Date() : null},${id === page.account_id && id !== input.accountId ? new Date() : null},${JSON.stringify(input.evidence)}::jsonb)
        on conflict(account_id) do update set creator_id=excluded.creator_id,
          generation=coalesce(excluded.generation,ofapi_account_bindings.generation),
          valid_from=coalesce(ofapi_account_bindings.valid_from,excluded.valid_from),
          valid_to=case when excluded.account_id=${input.accountId} then null
            else coalesce(excluded.valid_to,ofapi_account_bindings.valid_to) end,
          evidence=ofapi_account_bindings.evidence || excluded.evidence
      `);
    }
    await tx.execute(sql`
      update pages set ofapi_account_id=${input.accountId}, ofapi_binding_generation=${generation},
        external_page_id=${input.creatorId}, metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('onlyfansUserId',${input.creatorId}::text),
        ofapi_auth_status=null, ofapi_auth_changed_at=null,
        transactions_writer=coalesce(transactions_writer,'ofapi'),updated_at=now()
      where id=${input.pageId}
    `);
    for (const candidate of recovery) {
      await tx.execute(sql`
        update page_sync_states set status=case when request_seq>applied_seq then 'pending'::page_sync_status else 'idle'::page_sync_status end,
          blocker_kind=null,blocker_code=null,blocker_message=null,blocked_at=null,blocker_ofapi_generation=null,
          retry_kind=null,retry_at=null,updated_at=now()
        where page_id=${input.pageId} and stream=${candidate.stream} and updated_at::text=${candidate.version}
          and blocker_ofapi_generation=${page.generation} and blocker_kind='auth' and not ofapi_user_paused
      `);
    }
    return true;
  });
}

export async function recordOfapiCredentialPreflight(db: Database, value: {
  credentialFingerprint: string; expectedTeam: string | null; observedTeam: string | null;
  status: string; checkedAt: string; reason: string | null;
}) {
  await db.execute(sql`
    insert into ofapi_credential_preflights(credential_fingerprint,expected_team,observed_team,status,checked_at,reason)
    values (${value.credentialFingerprint},${value.expectedTeam},${value.observedTeam},${value.status},${value.checkedAt}::timestamptz,${value.reason})
    on conflict(credential_fingerprint) do update set expected_team=excluded.expected_team,observed_team=excluded.observed_team,
      status=excluded.status,checked_at=excluded.checked_at,reason=excluded.reason
  `);
}

export async function listHistoricalOfapiBindings(db: Database) {
  const result = await db.execute<{ account_id: string; page_id: number }>(sql`
    select b.account_id,b.page_id from ofapi_account_bindings b
    join pages p on p.id=b.page_id where p.platform='onlyfans'
  `);
  return result.rows.map(row => ({ ...row, page_id: Number(row.page_id) }));
}

export async function checkOfapiCurrentBinding(db: Database, pageId: number | null | undefined, accountId: string, generation?: number) {
  const result = await db.execute<{ generation: number; auth_status: string | null }>(sql`
    select p.ofapi_binding_generation as generation,p.ofapi_auth_status as auth_status from pages p
    where p.ofapi_account_id=${accountId} and p.status='active' and p.platform='onlyfans'
      and (${pageId ?? null}::bigint is null or p.id=${pageId ?? null})
  `);
  const row = result.rows[0];
  if (!row || (generation !== undefined && generation !== row.generation) || row.auth_status === 'account_not_found') {
    throw new Error("ofapi_account_not_found_or_binding_changed");
  }
  return row.generation;
}

export async function markOfapiBindingUnavailable(db: Database, accountId: string, generation: number) {
  const selected = await db.execute<{ id: number; label: string }>(sql`select p.id,p.label from pages p where p.ofapi_account_id=${accountId}`);
  const page = selected.rows[0];
  if (!page) return null;
  return withOfapiBindingLock(db, page.id, async tx => {
    const changed = await tx.execute(sql`
      update pages set ofapi_auth_status='account_not_found',ofapi_auth_changed_at=now(),updated_at=now()
      where id=${page.id} and ofapi_account_id=${accountId} and ofapi_binding_generation=${generation}
      returning id
    `);
    if (!changed.rows.length) return null;
    await tx.execute(sql`
      update page_sync_states set status='paused',blocker_kind='auth',blocker_code='ofapi_account_not_found',
        blocker_message='OFAPI account binding is unavailable',blocker_ofapi_generation=${generation},blocked_at=now(),
        leased_seq=null,lease_owner=null,lease_token=null,lease_heartbeat_at=null,lease_expires_at=null,updated_at=now()
      where page_id=${page.id} and not ofapi_user_paused and (status<>'paused' or blocker_kind='auth')
    `);
    return { ...page, id: Number(page.id) };
  });
}
