import { describe, expect, it } from "vitest";
import { buildMarketingCommand, newMarketingForm, marketingDisplayMoney, marketingFlag, marketingPixelCanTest, marketingPreviewValue } from "../apps/dashboard/src/pages/marketing/marketingForm.ts";
import { normalizeOfapiMarketingResource } from "../apps/runtime/src/services/ofapi-marketing-normalization.ts";
const linkId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("owner marketing action forms", () => {
  it("keeps an unchanged secret out of a pixel update and uses the numeric team pixel id", () => {
    const form = { ...newMarketingForm("pixel_update", 7), linkId, resourceId: "12", platformPixelId: "meta-pixel-41" };
    const command = buildMarketingCommand(form);
    expect(command).toMatchObject({ action: "pixel_update", pageId: 7, linkId, pixelId: 12, pixel_id: "meta-pixel-41" });
    expect(command).not.toHaveProperty("pixel_access_token");
    expect(command).not.toHaveProperty("platform");
  });
  it("requires a token when creating a pixel; test parameters cannot leak into that action", () => {
    const form = { ...newMarketingForm("pixel_create", 7), linkId, platformPixelId: "123", testCode: "unrelated" };
    expect(() => buildMarketingCommand(form)).toThrow();
    const command = buildMarketingCommand({ ...form, token: "synthetic-test-token" });
    expect(command).toHaveProperty("pixel_access_token", "synthetic-test-token");
    expect(command).not.toHaveProperty("test_event_code");
  });
  it("preserves existing postback headers and body when update inputs are empty", () => {
    const form = { ...newMarketingForm("postback_update", 7), resourceId: "21", url: "https://example.test/receive?fan={fan_id}", linkIds: [linkId] };
    const command = buildMarketingCommand(form);
    expect(command).toMatchObject({ action: "postback_update", postbackId: 21, smart_link_scope: "campaign_specific", smart_link_ids: [linkId] });
    expect(command).not.toHaveProperty("headers");
    expect(command).not.toHaveProperty("body");
    expect(command).not.toHaveProperty("pageId");
  });
  it("rejects line breaks in a secret header before preparing an action", () => {
    const form = { ...newMarketingForm("postback_create", 7), scope: "global" as const, url: "https://example.test", headers: [{ name: "Authorization", value: "Bearer synthetic\r\nInjected: secret" }] };
    expect(() => buildMarketingCommand(form)).toThrow();
  });
  it("removes only selected whole tags and drops every unrelated hidden input", () => {
    const form = { ...newMarketingForm("tags_remove", 7), linkId, tags: "source, paid\n referral \nreferral", token: "must-not-leak", url: "https://example.test" };
    expect(buildMarketingCommand(form)).toEqual({ action: "tags_remove", pageId: 7, linkId, tags: ["source, paid", "referral"] });
  });
  it("checks trial duration and does not send hidden trial or campaign-scope fields", () => {
    const form = { ...newMarketingForm("smart_link_create", 7), name: "Campaign", linkType: "free_trial" as const, trialDays: "0" };
    expect(() => buildMarketingCommand(form)).toThrow();
    expect(buildMarketingCommand({ ...form, linkType: "tracking_link" })).not.toHaveProperty("free_trial_days");
    const postback = { ...newMarketingForm("postback_create", 7), url: "https://example.test", scope: "global" as const, linkIds: [linkId] };
    expect(buildMarketingCommand(postback)).not.toHaveProperty("smart_link_ids");
  });
  it("sends only the changed token from a partially known pixel and preserves provider defaults on create",()=>{
    const resource=normalizeOfapiMarketingResource({kind:"pixel",pageId:7,parentId:linkId,observedAt:new Date(),row:{id:12,label:"Shared",platform:"meta",pixel_id:"meta-pixel",event_click:"CampaignClick"}});
    const form=newMarketingForm("pixel_update",7,resource);
    expect(buildMarketingCommand({...form,token:"synthetic-rotation"})).toEqual({action:"pixel_update",pageId:7,linkId,pixelId:12,pixel_access_token:"synthetic-rotation"});
    expect(()=>buildMarketingCommand(form)).toThrow("одно поле");
    const create=buildMarketingCommand({...newMarketingForm("pixel_create",7),linkId,platformPixelId:"pixel",token:"synthetic"});
    expect(create).toEqual({action:"pixel_create",pageId:7,linkId,platform:"meta",pixel_id:"pixel",pixel_access_token:"synthetic"});
  });
  it("sends explicit event/source clearing without clearing untouched event fields",()=>{
    const resource=normalizeOfapiMarketingResource({kind:"pixel",pageId:7,parentId:linkId,observedAt:new Date(),row:{id:12,event_click:"CampaignClick",event_new_subscriber:"Subscribe"}});
    const form=newMarketingForm("pixel_update",7,resource);
    expect(buildMarketingCommand({...form,clearEventSourceUrl:true,events:{...form.events,event_click:""}})).toEqual({action:"pixel_update",pageId:7,linkId,pixelId:12,event_click:null,event_source_url:null});
  });
  it("distinguishes preserving secret fields from owner-requested removal",()=>{
    const form={...newMarketingForm("postback_update",7),resourceId:"21",scope:"global" as const,url:"https://example.test",body:"stale hidden text",headers:[{name:"Authorization",value:"stale hidden secret"}],clearBody:true,clearHeaders:true};
    const command=buildMarketingCommand(form);
    expect(command).toMatchObject({body:"",headers:[]});expect(JSON.stringify(command)).not.toContain("stale hidden");
    expect(marketingPreviewValue({field:"body_change",value:"clear"})).toBe("Удалить сохранённое значение");
    expect(marketingPreviewValue({field:"body_change",value:"preserve"})).toBe("Сохранить текущее значение");
  });
  it("keeps zero amounts with their own net/gross basis and shows false separately from unknown",()=>{
    expect(marketingDisplayMoney({attributionOnly:true,revenueMills:null,revenueBasis:"unspecified",amountNetMills:"0",amountGrossMills:"1000"})).toEqual({mills:"0",basis:"net"});
    expect(marketingDisplayMoney({attributionOnly:true,amountGrossMills:"1000",revenueBasis:"unspecified"})).toEqual({mills:"1000",basis:"gross"});
    expect(marketingDisplayMoney({attributionOnly:true,revenueMills:"0",revenueBasis:"unspecified",amountNetMills:"1000"})).toEqual({mills:"0",basis:"unspecified"});
    expect(marketingFlag("Бот",false)).toBe("Бот: нет");expect(marketingFlag("Бот",null)).toBe("Бот: неизвестно");
    expect(marketingPixelCanTest("creatortraffic")).toBe(false);expect(marketingPixelCanTest("meta")).toBe(true);
  });

});
