// The verdict of a batch5 series, read from the result files themselves.
//   node stand/runner/verify-series.ts <results dir> [log prefix, default "last-"]
// batch5.sh only records what the runner printed; it does not judge (Astra
// review 5: a runner that exits 1, or dies without a summary, must not pass
// unnoticed). Here every scenario of the series must have its asked number
// of valid runs, none of them failed; a control without the gate must show
// the violation it exists for in every run.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** batch5.sh, parts A–D: scenario → valid runs asked. */
const SERIES: Record<string, Record<string, number>> = {
  A: {
    "ws-contexts": 50, "ws-refused": 50, "ws-blank-iframe": 50, "ws-h2": 50, "ws-sw-restart": 50,
    "ws-tamper": 20, "ws-handshake-outcome": 20, "ws-frames": 20, "rules": 20, "rules-bypass": 20, "ws-detect": 5,
    "site-redirect": 20, "site-redirect-xhr": 20, "hub-redirect": 20, "xhr-parity": 10,
    "body-capture": 20, "body-burst": 5, "hub-slow-body": 10, "hub-gc-body": 5,
  },
  B: {
    "loss-operator-kill": 50, "loss-operator-kill-inflight": 50, "loss-operator-hang": 50, "loss-holder-kill": 50,
    "loss-holder-kill-inflight": 50, "loss-cdp-break": 50, "loss-cdp-break-inflight": 50, "loss-cdp-drop": 50,
    "loss-chrome-kill": 50, "loss-planned-stop": 50, "engine-loss-halt": 20,
  },
  C: {
    "loss-cdp-break-late": 50, "loss-cdp-break-late-inflight": 50, "loss-holder-kill-late": 50, "loss-open-window": 50,
    "loss-open-window-late": 50, "loss-responding": 50, "loss-responding-late": 50, "loss-new-connection": 50,
    "loss-new-connection-late": 50, "loss-cdp-break-late-nogate": 10,
  },
  D: {
    "smoke": 50, "retry-refused": 50, "retry-goaway": 50, "retry-reset": 50,
    "retry-refused-rtt0": 20, "retry-goaway-rtt0": 20, "retry-reset-rtt0": 20,
    "retry-post": 20, "retry-post-slowcdp": 20, "retry-post-large": 20, "retry-post-large-nogate": 10, "post-too-large": 10,
    "idle-ping": 10, "idle-post": 10, "send-time": 10, "slow-body-limit": 10, "slow-body-limit-capture": 5,
    "expiry-site-socks": 50, "expiry-site-tcp": 50, "expiry-hub-socks": 50,
  },
};

/** Controls run without the gate: every run must show this violation, and
 *  an unrelated failure does not count for it. */
const CONTROLS: Record<string, string> = {
  "loss-cdp-break-late-nogate": "arrived without any admission",
  "retry-post-large-nogate": "arrived again under one admission",
};

interface Run {
  run: number;
  ok: boolean;
  invalid: boolean;
  violations: string[];
}

interface Artifact {
  scenario: string;
  asked: number;
  short: number;
  results: Run[];
}

function main(): void {
  const dir = process.argv[2] ?? "/stand/results";
  const prefix = process.argv[3] ?? "last-";
  const logs = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".log"));
  const summaries = new Map<string, Array<{ file: string }>>();
  const finished = new Set<string>();
  for (const log of logs) {
    const text = readFileSync(join(dir, log), "utf8");
    const part = /-([A-D])-\d{8}T\d{6}Z\.log$/.exec(log)?.[1];
    if (part && /^=== done /m.test(text)) finished.add(part);
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      const summary = JSON.parse(line) as { scenario: string; file: string };
      summaries.set(summary.scenario, [...(summaries.get(summary.scenario) ?? []), summary]);
    }
  }

  const problems: string[] = [];
  let validRuns = 0;
  let notCounted = 0;
  for (const [part, scenarios] of Object.entries(SERIES)) {
    if (!finished.has(part)) problems.push(`part ${part}: the driver did not finish`);
    for (const [name, asked] of Object.entries(scenarios)) {
      const found = summaries.get(name);
      if (!found) {
        problems.push(`${name}: no result`);
        continue;
      }
      if (found.length > 1) problems.push(`${name}: ${found.length} results in one series`);
      let artifact: Artifact;
      try {
        artifact = JSON.parse(readFileSync(join(dir, basename(found.at(-1)!.file)), "utf8")) as Artifact;
      } catch (error) {
        problems.push(`${name}: result file unreadable (${(error as Error).message})`);
        continue;
      }
      const valid = artifact.results.filter((run) => !run.invalid);
      const invalid = artifact.results.filter((run) => run.invalid);
      validRuns += valid.length;
      notCounted += invalid.length;
      if (artifact.asked !== asked) problems.push(`${name}: ${artifact.asked} runs asked, the series needs ${asked}`);
      if (valid.length !== asked || artifact.short !== 0) problems.push(`${name}: ${valid.length} valid runs of ${asked}`);
      const control = CONTROLS[name];
      const wrong = control
        ? valid.filter((run) => run.ok || !run.violations.some((violation) => violation.includes(control)) || run.violations.some((violation) => violation.startsWith("error after the fault")))
        : valid.filter((run) => !run.ok || run.violations.length > 0);
      if (wrong.length > 0) problems.push(`${name}: ${control ? "control runs without the intended violation" : "failed runs"}: ${wrong.map((run) => run.run).join(", ")}`);
      for (const run of invalid) console.log(`not counted: ${name} run ${run.run}: ${run.violations.map((violation) => violation.split("\n")[0]).join("; ")}`);
    }
  }
  const expected = new Set(Object.values(SERIES).flatMap((scenarios) => Object.keys(scenarios)));
  for (const name of summaries.keys()) if (!expected.has(name)) console.log(`outside the series: ${name}`);

  console.log(`${expected.size} scenarios, ${validRuns} valid runs, ${notCounted} not counted`);
  for (const problem of problems) console.log(`PROBLEM ${problem}`);
  console.log(problems.length === 0 ? "PASSED" : `NOT PASSED: ${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main();
