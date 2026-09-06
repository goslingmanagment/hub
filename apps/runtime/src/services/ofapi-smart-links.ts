import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { decryptJsonWithKeyVersion, encryptJson } from "@agency_hub_core/shared";
import { getOfapiKeyDeclaration, checkOfapiCurrentBinding, findPageById, insertAuditEvent, insertObservation } from "@agency_hub_core/db";
import { ofapiMarketingMetricSchema, ofapiMarketingActionSchema, ofapiMarketingDashboardSchema, ofapiMarketingIntentSchema, ofapiMarketingResourceSchema, type OfapiMarketingAction, type OfapiMarketingResource } from "@agency_hub_core/contracts";
import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from "./errors.ts";
import { OfapiGovernedRequestError } from "./ofapi.ts";
import { assertOfapiConfiguredAccess } from "./ofapi-vendor-usage.ts";
import { asRecord } from "./ofapi-payloads.ts";
import { marketingDestination, marketingTemplateVariables } from "./ofapi-marketing-normalization.ts";

import { OFAPI_MARKETING_RESPONSE_KIND, runOfapiMarketingProjection, rebuildOfapiMarketingProjection, settleOfapiMarketingOutcome, type MarketingResponseSource } from "./projections/ofapi-marketing.ts";

function operation(action: string) { return `ofapi_command_marketing_${action}`; }
function fingerprint(app: AppContext) { return createHash("sha256").update(app.config.ofapiApiKey ?? "").digest("hex"); }
function errorCode(error: unknown) { return error instanceof OfapiGovernedRequestError ? `${error.phase}_${error.reason}` : "provider_or_capture_outcome_unknown"; }

export function ofapiMarketingRequest(command: OfapiMarketingAction, accountId?: string | null) {
  const { action, ...raw } = command;
  const body = { ...raw } as Record<string, unknown>;
  for (const key of ["pageId", "linkId", "pixelId", "postbackId"]) delete body[key];
  switch (action) {
    case "smart_link_create": return { method: "POST", path: "/smart-links", body: { ...body, account_id: accountId } };
    case "smart_link_delete": return { method: "DELETE", path: `/smart-links/${command.linkId}`, body: undefined };
    case "tags_add": case "tags_remove": return { method: action === "tags_add" ? "POST" : "DELETE", path: `/smart-links/${command.linkId}/tags`, body };
    case "pixel_create": return { method: "POST", path: `/smart-links/${command.linkId}/pixels`, body };
    case "pixel_update": case "pixel_disconnect": case "pixel_test": return {
      method: action === "pixel_update" ? "PATCH" : action === "pixel_disconnect" ? "DELETE" : "POST",
      path: `/smart-links/${command.linkId}/pixels/${command.pixelId}${action === "pixel_test" ? "/test-event" : ""}`,
      body: action === "pixel_disconnect" ? undefined : body,
    };
    case "postback_create": return { method: "POST", path: "/smart-link-postbacks", body };
    case "postback_update": case "postback_delete": return { method: action === "postback_update" ? "PATCH" : "DELETE", path: `/smart-link-postbacks/${command.postbackId}`, body: action === "postback_delete" ? undefined : body };
  }
}

async function intentById(app: AppContext, id: string) {
  return (await app.db.execute<{ id: string; action: string; state: string; body_encrypted: string; body_hash: string;
    remote_id: string | null; accounting_state: string; projection_state: string; error_code: string | null; created_at: Date; response_observation_id: string | null; preview: unknown }>(sql`select * from ofapi_marketing_intents where id=${id}`)).rows[0] ?? null;
}
function intentDto(row: NonNullable<Awaited<ReturnType<typeof intentById>>>) {
  return ofapiMarketingIntentSchema.parse({ id: row.id, action: row.action, state: row.state, errorCode: row.error_code,
    remoteId:row.remote_id,accountingState:row.accounting_state,projectionState:row.projection_state,createdAt: new Date(row.created_at).toISOString(), responseObservationId: row.response_observation_id ? Number(row.response_observation_id) : null, preview: row.preview });
}

