// A series of the stand's failure scenarios (plan §5, stage 2: "каждый сбой —
// 20 прогонов со случайным моментом"): each scenario N valid runs, the
// fault at a random moment drawn from the series' seed, the criteria checked
// on each run and its evidence written to a file of its own. The verdict of
// a finished series is verify.ts's, from the files alone.
//
//   node --no-warnings /pb/stand/runner/series.ts --name <series> [--runs 20]
//        [--seed <n>] [--only <scenario,…>] [--except <scenario,…>]
//
// Results: /stand/results/series/<series>/
//   series.json                       the series: seed, commit, scenarios
//   <scenario>.json                   its runs and its verdict
//   <scenario>/run-<n>.json           one run: seed, moment, checks, evidence
//
// A run that could not be set up (the stand failed before the fault: the
// page did not come up, a timeout) is not counted and is replaced (at most
// N + 2 more); one that fails after the fault is a failed run.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { siteVariant } from "../fansly/front.ts";
import { mono } from "../shared.ts";
import { captureCovers, pastTheProxy, readCapture, sendSentinel, sentinelPorts } from "./capture.ts";
import { Page, loadTopology, waitFor, type Ctx, type PageInfo, type ScenarioOutcome, type Topology } from "./context.ts";
import { ARRIVAL_SLACK_MS, closedWrites, directArrivals, eventsComplete, exactlyOnce, forbiddenSocketMessages, unadmittedArrivals, variantLoaded, type BufferBounds, type GrantUse, type PagesByAddress, type Resolution } from "./criteria.ts";
import { Docker } from "./docker.ts";
import { StandFansly, type JournalEvent } from "./fansly.ts";
import { SCENARIOS, type Need, type Scenario } from "./scenarios.ts";
import { Store } from "./store.ts";
import { judge, SETUP_FAILURE, violationsOf, type Checks, type COMMON_CHECKS, type Control } from "./verdict.ts";

export interface RunRecord {
  scenario: string;
  run: number;
  seed: number;
  momentMs: number;
  ok: boolean;
  invalid: boolean;
  violations: string[];
  checks: Checks;
  notes: Record<string, unknown>;
  startedWall: number;
  durationMs: number;
}

export interface ScenarioRecord {
  scenario: string;
  proves: string;
  asked: number;
  valid: number;
  passed: number;
  failed: number;
  invalid: number;
  /** Why it did not run (a PR it needs), or null. */
  skipped: string | null;
  control: Control | null;
  page: string;
  runs: Array<Pick<RunRecord, "run" | "seed" | "momentMs" | "ok" | "invalid" | "violations">>;
}

export interface SeriesRecord {
  name: string;
  seed: number;
  runs: number;
  revision: string;
  image: string;
  startedWall: number;
  finishedWall: number | null;
  scenarios: string[];
}

/** mulberry32: a small PRNG whose stream a seed fixes. */
export function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed of one run: the series' seed, the scenario and the run's number. */
export function runSeed(seriesSeed: number, scenario: string, run: number): number {
  let hash = seriesSeed >>> 0;
  for (const char of `${scenario}#${run}`) hash = Math.imul(hash ^ char.charCodeAt(0), 2654435761) >>> 0;
  return hash;
}

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (!key.startsWith("--")) throw new Error(`an argument that is not an option: ${key}`);
    out.set(key.slice(2), argv[i + 1] ?? "");
    i += 1;
  }
  return out;
}

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

export interface Stand {
  topology: Topology;
  store: Store;
  stand: StandFansly;
  docker: Docker;
  pages: Map<string, Page>;
  /** The stand's journal up to where the runs so far have judged it: a run
   *  judges everything since — its own setup included, nothing skipped. */
  journalCursor: number;
  /** What each admission was used for, over the whole series. */
  grantUse: GrantUse;
}

/** The stand's pages by the address the SOCKS5 sees them from. */
export function pagesByAddress(topology: Topology): PagesByAddress {
  return new Map(topology.pages.map((info) => [info.egressIp, info.name]));
}

