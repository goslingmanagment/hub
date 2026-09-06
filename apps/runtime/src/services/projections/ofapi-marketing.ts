import { sql } from "drizzle-orm";
import { decryptJsonWithKeyVersion } from "@agency_hub_core/shared";
import { isDmArchiveScopeFenced, tryAcquireDmArchiveWriterFenceLock, type Database } from "@agency_hub_core/db";
import { ofapiMarketingActionSchema, ofapiMarketingResourceSchema, type OfapiMarketingAction, type OfapiMarketingResource } from "@agency_hub_core/contracts";
import type { AppContext } from "../../bootstrap.ts";
import { asRecord, idToString } from "../ofapi-payloads.ts";
import { marketingTemplateVariables, normalizeOfapiMarketingResource } from "../ofapi-marketing-normalization.ts";
import { loadObservationPayload } from "../payload-reader.ts";
import { createOfapiCreditSpendSink } from "../ofapi-credits.ts";
import { parseResponseMeta } from "../ofapi.ts";

export const OFAPI_MARKETING_RESPONSE_KIND = "ofapi.marketing_response.v1";
export interface MarketingResponseSource {
  bodyBase64: string;
  headers: Record<string, string>;
  requestId: string;
  actorUserId: number;
  credentialFingerprint: string;
  frozen?: { command: unknown; accountId: string | null; bindingGeneration: number | null; credentialFingerprint: string; baselineResource?: unknown; baselineTemplateVariables?: unknown };
  postbackId?: number;
}
const MUTEX = 815_420;
const key = (r: OfapiMarketingResource) => `${r.pageId}:${r.kind}:${r.parentId ?? ""}:${r.id}`;
const remoteId = (command: OfapiMarketingAction) => "pixelId" in command ? String(command.pixelId) : "postbackId" in command ? String(command.postbackId) : "linkId" in command ? command.linkId : null;

/** A definite HTTP response settles the external outcome independently from
 * accounting and local materialization. Creation still requires its remote ID. */
export function classifyOfapiMarketingOutcome(command: OfapiMarketingAction, status: number, body: unknown, expectedAccountId?: string | null) {
  if (status < 200 || status >= 300) return { state: "rejected", remoteId: null, errorCode: `vendor_http_${status}` };
  const data = asRecord(asRecord(body)?.data);
  if (command.action === "pixel_test") return { state: data?.accepted === true ? "succeeded" : "indeterminate", remoteId: remoteId(command), errorCode: data?.accepted === true ? null : "vendor_acceptance_unconfirmed" };
  if (expectedAccountId && data?.account && asRecord(data.account)?.id !== expectedAccountId) return {state:"indeterminate",remoteId:null,errorCode:"vendor_resource_scope_unconfirmed"};
  const returned = idToString(data?.id), target = remoteId(command);
  const create = command.action.endsWith("_create");
  const valid = returned !== null && (command.action === "smart_link_create" ? /^[0-9A-HJKMNP-TV-Z]{26}$/.test(returned) : /^[1-9]\d*$/.test(returned));
  if ((create && !valid) || (returned && target && returned !== target)) return { state: "indeterminate", remoteId: null, errorCode: "vendor_resource_identity_unconfirmed" };
  return { state: "succeeded", remoteId: create ? returned : target, errorCode: null };
}

export async function settleOfapiMarketingOutcome(app: AppContext, intentId: string, observationId: number, command: OfapiMarketingAction, status: number, body: unknown, expectedAccountId?: string | null) {
  const outcome = classifyOfapiMarketingOutcome(command, status, body,expectedAccountId);
  await app.db.execute(sql`update ofapi_marketing_intents set state=${outcome.state},remote_id=${outcome.remoteId},error_code=${outcome.errorCode},
    response_observation_id=${observationId},settled_at=coalesce(settled_at,now()) where id=${intentId}
    and state<>'prepared' and (response_observation_id is null or response_observation_id=${observationId})`);
  return outcome;
}

