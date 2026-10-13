// The verdict of a finished series, from its files alone (series.ts writes
// them; it does not judge — a runner that died, or a scenario that did not
// gather its runs, must not pass unnoticed):
//
//   node --no-warnings stand/runner/verify.ts <series dir>
//
// - every scenario of the series has its record, and every record names its
//   own scenario;
// - a scenario that ran has exactly the asked number of valid runs, none
//   failed; each run's file is there, with its seed and its moment, and the
//   moments are not all the same (the fault came at random moments);
// - a control scenario shows, in every valid run, each violation it exists
//   for — otherwise the criteria could not see what it causes;
// - a skipped scenario says why (the PR it waits for); skips are listed,
//   never counted as passed.
//
// Exit 0: PASSED. Exit 1: NOT PASSED, with every problem.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RunRecord, ScenarioRecord, SeriesRecord } from "./series.ts";

export interface Verdict {
  problems: string[];
  skipped: Array<{ scenario: string; why: string }>;
  scenarios: number;
  validRuns: number;
  notCounted: number;
}

export function verifySeries(dir: string): Verdict {
  const verdict: Verdict = { problems: [], skipped: [], scenarios: 0, validRuns: 0, notCounted: 0 };
  const problem = (text: string) => verdict.problems.push(text);
  const seriesFile = join(dir, "series.json");
  if (!existsSync(seriesFile)) {
    problem(`no series.json in ${dir}`);
    return verdict;
  }
  const series = JSON.parse(readFileSync(seriesFile, "utf8")) as SeriesRecord;
  if (series.finishedWall === null) problem("the series did not finish (series.json has no finishedWall)");
  for (const name of series.scenarios) {
    const file = join(dir, `${name}.json`);
    if (!existsSync(file)) {
      problem(`${name}: no record`);
      continue;
    }
    const record = JSON.parse(readFileSync(file, "utf8")) as ScenarioRecord;
    if (record.scenario !== name) {
      problem(`${name}: its record holds ${String(record.scenario)}`);
      continue;
    }
    if (record.skipped !== null) {
      verdict.skipped.push({ scenario: name, why: record.skipped });
      continue;
    }
    verdict.scenarios += 1;
    const valid = record.runs.filter((run) => !run.invalid);
    verdict.validRuns += valid.length;
    verdict.notCounted += record.runs.length - valid.length;
    if (record.asked !== series.runs) problem(`${name}: ${record.asked} runs asked, the series asks ${series.runs}`);
    if (valid.length !== series.runs) problem(`${name}: ${valid.length} valid runs of ${series.runs}`);
    const wrong = record.control
      ? valid.filter((run) => !record.control!.every((wanted) => run.violations.some((violation) => violation.includes(wanted))))
      : valid.filter((run) => !run.ok || run.violations.length > 0);
    if (wrong.length > 0) problem(`${name}: ${record.control ? "control runs without the violation they exist for" : "failed runs"}: ${wrong.map((run) => run.run).join(", ")}`);
    for (const run of valid) {
      const runFile = join(dir, name, `run-${run.run}.json`);
      if (!existsSync(runFile)) {
        problem(`${name} run ${run.run}: no run file`);
        continue;
      }
      const detail = JSON.parse(readFileSync(runFile, "utf8")) as RunRecord;
      if (detail.scenario !== name || detail.run !== run.run || detail.seed !== run.seed) problem(`${name} run ${run.run}: its file does not match the record`);
      if (!Number.isInteger(detail.seed) || !Number.isFinite(detail.momentMs)) problem(`${name} run ${run.run}: no seed or moment`);
    }
    const moments = new Set(valid.map((run) => run.momentMs));
    if (valid.length >= 3 && moments.size === 1 && !record.control) {
      const [first] = moments;
      if (first !== 0) problem(`${name}: every run had the same moment (${String(first)} ms) — not random`);
    }
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
  console.log(`${verdict.scenarios} scenarios ran, ${verdict.validRuns} valid runs, ${verdict.notCounted} not counted`);
  for (const skip of verdict.skipped) console.log(`SKIPPED ${skip.scenario}: ${skip.why}`);
  for (const problem of verdict.problems) console.log(`PROBLEM ${problem}`);
  console.log(verdict.problems.length === 0 ? "PASSED" : `NOT PASSED: ${verdict.problems.length} problem(s)`);
  process.exit(verdict.problems.length === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith("verify.ts")) main();