export async function openStand(): Promise<Stand> {
  const topology = loadTopology();
  const store = new Store(process.env.STAND_PG_HOST ?? "postgres");
  if (!(await store.reachable(60_000))) throw new Error("the stand's Postgres does not answer");
  await store.init();
  const stand = new StandFansly(process.env.STAND_FANSLY_CONTROL ?? "fansly");
  if (!(await waitFor(() => stand.health(), 30_000, 500))) throw new Error("the stand's Fansly does not answer");
  const docker = new Docker(process.env.STAND_DOCKER_SOCK ?? "/proxy/docker.sock");
  const pages = new Map<string, Page>();
  for (const info of topology.pages) pages.set(info.name, new Page(info, topology, store, (event, fields) => log(event, fields)));
  return { topology, store, stand, docker, pages, journalCursor: await stand.mark(), grantUse: new Map() };
}

/** The page's container and its capture running and healthy; the capture
 *  started after the page (it lives in the page's network namespace, which
 *  a start of the page makes anew). */
export async function startPage(docker: Docker, info: PageInfo): Promise<void> {
  if (!(await docker.inspect(info.container)).running) await docker.action(info.container, "start");
  if (!(await waitFor(async () => (await docker.inspect(info.container)).health === "healthy", 90_000, 1000))) throw new Error(`${info.container} is not healthy`);
  const page = await docker.inspect(info.container);
  const capture = await docker.inspect(info.capture);
  if (!capture.running || Date.parse(capture.startedAt) < Date.parse(page.startedAt)) await docker.action(info.capture, "restart", 1);
}

/** Why the scenario cannot run on this operator yet, or null. */
async function notReady(needs: readonly Need[], page: Page, stand: StandFansly, journalSince: number): Promise<string | null> {
  const state = page.engine.state;
  const reasons: string[] = [];
  if (needs.includes("PR6")) {
    const missing = state?.selfTest?.notInstalled ?? [];
    if (missing.includes("dnr_never") || missing.includes("dnr_write")) reasons.push(`the image has no rules extension yet: the self-test reports ${missing.join(", ")} not installed (PR 6)`);
  }
  if (needs.includes("PR7")) {
    const loaded = await waitFor(async () => {
      const step = page.engine.state?.step;
      if (step === "site_loaded" || step === "session_confirmed" || step === "ready") return true;
      return (await stand.journal(journalSince)).some((event) => event.type === "req" && event.role === "site" && event.pathname === "/");
    }, 8000, 500);
    if (!loaded) reasons.push(`the operator does not load the site yet: the page stays at ${state?.step ?? "?"} and nothing asked https://fansly.com/ (PR 7: site load and the site's admissions)`);
  }
  return reasons.length === 0 ? null : reasons.join("; ");
}

interface RunEvidence {
  label: string;
  outcome: ScenarioOutcome | null;
  journal: JournalEvent[];
  fromWall: number;
  toWall: number;
  /** The engine's committed position in each buffer when the run began. */
  positions: ReadonlyMap<string, number>;
  /** The run's capture sentinels (ports) sent to the page. */
  sentinels: number[];
}