async function resourcesAt(db: Database, at: Date) {
  const found = new Map<string, OfapiMarketingResource>();
  const snapshots = (await db.execute<{ page_id: string; pathname: string; operation: string; observed_at: Date; items: unknown[] }>(sql`
    select page_id,pathname,operation,observed_at,items from ofapi_read_snapshots where category in ('smart_links','tracking_links')
    and observed_at<=${at} order by observed_at,id`)).rows;
  for (const snapshot of snapshots) for (const item of snapshot.items) {
    const resource = asRecord(asRecord(item)?.resource); if (!resource) continue;
    const parsed = ofapiMarketingResourceSchema.safeParse({ ...resource, pageId: Number(snapshot.page_id),
      parentId: snapshot.operation.endsWith("_pixels") ? snapshot.pathname.split("/")[2] : null, observedAt: new Date(snapshot.observed_at).toISOString() });
    if (parsed.success) found.set(key(parsed.data), parsed.data);
  }
  for (const snapshot of snapshots.filter(s => s.operation.endsWith("_tags"))) for (const resource of found.values()) {
    if (resource.pageId === Number(snapshot.page_id) && snapshot.pathname.endsWith(`/${resource.id}/tags`) && new Date(snapshot.observed_at).toISOString() >= resource.observedAt)
      resource.tags = snapshot.items.flatMap(i => typeof asRecord(i)?.tag === "string" ? [String(asRecord(i)!.tag)] : []);
  }
  const configs = (await db.execute<{ data: unknown; deleted: boolean }>(sql`select data,deleted from ofapi_marketing_resources where observed_at<=${at} order by observed_at,id`)).rows;
  for (const config of configs) {
    const parsed = ofapiMarketingResourceSchema.safeParse(config.data); if (!parsed.success) continue;
    const k = key(parsed.data), previous = found.get(k);
    if (previous && previous.observedAt > parsed.data.observedAt) continue;
    if (config.deleted) found.delete(k); else found.set(k, parsed.data);
  }
  return [...found.values()];
}

function patchResource(previous: OfapiMarketingResource | undefined, row: Record<string, unknown>, kind: OfapiMarketingResource["kind"], pageId: number | null, parentId: string | null, at: Date) {
  const normalized = normalizeOfapiMarketingResource({ row, kind, pageId, parentId, observedAt: at });
  if (!previous) return normalized;
  const next = { ...previous, observedAt: at.toISOString() };
  const fields: Record<string, (keyof OfapiMarketingResource)[]> = {
    name: ["name"], label: ["name"], account: ["nativeAccountRef"], link_type: ["linkType"], platform: ["platform"], pixel_id: ["platformPixelId"], status: ["status"],
    traffic_redirect_url: ["publicUrl", "destination"], url: ["destination"], event_source_url: ["destination"], http_method: ["httpMethod"],
    tags: ["tags"], cost: ["cost"], revenue: ["revenueMills"], conversion_types: ["conversionTypes"], smart_link_scope: ["scope"], smart_link_ids: ["linkIds"], headers: ["headerNames"], body: ["hasBodyTemplate"],
  };
  for (const [field, targets] of Object.entries(fields)) if (field in row) for (const target of targets) Object.assign(next, { [target]: normalized[target] });
  next.eventNames = { ...previous.eventNames, ...normalized.eventNames };
  // Partial provider updates can omit write-only templates. Preserve their known
  // variable names rather than claiming those fields were cleared.
  if (["url", "body", "headers"].some(field => field in row)) next.templateVariables = [...new Set([...previous.templateVariables, ...normalized.templateVariables])].sort();
  return ofapiMarketingResourceSchema.parse(next);
}

