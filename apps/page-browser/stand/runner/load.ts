// The common load test of plan §5, stage 2 ("Общая нагрузка"), and the
// thresholds of spec §4: several profiles at once — engine requests at the
// ceiling, the site's own traffic, socket frames at the requirements' rate
// with bursts, an engine outage and the buffer's offload after it — with
// the stand's Postgres taking the engine's commits.
//
//   node --no-warnings /pb/stand/runner/load.ts --name <name> [--profiles N]
//        [--minutes 120] [--outage-minutes 15] [--frames-per-minute 246]
//        [--burst-per-minute 492] [--bursts 3] [--burst-minutes 5] [--pace-ms 2500]
//
// Writes /stand/results/load/<name>/report.json: each threshold with what
// was measured and whether it held — or why it was not measured: what needs
// the site in the browser (its requests, its socket, its frames) waits for
// PR 7, and is reported so, never as passed.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { atLeast } from "../../src/state/steps.ts";
import { mono, sleep } from "../shared.ts";
import { pastTheProxy, readCapture } from "./capture.ts";
import { waitFor, type Page } from "./context.ts";
import { closedWrites, contiguous, directArrivals, forbiddenSocketMessages, unadmittedArrivals } from "./criteria.ts";
import type { ContainerSample } from "./docker.ts";
import { openStand, startPage, type Stand } from "./series.ts";

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) out.set(argv[i]!.replace(/^--/, ""), argv[i + 1] ?? "");
  return out;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

interface Threshold {
  id: string;
  what: string;
  limit: string;
  value: unknown;
  /** true: held; false: did not; null: not measured (see `why`). */
  held: boolean | null;
  why?: string;
}

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

/** One page's engine at the ceiling: one request in flight, the next one
 *  the page's pause after the previous one ended (S × (1 + u), u ≤ 0.2). */