/** Read consumers use the rebuildable snapshot projection. Configuration-only
 * postback inventory is separately encrypted in its source journal. */
async function readMarketingResources(app: AppContext): Promise<OfapiMarketingResource[]> {
  const snapshots = (await app.db.execute<{ page_id: string; operation: string; pathname: string; observed_at: Date; items: unknown[] }>(sql`
    select page_id,operation,pathname,observed_at,items from ofapi_read_snapshots
    where category in ('smart_links','tracking_links') order by observed_at desc,id desc limit 2000`)).rows;
  const found = new Map<string, OfapiMarketingResource>();
  for (const snapshot of snapshots) for (const item of snapshot.items) {
    const data = asRecord(item); if (!data || !asRecord(data.resource)) continue;
    const parentId = snapshot.operation.endsWith("_pixels") || snapshot.operation.endsWith("_tags") ? snapshot.pathname.split("/")[2] ?? null : null;
    const parsed = ofapiMarketingResourceSchema.safeParse({ ...asRecord(data.resource), pageId: Number(snapshot.page_id), parentId, observedAt: new Date(snapshot.observed_at).toISOString() });
    if (!parsed.success) continue;
    const r = parsed.data; const key = `${r.pageId}:${r.kind}:${r.shared}:${r.parentId}:${r.id}`;
    if (!found.has(key)) found.set(key, r);
  }
  const tagSnapshots = snapshots.filter(s => s.operation.endsWith("_tags"));
  for (const resource of found.values()) {
    const snapshot = tagSnapshots.find(s => Number(s.page_id) === resource.pageId && s.pathname.endsWith(`/${resource.id}/tags`));
    if (snapshot && new Date(snapshot.observed_at).toISOString() >= resource.observedAt) resource.tags = snapshot.items.flatMap(i => typeof asRecord(i)?.tag === "string" ? [String(asRecord(i)!.tag)] : []);
  }
  const tombstones=new Set<string>();
  const configs = (await app.db.execute<{ data: unknown; deleted: boolean }>(sql`select data,deleted from ofapi_marketing_resources order by observed_at desc`)).rows;
  for (const config of configs) {
    const parsed = ofapiMarketingResourceSchema.safeParse(config.data); if (!parsed.success) continue;
    const r = parsed.data; const key = `${r.pageId}:${r.kind}:${r.shared}:${r.parentId}:${r.id}`;
    const existing = found.get(key); if (!existing || existing.observedAt <= r.observedAt) { if (config.deleted) tombstones.add(key); else found.set(key, r); }
  }
  return [...found.entries()].filter(([key])=>!tombstones.has(key)).map(([,resource])=>resource);
}

export async function getOfapiMarketingDashboard(app: AppContext) {
  await runOfapiMarketingProjection(app);
  await app.db.execute(sql`update ofapi_marketing_intents set state='indeterminate',error_code='dispatch_interrupted'
    where state='dispatching' and dispatched_at<now()-interval '2 minutes'`);
  const rows = (await app.db.execute<NonNullable<Awaited<ReturnType<typeof intentById>>>>(sql`select * from ofapi_marketing_intents order by created_at desc limit 50`)).rows;
  const snapshots = (await app.db.execute<{page_id: number; operation: string; pathname: string; query:Record<string,string>; observed_at: Date; coverage: unknown; items: unknown[]}>(sql`select page_id,operation,pathname,query,observed_at,coverage,items from ofapi_read_snapshots where category in ('smart_links','tracking_links') order by observed_at desc,id desc limit 100`)).rows;
  const analytics = snapshots.flatMap(s => {
    const metrics = s.items.flatMap(i => { const p = ofapiMarketingMetricSchema.safeParse(asRecord(i)?.metric); return p.success ? [p.data] : []; });
    return metrics.length ? [{pageId:Number(s.page_id),operation:s.operation,linkId:s.pathname.split("/")[s.pathname.startsWith("/smart-links/") ? 2 : 3] ?? "",observedAt:new Date(s.observed_at).toISOString(),window:{from:s.query.date_start ?? s.query.acquisition_start ?? null,to:s.query.date_end ?? s.query.acquisition_end ?? null},requestedRevenueBasis:s.query.revenue_basis === "gross" ? "gross" : s.operation.endsWith("_cohort_arps") ? "net" : null,coverage:s.coverage,rows:metrics}] : [];
  });
  return ofapiMarketingDashboardSchema.parse({ analytics, resources: await readMarketingResources(app), intents: rows.map(intentDto), attributionWindowHours: 6, revenueIsAdditive: false });
}

