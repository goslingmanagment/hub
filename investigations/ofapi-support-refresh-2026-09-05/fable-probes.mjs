// From Hub root: node --import tsx/esm investigations/ofapi-support-refresh-2026-09-05/fable-probes.mjs
// Executes pure/noop branches of real source functions. No network or DB calls.
import { onlyfansTransactionsChunk, onlyfansTopSpendersChunk } from '/Users/dmitriy/code/goose/hub/apps/runtime/src/services/sync/executor-handlers.ts';
import { createOfapiCommandBodySchema } from '/Users/dmitriy/code/goose/hub/packages/contracts/src/routes.ts';
import { resolveOfapiReadGatewayRequest } from '/Users/dmitriy/code/goose/hub/apps/runtime/src/services/ofapi-read-gateway.ts';
import { validateOfapiInteractiveResponseShape } from '/Users/dmitriy/code/goose/hub/apps/runtime/src/services/ofapi-capture-contract.ts';

const phases=[];
const input={pageContext:{platform:'onlyfans',page:{id:1}},telemetry:{recordPhaseStarted:async phase=>phases.push(phase)}};
const forbid=new Proxy({}, {get(){throw new Error('Forbidden I/O in local probe');}});
const app={config:{onlyFansTopSpendersEnabled:false},db:forbid,ofapi:forbid};
const transactions=await onlyfansTransactionsChunk(app,input);
const topSpendersDisabled=await onlyfansTopSpendersChunk(app,input);
const mediaCommand={clientCommandId:'00000000-0000-4000-8000-000000000001',kind:'send_media_message_v1',accountId:'acct_AUDIT',conversationId:'123',payload:{text:'fixture',price:0,mediaFiles:['ofapi_media_Audit123'],previews:[]}};
const parsed=createOfapiCommandBodySchema.safeParse(mediaCommand);
const vault=resolveOfapiReadGatewayRequest('acct_AUDIT/media/vault',{});
const result={
  transactionsNoop:transactions,
  topSpendersFlagOff:topSpendersDisabled,
  executorClassifiesTransactionsAsGatedSkip:Boolean(transactions.gatedSkip),
  executorClassifiesFlagOffAsGatedSkip:Boolean(topSpendersDisabled.gatedSkip),
  completedPhases:phases,
  currentSendMediaV1AcceptsOfapiUploadToken:parsed.success,
  vaultOperation:vault.operation,
  vaultCaptureFamilyRecognizesList:validateOfapiInteractiveResponseShape(vault.operation,{data:{list:[{id:123}],hasMore:false}}),
};
console.log(JSON.stringify(result,null,2));