/** The common criteria of every run (plan §5, stage 2). */
async function commonChecks(s: Stand, page: Page, run: RunEvidence): Promise<Checks> {
  const { journal } = run;
  const grants = [...s.pages.values()].flatMap((p) => p.engines.flatMap((engine) => engine.grants));
  // The run's own interval, exactly: its sentinels are sent inside it, and
  // what the run before let out is that run's.
  const capture = readCapture(join(s.topology.results, "capture", page.info.name), run.fromWall, run.toWall);
  const attempts = await s.store.attemptsOfRun(run.label);
  const outcomes = await s.store.outcomes(page.info.name, attempts.map((attempt) => attempt.attemptId), run.outcome?.naive === true);
  const recovered = new Map<number, "outcome_resent" | "not_sent" | "unknown">();
  for (const engine of page.enginesOfRun) for (const result of engine.recoverResults) for (const answer of result.attempts) recovered.set(answer.attemptId, answer.state);
  const arrivedRids = new Set(journal.filter((event) => event.type === "req").map((event) => /[?&]rid=([^&]+)/.exec(String(event.path))?.[1] ?? "").filter(Boolean));
  const resolutions: Resolution[] = attempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    outcomes: outcomes.filter((row) => row.attemptId === attempt.attemptId),
    recovered: recovered.get(attempt.attemptId) ?? null,
    arrived: attempt.rid !== null && arrivedRids.has(attempt.rid),
  }));
  // Each buffer the run touched, between its bounds: where the engine stood
  // when the run began (0 for a buffer it had never seen), and the highest
  // number the operator sent on the wire during the run.
  const bounds: BufferBounds[] = [];
  for (const bufferId of new Set(page.enginesOfRun.map((engine) => engine.bufferId).filter(Boolean))) {
    const start = run.positions.get(bufferId) ?? 0;
    bounds.push({ bufferId, start, wireMax: Math.max(0, ...page.enginesOfRun.map((engine) => engine.wireMax.get(bufferId) ?? 0)), stored: (await s.store.seqsOf(bufferId)).filter((seq) => seq > start) });
  }
  const past = pastTheProxy(capture.packets, { pageIps: [page.info.controlIp, page.info.egressIp], socks: { ip: s.topology.socksIp, port: s.topology.socksPort }, engineIp: s.topology.engineIp, rpcPort: s.topology.rpcPort });
  const checks: Record<(typeof COMMON_CHECKS)[number], string[]> = {
    "C1 no request or socket without an admission in force": unadmittedArrivals(journal, grants, pagesByAddress(s.topology), ARRIVAL_SLACK_MS, s.grantUse),
    "C2 no closed write": closedWrites(journal),
    "C3 no forbidden socket message": forbiddenSocketMessages(journal),
    // No sentinel, no evidence: an empty capture says nothing.
    "C4 no traffic past the proxy (OS capture)": [...captureCovers(capture.packets, page.info.controlIp, s.topology.engineIp, run.sentinels), ...past],
    "C5 nothing reached the stand past the proxy": directArrivals(journal),
    "C6 every attempt resolved exactly once": exactlyOnce(resolutions),
    "C7 no event deleted before it was committed": eventsComplete(bounds),
    "C8 the stand's Fansly had no error": journal.filter((event) => event.type === "server.error").map((event) => `stand error: ${String(event.error).slice(0, 200)}`),
  };
  return checks;
}

/** The capture's last lines are on disk once the run's last sentinel is. */
async function awaitSentinel(s: Stand, page: Page, port: number, fromWall: number): Promise<void> {
  const dir = join(s.topology.results, "capture", page.info.name);
  await waitFor(() => captureCovers(readCapture(dir, fromWall - 2000, Date.now() + 2000).packets, page.info.controlIp, s.topology.engineIp, [port]).length === 0, 4000, 250);
}

/** After the fault: the attempts of the run get their outcomes; those still
 *  without one are asked about (`recover`). */
async function settle(s: Stand, page: Page, label: string, naive: boolean): Promise<void> {
  const ids = async () => (await s.store.attemptsOfRun(label)).map((attempt) => attempt.attemptId);
  const open = async () => {
    const all = await ids();
    const have = new Set((await s.store.outcomes(page.info.name, all, naive)).map((row) => row.attemptId));
    return all.filter((id) => !have.has(id));
  };
  await waitFor(async () => (await open()).length === 0, 20_000, 300);
  const missing = await open();
  const engine = page.engine;
  if (missing.length > 0 && engine.connected) {
    const before = engine.recoverResults.length;
    engine.recover(missing);
    await waitFor(() => engine.recoverResults.length > before, 5000);
    await waitFor(async () => (await open()).length === 0, 3000, 300);
  }
  await engine.settled();
}

