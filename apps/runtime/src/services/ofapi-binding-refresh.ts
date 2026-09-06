import { createHash, createHmac, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  applyVerifiedOfapiBinding, getOfapiBindingPage, insertObservation, listOfapiBindingRecoveryCandidates,
} from "@agency_hub_core/db";
import type { OfapiBindingRefreshBody } from "@agency_hub_core/contracts";
import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, ServiceUnavailableError } from "./errors.ts";
import { toAccountRecords } from "./ofapi.ts";
import { resolveOfapiAuthIncident } from "./notification-incidents.ts";
import { loadObservationPayload } from "./payload-reader.ts";

export async function refreshOfapiBinding(app: AppContext, input: OfapiBindingRefreshBody, actorId: number) {
  const client = app.ofapi;
  const credential = await client?.getCredentialPreflight?.();
  if (credential?.status !== "verified") throw new ServiceUnavailableError(`OFAPI credential preflight ${credential?.status ?? "unknown"}`);
  const page = await getOfapiBindingPage(app.db, input.pageId);
  if (!page) throw new BadRequestError("Active OnlyFans page is required");
  if (page.account_id !== input.expectedAccountId || page.generation !== input.expectedGeneration) {
    throw new ConflictError("OFAPI binding changed; refresh preview");
  }
  const accounts = await client!.listAccounts();
  const target = accounts.find(account => account.id === input.accountId);
  if (!target?.onlyfansUserId || target.identityStatus === "conflict") {
    throw new ConflictError("Target account identity is unavailable or conflicting; the visible roster may be restricted");
  }
  const identities = [page.creator_id, page.metadata_creator_id].filter((id): id is string => Boolean(id));
  // A current mapping plus the provider's numeric creator ID is seed evidence.
  // A replacement account alone is never evidence for which Hub page owns it.
  const current = accounts.find(account => account.id === page.account_id);
  if (current?.identityStatus === "conflict") throw new ConflictError("Current account identity conflicts");
  if (current?.onlyfansUserId) identities.push(current.onlyfansUserId);
  if (input.identityEvidence) {
    const rows = await app.db.execute(sql`
      select o.* from observations o where o.id=${input.identityEvidence.id}
        and o.received_at=${input.identityEvidence.receivedAt}::timestamptz
        and o.producer='ofapi:admin' and o.kind='ofapi_admin_accounts'
    `);
    const row = rows.rows[0];
    if (!row) throw new ConflictError("Account identity observation is unavailable");
    const captured = await loadObservationPayload(app, input.identityEvidence.id);
    const payload = captured?.payload;
    const raw = payload as { status?: number; body?: string } | null;
    if (raw?.status !== 200 || typeof raw.body !== "string" || raw.body.length === 0) {
      throw new ConflictError("Evidence is not a successful roster read or its body was withheld at capture");
    }
    const previous = toAccountRecords(JSON.parse(raw.body)).find(account => account.id === page.account_id);
    if (!previous?.onlyfansUserId) throw new ConflictError("Evidence does not establish the current binding identity");
    identities.push(previous.onlyfansUserId);
  }
  if (!identities.length || identities.some(id => id !== target.onlyfansUserId)) {
    throw new ConflictError("Verified stable creator evidence is required and must agree with the target");
  }
  const historicalAccountIds: string[] = [];
  for (const evidence of input.historicalEvidence) {
    // Original capture attribution is proof of the old account -> page mapping.
    // Do not assign historical boundaries from a replay's arrival time.
    const result = await app.db.execute<{ native_account_ref: string | null }>(sql`
      select o.native_account_ref from observations o
      where o.id=${evidence.id} and o.received_at=${evidence.receivedAt}::timestamptz
        and (o.account_id=${page.id} or exists (
          select 1 from domain_events d where d.observation_id=o.id and d.account_id=${page.id}
        )) and o.platform='onlyfans'
        and o.source in ('webhook','pull')
    `);
    const ref = result.rows[0]?.native_account_ref;
    if (!ref || !/^acct_[A-Za-z0-9]+$/.test(ref)) throw new ConflictError("Historical observation does not prove account attribution");
    historicalAccountIds.push(ref);
  }
  const recovery = await listOfapiBindingRecoveryCandidates(app.db, page.id, page.generation);
  if (recovery.length && target.isAuthenticated !== true) throw new ConflictError("Recovery requires a verified authenticated target account");
  const preview = {
    pageId: page.id, expectedAccountId: page.account_id, expectedGeneration: page.generation,
    accountId: target.id, creatorId: target.onlyfansUserId,
    historicalAccountIds: [...new Set(historicalAccountIds)].sort(), recovery,
    credentialFingerprint: credential.credentialFingerprint, expectedTeam: credential.expectedTeam,
    identityEvidence: input.identityEvidence, historicalEvidence: input.historicalEvidence,
  };
  const previewToken = createHmac("sha256", app.config.encryptionKey).update(JSON.stringify(preview)).digest("hex");
  if (input.dryRun) return { dryRun: true, applied: false, previewToken, ...preview };
  if (input.previewToken !== previewToken) throw new ConflictError("OFAPI preview changed; preview again before applying");
  const applied = await app.db.transaction(async tx => {
    const db = tx as AppContext["db"];
    const changed = await applyVerifiedOfapiBinding(db, {
      ...preview, evidence: { actorId, previewToken, credentialFingerprint: credential.credentialFingerprint,
        identityEvidence: input.identityEvidence, historicalEvidence: input.historicalEvidence },
    });
    if (!changed) return false;
    await insertObservation(db, {
      source: "operator", producer: "ofapi:binding", platform: "onlyfans", accountId: page.id,
      nativeAccountRef: target.id, kind: "ofapi.binding.replaced", actorPrincipalId: actorId,
      payload: preview, payloadHash: createHash("sha256").update(JSON.stringify(preview)).digest(), idempotencyKey: randomUUID(),
    });
    if (target.isAuthenticated === true) await resolveOfapiAuthIncident({ ...app, db }, {
      platformAccountId: page.id, pageLabel: page.label, platform: "onlyfans", recoveredAt: new Date(),
    });
    return true;
  });
  if (!applied) throw new ConflictError("Binding or recovery blockers changed; refresh preview");
  return { dryRun: false, applied: true, previewToken, ...preview };
}
