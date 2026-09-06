import { createHash } from "node:crypto";
import { describe,expect,it } from "vitest";
import { canonicalizeOfapiWebhookObservation } from "../apps/runtime/src/services/canonicalize/ofapi-webhook.ts";
const token="ofapi_media_one_use_capability";
function observation(kind:string,payload:Record<string,unknown>){return {id:1,source:"webhook",producer:"ofapi:webhook",platform:"onlyfans",accountId:2,kind,payload:{event:kind,account_id:"acct_test",payload},observedAt:null,receivedAt:new Date("2026-09-06T10:00:00Z")};}
describe("upload capability boundary",()=>{
 it("retains exact upload identity only in captured authority, never general canonical event data or keys",()=>{
  const events=canonicalizeOfapiWebhookObservation(observation("media_uploads.completed",{id:token,status:"completed",media_id:token,media:{isReady:false},credits_used:3}));
  expect(events).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain(token);
  expect(events[0]?.data).toMatchObject({resourceId:`sha256:${createHash("sha256").update(token).digest("hex")}`,mediaId:null,mediaReady:false,creditCost:3});
  expect(canonicalizeOfapiWebhookObservation(observation("media_uploads.completed",{id:token,status:"completed",media_id:123}))[0]?.data.mediaId).toBe("123");
 });
 it("preserves the non-capability export resource identity",()=>{
  const events=canonicalizeOfapiWebhookObservation(observation("data_exports.completed",{id:"data_export_test",account_ids:["acct_test"],status:"completed"}));
  expect(events[0]?.data.resourceId).toBe("data_export_test");
 });
});