async function runScenario(s: Stand, scenario: Scenario, series: SeriesRecord, dir: string): Promise<ScenarioRecord> {
  const info = s.topology.pages.find((candidate) => (scenario.page === "disk" ? candidate.buffer === "tmpfs" : candidate.buffer === "volume"));
  if (!info) throw new Error(`the stand has no ${scenario.page} page`);
  const page = s.pages.get(info.name)!;
  const record: ScenarioRecord = { scenario: scenario.name, proves: scenario.proves, asked: series.runs, valid: 0, passed: 0, failed: 0, invalid: 0, skipped: null, control: scenario.control ?? null, page: info.name, runs: [] };
  await startPage(s.docker, info);
  await s.stand.reset();
  await s.stand.config({ site: scenario.site ?? null });
  await page.engine.ensureUp(90_000);
  if (scenario.needs.length > 0) {
    record.skipped = await notReady(scenario.needs, page, s.stand, await s.stand.mark());
    if (record.skipped) {
      log("scenario.skipped", { scenario: scenario.name, why: record.skipped });
      return record;
    }
  }
  mkdirSync(join(dir, scenario.name), { recursive: true });
  let invalidInRow = 0;
  for (let run = 1; record.valid < series.runs && run <= series.runs * 2 + 2; run++) {
    const seed = runSeed(series.seed, scenario.name, run);
    const random = rng(seed);
    const [min, max] = scenario.moment;
    const momentMs = Math.round(min + random() * (max - min));
    const label = `${series.name}/${scenario.name}/${run}`;
    for (const p of s.pages.values()) {
      p.engine.run = label;
      p.enginesOfRun = [p.engine];
    }
    const notes: Record<string, unknown> = {};
    let armed = false;
    let outcome: ScenarioOutcome | null = null;
    let error: string | null = null;
    const startedWall = Date.now();
    const started = mono();
    let journalSince = 0;
    const positions = new Map<string, number>();
    const ports = sentinelPorts(seed);
    const sentinels: number[] = [];
    try {
      await s.stand.reset();
      await startPage(s.docker, info);
      // The browser must run the page variant this scenario configures —
      // its traffic, or none: a setting changes only what the next load
      // gets, so the page is loaded anew, and says which variant it is. (A
      // browser that never loaded the site — until PR 7 — has no variant.)
      const variant = siteVariant(scenario.site ?? null);
      if (scenario.site || (page.variant !== null && page.variant !== variant)) {
        await s.stand.config({ site: scenario.site ?? null });
        const before = await s.stand.mark();
        const reloaded = mono();
        const restarted = await page.engine.command("restartBrowser");
        if (!restarted.ok) throw new Error(`restartBrowser: ${restarted.detail ?? ""}`);
        let loaded: string[] = ["not asked yet"];
        await waitFor(async () => (loaded = variantLoaded(await s.stand.journal(before), info.egressIp, variant, 0)).length === 0, 60_000, 500);
        if (loaded.length > 0) throw new Error(loaded[0]);
        page.variant = variant;
        await page.engine.waitState((state) => state.exitOpen, 60_000, reloaded);
      }
      await page.engine.ensureUp(90_000);
      await page.engine.settled();
      journalSince = await s.stand.mark();
      for (const engine of page.enginesOfRun) engine.wireMax.clear();
      if (page.engine.bufferId) positions.set(page.engine.bufferId, await s.store.committedUpTo(page.engine.bufferId));
      await sendSentinel(info.controlIp, ports.start);
      sentinels.push(ports.start);
      const ctx: Ctx = {
        page,
        pages: s.pages,
        stand: s.stand,
        docker: s.docker,
        store: s.store,
        topology: s.topology,
        momentMs,
        journalSince,
        random,
        pagesByAddress: pagesByAddress(s.topology),
        log: (event, fields) => log(event, { scenario: scenario.name, run, ...fields }),
        arm: () => {
          armed = true;
        },
        notes,
      };
      log("run.start", { scenario: scenario.name, run, seed, momentMs });
      outcome = await scenario.run(ctx);
      await settle(s, page, label, outcome.naive === true);
    } catch (caught) {
      error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
    }
    if (sentinels.length > 0) {
      await sendSentinel(info.controlIp, ports.end);
      sentinels.push(ports.end);
      await awaitSentinel(s, page, ports.end, startedWall);
    }
    const toWall = Date.now();
    let checks: Checks = {};
    let invalid = false;
    if (error !== null && !armed) {
      invalid = true;
      checks = { [SETUP_FAILURE]: [error] };
    } else {
      if (error !== null) checks["the run itself"] = [`an error after the fault: ${error}`];
      for (const [name, found] of Object.entries(outcome?.checks ?? {})) checks[name] = found;
      try {
        // Everything since the run before was judged: this run's setup too.
        const journal = await s.stand.journal(Math.min(s.journalCursor, journalSince));
        s.journalCursor = journal.at(-1)?.seq ?? s.journalCursor;
        Object.assign(checks, await commonChecks(s, page, { label, outcome, journal, fromWall: startedWall, toWall, positions, sentinels }));
        notes.journal = { events: journal.length, api: journal.filter((event) => event.type === "req" && event.role === "api").length, socks: journal.filter((event) => event.type === "socks.connect").length, ipify: journal.filter((event) => event.type === "ipify").length };
        notes.redeliveries = await s.store.redeliveries(label);
        const attempts = await s.store.attemptsOfRun(label);
        notes.attempts = { issued: attempts.length, byKind: Object.fromEntries([...new Set(attempts.map((attempt) => attempt.kind))].map((kind) => [kind, attempts.filter((attempt) => attempt.kind === kind).length])) };
        notes.events = (await s.store.eventsOfRun(label)).map((event) => (event.kind === "gap" ? `gap:${event.reason ?? "?"}` : event.kind));
      } catch (caught) {
        checks["the evidence"] = [`could not be read: ${caught instanceof Error ? caught.message : String(caught)}`];
      }
    }
    const violations = violationsOf(checks);
    const ok = !invalid && judge(checks, scenario.control ?? null).ok;
    const result: RunRecord = { scenario: scenario.name, run, seed, momentMs, ok, invalid, violations, checks, notes, startedWall, durationMs: Math.round(mono() - started) };
    writeFileSync(join(dir, scenario.name, `run-${run}.json`), `${JSON.stringify(result, null, 2)}\n`);
    record.runs.push({ run, seed, momentMs, ok, invalid, violations });
    log("run.end", { scenario: scenario.name, run, ok, invalid, violations: violations.length, ms: result.durationMs });
    if (invalid) {
      record.invalid += 1;
      invalidInRow += 1;
      if (invalidInRow >= 2) {
        // The stand got stuck: the page's container is started again.
        invalidInRow = 0;
        await s.docker.action(info.container, "restart", 10).catch(() => undefined);
        await startPage(s.docker, info).catch(() => undefined);
        await page.engine.reconnect(90_000).catch(() => undefined);
      }
      continue;
    }
    invalidInRow = 0;
    record.valid += 1;
    if (ok) record.passed += 1;
    else record.failed += 1;
  }
  return record;
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2));
  const name = options.get("name") ?? `s-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("--name: letters, digits, . _ -");
  const runs = Number(options.get("runs") ?? "20");
  const seed = Number(options.get("seed") ?? String(Date.now() % 2147483647));
  const only = options.get("only")?.split(",").filter(Boolean) ?? null;
  const except = new Set(options.get("except")?.split(",").filter(Boolean) ?? []);
  const unknown = [...(only ?? []), ...except].filter((wanted) => !SCENARIOS.some((scenario) => scenario.name === wanted));
  if (unknown.length > 0) throw new Error(`unknown scenarios: ${unknown.join(", ")}`);
  const chosen = SCENARIOS.filter((scenario) => (only === null || only.includes(scenario.name)) && !except.has(scenario.name));
  const s = await openStand();
  const dir = join(s.topology.results, "series", name);
  mkdirSync(dir, { recursive: true });
  const series: SeriesRecord = { name, seed, runs, revision: process.env.PB_SUITE_REV ?? "unknown", image: process.env.PB_SUITE_IMAGE ?? "unknown", startedWall: Date.now(), finishedWall: null, scenarios: chosen.map((scenario) => scenario.name) };
  writeFileSync(join(dir, "series.json"), `${JSON.stringify(series, null, 2)}\n`);
  log("series.start", { name, seed, runs, scenarios: series.scenarios });
  // The disk page runs only while its scenarios do.
  const disk = s.topology.pages.find((info) => info.buffer === "tmpfs");
  for (const scenario of chosen) {
    let record: ScenarioRecord;
    try {
      record = await runScenario(s, scenario, series, dir);
    } catch (caught) {
      const why = caught instanceof Error ? caught.message : String(caught);
      log("scenario.failed_to_start", { scenario: scenario.name, why });
      record = { scenario: scenario.name, proves: scenario.proves, asked: runs, valid: 0, passed: 0, failed: 0, invalid: 0, skipped: null, control: scenario.control ?? null, page: scenario.page, runs: [{ run: 0, seed: 0, momentMs: 0, ok: false, invalid: true, violations: [`the stand could not start the scenario: ${why}`] }] };
    }
    writeFileSync(join(dir, `${scenario.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
    log("scenario.end", { scenario: scenario.name, valid: record.valid, passed: record.passed, failed: record.failed, invalid: record.invalid, skipped: record.skipped });
    if (disk && scenario.page === "disk") {
      await s.pages.get(disk.name)!.engine.drop("clean");
      await s.docker.action(disk.container, "stop", 10).catch(() => undefined);
    }
  }
  series.finishedWall = Date.now();
  writeFileSync(join(dir, "series.json"), `${JSON.stringify(series, null, 2)}\n`);
  for (const page of s.pages.values()) await page.engine.drop("clean");
  s.store.close();
  log("series.end", { name, dir });
  process.exit(0);
}

if (process.argv[1]?.endsWith("series.ts")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
}