async function ceiling(page: Page, until: () => boolean, paceMs: number, roundTrips: number[], counts: { sent: number }): Promise<void> {
  while (!until()) {
    const engine = page.engine;
    if (!engine.connected) {
      await sleep(500);
      continue;
    }
    const began = mono();
    const [attemptId] = await engine.sendHub(1).catch(() => [] as number[]);
    if (attemptId !== undefined) {
      counts.sent += 1;
      const outcome = await engine.waitOutcome(attemptId, 30_000);
      if (outcome) roundTrips.push(outcome.atMono - began);
    }
    await sleep(paceMs * (1 + Math.random() * 0.2));
  }
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2));
  const name = options.get("name") ?? `load-${Date.now()}`;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("--name: letters, digits, . _ -");
  const minutes = Number(options.get("minutes") ?? "120");
  const outageMinutes = Number(options.get("outage-minutes") ?? "15");
  const framesPerMinute = Number(options.get("frames-per-minute") ?? "246");
  const burstPerMinute = Number(options.get("burst-per-minute") ?? "492");
  const bursts = Number(options.get("bursts") ?? "3");
  const burstMinutes = Number(options.get("burst-minutes") ?? "5");
  const paceMs = Number(options.get("pace-ms") ?? "2500");
  const s: Stand = await openStand();
  const all = s.topology.pages.filter((info) => info.buffer === "volume");
  const profiles = Number(options.get("profiles") ?? String(all.length));
  if (profiles < 1 || profiles > all.length) throw new Error(`--profiles: 1 to ${all.length} (stand.sh up --profiles)`);
  const pages = all.slice(0, profiles).map((info) => s.pages.get(info.name)!);
  const dir = join(s.topology.results, "load", name);
  mkdirSync(dir, { recursive: true });
  const label = `load/${name}`;
  const startedWall = Date.now();
  const journalSince = await s.stand.mark();
  await s.stand.reset();
  for (const page of pages) {
    page.engine.run = label;
    page.enginesOfRun = [page.engine];
  }
  log("load.start", { name, profiles, minutes, outageMinutes, framesPerMinute, burstPerMinute, bursts, burstMinutes });

  // Every page started at once: how long each took to open its exit.
  const startMs: Record<string, number> = {};
  await Promise.all(
    pages.map(async (page) => {
      await startPage(s.docker, page.info);
      if (!page.engine.connected) await page.engine.connect();
      const began = mono();
      if (page.engine.state && atLeast(page.engine.state.step, "exit_open")) await page.engine.command("stopPage");
      await page.engine.ensureUp(180_000);
      startMs[page.info.name] = Math.round(mono() - began);
    }),
  );
  log("load.up", { startMs });

  // The resources, every 5 s (spec §4, threshold 8).
  const samples = new Map<string, ContainerSample[]>(pages.map((page) => [page.info.name, []]));
  const bufferAges: number[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      for (const page of pages) {
        try {
          samples.get(page.info.name)!.push(await s.docker.stats(page.info.container));
        } catch {
          // a sample missed
        }
        const age = page.engine.state?.buffer.oldestAgeMs;
        if (typeof age === "number" && page.engine.connected) bufferAges.push(age);
      }
      await sleep(5000);
    }
  })();

  // The site: loaded by the operator (PR 7), or not.
  const siteLoaded = await waitFor(async () => (await s.stand.journal(journalSince)).some((event) => event.type === "req" && event.role === "site" && event.pathname === "/"), 10_000, 1000);
  if (siteLoaded) await s.stand.config({ site: { readEveryMs: 30_000, writeEveryMs: 0, socket: true, forbiddenWs: false } });

  // The ceiling, with frames: background, then the bursts.
  const ceilingEnd = mono() + minutes * 60_000;
  const roundTrips: number[] = [];
  const counts = { sent: 0 };
  const loops = pages.map((page) => ceiling(page, () => mono() > ceilingEnd, paceMs, roundTrips, counts));
  await s.stand.config({ wsPush: { perMinute: framesPerMinute, bytes: 600 } });
  const burstEvery = (minutes * 60_000) / (bursts + 1);
  for (let burst = 1; burst <= bursts; burst++) {
    await sleep(Math.max(0, Math.min(burstEvery, ceilingEnd - mono())));
    if (mono() > ceilingEnd) break;
    log("load.burst", { burst });
    await s.stand.config({ wsPush: { perMinute: burstPerMinute, bytes: 600 } });
    await sleep(Math.min(burstMinutes * 60_000, Math.max(0, ceilingEnd - mono())));
    await s.stand.config({ wsPush: { perMinute: framesPerMinute, bytes: 600 } });
  }
  await Promise.all(loops);
  const ceilingWall = Date.now();

  // The engine away (a Hub outage), the frames still coming; then back.
  log("load.outage", { minutes: outageMinutes });
  for (const page of pages) await page.engine.drop("clean");
  await sleep(outageMinutes * 60_000);
  const returned = mono();
  for (const page of pages) await page.engine.connectRetrying(60_000);
  // The offload: until every page's buffer is drained of what waited.
  const drained = await waitFor(() => pages.every((page) => (page.engine.state?.buffer.oldestAgeMs ?? 0) < 2000 && page.engine.connected), 15 * 60_000, 1000);
  const offloadMs = Math.round(mono() - returned);
  await s.stand.config({ wsPush: { perMinute: 0 } });
  await sleep(5000);
  sampling = false;
  await sampler;
  const endWall = Date.now();

  // ── the measurements against spec §4 ──
  const journal = await s.stand.journal(journalSince);
  const thresholds: Threshold[] = [];
  const hours = minutes / 60;
  // A request's page: the SOCKS5 connection it came on, logged in from the
  // page's egress address.
  const socksFrom = new Map(journal.filter((event) => event.type === "socks.login").map((event) => [Number(event.socksId), String(event.from)]));
  const perPage = pages.map((page) => {
    const operations = journal.filter((event) => event.type === "req" && event.role === "api" && event.method !== "OPTIONS" && event.wall >= startedWall && event.wall <= ceilingWall && socksFrom.get(Number(event.socksId)) === page.info.egressIp).length;
    return { page: page.info.name, perHour: Math.round(operations / hours) };
  });
  const site = siteLoaded ? null : "the operator does not load the site yet (PR 7): no request reaches the stand, Hub's are answered 'not sent' in the operator";
  thresholds.push({ id: "1", what: "pages at once", limit: "7", value: profiles, held: profiles >= 7 ? true : null, ...(profiles < 7 ? { why: `run with --profiles ${profiles}: the threshold is judged with 7` } : {}) });
  thresholds.push({ id: "2", what: "requests per hour per page at the ceiling (stand journal)", limit: "≥ 1240 at S = 2.5 s", value: perPage, held: site ? null : perPage.every((entry) => entry.perHour >= 1240), ...(site ? { why: site } : {}) });
  const framesOut = journal.filter((event) => event.type === "ws.out");
  thresholds.push({ id: "3", what: "socket frames per minute per page, bursts", limit: `${burstPerMinute}/min per page in bursts`, value: { pushed: framesOut.length }, held: framesOut.length === 0 ? null : true, ...(framesOut.length === 0 ? { why: "no site socket was open (PR 7): the frames had nowhere to go" } : {}) });
  const committed = await s.store.framesOfRun(label);
  const pushedAt = new Map(framesOut.map((event) => [Number(event.frame), event.mono]));
  const latencies = committed.map((row) => row.committedMono - (pushedAt.get(row.frame) ?? row.committedMono));
  const liveLatencies = committed.filter((row) => (pushedAt.get(row.frame) ?? 0) < returned - outageMinutes * 60_000).map((row) => row.committedMono - pushedAt.get(row.frame)!);
  thresholds.push({ id: "4", what: "frame on the stand → committed in Postgres, p95 (outside the outage)", limit: "≤ 5000 ms", value: percentile(liveLatencies, 95), held: liveLatencies.length === 0 ? null : percentile(liveLatencies, 95)! <= 5000, ...(liveLatencies.length === 0 ? { why: "no frame was committed (PR 7)" } : {}) });
  thresholds.push({ id: "5", what: "the browser's addition to a request, p95", limit: "≤ 300 ms", value: { roundTripP95: percentile(roundTrips, 95), sends: counts.sent }, held: null, why: site ?? "the request's own time on the stand is to be taken from the stand journal per attempt once requests leave (PR 7)" });
  thresholds.push({ id: "6", what: "the buffer's age, p95 (state.buffer.oldestAgeMs)", limit: "< 2000 ms", value: percentile(bufferAges, 95), held: bufferAges.length === 0 ? null : percentile(bufferAges, 95)! < 2000 });
  const pushedDuringOutage = framesOut.filter((event) => event.mono >= returned - outageMinutes * 60_000 && event.mono < returned).length;
  const duplicates = await s.store.duplicateFrames();
  const lost = [...pushedAt.keys()].filter((frame) => !committed.some((row) => row.frame === frame));
  thresholds.push({ id: "7", what: `${outageMinutes} min without the engine: offload without loss or duplicates`, limit: "≤ 10 min, none lost, none twice", value: { offloadMs, drained, pushedDuringOutage, lost: lost.length, duplicates: duplicates.length }, held: drained && offloadMs <= 10 * 60_000 && duplicates.length === 0 && (framesOut.length === 0 || lost.length === 0), ...(framesOut.length === 0 ? { why: "measured on the buffer's own events only: no frames without the site's socket (PR 7)" } : {}) });
  const resources = pages.map((page) => {
    const list = samples.get(page.info.name)!;
    const peak = Math.max(0, ...list.map((sample) => sample.memoryBytes));
    const limit = list[0]?.memoryLimitBytes ?? 0;
    return { page: page.info.name, samples: list.length, peakMemoryMiB: Math.round(peak / 1048576), limitMiB: Math.round(limit / 1048576), peakPercent: limit > 0 ? Math.round((peak / limit) * 100) : null, cpuP95: percentile(list.map((sample) => sample.cpuPercent), 95), pidsMax: Math.max(0, ...list.map((sample) => sample.pids)) };
  });
  const oom = await Promise.all(pages.map(async (page) => ({ page: page.info.name, oomKilled: (await s.docker.inspect(page.info.container)).oomKilled })));
  thresholds.push({ id: "8", what: "resources per page container (cgroup every 5 s)", limit: "peak memory ≤ 90 % of the limit, no OOM", value: { resources, oom, startMs }, held: resources.every((entry) => entry.peakPercent !== null && entry.peakPercent <= 90) && oom.every((entry) => !entry.oomKilled) });
  const commits = pages.flatMap((page) => page.enginesOfRun.flatMap((engine) => engine.commitMs));
  thresholds.push({ id: "9", what: "Hub and Postgres: the ten most frequent queries vs the baseline", limit: "≤ 1.1 × baseline", value: { standCommitP95Ms: percentile(commits, 95), commits: commits.length }, held: null, why: "Hub's own queries are not on the stand (its engine is the runner); the runner's commit times are shown for the record" });

  // ── the criteria over the whole test ──
  const grants = pages.flatMap((page) => page.enginesOfRun.flatMap((engine) => engine.grants));
  const criteria: Record<string, string[]> = {
    "C1 no request or socket without an admission in force": unadmittedArrivals(journal, grants),
    "C2 no closed write": closedWrites(journal),
    "C3 no forbidden socket message": forbiddenSocketMessages(journal),
    "C5 nothing reached the stand past the proxy": directArrivals(journal),
  };
  for (const page of pages) {
    const capture = readCapture(join(s.topology.results, "capture", page.info.name), startedWall, endWall);
    criteria[`C4 no traffic past the proxy (${page.info.name})`] = pastTheProxy(capture.packets, { pageIps: [page.info.controlIp, page.info.egressIp], socks: { ip: s.topology.socksIp, port: s.topology.socksPort }, engineIp: s.topology.engineIp, rpcPort: s.topology.rpcPort });
    const seqs = new Map<string, number[]>();
    for (const engine of page.enginesOfRun) if (engine.bufferId) seqs.set(engine.bufferId, await s.store.seqsOf(engine.bufferId));
    criteria[`C7 no event deleted before it was committed (${page.info.name})`] = contiguous(seqs);
  }
  const report = { name, profiles, minutes, outageMinutes, revision: process.env.PB_SUITE_REV ?? "unknown", startedWall, endWall, siteLoaded, frameLatencyAllP95: percentile(latencies, 95), thresholds, criteria };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const failed = thresholds.filter((threshold) => threshold.held === false).map((threshold) => threshold.id);
  const violations = Object.values(criteria).flat();
  for (const threshold of thresholds) log("threshold", { id: threshold.id, what: threshold.what, held: threshold.held, value: threshold.value, ...(threshold.why ? { why: threshold.why } : {}) });
  for (const violation of violations) log("violation", { violation });
  log("load.end", { report: join(dir, "report.json"), failedThresholds: failed, violations: violations.length });
  for (const page of pages) await page.engine.drop("clean");
  s.store.close();
  process.exit(failed.length === 0 && violations.length === 0 ? 0 : 1);
}

if (process.argv[1]?.endsWith("load.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
}