async function validateTarget(app: AppContext, command: OfapiMarketingAction) {
  const resources = await readMarketingResources(app);
  let accountId: string | null = null;
  if ("pageId" in command) {
    const page = await findPageById(app.db, command.pageId); accountId = page?.page.ofapiAccountId ?? null;
    if (!accountId) throw new ConflictError("An active OFAPI account binding is required");
    await checkOfapiCurrentBinding(app.db, command.pageId, accountId);
    if ("linkId" in command && !resources.some(r => r.kind === "smart_link" && r.id === command.linkId && r.pageId === command.pageId && r.nativeAccountRef === accountId)) throw new ConflictError("Read this Smart Link inventory for the selected page first");
    if ("pixelId" in command && !resources.some(r => r.kind === "pixel" && r.id === String(command.pixelId) && r.parentId === command.linkId && r.pageId === command.pageId)) throw new ConflictError("Read the connected pixel inventory first");
    if (command.action === "pixel_test" && resources.some(r => r.kind === "pixel" && r.id === String(command.pixelId) && r.platform === "creatortraffic")) throw new BadRequestError("CreatorTraffic does not support test events");
  }
  if ("postbackId" in command && !resources.some(r => r.kind === "postback" && r.id === String(command.postbackId))) throw new ConflictError("Refresh postback configuration before changing it");
  if ("smart_link_ids" in command) for (const id of command.smart_link_ids ?? []) {
    if (!resources.some(r => r.kind === "smart_link" && r.id === id)) throw new ConflictError("Read every selected Smart Link before applying a postback");
  }
  const declaration = await getOfapiKeyDeclaration(app.db, fingerprint(app));
  if (declaration?.account_ids && (command.action === "pixel_update" || (command.action.startsWith("postback_") && (!("smart_link_scope" in command) || command.smart_link_scope === "global")))) throw new ConflictError("An account-restricted credential cannot change configuration with unknown team scope");
  if ("smart_link_ids" in command) for (const id of command.smart_link_ids ?? []) {
    const resource = resources.find(r => r.kind === "smart_link" && r.id === id)!;
    const page = resource.pageId ? await findPageById(app.db, resource.pageId) : null;
    if (!page?.page.ofapiAccountId || resource.nativeAccountRef !== page.page.ofapiAccountId) throw new ConflictError("Selected postback link no longer has a current account binding");
    await checkOfapiCurrentBinding(app.db, resource.pageId, page.page.ofapiAccountId);
    await assertOfapiConfiguredAccess(app.db, fingerprint(app), { operation: operation(command.action), method: "POST", accountId: page.page.ofapiAccountId });
  }
  const request = ofapiMarketingRequest(command, accountId);
  await assertOfapiConfiguredAccess(app.db, fingerprint(app), { operation: operation(command.action), method: request.method, accountId });
  return { resources, accountId, request };
}