type TemplateVariables = Record<"url"|"body"|"headers",string[]>;
function templateVariables(row:Record<string,unknown>):TemplateVariables {
  return {url:marketingTemplateVariables(row.url),body:marketingTemplateVariables(row.body),headers:marketingTemplateVariables(...(Array.isArray(row.headers) ? row.headers.map(value=>asRecord(value)?.value) : []))};
}
function savedTemplateVariables(value:unknown):TemplateVariables|null {
  const row=asRecord(value);
  if(!row || !["url","body","headers"].every(key=>Array.isArray(row[key]) && row[key].every(v=>typeof v==="string"))) return null;
  return {url:[...row.url as string[]],body:[...row.body as string[]],headers:[...row.headers as string[]]};
}
async function upsert(db: Database, resource: OfapiMarketingResource, observationId: number, credential: string, deleted = false, variables?:TemplateVariables) {
  if (resource.pageId) {
    if (!await tryAcquireDmArchiveWriterFenceLock(db,resource.pageId)) throw new Error("marketing_erasure_busy");
    if (await isDmArchiveScopeFenced(db,{pageId:resource.pageId,refs:[],materialAt:new Date(resource.observedAt)})) return;
  }
  await db.execute(sql`insert into ofapi_marketing_resources(page_id,kind,upstream_id,parent_id,data,deleted,credential_fingerprint,observation_id,observed_at)
    values(${resource.pageId},${resource.kind},${resource.id},${resource.parentId ?? ""},${JSON.stringify({...resource,...(variables ? {_templateVariablesByField:variables} : {})})}::jsonb,${deleted},${credential},${observationId},${new Date(resource.observedAt)})
    on conflict ((coalesce(page_id,0)),kind,parent_id,upstream_id) do update set data=excluded.data,deleted=excluded.deleted,
    credential_fingerprint=excluded.credential_fingerprint,observation_id=excluded.observation_id,observed_at=excluded.observed_at
    where ofapi_marketing_resources.observed_at<=excluded.observed_at`);
}

async function projectMaterial(db: Database, input: { source: MarketingResponseSource; command: OfapiMarketingAction | null; body: unknown; observationId: number; at: Date; status: number }) {
  const { source, command, body, observationId, at } = input;
  if (input.status < 200 || input.status >= 300) return;
  const root = asRecord(body), data = asRecord(root?.data);
  if (!command) {
    const rows = source.postbackId ? [root?.data] : root?.data;
    if (!Array.isArray(rows)) throw new Error("postback_inventory_shape_unavailable");
    const variableSets=new Map<string,TemplateVariables>();
    const resources = rows.map(value => {
      const row = asRecord(value); if (!row || !/^[1-9]\d*$/.test(idToString(row.id) ?? "")) throw new Error("postback_identity_unavailable");
      if (source.postbackId && String(row.id) !== String(source.postbackId)) throw new Error("postback_identity_mismatch");
      const resource=normalizeOfapiMarketingResource({ kind: "postback", pageId: null, row, observedAt: at });
      variableSets.set(resource.id,templateVariables(row));return resource;
    });
    for (const resource of resources) await upsert(db, resource, observationId, source.credentialFingerprint,false,variableSets.get(resource.id));
    const pagination = asRecord(root?._pagination);
    // A plain array does not establish inventory completeness. Only explicit
    // EOF authorizes absence tombstones, scoped to this credential's inventory.
    if (!source.postbackId && (root?.hasMore === false || pagination?.hasMore === false || (pagination && "next_page" in pagination && pagination.next_page === null))) {
      const previous = (await db.execute<{ data: unknown }>(sql`select data from ofapi_marketing_resources where kind='postback' and page_id is null
        and credential_fingerprint=${source.credentialFingerprint} and observed_at<=${at} and not deleted`)).rows;
      for (const item of previous) {
        const old = ofapiMarketingResourceSchema.parse(item.data);
        if (!resources.some(r => r.id === old.id)) await upsert(db, { ...old, observedAt: at.toISOString() }, observationId, source.credentialFingerprint, true);
      }
    }
    return;
  }
  const outcome = classifyOfapiMarketingOutcome(command, input.status, body,source.frozen?.accountId);
  if (outcome.state !== "succeeded" || command.action === "pixel_test") return;
  const pageId = "pageId" in command ? command.pageId : null;
  const kind = command.action.startsWith("pixel_") ? "pixel" : command.action.startsWith("postback_") ? "postback" : "smart_link";
  const parentId = kind === "pixel" && "linkId" in command ? command.linkId : null;
  const available = await resourcesAt(db, at);
  const baseline=ofapiMarketingResourceSchema.safeParse(source.frozen?.baselineResource);
  const matches=(r:OfapiMarketingResource)=>r.pageId===pageId && r.kind===kind && r.id===outcome.remoteId && r.parentId===parentId;
  const previous = baseline.success && matches(baseline.data) ? baseline.data : available.find(matches);
  const row: Record<string, unknown> = { ...command, ...(data ?? {}), id: outcome.remoteId };
  if (source.frozen?.accountId) {
    if (data?.account && asRecord(data.account)?.id !== source.frozen.accountId) throw new Error("marketing_account_mismatch");
    row.account = { id: source.frozen.accountId };
  }
  if (command.action === "tags_add" || command.action === "tags_remove") {
    const tags = root?.tags ?? data?.tags;
    row.tags = Array.isArray(tags) ? tags : command.action === "tags_add" ? [...new Set([...(previous?.tags ?? []), ...command.tags])] : (previous?.tags ?? []).filter(t => !command.tags.includes(t));
  }
  const resource = patchResource(previous, row, kind, pageId, parentId, at);
  let variables:TemplateVariables|undefined;
  if(kind==="postback") {
    const stored=(await db.execute<{variables:unknown}>(sql`select data->'_templateVariablesByField' as variables from ofapi_marketing_resources
      where kind='postback' and page_id is null and upstream_id=${resource.id} and observed_at<=${at}`)).rows[0]?.variables;
    variables=savedTemplateVariables(source.frozen?.baselineTemplateVariables) ?? savedTemplateVariables(stored) ?? templateVariables({});
    const incoming=templateVariables(row);
    for(const field of ["url","body","headers"] as const) if(field in row) variables[field]=incoming[field];
    resource.templateVariables=[...new Set(Object.values(variables).flat())].sort();
  }
  const deleted = command.action.endsWith("_delete") || command.action === "pixel_disconnect";
  await upsert(db, resource, observationId, source.credentialFingerprint, deleted,variables);
  if (command.action === "pixel_update") for (const other of available.filter(r => r.kind === "pixel" && r.id === resource.id && key(r) !== key(resource))) {
    // The team-wide pixel update also changes every known connection, while its
    // acknowledgement explicitly says the known relation inventory is incomplete.
    await upsert(db, patchResource(other, {...row,account:{id:other.nativeAccountRef}}, "pixel", other.pageId, other.parentId, at), observationId, source.credentialFingerprint);
  }
  if (command.action === "smart_link_delete") for (const pixel of available.filter(r => r.pageId === pageId && r.kind === "pixel" && r.parentId === resource.id))
    await upsert(db, { ...pixel, observedAt: at.toISOString() }, observationId, source.credentialFingerprint, true);
}

