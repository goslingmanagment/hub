#!/usr/bin/env -S node --import tsx/esm
// Run from Hub root. Local source execution with DB stubs: no API, key, network or DB.
// Unexported mapping/cursor blocks are extracted from the current source, not rewritten here.
import fs from 'node:fs';
import ts from '/Users/dmitriy/code/goose/hub/node_modules/typescript/lib/typescript.js';
import { idToString } from '/Users/dmitriy/code/goose/hub/apps/runtime/src/services/ofapi-payloads.ts';
import { toFansListPage, resolveOfapiCreditSpend } from '/Users/dmitriy/code/goose/hub/apps/runtime/src/services/ofapi.ts';

const root = '/Users/dmitriy/code/goose/hub';
const fixtures = JSON.parse(fs.readFileSync(new URL('./comparison-fixtures.json', import.meta.url), 'utf8'));
function extract(source, begin, end) {
  const start = source.indexOf(begin);
  const stop = source.indexOf(end, start);
  if (start < 0 || stop <= start) throw new Error('Source shape changed: inspect probe extraction');
  return source.slice(start, stop);
}
const identitySource = fs.readFileSync(`${root}/apps/runtime/src/services/sync/ofapi-fan-identities.ts`, 'utf8');
const helpers = extract(identitySource, 'function normalizeIdentityText', 'type GuardedFetch');
const js = ts.transpileModule(helpers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
let calls = [];
const upsertFans = async (_db, rows) => {
  calls.push({ function: 'upsertFans', count: rows.length });
  return rows.map((row, i) => ({ ...row, id: i + 1 }));
};
const upsertFanPages = async (_db, rows) => { calls.push({ function: 'upsertFanPages', count: rows.length }); };
const upsertLinkUsers = new Function('idToString', 'upsertFans', 'upsertFanPages', `${js};return upsertLinkUsers;`)(idToString, upsertFans, upsertFanPages);
const identities = [];
for (const [name, items] of [['documented-spenders', fixtures.spenders], ['documented-subscribers-control', fixtures.subscribers]]) {
  calls = [];
  const inserted = await upsertLinkUsers({ db: {} }, 1, items);
  identities.push({ name, inputRows: items.length, inserted, dbCalls: calls });
}

const audienceSource = fs.readFileSync(`${root}/apps/runtime/src/services/sync/ofapi-audience-sync.ts`, 'utf8');
const stateLogic = extract(audienceSource, '    const sweepComplete = ', '    if (contradictoryPagination)');
const advance = new Function('page', 'state', `${stateLogic};return {sweepComplete,contradictoryPagination,nextState};`);
const cursors = [];
for (const count of [19, 0]) {
  const page = toFansListPage({
    data: { list: Array.from({ length: count }, (_, i) => ({ id: 100 + i })), hasMore: true },
    _pagination: { next_page: 'https://app.onlyfansapi.com/api/acct_AUDIT/fans/active?limit=20&offset=20' },
  });
  const result = advance(page, { offset: 0, pageCount: 0, sweepStartedAt: '2026-09-05T00:00:00Z' });
  cursors.push({
    name: `synthetic-${count}-rows-next-offset-20`,
    providerNextOffset: 20,
    nextPageRetainedByTransport: page.nextPageUrl !== null,
    consumerNextOffset: result.nextState.offset,
    sweepComplete: result.sweepComplete,
    contradictoryPagination: result.contradictoryPagination,
  });
}
const creditCases = [
  [500, 1, 100], [404, 1, 100], [429, 1, 100], [403, 0, 100],
  [500, null, null], [500, null, 100], [200, null, null], [304, null, null],
];
const credits = creditCases.map(([httpStatus, creditsUsed, creditBalance]) => ({
  httpStatus, bodyCreditsUsed: creditsUsed, bodyBalance: creditBalance,
  result: resolveOfapiCreditSpend({ httpStatus, meta: { creditsUsed, creditBalance } }),
}));
console.log(JSON.stringify({
  scope: 'Local executable source check; documentation fixtures and synthetic pagination; no live incidence claim',
  identities, cursors, credits,
}, null, 2));
