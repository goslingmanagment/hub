// The verdict of a batch5 series, read from the result files themselves.
//   node stand/runner/verify-series.ts <results dir> [series name, default "last"]
// batch5.sh only records what the runner printed; it does not judge (Astra
// review 5: a runner that exits 1, or dies without a summary, must not pass
// unnoticed). Here every scenario of the series must have its asked number
// of valid runs, none of them failed; a control without the gate must show
// the violation it exists for in every run.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** batch5.sh, its parts: scenario → valid runs asked. */
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
    "retry-refused-nogate": 10, "retry-goaway-nogate": 10, "retry-reset-nogate": 10,
    "expiry-site-socks-nogate": 10, "expiry-site-tcp-nogate": 10, "expiry-hub-socks-nogate": 10,
  },
  E: {
    "expiry-site-tls": 50, "expiry-hub-tls": 50, "expiry-hub-page-stop": 50,
    "expiry-site-tls-nogate": 10, "expiry-hub-page-stop-nogate": 10,
    "next-admission-expired": 20, "next-admission-slow": 20, "stale-after-limit": 10,
    "cancel-next-admission": 20, "cancel-next-admission-pending": 20,
    "document-replaced-site": 10, "document-replaced-site-simple": 10, "document-replaced-hub": 10,
    "document-replaced-site-frame": 10, "document-replaced-hub-frame": 10,
  },
  F: {
    "expiry-site-reused": 50, "expiry-hub-reused": 50, "expiry-site-operator-stop": 50,
    "expiry-site-late-grant": 50, "expiry-hub-late-grant": 50, "retry-408": 50,
    "expiry-site-reused-nogate": 10, "expiry-site-operator-stop-nogate": 10, "retry-408-nogate": 10,
    "ws-expiry-socks": 50, "ws-expiry-tls": 50,
  },
  // The replies of CDP commands reach the operator 100 ms after the events.
  G: {
    "smoke": 20, "body-capture": 20, "hub-redirect": 20, "site-redirect": 20, "site-redirect-xhr": 20,
    "ws-contexts": 10, "xhr-parity": 10, "retry-post": 10, "loss-cdp-break-late-inflight": 20,
  },
};

/** Parts run with STAND_CDP_REPLY_DELAY_MS. */
const LATE_REPLIES_MS: Record<string, number> = { G: 100 };

/** Controls run without the gate: every run must show this violation, and
 *  an unrelated failure does not count for it. */
const CONTROLS: Record<string, string> = {
  "loss-cdp-break-late-nogate": "arrived without any admission",
  "retry-refused-nogate": "Chrome repeated the request",
  "retry-goaway-nogate": "Chrome repeated the request",
  "retry-reset-nogate": "Chrome repeated the request",
  "retry-post-large-nogate": "arrived again under one admission",
  "retry-408-nogate": "arrived again under one admission",
  "expiry-site-socks-nogate": "arrived outside its admission window",
  "expiry-site-tcp-nogate": "arrived outside its admission window",
  "expiry-hub-socks-nogate": "arrived outside its admission window",
  "expiry-site-tls-nogate": "arrived outside its admission window",
  "expiry-site-reused-nogate": "arrived outside its admission window",
  "expiry-site-operator-stop-nogate": "arrived outside its admission window",
  "expiry-hub-page-stop-nogate": "arrived outside its admission window",
};

interface Run {
  run: number;
  ok: boolean;
  invalid: boolean;
  violations: string[];
  stoppedBefore?: string;
}

interface Artifact {
  scenario: string;
  asked: number;
  short: number;
  cdpReplyDelayMs?: number;
  results: Run[];
}

function main(): void {
  const dir = process.argv[2] ?? "/stand/results";
  const series = process.argv[3] ?? "last";
  const logs = readdirSync(dir).filter((name) => name.startsWith(`${series}-`) && name.endsWith(".log"));
  const problems: string[] = [];
  let scenarios = 0;
  let validRuns = 0;
  let notCounted = 0;
  for (const [part, expected] of Object.entries(SERIES)) {
    const mine = logs.filter((name) => new RegExp(`-${part}-\\d{8}T\\d{6}Z\\.log$`).test(name));
    if (mine.length !== 1) {
      problems.push(`part ${part}: ${mine.length} logs`);
      continue;
    }
    const text = readFileSync(join(dir, mine[0]!), "utf8");
    if (!/^=== done /m.test(text)) problems.push(`part ${part}: the driver did not finish`);
    const files = new Map<string, string[]>();
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      const summary = JSON.parse(line) as { scenario: string; file: string };
      files.set(summary.scenario, [...(files.get(summary.scenario) ?? []), summary.file]);
    }
    for (const name of files.keys()) if (!(name in expected)) problems.push(`${part} ${name}: not in the series`);
    for (const [name, asked] of Object.entries(expected)) {
      scenarios += 1;
      const label = `${part} ${name}`;
      const found = files.get(name);
      if (!found) {
        problems.push(`${label}: no result`);
        continue;
      }
      if (found.length > 1) problems.push(`${label}: ${found.length} results`);
      let artifact: Artifact;
      try {
        artifact = JSON.parse(readFileSync(join(dir, basename(found.at(-1)!)), "utf8")) as Artifact;
      } catch (error) {
        problems.push(`${label}: result file unreadable (${(error as Error).message})`);
        continue;
      }
      // The log names the file; the file must be this scenario's own
      // (Astra review 6, finding 4).
      if (artifact.scenario !== name) {
        problems.push(`${label}: its result file holds ${String(artifact.scenario)}`);
        continue;
      }
      const valid = artifact.results.filter((run) => !run.invalid);
      const invalid = artifact.results.filter((run) => run.invalid);
      validRuns += valid.length;
      notCounted += invalid.length;
      if (artifact.asked !== asked) problems.push(`${label}: ${artifact.asked} runs asked, the series needs ${asked}`);
      if (valid.length !== asked || artifact.short !== 0) problems.push(`${label}: ${valid.length} valid runs of ${asked}`);
      if ((artifact.cdpReplyDelayMs ?? 0) !== (LATE_REPLIES_MS[part] ?? 0)) problems.push(`${label}: ran with CDP replies ${artifact.cdpReplyDelayMs ?? 0} ms late, the part needs ${LATE_REPLIES_MS[part] ?? 0}`);
      const control = CONTROLS[name];
      const wrong = control
        ? valid.filter((run) => run.ok || !run.violations.some((violation) => violation.includes(control)) || run.violations.some((violation) => violation.startsWith("error after the fault")))
        : valid.filter((run) => !run.ok || run.violations.length > 0);
      if (wrong.length > 0) problems.push(`${label}: ${control ? "control runs without the intended violation" : "failed runs"}: ${wrong.map((run) => run.run).join(", ")}`);
      for (const run of invalid) console.log(`not counted: ${label} run ${run.run}: ${run.violations.map((violation) => violation.split("\n")[0]).join("; ")}`);
      for (const run of artifact.results) if (run.stoppedBefore) console.log(`began on a stopped page: ${label} run ${run.run}: ${run.stoppedBefore}`);
    }
  }

  console.log(`${scenarios} scenarios, ${validRuns} valid runs, ${notCounted} not counted`);
  for (const problem of problems) console.log(`PROBLEM ${problem}`);
  console.log(problems.length === 0 ? "PASSED" : `NOT PASSED: ${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}

main();
