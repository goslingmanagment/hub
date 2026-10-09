import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceRoot = process.argv[2];
const write = process.argv.includes('--write');
assert(evidenceRoot, 'Usage: node verify-evidence.mjs <private-evidence-root> [--write]');
const outputRoot = dirname(fileURLToPath(import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const corePaths = [
  'summary', 'series', 'media/top', 'media', 'media/benchmarks', 'media/shown',
  'geo', 'activehours', 'tags', 'posts', 'fans/top', 'fans',
].map((path) => `/api/v1/account/stats/${path}`);
const sourceNames = [
  'main.2e6b96097a4bb73b.js', 'runtime.f973459b9af62fd8.js',
  '381.3db514b57dd6c2e7.js', '729.d14b4c5910bebc74.js',
];
const sources = [];
for (const name of sourceNames) {
  const bytes = await readFile(join(evidenceRoot, 'bundles', name));
  sources.push({ name, url: `https://fansly.com/${name}`, bytes: bytes.length, sha256: sha256(bytes) });
}

const queryValuesAllowed = new Set([
  'after', 'before', 'source', 'hours', 'end', 'kind', 'timezoneOffsetMinutes',
  'granularity', 'family', 'mediaType', 'orderBy', 'limit', 'offset', 'ngsw-bypass',
]);
function publicQuery(params) {
  return Object.fromEntries([...params].map(([key, value]) => {
    if (queryValuesAllowed.has(key)) return [key, value];
    if (value === '' || value === '0') return [key, value];
    const parts = value.split(',');
    return [key, { count: parts.length, references: parts.map((id) => `id:${sha256(id).slice(0,12)}`) }];
  }));
}
function pointerPart(key) {
  return (/^\d{15,}$/.test(key) ? '{id}' : key).replaceAll('~', '~0').replaceAll('/', '~1');
}
function collectShape(value, path, fields, evidenceId) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const field = fields.get(path) ?? { types: new Set(), evidence: new Set() };
  field.types.add(type);
  field.evidence.add(evidenceId);
  fields.set(path, field);
  if (type === 'array') {
    field.minLength = Math.min(field.minLength ?? Infinity, value.length);
    field.maxLength = Math.max(field.maxLength ?? 0, value.length);
    for (const item of value) collectShape(item, `${path}/*`, fields, evidenceId);
  } else if (type === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectShape(item, `${path}/${pointerPart(key)}`, fields, evidenceId);
    }
  }
}
function responseMetadata(body) {
  const response = body?.response;
  if (!response || typeof response !== 'object') return {};
  const result = {};
  for (const key of [
    'afterBucket', 'beforeBucket', 'previousAfterBucket', 'previousBeforeBucket',
    'dataSince', 'endHour', 'hours', 'source', 'kind', 'mediaType',
    'timezoneOffsetMinutes', 'granularity', 'family', 'bucketField', 'hasMore',
  ]) {
    if (response[key] !== undefined) result[key] = response[key];
  }
  for (const key of ['rows', 'offers', 'data', 'levels', 'buckets', 'views', 'imageViews', 'profileRows', 'tagSeries', 'media', 'likes']) {
    if (Array.isArray(response[key])) result[`${key}Count`] = response[key].length;
  }
  return result;
}

