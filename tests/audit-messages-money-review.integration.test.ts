import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createModel, createFanslyPage, createLiveSyncPage, ensurePollRows, type Database } from '@agency_hub_core/db';
import { createEngineRegistry, pollsFor } from '../apps/runtime/src/sync/engine/resource.ts';
import { FANSLY_RESOURCE_SPECS } from '../apps/runtime/src/sync/fansly/registry.ts';
import { transactionsModule } from '../apps/runtime/src/sync/fansly/resources/transactions.ts';
import { readSyncJournalAlertFacts } from '../packages/db/src/repositories/sync/observability.ts';
import { resetIntegrationDatabase, startIntegrationTestDatabase, type StartedTestDatabase } from './helpers/db.ts';

let testDb: StartedTestDatabase | null = null;
beforeAll(async () => { testDb = await startIntegrationTestDatabase(); },120000);
afterAll(async () => { await testDb?.stop(); });
beforeEach(async () => { if (testDb) await resetIntegrationDatabase(testDb.pool); });
const now = new Date('2026-10-09T12:00:00Z');
const db = () => testDb!.db as unknown as Database;

async function birth() {
  const label = `audit-${randomUUID().slice(0,8)}`;
  const model = await createModel(db(), {slug:label, name:label});
  const page = await createFanslyPage(db(), {modelId:model!.id,label});
  await testDb!.pool.query("update pages set external_page_id='300000000000000071' where id=$1",[page!.id]);
  await db().transaction(async tx => createLiveSyncPage(tx as unknown as Database, {
    pageId:page!.id,by:'synthetic-local-audit',identityAccountId:'300000000000000071',
    identityCheckedAt:now,credentialsGeneration:'a'.repeat(64),
  }));
  await ensurePollRows(db(), {pageId:page!.id,polls:pollsFor(createEngineRegistry(FANSLY_RESOURCE_SPECS),{registryOverrides:{}})});
  return page!.id;
}
function txItem(index: number) {
  return { transactionId:String(900000000000000000n-BigInt(index)),walletId:'700000000000000000',accountId:'300000000000000071',
    correlationId:null,correlationAccountId:null,type:7001,destination:1,amount:10000,destinationAmount:8000,destinationTax:2000,
    newBalance64:null,senderId:null,receiverId:null,status:2,createdAt:now.getTime()-index*86400000,updatedAt:null };
}
function work(cursor: unknown={}) { return {cursor,demand:{txIds:[],messageIds:[],reasons:[],overflow:false},params:{},subject:'',demandRevision:1}; }
async function apply(variant:'insurance'|'rescan',pageId:number,cursor:unknown,offset:number,items:unknown[]) {
  return db().transaction(async tx => transactionsModule(variant).apply(tx as unknown as Database, {
    pageId,now,parsed:{data:items,total:500},response:{data:items,total:500},work:work(cursor),
    request:{spec:'transactions.page',params:{limit:variant==='insurance'?20:100,offset}},
    attempt:{admittedAt:now,demandRevision:1},observation:{id:null},
  } as never));
}

describe('independent adversarial DB proof: money bootstrap and ledger alert',()=>{
  it('birth lacks backfill; completed first insurance stores200 then repeated scans cannot reach older300',async context=>{
    if(!testDb) return context.skip();
    const pageId=await birth();
    const works=await testDb.pool.query("select resource from sync_work where page_id=$1",[pageId]);
    expect(works.rows.map(r=>r.resource)).not.toContain('transactions.backfill');
    let cursor:unknown={}; let result;
    for(let offset=0;offset<200;offset+=20){
      result=await apply('insurance',pageId,cursor,offset,Array.from({length:20},(_,i)=>txItem(offset+i)));
      cursor=result.work.cursor;
    }
    expect(result!.work.closeReason).toBe('escalated');
    expect(result!.followups).toContainEqual(expect.objectContaining({resource:'transactions.rescan'}));
    const plan=await transactionsModule('rescan').plan(work() as never,{db:db(),pageId,now} as never);
    expect(plan.kind).toBe('request');
    const rescan=await apply('rescan',pageId,{},0,Array.from({length:100},(_,i)=>txItem(i)));
    expect(rescan.work).toMatchObject({closeReason:'early_stop',proof:{ledgerRows:200,ledgerIncomplete:300}});
    const rescanAgain=await apply('rescan',pageId,rescan.work.cursor,0,Array.from({length:100},(_,i)=>txItem(i)));
    expect(rescanAgain.work).toMatchObject({closeReason:'early_stop',proof:{ledgerRows:200,ledgerIncomplete:300}});
    // Desired recovery: bootstrap or a gap detector queues the missing tail.
    expect([...rescan.followups,...rescanAgain.followups]).toContainEqual(expect.objectContaining({resource:'transactions.backfill'}));
  },60000);
  it('actual alert SQL must see ledgerIncomplete on the standing open rescan row',async context=>{
    if(!testDb) return context.skip();
    const pageId=await birth();
    await testDb.pool.query("update sync_work set proof=$2::jsonb,last_served_at=$3 where page_id=$1 and resource='transactions.rescan'",[pageId,JSON.stringify({ledgerIncomplete:300}),now]);
    const facts=await readSyncJournalAlertFacts(db(),{pageId,stopLookbackMs:10000,urgentAfterMs:10000,requestStallMs:10000});
    expect(facts.ledgerIncomplete).not.toBeNull();
  });
});