export async function prepareOfapiMarketingCommand(app: AppContext, input: { id: string; command: OfapiMarketingAction }, actorUserId: number) {
  const command = ofapiMarketingActionSchema.parse(input.command);
  const { resources, accountId } = await validateTarget(app, command);
  if ("url" in command) {
    const destination = marketingDestination(command.url);
    if (!destination || new URL(command.url).username || new URL(command.url).password) throw new BadRequestError("Postback destination requires an HTTP(S) URL without embedded credentials");
    if (command.body && (command.http_method ?? (command.action === "postback_update" ? resources.find(r => r.kind === "postback" && r.id === String(command.postbackId))?.httpMethod : "GET")) !== "POST") throw new BadRequestError("A body template requires POST");
  }
  const encoded = JSON.stringify(command); const hash = createHash("sha256").update(encoded).digest("hex");
  const previous = await intentById(app, input.id);
  if (previous) { if (previous.body_hash !== hash) throw new ConflictError("Command identity belongs to another payload"); return intentDto(previous); }
  const affectedLinkIds = "pixelId" in command ? [...new Set(resources.filter(r => r.kind === "pixel" && r.id === String(command.pixelId)).flatMap(r => r.parentId ? [r.parentId] : []))]
    : "linkId" in command ? [command.linkId] : "smart_link_ids" in command ? command.smart_link_ids ?? [] : "postbackId" in command ? resources.find(r => r.kind === "postback" && r.id === String(command.postbackId))?.linkIds ?? [] : [];
  const headers = "headers" in command ? command.headers ?? [] : [];
  const preview = { destination: "url" in command ? marketingDestination(command.url) : "event_source_url" in command ? marketingDestination(command.event_source_url) : null,
    templateVariables: "url" in command ? marketingTemplateVariables(command.url, command.body, ...headers.map(h => h.value)) : [],
    targetId: "pixelId" in command ? String(command.pixelId) : "postbackId" in command ? String(command.postbackId) : "linkId" in command ? command.linkId : null,
    changedFields:Object.keys(command).filter(k => !["action","pageId","linkId","pixelId","postbackId"].includes(k)),
    conversionTypes:"conversion_types" in command ? command.conversion_types : [],scope:"smart_link_scope" in command ? command.smart_link_scope : null,
    headerNames: headers.map(h => h.name), affectedLinkIds: affectedLinkIds.sort(), affectedLinksComplete: !["pixel_update", "postback_create", "postback_update", "postback_delete"].includes(command.action),
    effect: command.action === "pixel_update" ? "Changes the shared team pixel on every connected link, including links outside known inventory"
      : command.action === "pixel_disconnect" ? "Disconnects this link; the shared team pixel remains"
        : command.action === "pixel_test" ? "Sends one labeled test event to the external ad platform"
          : command.action.startsWith("postback_") ? "Changes external event forwarding; destination and variable names are shown, secret values are withheld" : command.action,
    externalTest: command.action === "pixel_test", estimatedCredits: 0 };
  const baselineResource=resources.find(r=>"pixelId" in command ? r.kind==="pixel" && r.pageId===command.pageId && r.parentId===command.linkId && r.id===String(command.pixelId) : "postbackId" in command ? r.kind==="postback" && r.id===String(command.postbackId) : "linkId" in command ? r.kind==="smart_link" && r.pageId===command.pageId && r.id===command.linkId : false) ?? null;
  const frozen = { command, accountId, baselineResource, credentialFingerprint: fingerprint(app), bindingGeneration: accountId && "pageId" in command ? await checkOfapiCurrentBinding(app.db, command.pageId, accountId) : null };
  await app.db.transaction(async tx => {
    await tx.execute(sql`insert into ofapi_marketing_intents(id,page_id,actor_user_id,action,body_encrypted,body_hash,preview,state)
      values(${input.id},${"pageId" in command ? command.pageId : null},${actorUserId},${command.action},${JSON.stringify(encryptJson(frozen, app.config.encryptionKey, app.config.encryptionKeyVersion))},${hash},${JSON.stringify(preview)}::jsonb,'prepared')`);
    await insertAuditEvent(tx, { actorUserId, source: "api", eventType: "admin.ofapi_marketing_prepared", metadata: { id: input.id, action: command.action, ...preview } });
  });
  return intentDto((await intentById(app, input.id))!);
}

