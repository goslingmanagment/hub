import { describe, expect, it } from "vitest";
import { ofapiMarketingActionSchema, routeSchemas } from "@agency_hub_core/contracts";
import { findOfapiReadDefinition, resolveOfapiCatalogPath, OFAPI_READ_CATALOG } from "@agency_hub_core/shared";
import { normalizeOfapiRead, validateOfapiCatalogResponse, ofapiReadCoverage, validateOfapiMarketingAccount } from "../apps/runtime/src/services/ofapi-read-normalization.ts";
import { normalizeOfapiMarketingResource, normalizeOfapiMarketingAnalytics } from "../apps/runtime/src/services/ofapi-marketing-normalization.ts";
import { ofapiMarketingRequest, ofapiMarketingSafePreviewValues } from "../apps/runtime/src/services/ofapi-smart-links.ts";
const LINK = "01JQZ9MY9QZHBBEMYW0AN9N8EQ";
const def = (id: string) => findOfapiReadDefinition(`ofapi_read_${id}`)!;
describe("closed Smart Link reads and safe marketing contracts", () => {
  it("requires a frozen account scope for global paths, correct ULIDs, and exact inventory filters", () => {
    expect(resolveOfapiCatalogPath("/smart-links", { account_ids: "acct_a" })).toBeNull();
    expect(resolveOfapiCatalogPath("/smart-links", { account_ids: "acct_a" }, "acct_a")?.definition.id).toBe("smart_links");
    expect(()=>resolveOfapiCatalogPath("/smart-links", { account_ids: "acct_b" }, "acct_a")).toThrow("scope");
    expect(resolveOfapiCatalogPath(`/smart-links/${LINK}/pixels`, {}, "acct_a")?.definition.id).toBe("smart_link_pixels");
    expect(resolveOfapiCatalogPath("/smart-links/12/pixels", {}, "acct_a")).toBeNull();
    expect(resolveOfapiCatalogPath("/smart-link-postbacks", {}, "acct_a")).toBeNull();
    expect(new Set(OFAPI_READ_CATALOG.map(d=>d.operation)).size).toBe(OFAPI_READ_CATALOG.length);
  });
  it("preserves unknown campaign cost and attribution money without exposing private bodies", () => {
    const resource = normalizeOfapiMarketingResource({kind:"tracking",pageId:1,observedAt:new Date(),row:{id:4,campaignName:"A",cost:{inputMode:"perClick",inputValue:0},revenue:{total:"12.345"},tags:["IG"]}});
    expect(resource.cost).toEqual({inputMode:"perClick",inputValue:"0",currency:null,unit:"provider_input",source:"provider_campaign_configuration"});
    expect(resource.revenueMills).toBe("12345");expect(resource.revenueBasis).toBe("unspecified");expect(resource.tags).toEqual(["IG"]);
    expect(normalizeOfapiMarketingResource({kind:"tracking",pageId:1,observedAt:new Date(),row:{id:4}}).cost).toBeNull();
  });
  it("reads root tags and stored list inventories without fabricating completion", () => {
    expect(normalizeOfapiRead(def("smart_link_tags"),{tags:["IG"]})).toEqual([{nativeId:"IG",tag:"IG"}]);
    expect(validateOfapiCatalogResponse(def("smart_link_tags").operation,{data:["wrong"]})).toBe(false);
    expect(normalizeOfapiRead(def("stored_shared_trial_links"),{data:{list:[{id:1,owner:{id:2}}],hasMore:false}})[0]).toMatchObject({resource:{kind:"trial",shared:true}});
    const coverage=ofapiReadCoverage(def("smart_link_clicks"),{data:{rows:[{id:1}],summary:{clicks_total:1}}},`/smart-links/${LINK}/clicks`,{limit:"1",offset:"0"});
    expect(coverage).toMatchObject({state:"partial",reason:"bounded_offset_scan",nextQuery:{offset:"1"}});
    expect(ofapiReadCoverage(def("smart_links"),{data:[]},"/smart-links",{limit:"50",offset:"0",account_ids:"acct_a"})).toMatchObject({state:"unknown",nextQuery:null});
    expect(validateOfapiMarketingAccount(def("smart_links"),{data:[{id:LINK,account:{id:"acct_b"}}]},"acct_a")).toBe(false);
  });
  it("separates summary, daily and monthly series; handles unknown cohort units honestly", () => {
    const rows=normalizeOfapiMarketingAnalytics("ofapi_read_smart_link_stats",{data:{summary:{revenue_total:"5.001"},daily_metrics:[{timestamp:"2026-09-01",revenue:1}],monthly_metrics:[{timestamp:"2026-09-01",revenue:5}]}});
    expect(rows.map(r=>r.period)).toEqual(["summary","daily","monthly"]); expect(rows[0]?.revenueMills).toBe("5001");
    expect(normalizeOfapiMarketingAnalytics("ofapi_read_smart_link_cohort_arps",{data:{windows:[{days:30,arps:"1.75"}]}})).toContainEqual({period:"cohort",metricPath:"windows[0].arps",providerValue:"1.75",revenueBasis:"unspecified",attributionOnly:true});
  });
  it("retains meaningful fan/conversion flags but excludes IP, browser IDs and auth secrets", () => {
    const conversion=normalizeOfapiMarketingAnalytics("ofapi_read_smart_link_conversions",{data:{rows:[{id:7,fan_onlyfans_id:"90",conversion_type:"new_transaction",amount_net:"2.005",amount_gross:3,click:{is_bot:true,is_duplicate:false,ip_address:"private-ip",gclid:"private-gclid"}}]}})[0];
    expect(conversion).toMatchObject({fanId:"90",isBot:true,isDuplicate:false,organic:null,amountNetMills:"2005",amountGrossMills:"3000"}); expect(JSON.stringify(conversion)).not.toContain("private");
    const fan=normalizeOfapiMarketingAnalytics("ofapi_read_smart_link_fans",{data:{rows:[{onlyfans_id:"90",revenue_net:"4.25",subscription_insights:{previously_subscribed:true,subscribed_using_promo:false}}]}})[0];
    expect(fan).toMatchObject({revenueMills:"4250",revenueBasis:"net",previouslySubscribed:true,subscribedUsingPromo:false});
    const postback=normalizeOfapiMarketingResource({kind:"postback",pageId:null,observedAt:new Date(),row:{id:5,url:"https://example.test/secret-path?secret=token&fan={fan_id}",body:"token={amount_net}",headers:[{name:"Authorization",value:"private-secret"}],http_method:"POST"}});
    expect(postback).toMatchObject({destination:"https://example.test",headerNames:["Authorization"],templateVariables:["amount_net","fan_id"],hasBodyTemplate:true}); expect(JSON.stringify(postback)).not.toContain("private-secret");expect(JSON.stringify(postback)).not.toContain("secret-path");
  });
  it("types every explicit write including omitted token updates and relation-only disconnect", () => {
    const update=ofapiMarketingActionSchema.parse({action:"pixel_update",pageId:1,linkId:LINK,pixelId:9,event_click:null});
    expect(ofapiMarketingRequest(update)).toEqual({method:"PATCH",path:`/smart-links/${LINK}/pixels/9`,body:{event_click:null}});
    expect(ofapiMarketingRequest({action:"pixel_disconnect",pageId:1,linkId:LINK,pixelId:9})).toEqual({method:"DELETE",path:`/smart-links/${LINK}/pixels/9`,body:undefined});
    expect(ofapiMarketingActionSchema.safeParse({action:"pixel_create",pageId:1,linkId:LINK,platform:"meta",pixel_id:"",pixel_access_token:"token"}).success).toBe(false);
    expect(ofapiMarketingActionSchema.safeParse({action:"pixel_create",pageId:1,linkId:LINK,platform:"creatortraffic",pixel_id:"",pixel_access_token:"token"}).success).toBe(true);
    expect(ofapiMarketingActionSchema.safeParse({action:"postback_create",url:"https://example.test",smart_link_scope:"global",conversion_types:["arbitrary"]}).success).toBe(false);
    for(const name of ["ofapiMarketingGet","ofapiMarketingPrepare","ofapiMarketingDispatch","ofapiMarketingPostbacksRefresh","ofapiMarketingRebuild"] as const) expect(routeSchemas[name].auth).toEqual({kind:"owner-session"});
  });
  it("freezes concrete safe values while disclosing secret changes only as actions",()=>{
    expect(ofapiMarketingSafePreviewValues({action:"smart_link_create",pageId:4,name:"Launch",link_type:"free_trial",free_trial_days:30})).toEqual([{field:"name",value:"Launch"},{field:"link_type",value:"free_trial"},{field:"free_trial_days",value:30}]);
    expect(ofapiMarketingSafePreviewValues({action:"tags_remove",pageId:4,linkId:LINK,tags:["Launch"]})).toEqual([{field:"tags",value:["Launch"]}]);
    const preview=ofapiMarketingSafePreviewValues({action:"postback_update",postbackId:8,url:"https://example.test/PRIVATE?key=SECRET",http_method:"POST",body:"PRIVATE",headers:[{name:"Authorization",value:"SECRET"}],smart_link_scope:"global",conversion_types:["new_transaction"]});
    expect(preview).toEqual([{field:"http_method",value:"POST"},{field:"body_change",value:"replace"},{field:"headers_change",value:"replace"}]);expect(JSON.stringify(preview)).not.toMatch(/PRIVATE|SECRET|example/);
    expect(ofapiMarketingSafePreviewValues({action:"pixel_test",pageId:4,linkId:LINK,pixelId:9,event_type:"event_new_subscriber_paid",test_event_code:"PRIVATE"})).toEqual([{field:"event_type",value:"event_new_subscriber_paid"},{field:"test_event_code_change",value:"replace"}]);
  });

});
