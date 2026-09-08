// Run from the Hub root:
// node --import tsx/esm investigations/fansly-events-cross-check-2026-09-07/evidence/fan-earnings-aba-probe.mjs
// Offline only: the real pure canonicalizer plus a SIMULATED first-key-wins
// ledger/projected value. No database, network, session, or financial records.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourcePath = 'apps/runtime/src/services/canonicalize/sync-pull.ts';
const sourceRevision = 'dcbba081d3bfbbf19a5e3ccf0ea3d77646d5076d';
const sourceUrl = new URL(`../../../${sourcePath}`, import.meta.url);
const localSource = await readFile(sourceUrl, 'utf8');
const pinned = spawnSync('git', ['show', `${sourceRevision}:${sourcePath}`], {
  cwd: repositoryRoot,
  encoding: 'utf8',
});
assert.equal(pinned.status, 0, 'Pinned source revision must be available locally');
assert.equal(localSource, pinned.stdout,
  'Local canonicalizer differs from the reviewed revision; do not reuse this result');

const { canonicalizeSyncPullObservation } = await import(sourceUrl.href);
const seenKeys = new Set();
let simulatedProjectedNetMills = null;
const rows = [];

// Fictional fan and amounts. A, B, A are three DISTINCT observations in time.
for (const [index, netMills] of [100000, 110000, 100000].entries()) {
  const events = canonicalizeSyncPullObservation({
    id: index + 1,
    accountId: 1,
    platform: 'fansly',
    kind: 'fan_earnings_stats',
    receivedAt: new Date(Date.UTC(2026, 8, 7, 0, index)),
    observedAt: null,
    payload: [{
      correlationAccountId: 'fan-fixture',
      type: 1,
      totalGross: netMills,
      totalNet: netMills,
    }],
  });
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, 'fan.earnings_observed');

  // Simulation, NOT an invocation of appendDomainEvents/Postgres/projector.
  // The actual canonicalizer above supplies each key and monetary payload.
  const deduped = seenKeys.has(event.dedupKey);
  if (!deduped) {
    seenKeys.add(event.dedupKey);
    simulatedProjectedNetMills = event.data.netMills;
  }
  rows.push({
    observation: index + 1,
    inputNetMills: netMills,
    actualCanonicalKey: event.dedupKey,
    simulatedDeduped: deduped,
    simulatedProjectedNetMills,
  });
}

assert.equal(rows[0].actualCanonicalKey, rows[2].actualCanonicalKey);
assert.notEqual(rows[0].actualCanonicalKey, rows[1].actualCanonicalKey);
assert.equal(rows[2].simulatedDeduped, true);
assert.equal(simulatedProjectedNetMills, 110000);
assert.notEqual(simulatedProjectedNetMills, rows[2].inputNetMills);

console.log(JSON.stringify({
  kind: 'offline_synthetic_canonicalizer_probe',
  sourceRevision,
  sourcePath,
  sourceSha256: createHash('sha256').update(localSource).digest('hex'),
  sourceMatchesPinnedRevision: true,
  actualExecution: 'canonicalizeSyncPullObservation for three fictional snapshots',
  simulatedExecution: 'first-key-wins ledger and monotonic-time snapshot application',
  databaseOrNetworkAccess: false,
  productionIncidentEstablished: false,
  rows,
  conclusion: 'Distinct third observation A reuses the first A key; a first-key-wins ledger drops it and retains B.',
}, null, 2));