async function captureSensitiveResponse(app: AppContext, input: { operation: string; bodyBytes: Buffer; headers: Record<string,string>; status: number; receivedAt: Date; pageId?: number | null; accountId?: string | null; intentId?: string; source: Omit<MarketingResponseSource,"bodyBase64"|"headers"> }) {
  return insertObservation(app.db, { source: "operator", producer: "ofapi:marketing", platform: "onlyfans", kind: OFAPI_MARKETING_RESPONSE_KIND,
    accountId: input.pageId ?? null, nativeAccountRef: input.accountId ?? null, receivedAt: input.receivedAt,
    payload: { status: input.status, operation:input.operation, intentId:input.intentId ?? null,
      encryptedBody: encryptJson({ ...input.source, headers:input.headers, bodyBase64: input.bodyBytes.toString("base64") }, app.config.encryptionKey, app.config.encryptionKeyVersion), bodyEncoding: "encrypted_base64" },
    payloadHash: createHash("sha256").update(input.bodyBytes).digest(), idempotencyKey: randomUUID() });
}
export async function dispatchOfapiMarketingCommand(app: AppContext, input: { id: string; acknowledgeSharedImpact: boolean; acknowledgeExternalTest: boolean }, actorUserId: number) {
  const intent = await intentById(app, input.id); if (!intent) throw new NotFoundError("Marketing command was not found");
  if (intent.state !== "prepared") return intentDto(intent);
  const preview = ofapiMarketingIntentSchema.parse(intentDto(intent)).preview;
  if (!preview.affectedLinksComplete && !input.acknowledgeSharedImpact) throw new BadRequestError("Acknowledge the shared configuration impact");
  if (preview.externalTest && !input.acknowledgeExternalTest) throw new BadRequestError("Acknowledge the external test event");
  const frozen = decryptJsonWithKeyVersion<{command: unknown; accountId: string|null; bindingGeneration: number|null; credentialFingerprint: string; baselineResource?:unknown}>(JSON.parse(intent.body_encrypted), app.config.encryptionKeysByVersion);
  const command = ofapiMarketingActionSchema.parse(frozen.command);
  if (frozen.credentialFingerprint !== fingerprint(app)) throw new ConflictError("Credential changed since command preparation");
  if ("pageId" in command && frozen.accountId) await checkOfapiCurrentBinding(app.db, command.pageId, frozen.accountId, frozen.bindingGeneration ?? undefined);
  const { request, accountId } = await validateTarget(app, command);
  const client = app.ofapi; if (!client?.dispatchGovernedRaw || (await client.getCredentialPreflight?.())?.status !== "verified") throw new ServiceUnavailableError("Verified OFAPI command transport unavailable");
  let claimedByThisCall = false;
  try {
    const result = await client.dispatchGovernedRaw({ pageId: "pageId" in command ? command.pageId : null, actorUserId }, {
      attemptId: input.id, operation: operation(command.action), method: request.method as "POST" | "PATCH" | "DELETE", pathname: request.path,
      ...(request.body ? { bodyBytes: Buffer.from(JSON.stringify(request.body)), contentType: "application/json" } : {}),
      priorityClass: "interactive", deadlineAt: new Date(Date.now() + 65_000), maxResponseBytes: 2 * 1024 * 1024,
      beforeDispatch: async () => {
        await validateTarget(app, command);
        if ("pageId" in command && accountId) await checkOfapiCurrentBinding(app.db, command.pageId, accountId, frozen.bindingGeneration ?? undefined);
        const claimed = await app.db.execute(sql`update ofapi_marketing_intents set state='dispatching',dispatched_at=now() where id=${input.id} and state='prepared' returning id`);
        claimedByThisCall = claimed.rows.length > 0;
        return claimedByThisCall;
      },
    });
    const observation = await captureSensitiveResponse(app, { ...result, operation: operation(command.action), pageId: "pageId" in command ? command.pageId : null, accountId,
      intentId:input.id,source:{requestId:input.id,actorUserId,credentialFingerprint:fingerprint(app),frozen} });
    await app.db.execute(sql`update ofapi_marketing_intents set response_observation_id=${observation.observationId} where id=${input.id} and state='dispatching'`);
    let body:unknown=null;
    try { body=result.bodyBytes.length ? JSON.parse(result.bodyBytes.toString("utf8")) : null; } catch { /* Exact malformed bytes are already captured. */ }
    const outcome=await settleOfapiMarketingOutcome(app,input.id,observation.observationId,command,result.status,body,frozen.accountId);
    await runOfapiMarketingProjection(app,{observationId:observation.observationId});
    await insertAuditEvent(app.db, { actorUserId, source: "api", eventType: "admin.ofapi_marketing_dispatched", metadata: { id: input.id, action: command.action, state:outcome.state, remoteId:outcome.remoteId, externalTest: preview.externalTest, observationId: observation.observationId } });
  } catch (error) {
    if (claimedByThisCall) await app.db.execute(sql`update ofapi_marketing_intents set state='indeterminate',error_code=${errorCode(error)},settled_at=now() where id=${input.id} and state='dispatching'`);
    // A definite refusal before dispatch leaves the prepared command reusable.
    if ((await intentById(app, input.id))?.state === "prepared") throw new ServiceUnavailableError("The provider request was not dispatched; the prepared command is retained");
  }
  return intentDto((await intentById(app, input.id))!);
}

