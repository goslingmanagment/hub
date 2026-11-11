import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createFanslyPage, createModel, createOnlyFansPage, createUser } from '@agency_hub_core/db';
import { executeErasure, planErasure } from '../apps/runtime/src/services/erasure/index.ts';
import { startIntegrationTestDatabase, type StartedTestDatabase } from './helpers/db.ts';

// The table's writer (the old extension's custody route) is retired; its rows
// stay and erasure still owns them.
let harness: StartedTestDatabase;
let userId: number;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error('Docker Postgres is required');
  harness = started;
  userId = (await createUser(harness.db, { username: 'follower-one', role: 'chatter' }))!.id;
}, 120_000);
afterAll(async () => { await harness?.stop(); });

describe('follower custody rows under erasure', () => {
  it('erases custody with its fan or page while preserving other fans and platforms', async () => {
    const model = await createModel(harness.db, { slug: 'outreach-erasure', name: 'Outreach erasure' });
    const fs = (await createFanslyPage(harness.db, { modelId: model!.id, label: 'outreach-erasure-fs' }))!;
    const of = (await createOnlyFansPage(harness.db, { modelId: model!.id, label: 'outreach-erasure-of' }))!;
    const owner = (await createUser(harness.db, { username: 'outreach-erasure-owner', role: 'owner' }))!;
    const app = { db: harness.db, pool: harness.pool, config: { lakeDir: '/nonexistent-outreach-test-lake' }, logger: { info: () => {}, warn: () => {}, error: () => {} } } as never;
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    // The rows a reserve + dispatch left behind.
    for (const [index, targetPage, fan] of [[0, fs.id, '81'], [1, fs.id, '82'], [2, of.id, '81']] as const) {
      await harness.pool.query(
        `insert into follower_outreach_attempts (attempt_id, platform_account_id, fan_ref, user_id, state, expires_at)
         values ($1::uuid, $2, $3, $4, 'dispatching', now() + interval '60 seconds')`,
        [ids[index], targetPage, fan, userId],
      );
    }
    const scope = { scopeType: 'fan', platform: 'fansly', fanRef: '81' } as const;
    expect((await planErasure(app, scope)).targets.find((target) => target.target === 'follower_outreach_attempts')).toMatchObject({ rows: 1, action: 'delete' });
    await executeErasure(app, scope, { initiatedBy: owner.id });
    const remaining = async () => (await harness.pool.query<{ attempt_id: string }>('select attempt_id from follower_outreach_attempts where attempt_id = any($1::uuid[]) order by fan_ref', [ids])).rows.map((row) => row.attempt_id);
    expect(await remaining()).toEqual([ids[2], ids[1]]);
    await executeErasure(app, { scopeType: 'page', pageLabel: fs.label }, { initiatedBy: owner.id });
    expect(await remaining()).toEqual([ids[2]]);
  });
});
