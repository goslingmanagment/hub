// The stand's scenarios (plan §5, stage 1, mandatory conditions №1–№3).
//   node stand/runner/main.ts <scenario> [runs]
// Each run writes its evidence; the summary goes to stdout and
// /stand/results/<scenario>-<time>.json.

import { writeFileSync } from "node:fs";

import { StandEngine, type Grant } from "./engine.ts";
import { Docker, StandServer, type JournalEvent } from "./infra.ts";
import { scenarios } from "./scenarios.ts";
import { monoMs } from "../../src/shared/util.ts";

export interface Ctx {
  engine: StandEngine;
  stand: StandServer;
  docker: Docker;
  run: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** Called right before the fault: an error from here on is a failed run,
   *  not a run the stand could not set up. */
  arm: () => void;
  armed: boolean;
}

export interface RunResult {
  ok: boolean;
  violations: string[];
  notes: Record<string, unknown>;
}

export type Scenario = (ctx: Ctx) => Promise<RunResult>;

/** Every request the stand server received for these rids must have been
 *  admitted, must have arrived inside the admission's window and at the
 *  admitted address, and one admission covers one operation: at most one
 *  preflight and one request (a second is a repeat). `slackMs`: the
 *  forwarding latency between the proxy (the sender) and the server. */
export function checkAdmitted(events: JournalEvent[], grants: Grant[], ridPrefix: string, slackMs = 50): { violations: string[]; arrivals: number } {
  const violations: string[] = [];
  let arrivals = 0;
  const used = new Map<Grant, { preflight: number; main: number }>();
  for (const event of events) {
    if (event.t !== "req" || !event.rid || !event.rid.startsWith(ridPrefix)) continue;
    arrivals += 1;
    const what = `${event.method} ${event.path} (rid ${event.rid})`;
    const own = grants.filter((grant) => grant.rid === event.rid);
    if (own.length === 0) {
      violations.push(`${what} arrived without any admission`);
      continue;
    }
    const inWindow = own.filter((grant) => event.mono >= grant.grantedMono && event.mono <= grant.deadlineMono + slackMs);
    if (inWindow.length === 0) {
      const nearest = own.map((grant) => Math.round(event.mono - grant.deadlineMono)).join(", ");
      violations.push(`${what} arrived outside its admission window (ms after deadline: ${nearest})`);
      continue;
    }
    const admitted = inWindow.filter((grant) => samePath(grant.url ?? "", String(event.path ?? "")));
    if (admitted.length === 0) {
      violations.push(`${what} is not the address that was admitted`);
      continue;
    }
    // The request's own method; a preflight (OPTIONS) comes on top of it.
    const sameMethod = admitted.filter((grant) => event.method === "OPTIONS" || grant.method === null || grant.method.toUpperCase() === String(event.method).toUpperCase());
    if (sameMethod.length === 0) {
      violations.push(`${what} is not the method that was admitted (${admitted.map((grant) => grant.method).join(", ")})`);
      continue;
    }
    const role = event.method === "OPTIONS" ? "preflight" : "main";
    const grant = sameMethod.find((candidate) => (used.get(candidate)?.[role] ?? 0) === 0);
    if (!grant) {
      violations.push(`${what} arrived again under one admission — a repeat`);
      continue;
    }
    const count = used.get(grant) ?? { preflight: 0, main: 0 };
    count[role] += 1;
    used.set(grant, count);
  }
  return { violations, arrivals };
}

function samePath(url: string, path: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search === path;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? "smoke";
  const runs = Number(process.argv[3] ?? "1");
  const scenario = scenarios[name];
  if (!scenario) {
    console.error(`unknown scenario ${name}; known: ${Object.keys(scenarios).join(", ")}`);
    process.exit(2);
  }
  const engine = new StandEngine(process.env.STAND_OPERATOR ?? "ws://10.250.250.20:7700/rpc", "stand-token", Date.now());
  const stand = new StandServer(process.env.STAND_SERVER ?? "10.250.250.10");
  const docker = new Docker(process.env.STAND_BROWSER_CONTAINER ?? "pb-stand-browser-1");
  // A run that could not be set up (the stand itself failed: a timeout, a
  // browser that did not come back) says nothing about the criterion. It is
  // counted apart and replaced by another run; two in a row restart the
  // browser container.
  const results: Array<RunResult & { run: number; ms: number; invalid: boolean }> = [];
  let valid = 0;
  let invalidInRow = 0;
  let resets = 0;
  for (let run = 1; valid < runs && run <= runs * 2 + 2; run++) {
    const started = monoMs();
    const log = (event: string, fields?: Record<string, unknown>) =>
      console.log(JSON.stringify({ run, ms: Math.round(monoMs() - started), event, ...fields }));
    let result: RunResult;
    const ctx: Ctx = { engine, stand, docker, run, log, armed: false, arm: () => undefined };
    ctx.arm = () => {
      ctx.armed = true;
    };
    try {
      result = await scenario(ctx);
    } catch (error) {
      // Before the fault: the stand could not set the run up. After it: the
      // run failed (recovery is part of what is checked).
      result = ctx.armed
        ? { ok: false, violations: [`error after the fault: ${(error as Error).stack}`], notes: {} }
        : { ok: false, violations: [`scenario error: ${(error as Error).stack}`], notes: {} };
    }
    await stand.clearFaults().catch(() => undefined);
    const invalid = result.violations.length > 0 && result.violations.every((violation) => violation.startsWith("scenario error:"));
    results.push({ run, ms: Math.round(monoMs() - started), invalid, ...result });
    console.log(JSON.stringify({ run, ok: result.ok, invalid, violations: result.violations, notes: result.notes }));
    if (invalid) {
      invalidInRow += 1;
      if (invalidInRow >= 2) {
        resets += 1;
        invalidInRow = 0;
        engine.close();
        await docker.restart().catch(() => undefined);
        await engine.waitReady(180_000).catch(() => undefined);
      }
    } else {
      valid += 1;
      invalidInRow = 0;
    }
  }
  const counted = results.filter((result) => !result.invalid);
  const failed = counted.filter((result) => !result.ok);
  // A series that could not gather its valid runs is not a pass (Astra
  // review 3: 3 asked, 8 invalid, 0 valid used to exit 0).
  const short = Math.max(0, runs - counted.length);
  const summary = { scenario: name, asked: runs, runs: counted.length, passed: counted.length - failed.length, failed: failed.length, invalid: results.length - counted.length, short, resets, results };
  const file = `/stand/results/${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  try {
    writeFileSync(file, JSON.stringify(summary, null, 2));
  } catch {
    // results dir not mounted
  }
  console.log(JSON.stringify({ scenario: name, asked: runs, runs: summary.runs, passed: summary.passed, failed: summary.failed, invalid: summary.invalid, short, resets, file }));
  engine.close();
  process.exit(failed.length === 0 && short === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith("main.ts")) void main();
