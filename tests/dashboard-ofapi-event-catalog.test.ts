import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const query=vi.hoisted(()=>vi.fn());
vi.mock("../apps/dashboard/src/api/adminOfapiWebhookRecovery.ts",()=>({useOfapiWebhookRecovery:query,ofapiWebhookRecoveryActions:{}}));
import { OfapiWebhookRecovery } from "../apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx";
it("shows captured future events without presenting an unimplemented handler as enabled",()=>{
  query.mockReturnValue({data:{policy:{desiredGroups:[],appliedGroups:[],groups:[],historyEnabled:false,applyState:"never"},history:{attempts:[],latestScan:null,webhookId:null},catalog:{observedAt:"2026-09-06T10:00:00Z",state:"captured",events:[{value:"new_family.future_event",description:"Future event",requested:false,supported:false}]}}});
  const html=renderToStaticMarkup(createElement(OfapiWebhookRecovery));
  expect(html).toContain("2026-09-06T10:00:00Z");
  expect(html).toContain("new_family.future_event");
  expect(html).toContain("не запрошено");
  expect(html).toContain("обработчик не подключён");
  expect(html).toContain("новые события не включаются автоматически");
  expect(html).toContain("Обновить каталог · бесплатно");
});
