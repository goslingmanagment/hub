// The verdict of a finished series, from its files alone — and from each
// run's own file first. series.ts writes them; it does not judge: a runner
// that died, a scenario that did not gather its runs, a summary that says
// "passed" over a run file that says otherwise, must not pass unnoticed.
//
//   node --no-warnings stand/runner/verify.ts <series dir>
//
// - every scenario of the series is one the stand knows, has its record, and
//   the record names it;
// - every run the record counts has its own file, once: a run number counted
//   twice, or a run file the record does not name, is a problem;
// - each run's verdict is worked out again from the checks in its file
//   (verdict.ts — the rule series.ts used): every common check C1…C8 must be
//   there; an ordinary run passes with no violation in any check; a control
//   passes when each check it exists for shows each of its violations and no
//   other check shows any. The file's own `ok` and `violations`, and the
//   record's, must say the same;
// - a run counts as not set up (replaced, not counted) only if its file says
//   so and holds the setup failure;
// - a scenario that ran has exactly the asked number of counted runs, all
//   passed, and their moments are not all the same;
// - a skipped scenario is one that waits for a PR, and says which; skips are
//   listed, never counted as passed.
//
// Exit 0: PASSED. Exit 1: NOT PASSED, with every problem.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SCENARIOS } from "./scenarios.ts";
import type { RunRecord, ScenarioRecord, SeriesRecord } from "./series.ts";
import { judge, SETUP_FAILURE, violationsOf, type Checks } from "./verdict.ts";

