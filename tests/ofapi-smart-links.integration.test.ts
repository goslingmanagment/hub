import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createModel, createOnlyFansPage, createUser, setPageOfapiAccountId, createOfapiCollectionJob, getEffectiveOfapiCollectionPolicy } from "@agency_hub_core/db";
import { decryptJsonWithKeyVersion } from "@agency_hub_core/shared";
import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createOfapiClient } from "../apps/runtime/src/services/ofapi.ts";
import { ofapiCollectionPolicyHooks } from "../apps/runtime/src/services/ofapi-collection-policy.ts";
import { runOfapiCollectionJob } from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import { rebuildOfapiReadSnapshotProjection } from "../apps/runtime/src/services/projections/ofapi-read-snapshots.ts";
import { getOfapiMarketingDashboard, prepareOfapiMarketingCommand, dispatchOfapiMarketingCommand, refreshOfapiMarketingPostbacks } from "../apps/runtime/src/services/ofapi-smart-links.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
const LINK="01JQZ9MY9QZHBBEMYW0AN9N8EQ", OTHER="01JQZ9MY9QZHBBEMYW0AN9N8ER";
let db:StartedTestDatabase,app:AppContext,actor:number,pageId:number;
let fetchMock:ReturnType<typeof vi.fn>;
const response=(data:unknown, credits=0)=>new Response(JSON.stringify({data,_meta:{_credits:{used:credits,balance:0}}}));
beforeAll(async()=>{const value=await startIntegrationTestDatabase();if(!value)throw new Error("Marketing tests require PostgreSQL");db=value;},120000);
afterAll(async()=>{await db?.stop();});afterEach(()=>vi.unstubAllGlobals());
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
  expect(prepared.preview).toMatchObject({affectedLinkIds:[LINK,OTHER],affectedLinksComplete:false});expect(JSON.stringify(prepared)).not.toContain("PRIVATE-AD-TOKEN");
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
 it("page erasure removes populated intents, captures and marketing projections before replay",async()=>{
  await inventory();const id=randomUUID();await prepareOfapiMarketingCommand(app,{id,command:{action:"smart_link_create",pageId,name:"new",link_type:"tracking_link"}},actor);
  fetchMock.mockResolvedValueOnce(response({id:OTHER}));await apply(id);
  await db.pool.query("insert into ofapi_marketing_resources(page_id,kind,upstream_id,data,observation_id,observed_at) values($1,'pixel','999','{}',1,now())",[pageId]);
  const scope={scopeType:"page" as const,pageLabel:"marketing"};const plan=await planErasure(app,scope);
  expect(plan.targets.find(t=>t.target==="ofapi_marketing_intents")?.rows).toBe(1);expect(plan.targets.find(t=>t.target==="ofapi_marketing_resources")?.rows).toBe(1);
  await executeErasure(app,scope,{initiatedBy:actor});await rebuildOfapiReadSnapshotProjection(app,{accountId:pageId});
  expect((await getOfapiMarketingDashboard(app))).toMatchObject({resources:[],analytics:[],intents:[]});
  expect((await db.pool.query("select count(*)::int n from observations where account_id=$1",[pageId])).rows[0].n).toBe(0);
 });
});
