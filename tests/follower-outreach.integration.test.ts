import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createFanslyPage, createModel, createOnlyFansPage, createUser, transitionFollowerOutreach } from '@agency_hub_core/db';
import { executeErasure, planErasure } from '../apps/runtime/src/services/erasure/index.ts';
import { startIntegrationTestDatabase, type StartedTestDatabase } from './helpers/db.ts';

let harness: StartedTestDatabase;
let pageId: number;
let userId: number;
let otherUserId: number;
beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error('Docker Postgres is required');
  harness = started;
  const model = await createModel(harness.db, { slug: 'follower-review', name: 'Follower test' });
  if (!model) throw new Error('Model fixture missing');
  const page = await createFanslyPage(harness.db, { modelId: model.id, label: 'follower-test' });
  if (!page) throw new Error('Page fixture missing');
  pageId = page.id;
  userId = (await createUser(harness.db, { username: 'follower-one', role: 'chatter' }))!.id;
  otherUserId = (await createUser(harness.db, { username: 'follower-two', role: 'chatter' }))!.id;
}, 120_000);
afterAll(async () => { await harness?.stop(); });

describe('shared one-attempt follower custody', () => {
  it('grants only one of two simultaneous browser reservations, even for the same user', async () => {
    const results = await Promise.all([1, 2].map(() => transitionFollowerOutreach(harness.db, { pageId, userId, fanRef: '11', attemptId: randomUUID(), action: 'reserve' })));
    expect(results.filter((r) => r.owned)).toHaveLength(1);
  });
  it('expires only undispatched reservations, keeps old rows, fences stale owners', async () => {
    const first = { pageId, userId, fanRef: '12', attemptId: randomUUID() };
    await transitionFollowerOutreach(harness.db, { ...first, action: 'reserve' });
    await harness.pool.query('update follower_outreach_attempts set expires_at = now() - interval \'1 second\' where attempt_id = $1', [first.attemptId]);
    const next = { ...first, userId: otherUserId, attemptId: randomUUID() };
    expect((await transitionFollowerOutreach(harness.db, { ...next, action: 'reserve' })).owned).toBe(true);
    expect((await transitionFollowerOutreach(harness.db, { ...first, action: 'dispatch' })).owned).toBe(false);
    const rows = await harness.pool.query('select state from follower_outreach_attempts where fan_ref = $1 order by created_at', ['12']);
    expect(rows.rows.map((r) => r.state)).toEqual(['expired', 'reserved']);
  });
  it('never expires a dispatch, rejects foreign owners, retains the confirmed message', async () => {
    const input = { pageId, userId, fanRef: '13', attemptId: randomUUID() };
    await transitionFollowerOutreach(harness.db, { ...input, action: 'reserve' });
    expect((await transitionFollowerOutreach(harness.db, { ...input, action: 'dispatch' })).state).toBe('dispatching');
    await harness.pool.query('update follower_outreach_attempts set expires_at = now() - interval \'1 day\' where attempt_id = $1', [input.attemptId]);
    expect((await transitionFollowerOutreach(harness.db, { ...input, attemptId: randomUUID(), action: 'reserve' })).owned).toBe(false);
    expect((await transitionFollowerOutreach(harness.db, { ...input, userId: otherUserId, action: 'sent', messageRef: '90' })).owned).toBe(false);
    expect((await transitionFollowerOutreach(harness.db, { ...input, action: 'sent', messageRef: '91' })).state).toBe('sent');
    await transitionFollowerOutreach(harness.db, { ...input, action: 'sent', messageRef: '92' });
    const result = await harness.pool.query('select message_ref from follower_outreach_attempts where attempt_id = $1', [input.attemptId]);
    expect(result.rows[0].message_ref).toBe('91');
  });
  it('does not use a reused attempt id to claim another fan or another page', async () => {
    const attemptId = randomUUID();
    await transitionFollowerOutreach(harness.db, { pageId, userId, fanRef: '14', attemptId, action: 'reserve' });
    expect(await transitionFollowerOutreach(harness.db, { pageId, userId, fanRef: '15', attemptId, action: 'reserve' })).toMatchObject({ owned: false, state: 'expired' });
  });
  it('erases custody with its fan or page while preserving other fans and platforms', async () => {
    const model = await createModel(harness.db, { slug: 'outreach-erasure', name: 'Outreach erasure' });
    const fs = (await createFanslyPage(harness.db, { modelId: model!.id, label: 'outreach-erasure-fs' }))!;
    const of = (await createOnlyFansPage(harness.db, { modelId: model!.id, label: 'outreach-erasure-of' }))!;
    const owner = (await createUser(harness.db, { username: 'outreach-erasure-owner', role: 'owner' }))!;
    const app = { db: harness.db, pool: harness.pool, config: { lakeDir: '/nonexistent-outreach-test-lake' }, logger: { info: () => {}, warn: () => {}, error: () => {} } } as never;
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, targetPage, fan] of [[0, fs.id, '81'], [1, fs.id, '82'], [2, of.id, '81']] as const) {
      await transitionFollowerOutreach(harness.db, { pageId: targetPage, userId, fanRef: fan, attemptId: ids[index]!, action: 'reserve' });
      await transitionFollowerOutreach(harness.db, { pageId: targetPage, userId, fanRef: fan, attemptId: ids[index]!, action: 'dispatch' });
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