export interface Verdict {
  problems: string[];
  skipped: Array<{ scenario: string; why: string }>;
  scenarios: number;
  validRuns: number;
  notCounted: number;
  /** Scenarios the stand has that this series did not run. */
  notInSeries: string[];
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

function read<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function verifySeries(dir: string): Verdict {
  const verdict: Verdict = { problems: [], skipped: [], scenarios: 0, validRuns: 0, notCounted: 0, notInSeries: [] };
  const problem = (text: string) => verdict.problems.push(text);
  const series = read<SeriesRecord>(join(dir, "series.json"));
  if (series === null) {
    problem(`no readable series.json in ${dir}`);
    return verdict;
  }
  if (series.finishedWall === null) problem("the series did not finish (series.json has no finishedWall)");
  verdict.notInSeries = SCENARIOS.map((scenario) => scenario.name).filter((name) => !series.scenarios.includes(name));
  for (const name of series.scenarios) {
    const known = SCENARIOS.find((scenario) => scenario.name === name);
    if (!known) {
      problem(`${name}: not a scenario of the stand`);
      continue;
    }
    const record = read<ScenarioRecord>(join(dir, `${name}.json`));
    if (record === null) {
      problem(`${name}: no record`);
      continue;
    }
    if (record.scenario !== name) {
      problem(`${name}: its record holds ${String(record.scenario)}`);
      continue;
    }
    const control = known.control ?? null;
    if (JSON.stringify(record.control ?? null) !== JSON.stringify(control)) problem(`${name}: the record's control is not the scenario's`);
    if (record.skipped !== null) {
      if (known.needs.length === 0) problem(`${name}: skipped, and it waits for nothing`);
      else verdict.skipped.push({ scenario: name, why: record.skipped });
      continue;
    }
    verdict.scenarios += 1;
    if (record.asked !== series.runs) problem(`${name}: ${record.asked} runs asked, the series asks ${series.runs}`);

    const numbers = record.runs.map((run) => run.run);
    const twice = [...new Set(numbers.filter((run, index) => numbers.indexOf(run) !== index))];
    if (twice.length > 0) problem(`${name}: run ${twice.join(", ")} counted more than once`);
    let onDisk: number[] = [];
    try {
      onDisk = readdirSync(join(dir, name)).map((file) => Number(/^run-(\d+)\.json$/.exec(file)?.[1] ?? NaN)).filter((run) => Number.isInteger(run));
    } catch {
      // no directory: every run file is missing, said below
    }
    const unnamed = onDisk.filter((run) => !numbers.includes(run));
    if (unnamed.length > 0) problem(`${name}: run file(s) ${unnamed.join(", ")} the record does not name`);

    let counted = 0;
    let passed = 0;
    const moments = new Set<number>();
    for (const run of record.runs.filter((entry, index) => numbers.indexOf(entry.run) === index)) {
      const label = `${name} run ${run.run}`;
      const file = existsSync(join(dir, name, `run-${run.run}.json`)) ? read<RunRecord>(join(dir, name, `run-${run.run}.json`)) : null;
      if (file === null) {
        problem(`${label}: no readable run file`);
        continue;
      }
      if (file.scenario !== name || file.run !== run.run) {
        problem(`${label}: its file is ${String(file.scenario)} run ${String(file.run)}`);
        continue;
      }
      if (!Number.isInteger(file.seed) || !Number.isFinite(file.momentMs)) problem(`${label}: no seed or moment`);
      if (file.seed !== run.seed || file.momentMs !== run.momentMs) problem(`${label}: the record's seed or moment is not the file's`);
      const checks: Checks = file.checks !== null && typeof file.checks === "object" ? file.checks : {};
      const violations = violationsOf(checks);
      // Not set up — replaced, not counted — only by its own file's word and
      // with the setup failure in it.
      const notSetUp = file.invalid === true;
      if (notSetUp !== (run.invalid === true)) problem(`${label}: the record says ${run.invalid ? "not set up" : "counted"}, its file says ${notSetUp ? "not set up" : "counted"}`);
      if (notSetUp) {
        if (!Array.isArray(checks[SETUP_FAILURE]) || checks[SETUP_FAILURE].length === 0) problem(`${label}: marked not set up without a setup failure`);
        verdict.notCounted += 1;
        continue;
      }
      counted += 1;
      moments.add(file.momentMs);
      // A control's run passes only with the violations it planted, as its
      // own file names them.
      const derived = judge(checks, control, Array.isArray(file.planted) ? file.planted : null);
      if (derived.ok) passed += 1;
      else problem(`${label}: ${control ? "the control did not do what it exists for" : "failed"} — ${derived.why[0] ?? "?"}${derived.why.length > 1 ? ` (+${derived.why.length - 1} more)` : ""}`);
      if (file.ok !== derived.ok) problem(`${label}: its file says ok=${String(file.ok)}, its checks say ${String(derived.ok)}`);
      if (run.ok !== derived.ok) problem(`${label}: the record says ok=${String(run.ok)}, the run's checks say ${String(derived.ok)}`);
      if (!sameList(file.violations, violations)) problem(`${label}: its file's violations are not its checks'`);
      if (!sameList(run.violations, violations)) problem(`${label}: the record's violations are not the run file's`);
    }
    verdict.validRuns += counted;
    if (counted !== series.runs) problem(`${name}: ${counted} counted runs of ${series.runs}`);
    if (record.valid !== counted || record.passed !== passed || record.failed !== counted - passed) problem(`${name}: the record counts ${record.valid} valid, ${record.passed} passed, ${record.failed} failed; its run files give ${counted}, ${passed}, ${counted - passed}`);
    const [min, max] = known.moment;
    if (counted >= 3 && moments.size === 1 && max > min) problem(`${name}: every run had the same moment (${String([...moments][0])} ms) — not random`);
  }
  return verdict;
}

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error("verify.ts <series dir>");
    process.exit(2);
  }
  const verdict = verifySeries(dir);
  console.log(`${verdict.scenarios} scenarios ran, ${verdict.validRuns} counted runs, ${verdict.notCounted} not counted`);
  for (const skip of verdict.skipped) console.log(`SKIPPED ${skip.scenario}: ${skip.why}`);
  if (verdict.notInSeries.length > 0) console.log(`NOT IN THIS SERIES: ${verdict.notInSeries.join(", ")}`);
  for (const problem of verdict.problems) console.log(`PROBLEM ${problem}`);
  console.log(verdict.problems.length === 0 ? "PASSED" : `NOT PASSED: ${verdict.problems.length} problem(s)`);
  process.exit(verdict.problems.length === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith("verify.ts")) main();
