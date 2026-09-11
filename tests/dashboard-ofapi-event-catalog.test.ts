import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { expect, it, vi } from "vitest";
const query=vi.hoisted(()=>vi.fn());
vi.mock("../apps/dashboard/src/api/adminOfapiWebhookRecovery.ts",()=>({useOfapiWebhookRecovery:query,ofapiWebhookRecoveryActions:{}}));
vi.mock("../apps/dashboard/src/api/queries.ts",()=>({useAuthMe:()=>({data:{user:{id:1}}})}));
vi.mock("../apps/dashboard/src/lib/useSessionWorkspace.ts",()=>({useSessionWorkspace:(_name:string,initial:()=>unknown)=>{const state=initial();return [state,vi.fn(),()=>state];}}));
import { OfapiWebhookRecovery } from "../apps/dashboard/src/pages/settings/OfapiWebhookRecovery.tsx";
it("shows captured future events without presenting an unimplemented handler as enabled",()=>{
  query.mockReturnValue({policy:{data:{desiredGroups:[],appliedGroups:[],groups:[],historyEnabled:false,applyState:"never"}},history:{data:{attempts:[],latestScan:null,webhookId:null}},catalog:{data:{observedAt:"2026-09-06T10:00:00Z",state:"captured",events:[{value:"new_family.future_event",description:"Future event",requested:false,supported:false}]}}});
  const html=renderToStaticMarkup(createElement(MemoryRouter,null,createElement(OfapiWebhookRecovery)));
  expect(html).toContain("2026-09-06T10:00:00Z");
  expect(html).toContain("new_family.future_event");
  expect(html).toContain("не запрошено");
  expect(html).toContain("обработчик не подключён");
  expect(html).toContain("новые события не включаются автоматически");
  expect(html).toContain("Обновить каталог · бесплатно");
});
