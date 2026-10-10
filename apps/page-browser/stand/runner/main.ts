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
}

export interface RunResult {
  ok: boolean;
  violations: string[];
  notes: Record<string, unknown>;
}

export type Scenario = (ctx: Ctx) => Promise<RunResult>;

/** Every request the stand server received for these rids must have been
 *  admitted, and must have arrived inside the admission's window. `slackMs`:
 *  the forwarding latency between the proxy (the sender) and the server. */
export function checkAdmitted(events: JournalEvent[], grants: Grant[], ridPrefix: string, slackMs = 50): { violations: string[]; arrivals: number } {
  const violations: string[] = [];
  let arrivals = 0;
  for (const event of events) {
    if (event.t !== "req" || !event.rid || !event.rid.startsWith(ridPrefix)) continue;
    arrivals += 1;
    const own = grants.filter((grant) => grant.rid === event.rid);
    if (own.length === 0) {
      violations.push(`${event.method} ${event.path} (rid ${event.rid}) arrived without any admission`);
      continue;
    }
    const inWindow = own.some((grant) => event.mono >= grant.grantedMono && event.mono <= grant.deadlineMono + slackMs);
    if (!inWindow) {
      const nearest = own.map((grant) => Math.round(event.mono - grant.deadlineMono)).join(", ");
      violations.push(`${event.method} ${event.path} (rid ${event.rid}) arrived outside its admission window (ms after deadline: ${nearest})`);
    }
  }
  return { violations, arrivals };
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
  const results: Array<RunResult & { run: number; ms: number }> = [];
  for (let run = 1; run <= runs; run++) {
    const started = monoMs();
    const log = (event: string, fields?: Record<string, unknown>) =>
      console.log(JSON.stringify({ run, ms: Math.round(monoMs() - started), event, ...fields }));
    let result: RunResult;
    try {
      result = await scenario({ engine, stand, docker, run, log });
    } catch (error) {
      result = { ok: false, violations: [`scenario error: ${(error as Error).stack}`], notes: {} };
    }
    await stand.clearFaults().catch(() => undefined);
    results.push({ run, ms: Math.round(monoMs() - started), ...result });
    console.log(JSON.stringify({ run, ok: result.ok, violations: result.violations, notes: result.notes }));
  }
  const failed = results.filter((result) => !result.ok);
  const summary = { scenario: name, runs, passed: runs - failed.length, failed: failed.length, results };
  const file = `/stand/results/${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  try {
    writeFileSync(file, JSON.stringify(summary, null, 2));
  } catch {
    // results dir not mounted
  }
  console.log(JSON.stringify({ scenario: name, runs, passed: summary.passed, failed: summary.failed, file }));
  engine.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith("main.ts")) void main();
