import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, createModel, createOnlyFansPage, createPool, createUser, setPageOfapiAccountId, createOfapiCollectionJob, getEffectiveOfapiCollectionPolicy } from "@agency_hub_core/db";
import { decryptJsonWithKeyVersion } from "@agency_hub_core/shared";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { OFAPI_COLLECTION_SWEEP_QUEUE, runOfapiCollectionJob, startOfapiCollectionWorker } from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import { rebuildOfapiReadSnapshotProjection } from "../apps/runtime/src/services/projections/ofapi-read-snapshots.ts";
import { getOfapiMarketingDashboard, prepareOfapiMarketingCommand, dispatchOfapiMarketingCommand, refreshOfapiMarketingPostbacks, sweepOfapiMarketingIntents } from "../apps/runtime/src/services/ofapi-smart-links.ts";
import { rebuildOfapiMarketingProjection, runOfapiMarketingProjection } from "../apps/runtime/src/services/projections/ofapi-marketing.ts";
import * as creditService from "../apps/runtime/src/services/ofapi-credits.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
const LINK="01JQZ9MY9QZHBBEMYW0AN9N8EQ", OTHER="01JQZ9MY9QZHBBEMYW0AN9N8ER";
let db:StartedTestDatabase,app:AppContext,actor:number,pageId:number;
let fetchMock:ReturnType<typeof vi.fn>;
const response=(data:unknown, credits=0)=>new Response(JSON.stringify({data,_meta:{_credits:{used:credits,balance:0}}}));
beforeAll(async()=>{const value=await startIntegrationTestDatabase();if(!value)throw new Error("Marketing tests require PostgreSQL");db=value;},120000);
afterAll(async()=>{await db?.stop();});afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
beforeEach(async()=>{
 await resetIntegrationDatabase(db.pool);app=createTestAppContext(db);app.config.ofapiApiKey="synthetic-marketing";
 actor=(await createUser(app.db,{username:"marketing-owner",passwordHash:"synthetic",role:"owner"}))!.id;
 const model=(await createModel(app.db,{slug:"marketing",name:"Marketing"}))!;
 pageId=(await createOnlyFansPage(app.db,{modelId:model.id,label:"marketing"}))!.id;
 await setPageOfapiAccountId(app.db,{pageId,ofapiAccountId:"acct_marketing"});
 await db.pool.query("insert into ofapi_credit_state(id,last_balance,last_balance_at) values(1,10000,now()) on conflict(id) do update set last_balance=10000,last_balance_at=now()");
 app.ofapi=createOfapiClient({apiKey:"synthetic-marketing",restDelayMs:0,...ofapiCollectionPolicyHooks(app.db)});
 vi.spyOn(app.ofapi,"getCredentialPreflight").mockResolvedValue({status:"verified",expectedTeam:"test",observedTeam:"test",credentialFingerprint:"test",checkedAt:new Date().toISOString(),reason:null,rosterScope:"unknown"});
 fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
});
async function collect(selection:string[], category:"smart_links"|"tracking_links"="smart_links", maxCalls=10){
 const job=await createOfapiCollectionJob(app.db,{pageId,category,expectedRevision:0,maxCalls,maxCredits:100,maxBytes:1000000,from:null,to:null,selection},actor);
 return runOfapiCollectionJob(app,job.id);
}
async function inventory(){fetchMock.mockResolvedValueOnce(response([{id:LINK,name:"Link A",account:{id:"acct_marketing"}},{id:OTHER,name:"Link B",account:{id:"acct_marketing"}}]));expect(await collect(["smart_links"])).toEqual({state:"completed"});}
async function pixels(){await inventory();fetchMock.mockResolvedValueOnce(response([{id:9,platform:"meta",pixel_id:"external-pixel",label:"Shared"}])).mockResolvedValueOnce(response([{id:9,platform:"meta",pixel_id:"external-pixel",label:"Shared"}]));expect(await collect([`smart_link_pixels:${LINK}`,`smart_link_pixels:${OTHER}`])).toEqual({state:"completed"});}
const apply=(id:string,ackShared=true,ackTest=false)=>dispatchOfapiMarketingCommand(app,{id,acknowledgeSharedImpact:ackShared,acknowledgeExternalTest:ackTest},actor);
describe("Smart Links end-to-end capture and owner controls",()=>{
 it("ships off, admits documented free reads with stale zero balance, records actual charges and rebuilds attribution",async()=>{
  expect(await getEffectiveOfapiCollectionPolicy(app.db,"smart_links",pageId)).toMatchObject({mode:"off"});
  await db.pool.query("update ofapi_credit_state set last_balance=0,last_balance_at=now()-interval '2 days'");
  await inventory();fetchMock.mockResolvedValueOnce(response({summary:{clicks_total:10,subs_total:2,revenue_total:"5.005"},daily_metrics:[{timestamp:"2026-09-01",revenue:"5.005",clicks:10,subs:2}],monthly_metrics:[]}));
  expect(await collect([`smart_link_stats:${LINK}`])).toEqual({state:"completed"});
  const before=await getOfapiMarketingDashboard(app);expect(before.resources).toHaveLength(2);expect(before.analytics[0]?.rows[0]).toMatchObject({period:"summary",revenueMills:"5005",attributionOnly:true});expect(before.revenueIsAdditive).toBe(false);
  expect(String(fetchMock.mock.calls[0]![0])).toContain("account_ids=acct_marketing");
  const attempts=(await db.pool.query("select reserved_credits,settled_credits from ofapi_request_attempts")).rows;
  expect(attempts).toHaveLength(2);expect(attempts.every(r=>Number(r.reserved_credits)===0 && Number(r.settled_credits)===0)).toBe(true);
  expect((await db.pool.query("select parse_version from observations where kind='ofapi.collection_read_response.v1'")).rows.every(r=>r.parse_version===1)).toBe(true);
  await rebuildOfapiReadSnapshotProjection(app,{accountId:pageId});
  expect(await getOfapiMarketingDashboard(app)).toEqual(before);expect(fetchMock).toHaveBeenCalledTimes(2);
 });
 it("keeps foreign-account responses replayable and refuses unknown link detail before dispatch",async()=>{
  expect(await collect([`smart_link_pixels:${LINK}`])).toMatchObject({state:"paused"});expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValueOnce(response([{id:LINK,account:{id:"acct_foreign"}}]));
  expect(await collect(["smart_links"])).toMatchObject({state:"paused"});
  expect((await db.pool.query("select parse_version from observations where kind='ofapi.collection_read_response.v1'")).rows).toEqual([{parse_version:0}]);
  expect((await getOfapiMarketingDashboard(app)).resources).toEqual([]);
 });
 it("requires explicit shared-pixel acknowledgement and preserves one physical attempt with encrypted token custody",async()=>{
  await pixels(); const id=randomUUID();
  const prepared=await prepareOfapiMarketingCommand(app,{id,command:{action:"pixel_update",pageId,linkId:LINK,pixelId:9,pixel_access_token:"PRIVATE-AD-TOKEN"}},actor);
  expect(prepared.preview).toMatchObject({affectedLinkIds:[LINK,OTHER],affectedLinksComplete:false});
  const disconnect=await prepareOfapiMarketingCommand(app,{id:randomUUID(),command:{action:"pixel_disconnect",pageId,linkId:LINK,pixelId:9}},actor);
  expect(disconnect.preview.affectedLinkIds).toEqual([LINK]);expect(JSON.stringify(prepared)).not.toContain("PRIVATE-AD-TOKEN");
  await expect(apply(id,false)).rejects.toThrow("shared");
  fetchMock.mockResolvedValueOnce(response({id:9,pixel_access_token:"PRIVATE-AD-TOKEN"}));
  expect(await apply(id)).toMatchObject({state:"succeeded"});expect(await apply(id)).toMatchObject({state:"succeeded"});expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(String(fetchMock.mock.calls[3]![0])).toContain(`/smart-links/${LINK}/pixels/9`);
  const intent=(await db.pool.query("select body_encrypted from ofapi_marketing_intents where id=$1",[id])).rows[0];expect(intent.body_encrypted).not.toContain("PRIVATE-AD-TOKEN");
  const clear=decryptJsonWithKeyVersion<{command:unknown}>(JSON.parse(intent.body_encrypted),app.config.encryptionKeysByVersion);expect(clear.command).toMatchObject({pixel_access_token:"PRIVATE-AD-TOKEN"});
  const captures=(await db.pool.query("select payload from observations where producer='ofapi:marketing'")).rows;expect(captures).toHaveLength(1);expect(JSON.stringify(captures)).not.toContain("PRIVATE-AD-TOKEN");
  expect(JSON.stringify((await db.pool.query("select metadata from audit_events where event_type like 'admin.ofapi_marketing_%'")).rows)).not.toContain("PRIVATE-AD-TOKEN");
 });
 it("external test is an explicit action with immutable provenance; timeout never retries",async()=>{
  await pixels();const id=randomUUID();await prepareOfapiMarketingCommand(app,{id,command:{action:"pixel_test",pageId,linkId:LINK,pixelId:9,event_type:"event_click",test_event_code:"OWNER-TEST"}},actor);
  await expect(apply(id,true,false)).rejects.toThrow("external test");
  fetchMock.mockRejectedValueOnce(new Error("transport lost"));expect(await apply(id,true,true)).toMatchObject({state:"indeterminate"});expect(await apply(id,true,true)).toMatchObject({state:"indeterminate"});expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(String(fetchMock.mock.calls[3]![0])).toContain("/test-event");expect((await getOfapiMarketingDashboard(app)).intents[0]?.preview.externalTest).toBe(true);
 });
 it("serializes competing dispatches and refuses a prepared command after binding rotation",async()=>{
  await inventory();const id=randomUUID();await prepareOfapiMarketingCommand(app,{id,command:{action:"tags_add",pageId,linkId:LINK,tags:["IG"]}},actor);
  fetchMock.mockImplementationOnce(async()=>{await new Promise(resolve=>setTimeout(resolve,30));return response({tags:["IG"]});});
  await Promise.all([apply(id),apply(id)]);expect(fetchMock).toHaveBeenCalledTimes(2);expect(await apply(id)).toMatchObject({state:"succeeded"});
  const blocked=randomUUID();await prepareOfapiMarketingCommand(app,{id:blocked,command:{action:"smart_link_delete",pageId,linkId:LINK}},actor);
  await db.pool.query("update pages set ofapi_account_id='acct_rotated',ofapi_binding_generation=ofapi_binding_generation+1 where id=$1",[pageId]);await expect(apply(blocked)).rejects.toThrow("binding");
  await expect(prepareOfapiMarketingCommand(app,{id:randomUUID(),command:{action:"smart_link_delete",pageId,linkId:LINK}},actor)).rejects.toThrow("inventory");expect(fetchMock).toHaveBeenCalledTimes(2);
 });
 it("captures postback secrets before parsing; safe inventory and omitted PATCH secrets remain separate",async()=>{
  fetchMock.mockResolvedValueOnce(response([{id:8,url:"https://events.test/secret-path?token=PRIVATE&fan={fan_id}",http_method:"POST",body:"secret=PRIVATE&amount={amount_net}",headers:[{name:"Authorization",value:"PRIVATE"}],smart_link_scope:"global",conversion_types:["new_transaction"],smart_link_ids:[]}])) ;
  const dashboard=await refreshOfapiMarketingPostbacks(app,actor);expect(dashboard.resources[0]).toMatchObject({pageId:null,kind:"postback",destination:"https://events.test",templateVariables:["amount_net","fan_id"],headerNames:["Authorization"]});expect(JSON.stringify(dashboard)).not.toContain("PRIVATE");
  const id=randomUUID();await prepareOfapiMarketingCommand(app,{id,command:{action:"postback_update",postbackId:8,url:"https://events.test/{fan_id}",smart_link_scope:"global",conversion_types:["new_transaction"]}},actor);
  fetchMock.mockResolvedValueOnce(response({id:8}));expect(await apply(id)).toMatchObject({state:"succeeded"});
  const requestBody=Buffer.from((fetchMock.mock.calls[1]![1] as RequestInit).body as Uint8Array).toString();expect(requestBody).not.toContain("headers");expect(requestBody).not.toContain('"body"');
  expect(JSON.stringify((await db.pool.query("select payload from observations where producer='ofapi:marketing'")).rows)).not.toContain("PRIVATE");
 });
 it("records contradictory actual credits from a documented free stored inventory",async()=>{
  await db.pool.query("update ofapi_credit_state set last_balance=0,last_balance_at=now()-interval '2 days'");
  fetchMock.mockResolvedValueOnce(response({list:[{id:1,owner:{id:99},tags:["shared"]}],hasMore:false},1));
  expect(await collect(["stored_shared_tracking_links"],"tracking_links")).toEqual({state:"completed"});
  expect((await db.pool.query("select reserved_credits,settled_credits from ofapi_request_attempts")).rows).toMatchObject([{reserved_credits:0,settled_credits:1}]);
 });
 it("projects confirmed create IDs and exact DELETE 204 tombstones; local rebuild reproduces state",async()=>{
  const id=randomUUID();await prepareOfapiMarketingCommand(app,{id,command:{action:"smart_link_create",pageId,name:"Launch",link_type:"tracking_link"}},actor);
  fetchMock.mockResolvedValueOnce(response({id:LINK,name:"Launch",traffic_redirect_url:"https://ofapi.link/launch",account:{id:"acct_marketing"}}));
  expect(await apply(id)).toMatchObject({state:"succeeded",remoteId:LINK,projectionState:"complete",accountingState:"complete"});
  expect((await getOfapiMarketingDashboard(app)).resources).toMatchObject([{id:LINK,name:"Launch",publicUrl:"https://ofapi.link/launch",nativeAccountRef:"acct_marketing"}]);
  const remove=randomUUID();await prepareOfapiMarketingCommand(app,{id:remove,command:{action:"smart_link_delete",pageId,linkId:LINK}},actor);
  fetchMock.mockResolvedValueOnce(new Response(null,{status:204}));expect(await apply(remove)).toMatchObject({state:"succeeded",remoteId:LINK});
  const before=await getOfapiMarketingDashboard(app);expect(before.resources).toEqual([]);
  expect((await db.pool.query("select deleted from ofapi_marketing_resources")).rows).toEqual([{deleted:true}]);
  await rebuildOfapiMarketingProjection(app);expect(await getOfapiMarketingDashboard(app)).toEqual(before);expect(fetchMock).toHaveBeenCalledTimes(2);
 });
 it("does not call a malformed 2xx creation confirmed or resend its retained intent",async()=>{
  const id=randomUUID();await prepareOfapiMarketingCommand(app,{id,command:{action:"smart_link_create",pageId,name:"Unknown",link_type:"tracking_link"}},actor);
  fetchMock.mockResolvedValueOnce(response({name:"missing remote identity"}));
  expect(await apply(id)).toMatchObject({state:"indeterminate",remoteId:null,errorCode:"vendor_resource_identity_unconfirmed"});
  expect((await getOfapiMarketingDashboard(app)).resources).toEqual([]);await apply(id);await rebuildOfapiMarketingProjection(app);expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it("keeps confirmed writes succeeded through projection and credit failures; repairs locally",async()=>{
  const id=randomUUID();await prepareOfapiMarketingCommand(app,{id,command:{action:"smart_link_create",pageId,name:"Recoverable",link_type:"tracking_link"}},actor);
  await db.pool.query("create function marketing_projection_fault() returns trigger language plpgsql as $$ begin raise exception 'synthetic projection outage'; end $$");
  await db.pool.query("create trigger marketing_projection_fault before insert on ofapi_marketing_resources for each row execute function marketing_projection_fault()");
  fetchMock.mockResolvedValueOnce(response({id:LINK}));
  expect(await apply(id)).toMatchObject({state:"succeeded",remoteId:LINK,projectionState:"pending"});
  await db.pool.query("drop trigger marketing_projection_fault on ofapi_marketing_resources");await db.pool.query("drop function marketing_projection_fault()");
  vi.spyOn(creditService,"createOfapiCreditSpendSink").mockReturnValueOnce(async()=>false);
  await runOfapiMarketingProjection(app);
  expect((await db.pool.query("select state,projection_state,accounting_state from ofapi_marketing_intents where id=$1",[id])).rows[0]).toEqual({state:"succeeded",projection_state:"complete",accounting_state:"pending"});
  // The dashboard read repairs nothing; the worker's minute pass does.
  expect((await getOfapiMarketingDashboard(app)).intents[0]).toMatchObject({state:"succeeded",projectionState:"complete",accountingState:"pending"});
  await sweepOfapiMarketingIntents(app);
  expect((await getOfapiMarketingDashboard(app)).intents[0]).toMatchObject({state:"succeeded",projectionState:"complete",accountingState:"complete"});expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it("the dashboard read writes nothing; the minute pass marks a stranded dispatch indeterminate and never sends it",async()=>{
  const stranded=randomUUID(),fresh=randomUUID(),settled=randomUUID();
  for(const id of [stranded,fresh,settled]) await prepareOfapiMarketingCommand(app,{id,command:{action:"smart_link_create",pageId,name:`Lost ${id}`,link_type:"tracking_link"}},actor);
  // A process lost after the claim: the row says dispatching and nothing was captured.
  await db.pool.query("update ofapi_marketing_intents set state='dispatching',dispatched_at=now()-interval '3 minutes' where id=$1",[stranded]);
  await db.pool.query("update ofapi_marketing_intents set state='dispatching',dispatched_at=now() where id=$1",[fresh]);
  await db.pool.query("update ofapi_marketing_intents set state='succeeded',dispatched_at=now()-interval '3 minutes',settled_at=now() where id=$1",[settled]);
  // Every statement of the read runs on a session that refuses writes.
  const url=new URL(db.connectionString);url.searchParams.set("options","-c default_transaction_read_only=on");
  const readOnlyPool=createPool(url.toString());
  try {
   await expect(readOnlyPool.query("update ofapi_marketing_intents set error_code='x'")).rejects.toThrow("read-only");
   const read=await getOfapiMarketingDashboard({...app,db:createDb(readOnlyPool)});
   expect(Object.fromEntries(read.intents.map(i=>[i.id,i.state]))).toEqual({[stranded]:"dispatching",[fresh]:"dispatching",[settled]:"succeeded"});
  } finally { await readOnlyPool.end(); }
  // The worker's minute pass: the collection sweep queue's handler.
  const handlers=new Map<string,()=>Promise<void>>();
  const boss={work:vi.fn(async(queue:string,_options:unknown,handler:()=>Promise<void>)=>{handlers.set(queue,handler);}),send:vi.fn(async()=>null)};
  await startOfapiCollectionWorker(app,boss as unknown as Parameters<typeof startOfapiCollectionWorker>[1]);
  await handlers.get(OFAPI_COLLECTION_SWEEP_QUEUE)!();
  const states=Object.fromEntries((await db.pool.query("select id,state,error_code from ofapi_marketing_intents")).rows.map(r=>[r.id,[r.state,r.error_code]]));
  expect(states).toEqual({[stranded]:["indeterminate","dispatch_interrupted"],[fresh]:["dispatching",null],[settled]:["succeeded",null]});
  // An indeterminate command is evidence, never a fresh send.
  expect(await apply(stranded)).toMatchObject({state:"indeterminate",errorCode:"dispatch_interrupted"});
  await handlers.get(OFAPI_COLLECTION_SWEEP_QUEUE)!();
  expect(fetchMock).not.toHaveBeenCalled();
 });
 it("rebuilds secret-safe postbacks and only infers absence from explicit complete inventory",async()=>{
  fetchMock.mockResolvedValueOnce(response([{id:8,url:"https://events.test/PRIVATE?fan={fan_id}",body:"PRIVATE {amount_net}",http_method:"POST",headers:[{name:"Authorization",value:"PRIVATE"}],smart_link_scope:"global",conversion_types:["new_transaction"]}]));
  await refreshOfapiMarketingPostbacks(app,actor);
  fetchMock.mockResolvedValueOnce(response([]));expect((await refreshOfapiMarketingPostbacks(app,actor)).resources).toHaveLength(1);
  const before=await getOfapiMarketingDashboard(app);await rebuildOfapiMarketingProjection(app);expect(await getOfapiMarketingDashboard(app)).toEqual(before);expect(JSON.stringify(before)).not.toContain("PRIVATE");
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({data:[],_pagination:{next_page:null}})));
  expect((await refreshOfapiMarketingPostbacks(app,actor)).resources).toEqual([]);await rebuildOfapiMarketingProjection(app);expect((await getOfapiMarketingDashboard(app)).resources).toEqual([]);expect(fetchMock).toHaveBeenCalledTimes(3);
 });
 it("retains the exact page/account and safe values when a prepared action is reviewed later",async()=>{
  const id=randomUUID();const prepared=await prepareOfapiMarketingCommand(app,{id,command:{action:"smart_link_create",pageId,name:"Thirty day campaign",link_type:"free_trial",free_trial_days:30}},actor);
  expect(prepared.preview).toMatchObject({pageId,pageLabel:"marketing",accountId:"acct_marketing",values:[{field:"name",value:"Thirty day campaign"},{field:"link_type",value:"free_trial"},{field:"free_trial_days",value:30}]});
  await db.pool.query("update pages set label='renamed-after-preparation' where id=$1",[pageId]);
  expect((await getOfapiMarketingDashboard(app)).intents[0]?.preview).toEqual(prepared.preview);expect(fetchMock).not.toHaveBeenCalled();
 });
 it("clears postback templates explicitly and rebuilds accurate remaining variable names",async()=>{
  fetchMock.mockResolvedValueOnce(response([{id:8,url:"https://events.test/{fan_id}",body:"private {amount_net}",http_method:"POST",headers:[{name:"Authorization",value:"private {username}"}],smart_link_scope:"global",conversion_types:["new_transaction"]}]));
  await refreshOfapiMarketingPostbacks(app,actor);
  const id=randomUUID();const prepared=await prepareOfapiMarketingCommand(app,{id,command:{action:"postback_update",postbackId:8,url:"https://events.test/{fan_id}",http_method:"POST",body:"",smart_link_scope:"global",conversion_types:["new_transaction"]}},actor);
  expect(prepared.preview.values).toContainEqual({field:"body_change",value:"clear"});expect(prepared.preview.values).toContainEqual({field:"headers_change",value:"preserve"});
  fetchMock.mockResolvedValueOnce(response({id:8}));await apply(id);
  expect((await getOfapiMarketingDashboard(app)).resources[0]).toMatchObject({hasBodyTemplate:false,headerNames:["Authorization"],templateVariables:["fan_id","username"]});
  const clearHeaders=randomUUID();await prepareOfapiMarketingCommand(app,{id:clearHeaders,command:{action:"postback_update",postbackId:8,url:"https://events.test/{fan_id}",http_method:"GET",headers:[],smart_link_scope:"global",conversion_types:["new_transaction"]}},actor);
  fetchMock.mockResolvedValueOnce(response({id:8}));await apply(clearHeaders);
  const before=await getOfapiMarketingDashboard(app);expect(before.resources[0]).toMatchObject({hasBodyTemplate:false,headerNames:[],templateVariables:["fan_id"]});
  await rebuildOfapiMarketingProjection(app);expect(await getOfapiMarketingDashboard(app)).toEqual(before);expect(fetchMock).toHaveBeenCalledTimes(3);
 });
 it("page erasure removes populated intents, captures and marketing projections before replay",async()=>{
  await inventory();const id=randomUUID();await prepareOfapiMarketingCommand(app,{id,command:{action:"smart_link_create",pageId,name:"new",link_type:"tracking_link"}},actor);
  fetchMock.mockResolvedValueOnce(response({id:OTHER}));await apply(id);
  await db.pool.query("insert into ofapi_marketing_resources(page_id,kind,upstream_id,data,observation_id,observed_at) values($1,'pixel','999','{}',1,now())",[pageId]);
  const scope={scopeType:"page" as const,pageLabel:"marketing"};const plan=await planErasure(app,scope);
  expect(plan.targets.find(t=>t.target==="ofapi_marketing_intents")?.rows).toBe(1);expect(plan.targets.find(t=>t.target==="ofapi_marketing_resources")?.rows).toBe(2);expect(plan.targets.find(t=>t.target==="ofapi_marketing_projection_receipts")?.rows).toBe(1);
  await executeErasure(app,scope,{initiatedBy:actor});await rebuildOfapiReadSnapshotProjection(app,{accountId:pageId});await rebuildOfapiMarketingProjection(app);
  expect((await getOfapiMarketingDashboard(app))).toMatchObject({resources:[],analytics:[],intents:[]});
  expect((await db.pool.query("select count(*)::int n from observations where account_id=$1",[pageId])).rows[0].n).toBe(0);
 });
});
