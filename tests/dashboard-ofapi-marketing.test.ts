import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ofapiMarketingIntentSchema, type OfapiMarketingAction } from "@agency_hub_core/contracts";
import { ofapiMarketingSafePreviewValues } from "../apps/runtime/src/services/ofapi-smart-links.ts";
vi.mock("../apps/dashboard/src/api/ofapiMarketing.ts",()=>({marketingActions:{},useOfapiMarketing:vi.fn()}));
vi.mock("../apps/dashboard/src/api/adminOfapiCollection.ts",()=>({useAdminOfapiCollection:vi.fn()}));
vi.mock("../apps/dashboard/src/api/queries.ts",()=>({useAuthMe:vi.fn()}));
vi.mock("../apps/dashboard/src/lib/useSessionWorkspace.ts",()=>({useSessionWorkspace:vi.fn()}));
import { MarketingIntentReview } from "../apps/dashboard/src/pages/OfapiMarketing.tsx";
const LINK="01JQZ9MY9QZHBBEMYW0AN9N8EQ";
function render(command:OfapiMarketingAction, shared=false, external=false) {
  const intent=ofapiMarketingIntentSchema.parse({
    id:"aa000000-0000-4000-8000-000000000001",action:command.action,state:"prepared",errorCode:null,
    remoteId:null,accountingState:"pending",projectionState:"pending",createdAt:"2026-09-06T12:00:00Z",responseObservationId:null,
    preview:{pageId:7,pageLabel:"Creator Seven",accountId:"acct_seven",values:ofapiMarketingSafePreviewValues(command),
      destination:null,templateVariables:[],headerNames:[],targetId:"pixelId" in command ? String(command.pixelId) : null,
      changedFields:[],conversionTypes:[],scope:null,affectedLinkIds:[LINK],affectedLinksComplete:!shared,effect:"Review exact action",externalTest:external,estimatedCredits:0},
  });
  return renderToStaticMarkup(createElement(MarketingIntentReview,{intent,busy:false,error:"",onDispatch:vi.fn(),onClose:vi.fn()}));
}
describe("concrete owner marketing confirmation",()=>{
  it("shows the persisted page, account, campaign and trial duration before creation",()=>{
    const html=render({action:"smart_link_create",pageId:7,name:"Thirty day campaign",link_type:"free_trial",free_trial_days:30});
    expect(html).toContain("Creator Seven");expect(html).toContain("acct_seven");expect(html).toContain("Thirty day campaign");
    expect(html).toContain("Дней бесплатного доступа");expect(html).toContain(">30</dd>");
  });
  it("keeps shared changes disabled until acknowledgement and never displays token values",()=>{
    const html=render({action:"pixel_update",pageId:7,linkId:LINK,pixelId:9,pixel_access_token:"PRIVATE-TOKEN"},true);
    expect(html).toContain("общего пикселя");expect(html).toContain("Заменить значение");expect(html).not.toContain("PRIVATE-TOKEN");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Подтвердить и выполнить<\/button>/);
  });
  it("names the actual external test while withholding its code and requiring its separate acknowledgement",()=>{
    const html=render({action:"pixel_test",pageId:7,linkId:LINK,pixelId:9,event_type:"event_new_subscriber_paid",test_event_code:"PRIVATE-CODE"},false,true);
    expect(html).toContain("Новая платная подписка");expect(html).toContain("внешнюю рекламную систему");expect(html).not.toContain("PRIVATE-CODE");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Подтвердить и выполнить<\/button>/);
  });
});