export async function refreshOfapiMarketingPostbacks(app: AppContext, actorUserId: number, postbackId?: number) {
  if (!app.ofapi?.dispatchGovernedRaw || (await app.ofapi.getCredentialPreflight?.())?.status !== "verified") throw new ServiceUnavailableError("Verified OFAPI configuration transport unavailable");
  const declaration = await getOfapiKeyDeclaration(app.db, fingerprint(app));
  if (declaration?.account_ids) throw new ConflictError("Postback inventory has team scope and cannot use an explicitly account-restricted credential");
  await assertOfapiConfiguredAccess(app.db, fingerprint(app), { operation: operation("postbacks_read"), method: "GET" });
  const requestId = randomUUID();
  const result = await app.ofapi.dispatchGovernedRaw({ actorUserId }, { attemptId: requestId, operation: operation("postbacks_read"), method: "GET",
    pathname: `/smart-link-postbacks${postbackId ? `/${postbackId}` : ""}`, priorityClass: "interactive", deadlineAt: new Date(Date.now() + 65_000),
    maxResponseBytes: 2 * 1024 * 1024, beforeDispatch: async () => true });
  const observation = await captureSensitiveResponse(app, { ...result, operation: operation("postbacks_read"),source:{requestId,actorUserId,credentialFingerprint:fingerprint(app),...(postbackId ? {postbackId} : {})} });
  if (result.status < 200 || result.status >= 300) throw new ServiceUnavailableError(`Provider configuration read failed (${result.status}); encrypted evidence retained`);
  await runOfapiMarketingProjection(app,{observationId:observation.observationId});
  await insertAuditEvent(app.db, { actorUserId, source: "api", eventType: "admin.ofapi_marketing_postbacks_read", metadata: { postbackId: postbackId ?? null, observationId: observation.observationId } });
  return getOfapiMarketingDashboard(app);
}

export async function rebuildOfapiMarketingState(app:AppContext,actorUserId:number) {
  const result=await rebuildOfapiMarketingProjection(app);
  await insertAuditEvent(app.db,{actorUserId,source:"api",eventType:"admin.ofapi_marketing_rebuilt",metadata:result});
  return getOfapiMarketingDashboard(app);
}