const variants = new Map();
const schemaFields = new Map();
let rawRecords = 0;
let inferredMethodRecords = 0;
for (const name of (await readdir(join(evidenceRoot, 'network'))).sort()) {
  if (!name.endsWith('.json')) continue;
  const bytes = await readFile(join(evidenceRoot, 'network', name));
  const record = JSON.parse(bytes);
  if (!record.url || !record.body) continue;
  assert(record.method === undefined || record.method === 'GET', `Non-GET record in ${name}`);
  const methodEvidence = record.method === undefined
    ? 'inferred_from_pinned_get_wrapper'
    : name.startsWith('probe-') ? 'explicit_get_probe' : 'capture_record';
  if (record.method === undefined) inferredMethodRecords++;
  const url = new URL(record.url);
  assert(['apiv3.fansly.com', 'apip.fansly.com'].includes(url.hostname), `Unexpected host in ${name}`);
  assert(!record.headers?.authorization, `Secret request header in ${name}`);
  const bodySha256 = sha256(JSON.stringify(record.body));
  const identity = `${record.method ?? 'GET'}\0${url.href}\0${record.status}\0${bodySha256}`;
  const evidenceId = `response-${sha256(identity).slice(0,16)}`;
  let variant = variants.get(evidenceId);
  if (!variant) {
    variant = {
      id: evidenceId,
      method: record.method ?? 'GET',
      path: url.pathname,
      query: publicQuery(url.searchParams),
      status: record.status,
      success: record.body.success === true,
      bodySha256,
      response: responseMetadata(record.body),
      artifacts: [],
    };
    variants.set(evidenceId, variant);
    const fields = schemaFields.get(url.pathname) ?? new Map();
    collectShape(record.body, '', fields, evidenceId);
    schemaFields.set(url.pathname, fields);
  }
  variant.artifacts.push({
    file: name, label: record.label, observedAt: record.observedAt,
    methodEvidence,
    ...(record.requestId ? { requestId: record.requestId } : {}),
    sha256: sha256(bytes),
  });
  rawRecords++;
}
const records = [...variants.values()].sort((a,b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
const coreCoverage = corePaths.map((path) => ({
  path,
  successfulVariants: records.filter((r) => r.path === path && r.status === 200 && r.success).length,
}));
assert(coreCoverage.every((row) => row.successfulVariants > 0), 'A core endpoint has no successful response');
const schemas = Object.fromEntries([...schemaFields].sort(([a],[b]) => a.localeCompare(b)).map(([path, fields]) => [path,
  Object.fromEntries([...fields].sort(([a],[b]) => a.localeCompare(b)).map(([pointer, value]) => [pointer || '/', {
    types: [...value.types].sort(),
    ...(value.minLength !== undefined ? { observedArrayLength: { min: value.minLength, max: value.maxLength } } : {}),
    evidence: [...value.evidence].sort(),
  }])),
]));
const csvExports = [];
for (const name of ['statements-export.csv', 'earnings-export.csv']) {
  const bytes = await readFile(join(evidenceRoot, 'network', name));
  const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  csvExports.push({ name, sha256: sha256(bytes), header: lines[0].split(','), dataRows: lines.length - 1 });
}
const uiArtifacts = [];
for (const subdir of ['network', 'screenshots']) {
  for (const name of (await readdir(join(evidenceRoot, subdir))).sort()) {
    if (!(name.endsWith('-ui.txt') || name.endsWith('.png'))) continue;
    const bytes = await readFile(join(evidenceRoot, subdir, name));
    uiArtifacts.push({ file: `${subdir}/${name}`, bytes: bytes.length, sha256: sha256(bytes) });
  }
}
const outputs = {
  'sources.json': { schemaVersion: 1, sources },
  'verification.json': {
    schemaVersion: 1,
    scope: 'One authorized creator session; observed response variants, not a universal server specification',
    rawRecords,
    inferredMethodRecords,
    methodEvidenceNote: 'Missing methods in early response-only captures are inferred from the pinned GET wrappers, not independently observed wire-method evidence. Later capture_record methods and explicit_get_probe executions are distinguished per artifact.',
    uniqueResponseVariants: records.length,
    coreCoverage,
    csvExports,
    uiArtifacts,
    records,
  },
  'response-shapes.json': {
    schemaVersion: 1,
    semantics: 'Observed union of JSON pointer field types; * denotes array items. Missing fields and empty arrays are not proof of a closed schema. Array lengths are observations, not server limits.',
    endpoints: schemas,
  },
};
for (const [name, data] of Object.entries(outputs)) {
  const rendered = `${JSON.stringify(data, null, 2)}\n`;
  assert(!/https?:[^\s"]+[?&](?:Signature|Key-Pair-Id|Expires)=/i.test(rendered), `Signed URL in ${name}`);
  if (write) await writeFile(join(outputRoot, name), rendered);
  else assert.equal(await readFile(join(outputRoot, name), 'utf8'), rendered, `${name} differs from private evidence; rerun with --write only after reviewing new captures`);
}
console.log(JSON.stringify({ mode: write ? 'generated' : 'verified', sources: sources.length, coreEndpoints: coreCoverage.length, rawRecords, uniqueResponseVariants: records.length, schemaEndpoints: schemaFields.size, csvExports: csvExports.length, uiArtifacts: uiArtifacts.length }));
