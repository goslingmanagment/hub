#!/usr/bin/env node

// Deploy gate H-1c: a hub candidate keeps serving every client SDK the running
// hub registers.
//
// Released clients ship a vendored @kernel/sdk whose contract hash must stay
// in health.compatibleClientSdks, and whose frozen build the compat suite
// (tests/client-sdk-compat.integration.test.ts) must keep running. Both come
// from apps/runtime/src/services/client-sdk-registry.ts. A candidate that
// loses a registry row would deploy fine and break a client already in the
// field, so scripts/deploy-production.sh asks the running image and the
// candidate for `startup.js print-compatible-client-sdks` and hands both
// lines here:
//
//   node scripts/verify-client-sdk-retention.mjs --candidate <line>
//     [--running <line>] [--drop <sha256>]...
//
// A line is {"own":"<sha256>","registered":[contract hashes],"bundles":[build
// digests]} (services/compatible-client-sdks.ts); other keys are ignored. The
// gate refuses a candidate whose `registered` or `bundles` lacks a value the
// running line has, unless the owner named that exact value with the deploy's
// repeatable --drop-client-sdk <sha256> (passed here as --drop). Both lists
// count: a build can be dropped while another build keeps its contract hash
// listed, and the line does not say which build carries which hash, so each
// dropped value is named on its own. Without --running (no running image, or
// one that predates the print mode) the candidate line is only validated.
//
// Exit 0: kept, or every drop owner-approved. Exit 1: refused. Exit 2: bad input.

const SHA256_RE = /^[0-9a-f]{64}$/;
const LISTS = [
  ["registered", "contract hash"],
  ["bundles", "registry build"],
];

class GateInputError extends Error {}

function parseArgs(argv) {
  let candidate;
  let running;
  const drops = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new GateInputError(`missing value for ${flag}`);
    if (flag === "--candidate" && candidate === undefined) {
      candidate = value;
    } else if (flag === "--running" && running === undefined) {
      running = value;
    } else if (flag === "--drop") {
      if (!SHA256_RE.test(value)) throw new GateInputError(`--drop takes a lowercase sha256, got ${JSON.stringify(value)}`);
      drops.add(value);
    } else {
      throw new GateInputError(`unexpected argument ${JSON.stringify(flag)}`);
    }
  }
  if (candidate === undefined) throw new GateInputError("--candidate is required");
  return { candidate, running, drops };
}

function parseLine(label, raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new GateInputError(`the ${label} did not print one JSON line: ${JSON.stringify(raw.slice(0, 200))}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GateInputError(`the ${label} printed a non-object line`);
  }
  if (typeof value.own !== "string" || !SHA256_RE.test(value.own)) {
    throw new GateInputError(`the ${label} line has no sha256 "own"`);
  }
  const line = {};
  for (const [key] of LISTS) {
    const list = value[key];
    if (!Array.isArray(list) || !list.every((item) => typeof item === "string" && SHA256_RE.test(item))) {
      throw new GateInputError(`the ${label} line's "${key}" is not a list of sha256 values`);
    }
    line[key] = new Set(list);
  }
  return line;
}

function main(argv) {
  const args = parseArgs(argv);
  const candidate = parseLine("candidate", args.candidate);
  const size = `${candidate.registered.size} contract hash(es), ${candidate.bundles.size} build(s)`;
  if (args.running === undefined) {
    for (const drop of [...args.drops].sort()) {
      console.log(`--drop-client-sdk ${drop} ignored: no running image line to compare`);
    }
    console.log(`Candidate registers ${size}; no running image line to compare`);
    return 0;
  }

  const running = parseLine("running image", args.running);
  const dropped = [];
  for (const [key, kind] of LISTS) {
    for (const value of [...running[key]].sort()) {
      if (!candidate[key].has(value)) dropped.push({ kind, value });
    }
  }
  const droppedValues = new Set(dropped.map((item) => item.value));
  for (const drop of [...args.drops].sort()) {
    if (!droppedValues.has(drop)) console.log(`--drop-client-sdk ${drop} ignored: the candidate does not drop it`);
  }
  for (const item of dropped) {
    if (args.drops.has(item.value)) console.log(`Owner-approved drop of ${item.kind} ${item.value}`);
  }

  const refused = dropped.filter((item) => !args.drops.has(item.value));
  if (refused.length > 0) {
    console.error("Candidate drops client SDKs the running hub registers:");
    for (const item of refused) console.error(`  ${item.kind} ${item.value}`);
    console.error(
      "Released clients may still run them. Keep their rows in apps/runtime/src/services/client-sdk-registry.ts, "
        + "or, to retire them on purpose, rerun the deploy with --drop-client-sdk <sha256> once per value above.",
    );
    return 1;
  }
  console.log(`Candidate keeps every client SDK the running hub registers (${size})`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof GateInputError)) throw error;
  console.error(`verify-client-sdk-retention: ${error.message}`);
  process.exitCode = 2;
}