/** Registered administrative projection: its authority is an encrypted operator
 * response plus frozen intent, never a synthesized page business event. */
export const OFAPI_MARKETING_ADMIN_PROJECTION = { name: "ofapi_marketing_configuration", version: 1, sourceKind: OFAPI_MARKETING_RESPONSE_KIND,
  tables: ["ofapi_marketing_resources", "ofapi_marketing_projection_receipts"], run: runOfapiMarketingProjection, rebuild: rebuildOfapiMarketingProjection } as const;

export async function runOfapiMarketingProjection(app: AppContext, options: { observationId?: number; limit?: number } = {}) {
  const rows = (await app.db.execute<{ id: string; account_id: string | null }>(sql`select o.id,o.account_id from observations o
    left join ofapi_marketing_projection_receipts r on r.observation_id=o.id where o.kind=${OFAPI_MARKETING_RESPONSE_KIND} and o.source='operator'
    ${options.observationId ? sql`and o.id=${options.observationId}` : sql``}
    and (r.observation_id is null or r.projection_state='pending' or r.accounting_state='pending')
    order by r.checked_at nulls first,o.received_at,o.id limit ${Math.min(options.limit ?? 50, 200)}`)).rows;
  let projected = 0, pending = 0;
  for (const row of rows) {
    const observationId = Number(row.id), pageId = row.account_id ? Number(row.account_id) : null;
    let materialAt = new Date(0);
    try {
      const observation = await loadObservationPayload(app, observationId); if (!observation) continue;
      materialAt = observation.receivedAt;
      const payload = asRecord(observation.payload); if (!payload) throw new Error("marketing_source_unavailable");
      const source = decryptJsonWithKeyVersion<MarketingResponseSource>(payload.encryptedBody as Parameters<typeof decryptJsonWithKeyVersion>[0], app.config.encryptionKeysByVersion);
      const command = source.frozen ? ofapiMarketingActionSchema.parse(source.frozen.command) : null;
      if ((command && "pageId" in command ? command.pageId : null) !== pageId) throw new Error("marketing_scope_mismatch");
      let body: unknown = null;
      try { body = source.bodyBase64 ? JSON.parse(Buffer.from(source.bodyBase64, "base64").toString("utf8")) : null; } catch { /* Outcome classification records malformed response without resending. */ }
      const status = Number(payload.status), intentId = typeof payload.intentId === "string" ? payload.intentId : null;
      if (command && intentId) await settleOfapiMarketingOutcome(app, intentId, observationId, command, status, body,source.frozen?.accountId);
      let fenced=false;
      await app.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(${MUTEX}::bigint)`);
        if (pageId) {
          if (!await tryAcquireDmArchiveWriterFenceLock(tx, pageId)) throw new Error("marketing_erasure_busy");
          if (await isDmArchiveScopeFenced(tx, { pageId, refs: [], materialAt: observation.receivedAt })) {fenced=true;return;}
        }
        await tx.execute(sql`insert into ofapi_marketing_projection_receipts(observation_id,page_id) values(${observationId},${pageId}) on conflict do nothing`);
        const receipt = (await tx.execute<{ projection_state: string }>(sql`select projection_state from ofapi_marketing_projection_receipts where observation_id=${observationId}`)).rows[0];
        if (receipt?.projection_state !== "complete") {
          await projectMaterial(tx, { source, command, body, status, observationId, at: observation.receivedAt });
          await tx.execute(sql`update ofapi_marketing_projection_receipts set projection_state='complete',error_code=null,checked_at=now() where observation_id=${observationId}`);
          if (intentId) await tx.execute(sql`update ofapi_marketing_intents set projection_state='complete' where id=${intentId}`);
        }
      });
      if (fenced) continue;
      const meta = parseResponseMeta(body, source.headers);
      const accounting = await createOfapiCreditSpendSink(app)({ operation: String(payload.operation), httpStatus: status, credits: meta?.creditsUsed ?? 0,
        estimated: meta?.creditsUsed == null, balanceAfter: meta?.creditBalance ?? null, requestId: source.requestId, pageId, attemptNumber: 1,
        isCached: meta?.isCached ?? null, actorUserId: source.actorUserId, receivedAt: observation.receivedAt.toISOString() });
      if (accounting === false) throw new Error("marketing_accounting_pending");
      await app.db.execute(sql`update ofapi_marketing_projection_receipts set accounting_state='complete',checked_at=now() where observation_id=${observationId}`);
      if (intentId) await app.db.execute(sql`update ofapi_marketing_intents set accounting_state='complete' where id=${intentId}`);
      projected++;
    } catch {
      pending++;
      // The error label contains no provider text or write-only secret. Failure
      // here cannot change an already confirmed external mutation outcome.
      await app.db.transaction(async tx=>{
        if(pageId && (!await tryAcquireDmArchiveWriterFenceLock(tx,pageId) || await isDmArchiveScopeFenced(tx,{pageId,refs:[],materialAt}))) return;
        await tx.execute(sql`insert into ofapi_marketing_projection_receipts(observation_id,page_id,error_code) values(${observationId},${pageId},'local_repair_pending')
          on conflict(observation_id) do update set error_code='local_repair_pending',checked_at=now()`);
      });
    }
  }
  return { projected, pending };
}

export async function rebuildOfapiMarketingProjection(app: AppContext) {
  await app.db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MUTEX}::bigint)`);
    await tx.execute(sql`delete from ofapi_marketing_resources`);
    await tx.execute(sql`delete from ofapi_marketing_projection_receipts`);
    await tx.execute(sql`update ofapi_marketing_intents set projection_state='pending' where response_observation_id is not null`);
  });
  // Resumable and bounded: subsequent local dashboard reads continue receipts.
  return runOfapiMarketingProjection(app, { limit: 200 });
}
