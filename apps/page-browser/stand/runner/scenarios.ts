// The failure scenarios of plan §5, stage 2 (§4.9's table, §8 №14's stand),
// against the production operator and image. Each run: the page is up, the
// engine keeps issuing Hub requests (each an attempt resolved exactly once),
// the fault comes at the run's random moment, the page must react as §4.9
// says and come back. The common criteria (series.ts) are checked on every
// run besides each scenario's own.
//
// What a scenario needs that the operator in main does not do yet is
// declared (`needs`) and the scenario is skipped, with the reason, until the
// operator does it: PR 6 — the rules extension in the image; PR 7 — the
// operator loads the site (the stand's fansly.com) and admits its requests,
// which is also what brings the site's socket (its session comes from the
// site's API requests) and Hub requests that actually leave (they go from
// the site's tab).

import { randomBytes } from "node:crypto";

import { FANSLY_HOSTS } from "../../src/egress/hosts.ts";
import { atLeast } from "../../src/state/steps.ts";
import type { SiteBehaviour } from "../fansly/front.ts";
import { STAND_EXIT_IP, STAND_OTHER_EXIT_IP, STAND_SOCKS_USER, mono, sleep } from "../shared.ts";
import { Activity, waitFor, type Ctx, type Page, type ScenarioOutcome } from "./context.ts";
import { closedWriteAttempted, exitClosedWithin, expiredArrivals, expiredUnderHold, gapCommitted, inFlightAtRestart, lateUnderHold, plantedBypass, plantedDuplicates, plantedLate, plantedLeak, plantedLostFrames, plantedNoCapture, plantedRepeat, plantedTail, plantedUnkeptAnswer, sentAfterRecovery, stoodBetween, stoppedFor, upWithin, type OperatorRequestLine, type SeenTransition, type WaitingRequest } from "./criteria.ts";
import type { Grant, StandEngine } from "./engine.ts";
import type { JournalEvent } from "./fansly.ts";
import { leak } from "./leak.ts";
import type { Control, Planted } from "./verdict.ts";

export type Need = "PR6" | "PR7";

/** The site the stand's fansly.com page plays (fansly/front.ts) once the
 *  operator loads it (PR 7). */
export type SiteTraffic = SiteBehaviour;

export interface Scenario {
  name: string;
  /** What a pass proves, in one line (README.md lists them). */
  proves: string;
  needs: Need[];
  /** The page it runs on: the main one, or the one whose buffer volume is
   *  a small fixed-size tmpfs (disk-full). */
  page: "main" | "disk";
  /** The fault's moment: uniform in [min, max] ms after the activity began. */
  moment: [number, number];
  /** A control: the checks every run must trip, each with the violations
   *  it must show; every other check must hold (verdict.ts). */
  control?: Control;
  /** The site's traffic for the run (PR 7). */
  site?: SiteTraffic;
  run: (ctx: Ctx) => Promise<ScenarioOutcome>;
}

const SITE_TRAFFIC: SiteTraffic = { readEveryMs: 700, writeEveryMs: 0, socket: true, forbiddenWs: false };

// ── levers ───────────────────────────────────────────────────────────────

function inPage(ctx: Ctx, cmd: string[], user: "root" | "pb-operator" | "pb-chrome" = "root", page: Page = ctx.page): Promise<string> {
  return ctx.docker.run(page.info.container, cmd, user);
}

async function servicePid(ctx: Ctx, service: string): Promise<number> {
  const pid = Number((await inPage(ctx, ["/command/s6-svstat", "-o", "pid", `/run/service/${service}`])).trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no pid of ${service}`);
  return pid;
}

/** The controls' lever inside the page container (inside/lever.ts): what it
 *  is told goes from the page's own address, past the operator. */
const LEVER = "/opt/page-browser/stand/inside/lever.ts";
const LEVER_CA = "/stand/ca/ca.crt";
/** The operator's own journal, read inside the page (inside/journal.ts). */
const JOURNAL = "/opt/page-browser/stand/inside/journal.ts";

const CDP_BREAK = "pb-suite-cdp-break";
const BYPASS = "pb-suite-bypass";

/** Breaks the DevTools connection between the holder and Chrome with every
 *  process alive: the next packet either way gets a TCP reset. The resets
 *  themselves go out through the same chain, so they are let through
 *  (`tcp flags & rst == 0`): otherwise the rule drops its own reset, and
 *  the connection only stalls. */
async function breakCdp(ctx: Ctx): Promise<void> {
  for (const port of ["dport", "sport"]) {
    await inPage(ctx, ["nft", "insert", "rule", "inet", "pb", "output", "tcp", port, "9222", "tcp", "flags", "&", "rst", "==", "0", "reject", "with", "tcp", "reset", "comment", `"${CDP_BREAK}"`]);
  }
}

async function dropRules(ctx: Ctx, comment: string): Promise<void> {
  await inPage(ctx, ["sh", "-c", `for h in $(nft -a list chain inet pb output | sed -n 's/.*"${comment}".*# handle \\([0-9][0-9]*\\)$/\\1/p'); do nft delete rule inet pb output handle "$h"; done; ! nft list chain inet pb output | grep -q '${comment}'`]);
}

function transitions(page: Page): SeenTransition[] {
  return page.enginesOfRun
    .flatMap((engine) => engine.states)
    .map(({ atMono, state }) => ({ atMono, exitOpen: state.exitOpen, step: state.step, stopReason: state.stopReason, retryAtWall: state.retryAtWall }))
    .sort((a, b) => a.atMono - b.atMono);
}

function closures(page: Page): number[] {
  return page.enginesOfRun.flatMap((engine) => engine.closures);
}

function isUp(engine: StandEngine): boolean {
  const state = engine.state;
  return state !== null && state.exitOpen && atLeast(state.step, "exit_open");
}

/** The committed gaps of the run so far, once one of `reason` is there. */
async function waitGap(ctx: Ctx, reason: string, sinceMono: number, timeoutMs = 15_000): Promise<string[]> {
  let gaps: Array<{ reason: string | null; committedMono: number }> = [];
  await waitFor(async () => {
    gaps = (await ctx.store.eventsOfRun(ctx.page.engine.run)).filter((event) => event.kind === "gap");
    return gapCommitted(gaps, sinceMono, reason).length === 0;
  }, timeoutMs, 250);
  ctx.notes.gaps = gaps.map((gap) => gap.reason);
  return gapCommitted(gaps, sinceMono, reason);
}

/** The run's background and its fault at the random moment. */
async function atMoment(ctx: Ctx, fault: (activity: Activity) => Promise<void>): Promise<{ activity: Activity; faultMono: number }> {
  const activity = new Activity(ctx.page);
  activity.start();
  await sleep(ctx.momentMs);
  ctx.arm();
  const faultMono = mono();
  await fault(activity);
  return { activity, faultMono };
}

/** The stop the exit closed for, as the engine saw it: the operator says
 *  first that the exit closed (its `state` as the exit is cut) and a moment
 *  later the step with its reason (the page's transition) — so the reason is
 *  read once a state with one came since the fault, or after `waitMs`
 *  without one (then the check says none was seen). */
async function stoppedSince(ctx: Ctx, faultMono: number, reasons: readonly string[], halted: boolean | null, waitMs = 3000): Promise<string[]> {
  await ctx.page.engine.waitState((state) => state.stopReason !== null, waitMs, faultMono);
  return stoppedFor(transitions(ctx.page), faultMono, reasons, halted);
}

/** After a stop that holds: it holds for `holdMs`, then the engine starts
 *  the page and it comes up. */
async function standsThenStarts(ctx: Ctx, fromMono: number, holdMs: number, what: string): Promise<Record<string, string[]>> {
  await sleep(holdMs);
  const stood = stoodBetween(transitions(ctx.page), fromMono, mono(), what);
  const restart = mono();
  const engine = ctx.page.engine;
  const result = await engine.command("restartBrowser");
  const up = result.ok ? await engine.waitState((state) => state.exitOpen && atLeast(state.step, "exit_open"), 60_000, restart) : null;
  return { stands: stood, startsOnCommand: up ? [] : [`restartBrowser did not bring the page up: ${result.detail ?? ""}`] };
}

// ── the operator's process ───────────────────────────────────────────────

/** The operator killed (SIGKILL) or hung (SIGSTOP, then the watchdog). */
function operatorLoss(how: "kill" | "hang"): Scenario["run"] {
  return async (ctx) => {
    const engine = ctx.page.engine;
    const pid = await servicePid(ctx, "operator");
    const { activity, faultMono } = await atMoment(ctx, () => inPage(ctx, ["kill", how === "kill" ? "-KILL" : "-STOP", String(pid)]).then(() => undefined));
    // The connection to the engine goes with the process (the watchdog's
    // kill, for a hung one: 5 s without a heartbeat).
    const dropped = await engine.waitClosed(how === "kill" ? 5000 : 12_000);
    ctx.notes.droppedAfterMs = Math.round(mono() - faultMono);
    activity.stop();
    const checks: Record<string, string[]> = { linkDropped: dropped ? [] : ["the engine's connection outlived the operator"] };
    checks.exitClosed = exitClosedWithin(transitions(ctx.page), closures(ctx.page), faultMono, how === "kill" ? 1000 : 9000);
    const replaced = await waitFor(async () => {
      try {
        return (await servicePid(ctx, "operator")) !== pid;
      } catch {
        return false;
      }
    }, 20_000, 200);
    if (!replaced) checks.replaced = ["s6 did not start a new operator in 20 s"];
    ctx.notes.replacedAfterMs = Math.round(mono() - faultMono);
    await engine.reconnect(40_000);
    const back = mono();
    ctx.notes.reconnectedAfterMs = Math.round(back - faultMono);
    // An operator that starts again stands until the engine starts the page
    // (stage 1, amendment 17); its start writes the operator_start gap.
    Object.assign(checks, await standsThenStarts(ctx, back, 3000, "after the operator started again"));
    ctx.notes.upAfterMs = Math.round(mono() - faultMono);
    checks.gap = await waitGap(ctx, "operator_start", faultMono);
    return { faultMono, checks, attempts: activity.issued };
  };
}

/** Control of Chrome lost: the holder killed, Chrome killed, or the
 *  DevTools connection broken with every process alive. The exit closes,
 *  Chrome goes, and the page starts again by itself. */
function controlLoss(how: "holder" | "chrome" | "cdp-break"): Scenario["run"] {
  return async (ctx) => {
    const engine = ctx.page.engine;
    const fault = async () => {
      if (how === "holder") await inPage(ctx, ["/command/s6-svc", "-k", "/run/service/cdp-holder"]);
      else if (how === "chrome") await inPage(ctx, ["kill", "-KILL", String(await servicePid(ctx, "chrome"))]);
      else await breakCdp(ctx);
    };
    const { activity, faultMono } = await atMoment(ctx, fault);
    const checks: Record<string, string[]> = {};
    const closed = await engine.waitState((state) => !state.exitOpen, 6000, faultMono);
    // The broken connection is mended before the next Chrome connects.
    if (how === "cdp-break") await dropRules(ctx, CDP_BREAK);
    activity.stop();
    checks.exitClosed = exitClosedWithin(transitions(ctx.page), closures(ctx.page), faultMono, how === "cdp-break" ? 3000 : 1000);
    // A killed Chrome is named chrome_crashed when s6 has reaped it by the
    // time the operator asks, cdp_lost otherwise; either is a failure with a
    // retry. Which one, the run notes.
    if (closed) checks.stopReason = await stoppedSince(ctx, faultMono, ["cdp_lost", "chrome_crashed"], false);
    ctx.notes.stopReason = transitions(ctx.page).find((state) => state.atMono >= faultMono && state.stopReason !== null)?.stopReason ?? null;
    const alarm = engine.alarms.find(({ atMono, alarm: a }) => atMono >= faultMono && a.kind === "cdp_lost");
    checks.alarm = alarm ? [] : ["no cdp_lost alarm"];
    if (alarm) ctx.notes.alarm = alarm.alarm.detail;
    await engine.waitState((state) => state.exitOpen && atLeast(state.step, "exit_open"), 40_000, faultMono);
    checks.upByItself = upWithin(transitions(ctx.page), faultMono, 40_000, "after the control loss");
    return { faultMono, checks, attempts: activity.issued };
  };
}

// ── the page's proxy ─────────────────────────────────────────────────────

/** `site`: the scenario is about the site's requests that waited when the
 *  proxy failed (PR 7) — there must have been some. */
function proxyFault(how: "down" | "auth", site = false): Scenario["run"] {
  return async (ctx) => {
    const engine = ctx.page.engine;
    let waiting: WaitingRequest[] = [];
    const { activity, faultMono } = await atMoment(ctx, async () => {
      // What waits right now — asked an admission and not given one, or
      // admitted and not ended — is cancelled by the failure, for good.
      waiting = engine.waiting().map((request) => ({ page: ctx.page.info.name, method: request.method, target: request.target }));
      await ctx.stand.socks(how === "down" ? { down: true } : { refuseAuth: true });
    });
    const checks: Record<string, string[]> = {};
    // The exit IP is checked every 2 s on the stand (engine.ts STAND_PARAMS).
    await engine.waitState((state) => !state.exitOpen, 6000, faultMono);
    checks.exitClosed = exitClosedWithin(transitions(ctx.page), closures(ctx.page), faultMono, 3500);
    checks.stopReason = await stoppedSince(ctx, faultMono, how === "down" ? ["proxy_unavailable"] : ["proxy_auth"], false);
    const outageMs = 2500 + Math.round(ctx.random() * 2000);
    await sleep(outageMs);
    checks.stoodWhileDown = stoodBetween(transitions(ctx.page), faultMono + 3500, mono(), "while the proxy failed");
    const recovered = mono();
    await ctx.stand.socks(how === "down" ? { down: false } : { refuseAuth: false });
    activity.stop();
    await engine.waitState((state) => state.exitOpen && atLeast(state.step, "exit_open"), 40_000, recovered);
    // Back with the same IP: the work resumes by itself (plan §4.5).
    checks.upByItself = upWithin(transitions(ctx.page), recovered, 40_000, "after the proxy came back");
    const upAt = transitions(ctx.page).find((state) => state.atMono >= recovered && state.exitOpen)?.atMono ?? mono();
    ctx.notes.outageMs = outageMs;
    ctx.notes.upAfterMs = Math.round(upAt - recovered);
    ctx.notes.waitingAtFailure = waiting.length;
    if (site) {
      // Long enough for a cancelled request to come back, if it would.
      await sleep(8000);
      checks.waitedAtFailure = waiting.length > 0 ? [] : ["no request of the site waited when the proxy failed: the run proves nothing about their cancellation"];
    }
    // None of them goes after the recovery, whatever admission it is given
    // then (plan §4.5; nothing waits until the site's requests do — PR 7).
    checks.cancelledStayCancelled = sentAfterRecovery(await ctx.stand.journal(ctx.journalSince), waiting, ctx.pagesByAddress, recovered);
    return { faultMono, checks, attempts: activity.issued };
  };
}

/** The exit IP changed: the page stands until the owner decides — the
 *  engine's restartBrowser — even when the IP comes back (plan §4.5). */
async function exitIpChange(ctx: Ctx): Promise<ScenarioOutcome> {
  const engine = ctx.page.engine;
  const { activity, faultMono } = await atMoment(ctx, () => ctx.stand.config({ exitIp: STAND_OTHER_EXIT_IP }));
  const checks: Record<string, string[]> = {};
  await engine.waitState((state) => !state.exitOpen, 6000, faultMono);
  activity.stop();
  checks.exitClosed = exitClosedWithin(transitions(ctx.page), closures(ctx.page), faultMono, 3500);
  checks.stopReason = await stoppedSince(ctx, faultMono, ["exit_ip_changed"], true);
  await ctx.stand.config({ exitIp: STAND_EXIT_IP });
  const restored = mono();
  // Two checks and the longest retry would have passed: it still stands.
  Object.assign(checks, await standsThenStarts(ctx, restored, 6000, "after the IP came back"));
  return { faultMono, checks, attempts: activity.issued };
}

// ── the engine ───────────────────────────────────────────────────────────

/** The engine goes silent (no pong, nothing): after 5 s the operator counts
 *  the link lost and closes it; the page stays up; the engine connects
 *  again and gets every outcome it had not acknowledged. */
async function engineLinkLoss(ctx: Ctx): Promise<ScenarioOutcome> {
  const engine = ctx.page.engine;
  let burst: number[] = [];
  const { activity, faultMono } = await atMoment(ctx, async (running) => {
    running.stop();
    // Requests sent the instant the engine goes silent: their outcomes come
    // and are committed, but never acknowledged on this connection.
    burst = await engine.issueHub(5);
    engine.sendIssued(burst);
    await engine.drop("silent");
  });
  const checks: Record<string, string[]> = {};
  const dropped = await engine.waitClosed(10_000);
  const droppedAt = engine.closedAtMono;
  if (!dropped || droppedAt === null) checks.linkLoss = ["the operator did not count the silent link lost in 10 s"];
  else {
    const after = droppedAt - faultMono;
    ctx.notes.lostAfterMs = Math.round(after);
    // The operator's 5 s (plan §4.13), counted from the last thing heard.
    checks.linkLoss = after >= 3500 && after <= 7500 ? [] : [`the link was counted lost ${Math.round(after)} ms after the engine went silent (expected 5 s)`];
  }
  await engine.reconnect(20_000);
  const back = engine.state;
  // A lost engine is no reason to stop the page (plan §4.9: sockets and the
  // buffer go on; only admissions stop).
  checks.pageStayedUp = back !== null && back.exitOpen && back.stopReason === null ? [] : [`the page was not up when the engine came back: ${JSON.stringify(back)}`];
  await sleep(1000);
  ctx.notes.redelivered = (await ctx.store.redeliveries(engine.run)).outcomes;
  return { faultMono, checks, attempts: [...activity.issued, ...burst] };
}

/** The engine restarts (a Hub deploy): a new owner generation says hello;
 *  the operator answers `quiesced` once the previous owner's work is over;
 *  the new engine asks `recover` about what it issued and has no outcome
 *  of; the page stays up.
 *
 *  `inFlight` (needs the site, PR 7): the restart comes inside a confirmed
 *  window — the stand's Fansly holds its answer for 8 s, the run waits until
 *  that very request has arrived there, and only then the engine goes. So a
 *  request that left is really among what `recover` is asked about, and
 *  "not sent" of it is caught (C6). */
function engineRestart(inFlight: boolean): Scenario["run"] {
  return async (ctx) => {
    const before = ctx.page.engine;
    let burst: number[] = [];
    let engine = before;
    let restartMono = 0;
    const { activity, faultMono } = await atMoment(ctx, async (running) => {
      running.stop();
      if (inFlight) {
        // With the site live, one operation of the page in flight
        // (admissions.ts): the request goes in its turn.
        let sent: number | null = null;
        await waitFor(async () => (sent = await before.sendHubInTurn("/api/v1/account/me", "delayMs=8000")) !== null, 20_000, 100);
        burst = sent === null ? [] : [sent];
      } else {
        // Outcomes on their way at the restart: a burst, past the turns (no
        // session of the site, so nothing of it leaves).
        burst = await before.issueHub(5);
        before.sendIssued(burst);
      }
      if (inFlight) {
        const rids = burst.map((id) => before.ridOf(id));
        await waitFor(async () => (await ctx.stand.journal(ctx.journalSince)).some((event) => event.type === "req" && event.role === "api" && event.method !== "OPTIONS" && rids.includes(String(event.rid))), 25_000, 150);
      }
      restartMono = mono();
      engine = await ctx.page.restartEngine();
    });
    const previousGeneration = before.generation;
    await engine.connectRetrying(20_000);
    const checks: Record<string, string[]> = {};
    const quiesced = await waitFor(() => engine.quiesced.length > 0, inFlight ? 40_000 : 10_000);
    checks.quiesced = quiesced && engine.quiesced[0]!.previousGeneration === previousGeneration ? [] : [`no quiesced for generation ${previousGeneration}: ${JSON.stringify(engine.quiesced)}`];
    ctx.notes.quiesced = engine.quiesced[0] ?? null;
    // What the previous engine issued and has no committed outcome of.
    const issued = [...activity.issued, ...burst];
    const committed = new Set((await ctx.store.outcomes(ctx.page.info.name, issued)).map((row) => row.attemptId));
    const open = issued.filter((id) => !committed.has(id));
    ctx.notes.recovered = open.length;
    engine.recover(open);
    const answered = await waitFor(() => engine.recoverResults.length > 0, 10_000);
    checks.recoverAnswered = answered ? [] : ["no recoverResult in 10 s"];
    const state = engine.state;
    checks.pageStayedUp = state !== null && isUp(engine) ? [] : [`a new owner stopped the page: ${JSON.stringify(state)}`];
    await sleep(1000);
    ctx.notes.redelivered = (await ctx.store.redeliveries(engine.run)).outcomes;
    if (inFlight) {
      await sleep(9000);
      checks.inFlightAtRestart = inFlightAtRestart(await ctx.stand.journal(ctx.journalSince), burst.map((id) => before.ridOf(id)), restartMono);
    }
    return { faultMono, checks, attempts: issued };
  };
}

// ── the database, the disk, the container ────────────────────────────────

/** The stand's Postgres stops: the engine commits nothing, acknowledges
 *  nothing; the operator's buffer keeps it all and the page stays up; once
 *  the database is back, everything is committed once. */
async function databaseDown(ctx: Ctx): Promise<ScenarioOutcome> {
  const postgres = process.env.STAND_POSTGRES_CONTAINER ?? "";
  if (!postgres) throw new Error("STAND_POSTGRES_CONTAINER is not set");
  const engine = ctx.page.engine;
  const failuresBefore = engine.commitFailures;
  // Issued before the outage (the engine records its attempts first), sent
  // once the database is gone: their outcomes come while it is down.
  const pending = await engine.issueHub(5);
  const { activity, faultMono } = await atMoment(ctx, async (running) => {
    running.stop();
    await ctx.docker.action(postgres, "stop", 2);
    engine.sendIssued(pending);
  });
  const checks: Record<string, string[]> = {};
  // Longer than the engine's connection attempt (5 s, runner/pg.ts): a
  // commit tried at the start of the outage fails before the database is
  // back, never just waits it out.
  const downMs = 6000 + Math.round(ctx.random() * 3000);
  await sleep(downMs);
  await ctx.docker.action(postgres, "start");
  const back = await ctx.store.reachable(30_000);
  activity.stop();
  checks.databaseBack = back ? [] : ["the stand's database did not come back in 30 s"];
  ctx.notes.downMs = downMs;
  ctx.notes.commitFailures = engine.commitFailures - failuresBefore;
  checks.outageFelt = engine.commitFailures > failuresBefore ? [] : ["nothing was to be committed while the database was down: the run proves nothing"];
  // The page did not stop for it (plan §4.9).
  const stops = transitions(ctx.page).filter((state) => state.atMono >= faultMono && (!state.exitOpen || state.stopReason !== null));
  checks.pageStayedUp = stops.length === 0 && isUp(engine) ? [] : [`the page stopped while the database was down: ${JSON.stringify(stops[0] ?? engine.state)}`];
  return { faultMono, checks, attempts: [...activity.issued, ...pending] };
}

/** The buffer's disk fills up (only the disk page's small fixed-size tmpfs
 *  volume): the page stops with `disk_full`, an alarm; the room comes back,
 *  a `disk_full` gap is written first, and the page starts by itself. */
async function diskFull(ctx: Ctx): Promise<ScenarioOutcome> {
  const engine = ctx.page.engine;
  const fill = "/data/buffer/pb-suite-fill";
  const { activity, faultMono } = await atMoment(ctx, async () => {
    const out = await inPage(ctx, ["sh", "-c", `free=$(df -B1 --output=avail /data/buffer | tail -1); size=$((free - 150 * 1024 * 1024)); [ "$size" -gt 0 ] && fallocate -l "$size" ${fill} && echo "$size"`]);
    ctx.notes.filledBytes = Number(out.trim());
  });
  const checks: Record<string, string[]> = {};
  await engine.waitState((state) => !state.exitOpen, 6000, faultMono);
  checks.exitClosed = exitClosedWithin(transitions(ctx.page), closures(ctx.page), faultMono, 2500);
  checks.stopReason = await stoppedSince(ctx, faultMono, ["disk_full"], false);
  const alarm = engine.alarms.find(({ atMono, alarm: a }) => atMono >= faultMono && a.kind === "buffer" && a.detail.full === true);
  checks.alarm = alarm ? [] : ["no buffer alarm saying full"];
  const fullMs = 2500 + Math.round(ctx.random() * 2000);
  await sleep(fullMs);
  checks.stoodWhileFull = stoodBetween(transitions(ctx.page), faultMono + 2500, mono(), "while the disk was full");
  const freed = mono();
  await inPage(ctx, ["rm", "-f", fill]);
  activity.stop();
  await engine.waitState((state) => state.exitOpen && atLeast(state.step, "exit_open"), 40_000, freed);
  checks.upByItself = upWithin(transitions(ctx.page), freed, 40_000, "after the room came back");
  checks.gap = await waitGap(ctx, "disk_full", faultMono);
  return { faultMono, checks, attempts: activity.issued };
}

/** The page's container restarts with its volumes: the profile and the
 *  buffer are the same, the owner generation is remembered (an older one is
 *  refused), and the page stands until the engine starts it. */
async function containerRestart(ctx: Ctx): Promise<ScenarioOutcome> {
  const engine = ctx.page.engine;
  const profileInode = (await inPage(ctx, ["stat", "-c", "%i", "/data/profile/Default"])).trim();
  const bufferId = engine.bufferId;
  const { activity, faultMono } = await atMoment(ctx, () => ctx.docker.action(ctx.page.info.container, "restart", 10));
  activity.stop();
  await ctx.docker.action(ctx.page.info.capture, "restart", 1).catch((error: unknown) => (ctx.notes.captureRestart = String(error)));
  const checks: Record<string, string[]> = {};
  await engine.reconnect(90_000);
  const back = mono();
  checks.sameBuffer = engine.bufferId === bufferId ? [] : [`the buffer is another after the restart (${bufferId} → ${engine.bufferId})`];
  Object.assign(checks, await standsThenStarts(ctx, back, 3000, "after the container restarted"));
  const after = (await inPage(ctx, ["stat", "-c", "%i", "/data/profile/Default"])).trim();
  checks.sameProfile = after === profileInode ? [] : [`the profile is another after the restart (inode ${profileInode} → ${after})`];
  // The owner generation outlived the restart: an older owner is refused.
  const stale = ctx.page.newEngine();
  stale.generation = engine.generation - 1;
  const refused = await stale.connect(10_000, false).then(
    () => false,
    (error: unknown) => String(error).includes("generation_stale"),
  );
  await stale.drop("clean");
  checks.olderOwnerRefused = refused || engine.generation <= 1 ? [] : ["a hello of an older generation was taken after the restart"];
  checks.gap = await waitGap(ctx, "operator_start", faultMono);
  return { faultMono, checks, attempts: activity.issued };
}

/** stopPage: the exit closes before CDP goes (plan §4.1); the page holds
 *  until restartBrowser. */
async function plannedStop(ctx: Ctx): Promise<ScenarioOutcome> {
  const engine = ctx.page.engine;
  const { activity, faultMono } = await atMoment(ctx, async () => {
    const result = await engine.command("stopPage");
    if (!result.ok) throw new Error(`stopPage: ${result.detail ?? ""}`);
  });
  activity.stop();
  const checks: Record<string, string[]> = {};
  checks.exitClosed = exitClosedWithin(transitions(ctx.page), closures(ctx.page), faultMono, 1000);
  checks.stopReason = await stoppedSince(ctx, faultMono, ["owner_stop"], true);
  Object.assign(checks, await standsThenStarts(ctx, mono(), 3000, "after stopPage"));
  return { faultMono, checks, attempts: activity.issued };
}

// ── controls: each must show its violation in every run ──────────────────

async function controlLeak(ctx: Ctx): Promise<ScenarioOutcome> {
  const rid = `leak-${Math.floor(ctx.random() * 1e9)}`;
  const { activity, faultMono } = await atMoment(ctx, async () => {
    ctx.notes.leak = await leak({ ip: ctx.topology.socksIp, port: ctx.topology.socksPort, username: STAND_SOCKS_USER, password: ctx.topology.socksPassword }, ctx.topology.caFile, rid);
  });
  activity.stop();
  return { faultMono, checks: {}, attempts: activity.issued, planted: plantedLeak(rid) };
}

async function controlBypass(ctx: Ctx): Promise<ScenarioOutcome> {
  const target = ctx.topology.socksIp;
  const { activity, faultMono } = await atMoment(ctx, async () => {
    await inPage(ctx, ["nft", "insert", "rule", "inet", "pb", "output", "meta", "skuid", "pb-chrome", "ip", "daddr", target, "tcp", "dport", "443", "accept", "comment", `"${BYPASS}"`]);
    try {
      ctx.notes.bypass = (
        await ctx.docker.exec(ctx.page.info.container, ["node", "-e", `const s=require("net").connect(443,${JSON.stringify(target)},()=>{s.write("pb-suite bypass");setTimeout(()=>{s.destroy();console.log("connected")},300)});s.on("error",(e)=>console.log(e.code))`], "pb-chrome")
      ).output.trim();
    } finally {
      await dropRules(ctx, BYPASS);
    }
  });
  activity.stop();
  return { faultMono, checks: {}, attempts: activity.issued, planted: plantedBypass(ctx.page.info.egressIp, target) };
}

/** An engine that commits outcomes with no key and acknowledges late,
 *  dropped between the two: the operator delivers again, and the naive
 *  table holds the outcome twice. */
async function controlDuplicate(ctx: Ctx): Promise<ScenarioOutcome> {
  const naive = await ctx.page.restartEngine({ naive: true });
  await naive.connectRetrying(20_000);
  const issued = await naive.sendHub(3);
  ctx.arm();
  const faultMono = mono();
  // Committed (naive) on arrival, acknowledged 1.5 s later: drop between.
  await waitFor(async () => (await ctx.store.outcomes(ctx.page.info.name, issued, true)).length >= issued.length, 5000);
  await naive.drop("clean");
  await naive.connectRetrying(20_000);
  await sleep(2500);
  const normal = await ctx.page.restartEngine();
  await normal.connectRetrying(20_000);
  return { faultMono, checks: {}, attempts: issued, naive: true, planted: plantedDuplicates(issued) };
}

/** An engine that acknowledges events before it commits them, with its
 *  database down while the operator's start writes its gap: the operator
 *  deletes what the engine never kept. Nothing comes after it — the lost
 *  event is the tail, and only the bound recorded off the wire shows it. */
async function controlHole(ctx: Ctx): Promise<ScenarioOutcome> {
  const postgres = process.env.STAND_POSTGRES_CONTAINER ?? "";
  if (!postgres) throw new Error("STAND_POSTGRES_CONTAINER is not set");
  const early = await ctx.page.restartEngine({ ackEarly: true });
  await early.connectRetrying(20_000);
  await early.ensureUp(60_000);
  await sleep(ctx.momentMs);
  ctx.arm();
  const faultMono = mono();
  await ctx.docker.action(postgres, "stop", 2);
  try {
    // The operator starts again: its operator_start gap is acknowledged
    // and lost.
    const received = early.eventsReceived;
    await inPage(ctx, ["kill", "-KILL", String(await servicePid(ctx, "operator"))]);
    await early.waitClosed(5000);
    await early.reconnect(40_000);
    ctx.notes.received = await waitFor(() => early.eventsReceived > received, 15_000);
    // The database stays down until that commit has failed.
    ctx.notes.lost = await waitFor(() => early.eventsLost > 0, 20_000);
  } finally {
    await ctx.docker.action(postgres, "start");
    await ctx.store.reachable(30_000);
  }
  const normal = await ctx.page.restartEngine();
  await normal.connectRetrying(20_000);
  await normal.ensureUp(60_000);
  ctx.notes.lostSeqs = early.lostSeqs;
  return { faultMono, checks: {}, attempts: [], planted: plantedTail(early.bufferId, early.lostSeqs) };
}

/** One socket is admitted; two are opened under it — from the page's own
 *  address, through its SOCKS5, past the operator. C1 must see the second
 *  as a repeat: an admission is one socket. */
async function controlDoubleOpen(ctx: Ctx): Promise<ScenarioOutcome> {
  const socket = `wss://${FANSLY_HOSTS.ws[0]}/?v=3`;
  const login = { username: "pb-suite-control", password: randomBytes(16).toString("hex") };
  const { activity, faultMono } = await atMoment(ctx, async () => {
    await ctx.stand.socks({ extraLogin: login });
    try {
      ctx.page.engine.journalGrant("ws", "control-double-open", socket);
      const told = { socks: { ip: ctx.topology.socksIp, port: ctx.topology.socksPort, ...login }, ca: LEVER_CA, sockets: { host: FANSLY_HOSTS.ws[0], path: "/?v=3", opens: 2, keepMs: 300 } };
      ctx.notes.opens = (await inPage(ctx, ["node", "--no-warnings", LEVER, JSON.stringify(told)])).trim();
    } finally {
      await ctx.stand.socks({ extraLogin: null });
    }
  });
  activity.stop();
  // The repeat is the lever's second socket — told apart by the control's
  // own SOCKS5 login — and nothing else.
  const levers = leverSockets(await ctx.stand.journal(ctx.journalSince));
  ctx.notes.leverSockets = levers;
  return { faultMono, checks: {}, attempts: activity.issued, planted: levers.length === 2 ? plantedRepeat(levers[1]!) : [] };
}

/** The sockets opened over a control's own SOCKS5 login, in order. */
function leverSockets(journal: readonly JournalEvent[]): string[] {
  const extra = new Set(journal.filter((event) => event.type === "socks.login" && event.extra === true && event.ok === true).map((event) => Number(event.socksId)));
  return journal.filter((event) => event.type === "ws.open" && extra.has(Number(event.socksId))).map((event) => String(event.wsId));
}

/** The capture stops in the middle of the run: with no live capture there
 *  is no evidence of what left, and C4 must say so — not pass on silence. */
async function controlNoCapture(ctx: Ctx): Promise<ScenarioOutcome> {
  const { activity, faultMono } = await atMoment(ctx, () => ctx.docker.action(ctx.page.info.capture, "stop", 1));
  await sleep(1000);
  activity.stop();
  return { faultMono, checks: {}, attempts: activity.issued, planted: plantedNoCapture(ctx.page.info.controlIp) };
}

/** The operator's own journal (inside/journal.ts): the `requests` lines
 *  that end a request, written at or after `sinceWall`. */
async function operatorEnds(ctx: Ctx, sinceWall: number): Promise<OperatorRequestLine[]> {
  const out = await inPage(ctx, ["node", "--no-warnings", JOURNAL, JSON.stringify({ kind: "requests", sinceWall, decision: "ended" })]);
  return out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as OperatorRequestLine);
}

/** What a run about an admission's deadline must show (criteria.ts). The
 *  scenario: one site request the operator journaled as not sent for its
 *  deadline, with a CONNECT of the API host held across that deadline — or
 *  the run proves nothing (`heldPastDeadline`); and that request never
 *  arrives (`heldRequestNeverArrived`). The control (`late`): a request
 *  that arrived after its deadline over a CONNECT held across it, which C1
 *  calls late (`lateSendShown`). */
async function expiryChecks(ctx: Ctx, journal: readonly JournalEvent[], grants: readonly Grant[], host: string, late: boolean, sinceWall: number): Promise<{ checks: Record<string, string[]>; planted?: Planted[] }> {
  if (late) {
    const shown = lateUnderHold(journal, grants, ctx.page.info.name, ctx.page.info.egressIp, host, ctx.pagesByAddress);
    ctx.notes.lateArrivals = shown.late.map(({ violation: _violation, ...send }) => send);
    // The control's C1 may show these late sends and nothing else.
    return { checks: { lateSendShown: shown.violations }, planted: plantedLate(shown.late) };
  }
  const offset = Date.now() - mono();
  const lines = await operatorEnds(ctx, sinceWall);
  const { expired, violations } = expiredUnderHold(journal, grants, lines, ctx.page.info.name, ctx.page.info.egressIp, host, (at) => at + offset);
  ctx.notes.operatorEnds = lines.length;
  ctx.notes.expired = expired.map((request) => ({ attemptId: request.attemptId, rid: request.rid, windowMs: Math.round(request.deadlineMono - request.grantedMono), refusedAfterDeadlineMs: Math.round(request.refusedWall - (request.deadlineMono + offset)), holds: request.holds.map((hold) => ({ socksId: hold.socksId, heldAfterAdmissionMs: Math.round(hold.heldMono - request.grantedMono), endedAfterDeadlineMs: hold.endedMono === null ? null : Math.round(hold.endedMono - request.deadlineMono) })) }));
  return { checks: { heldPastDeadline: violations, heldRequestNeverArrived: expiredArrivals(journal, expired) } };
}

/** The control's side of the expiry, live against the operator in main (it
 *  sends no request of its own yet): the engine admits one request for
 *  6 s, and the lever sends it from the page's own address through a CONNECT
 *  the SOCKS5 holds 10 s — as an operator would that did not look at the
 *  deadline. The run must show that request arriving after its deadline
 *  over the CONNECT held across it, C1 calling it late (the same check
 *  `control-site-late-send` runs on the real operator) — and C7 missing its
 *  outcome: Fansly answered it, and the engine has nothing of it. */
async function controlHeldLate(ctx: Ctx): Promise<ScenarioOutcome> {
  const api = FANSLY_HOSTS.api[0];
  const login = { username: "pb-suite-control", password: randomBytes(16).toString("hex") };
  const rid = `held-${randomBytes(5).toString("hex")}`;
  const path = `/api/v1/account/me?rid=${rid}`;
  const { activity, faultMono } = await atMoment(ctx, async () => {
    await ctx.stand.socks({ extraLogin: login, hold: { host: api, ms: 10_000 } });
    try {
      await ctx.stand.drop(api);
      ctx.page.engine.journalGrant("site", rid, `${api}${path}`, 6000);
      const told = { socks: { ip: ctx.topology.socksIp, port: ctx.topology.socksPort, ...login }, ca: LEVER_CA, request: { host: api, path, timeoutMs: 15_000 } };
      ctx.notes.sent = (await inPage(ctx, ["node", "--no-warnings", LEVER, JSON.stringify(told)])).trim();
    } finally {
      await ctx.stand.socks({ extraLogin: null, hold: null });
    }
  });
  activity.stop();
  const grants = ctx.page.enginesOfRun.flatMap((owner) => owner.grants);
  const expiry = await expiryChecks(ctx, await ctx.stand.journal(ctx.journalSince), grants, api, true, 0);
  return { faultMono, checks: expiry.checks, attempts: activity.issued, planted: [...(expiry.planted ?? []), ...plantedUnkeptAnswer(ctx.page.info.name, rid)] };
}

/** Events made and lost before the engine ever received them — the second
 *  half of C7 must see them by the stand's own record of what it made:
 *
 *  - frames: the lever opens the site's socket from the page's own address
 *    (one, under an admission: C1 holds) and the stand's Fansly sends three
 *    frames into it. The operator never saw that socket, so no number of
 *    its buffer is missing and nothing came on the wire.
 *  - a site answer whose outcome is kept and whose data event is not: the
 *    lever sends one API request under a site admission of a real attempt,
 *    Fansly answers it, and the stand commits that attempt's outcome as the
 *    engine does on its `siteDone` — but no `site.response` event of it
 *    ever comes. The operator in main sends neither (PR 7), so this half
 *    stands in for the engine's side; what it checks is that C7 asks for
 *    the answer's event and not only for its outcome (C6 is satisfied).
 *
 *  No gap mark covers either. */
async function controlLostFrames(ctx: Ctx): Promise<ScenarioOutcome> {
  const socket = `wss://${FANSLY_HOSTS.ws[0]}/?v=3`;
  const api = FANSLY_HOSTS.api[0];
  const login = { username: "pb-suite-control", password: randomBytes(16).toString("hex") };
  const engine = ctx.page.engine;
  const rid = `lost-${randomBytes(5).toString("hex")}`;
  const path = `/api/v1/account/me?rid=${rid}`;
  let pushed = 0;
  let siteAttempt = 0;
  let wsId: string | undefined;
  const { activity, faultMono } = await atMoment(ctx, async () => {
    await ctx.stand.socks({ extraLogin: login });
    try {
      engine.journalGrant("ws", "control-lost-frames", socket);
      siteAttempt = (await ctx.store.issue(ctx.page.info.name, engine.run, "site", [rid]))[0] ?? 0;
      engine.journalGrant("site", rid, `${api}${path}`, engine.windowMs, siteAttempt);
      const told = { socks: { ip: ctx.topology.socksIp, port: ctx.topology.socksPort, ...login }, ca: LEVER_CA, sockets: { host: FANSLY_HOSTS.ws[0], path: "/?v=3", opens: 1, keepMs: 3000 }, request: { host: api, path, timeoutMs: 10_000 } };
      const lever = inPage(ctx, ["node", "--no-warnings", LEVER, JSON.stringify(told)]).then(
        (out) => out.trim(),
        (error: unknown) => `failed: ${String(error)}`,
      );
      await waitFor(async () => (wsId = (await ctx.stand.state()).sockets.find((open) => open.from === ctx.page.info.egressIp)?.wsId) !== undefined, 8000, 100);
      for (let n = 0; wsId !== undefined && n < 3; n++) {
        pushed += await ctx.stand.push(200, wsId);
        await sleep(100);
      }
      ctx.notes.opens = await lever;
    } finally {
      await ctx.stand.socks({ extraLogin: null });
    }
  });
  activity.stop();
  // The engine's half of the site answer: its outcome, as on `siteDone`.
  const answered = (await ctx.stand.journal(ctx.journalSince)).find((event) => event.type === "res" && event.rid === rid);
  if (answered !== undefined && siteAttempt > 0) {
    await ctx.store.commitOutcome(ctx.page.info.name, engine.run, siteAttempt, "siteDone", "response", true, { type: "siteDone", siteRequestId: rid, attemptId: siteAttempt, sent: true, status: answered.status, body: "buffered" });
  }
  ctx.notes.pushed = pushed;
  ctx.notes.siteAnswer = { rid, attemptId: siteAttempt, status: answered?.status ?? null };
  return {
    faultMono,
    checks: {
      framesSent: pushed === 3 ? [] : [`the stand sent ${pushed} of 3 frames into the page's socket: the control showed nothing`],
      siteAnswered: answered?.status === 200 ? [] : [`Fansly did not answer the site request ${rid}: the control showed nothing about a lost site.response`],
    },
    attempts: [...activity.issued, ...(siteAttempt > 0 ? [siteAttempt] : [])],
    planted: wsId === undefined ? [] : plantedLostFrames(ctx.page.info.name, wsId, pushed, rid),
  };
}

// ── what needs the site (PR 7) ───────────────────────────────────────────

/** The site's own traffic for a run, once the operator loads the site: the
 *  common criteria then judge real admissions, and this checks there was
 *  traffic to judge. */
function withSite(base: Scenario["run"]): Scenario["run"] {
  return async (ctx) => {
    const outcome = await base(ctx);
    const grants = ctx.page.enginesOfRun.flatMap((engine) => engine.grants);
    outcome.checks.siteTraffic = grants.some((grant) => grant.kind === "site") ? [] : ["the site sent nothing to admit: the run proves nothing about it"];
    ctx.notes.grants = { hub: grants.filter((grant) => grant.kind === "hub").length, site: grants.filter((grant) => grant.kind === "site").length, ws: grants.filter((grant) => grant.kind === "ws").length };
    return outcome;
  };
}

/** An admission runs out while its connection is being set up (plan §5,
 *  stage 2: "истечение срока допуска во время установления соединения с
 *  последующим снятием задержки"). The engine's admissions last 6 s here;
 *  the page's connections to the API host are dropped — so that a request
 *  has none to ride, and needs a new one — and the SOCKS5 holds each CONNECT
 *  of that host for 10 s: past the admission, but inside the 15 s after
 *  which the operator's own SOCKS5 client gives up, so that it is the
 *  deadline that must stop the request, not that timeout — and then lets it
 *  go.
 *
 *  Safety is C1's, as in every run: nothing arrives after its admission's
 *  deadline. Whether the run proves anything is apart: the operator's own
 *  journal must say of one specific site request that it was not sent
 *  because its admission's deadline passed before the send (not a page's
 *  cancel, not a failed tunnel), and the stand's SOCKS5 must show a CONNECT
 *  of the API host held across that deadline (`heldPastDeadline`; with
 *  none, the run proves nothing and fails). That request must never arrive
 *  (`heldRequestNeverArrived`).
 *
 *  `late`: the control. The operator is given 14 s while the engine journals
 *  6 s: it sends when the CONNECT is let go, rightly by what it was told —
 *  and exactly as an operator would that did not check the deadline. A
 *  request must be seen arriving after its journaled deadline over a CONNECT
 *  held across it (`lateSendShown`), and C1 must show the late send. */
function admissionExpiry(late: boolean): Scenario["run"] {
  return async (ctx) => {
    const engine = ctx.page.engine;
    const api = FANSLY_HOSTS.api[0];
    // Every admission of the fault carries the run's windows, and the first
    // one after it needs a new connection: nothing is admitted until the
    // CONNECTs are held and the API's connections dropped — what the setup
    // admitted (with the usual 15 s) ends first, unheld.
    engine.holdAdmissions(true);
    await waitFor(() => !engine.admissionInFlight, 20_000, 50);
    engine.windowMs = late ? 14_000 : 6000;
    engine.journalWindowMs = late ? 6000 : null;
    const sinceWall = Date.now() - 1000;
    try {
      const { activity, faultMono } = await atMoment(ctx, async () => {
        await ctx.stand.socks({ hold: { host: api, ms: 10_000 } });
        await ctx.stand.drop(api);
        engine.holdAdmissions(false);
      });
      await sleep(14_000);
      await ctx.stand.socks({ hold: null });
      await sleep(8000);
      activity.stop();
      const grants = ctx.page.enginesOfRun.flatMap((owner) => owner.grants);
      const expiry = await expiryChecks(ctx, await ctx.stand.journal(ctx.journalSince), grants, api, late, sinceWall);
      return { faultMono, checks: expiry.checks, attempts: activity.issued, ...(expiry.planted ? { planted: expiry.planted } : {}) };
    } finally {
      engine.windowMs = 15_000;
      engine.journalWindowMs = null;
      await ctx.stand.socks({ hold: null });
    }
  };
}

/** The site's closed writes: it tries them (its own reports say so), the
 *  browser cancels each, none reaches Fansly (C2). */
async function siteClosedWrites(ctx: Ctx): Promise<ScenarioOutcome> {
  const { activity, faultMono } = await atMoment(ctx, async () => undefined);
  await sleep(12_000);
  activity.stop();
  return { faultMono, checks: { closedWriteAttempted: closedWriteAttempted(await ctx.stand.journal(ctx.journalSince), ctx.page.info.egressIp) }, attempts: activity.issued };
}

/** The site works for a while, no fault: every request it made, and every
 *  socket it opened, went under its own admission. */
/** The site sends a socket message spec §2.6 does not allow: it never
 *  leaves (the common criteria), and the page stops for it. */
async function siteForbidden(ctx: Ctx): Promise<ScenarioOutcome> {
  const engine = ctx.page.engine;
  const { activity, faultMono } = await atMoment(ctx, async () => undefined);
  const stopped = await engine.waitState((state) => state.stopReason === "unknown_ws_message", 30_000, faultMono);
  activity.stop();
  return { faultMono, checks: { stopped: stopped ? [] : ["the page did not stop for the forbidden message"] }, attempts: activity.issued };
}

async function siteSteady(ctx: Ctx): Promise<ScenarioOutcome> {
  const { activity, faultMono } = await atMoment(ctx, async () => undefined);
  await ctx.stand.config({ wsPush: { perMinute: 120, bytes: 400 } });
  await sleep(15_000);
  await ctx.stand.config({ wsPush: { perMinute: 0 } });
  activity.stop();
  const frames = (await ctx.store.eventsOfRun(ctx.page.engine.run)).filter((event) => event.frame !== null);
  ctx.notes.framesCommitted = frames.length;
  return { faultMono, checks: { frames: frames.length > 0 ? [] : ["no frame of the site's socket reached the engine"] }, attempts: activity.issued };
}

export const SCENARIOS: Scenario[] = [
  { name: "loss-operator-kill", proves: "the operator killed (SIGKILL): the exit dies with it, s6 brings a new one that stands until restartBrowser, an operator_start gap is written, every attempt resolved once", needs: [], page: "main", moment: [0, 1500], run: operatorLoss("kill") },
  { name: "loss-operator-hang", proves: "the operator hung (SIGSTOP): the watchdog kills it within its 5 s, then as loss-operator-kill", needs: [], page: "main", moment: [0, 1500], run: operatorLoss("hang") },
  { name: "loss-holder-kill", proves: "the CDP holder killed: the exit closes at once, cdp_lost alarm, Chrome goes, the page starts again by itself", needs: [], page: "main", moment: [0, 1500], run: controlLoss("holder") },
  { name: "loss-chrome-kill", proves: "Chrome killed: chrome_crashed (or cdp_lost), the exit closes, the page starts again by itself", needs: [], page: "main", moment: [0, 1500], run: controlLoss("chrome") },
  { name: "loss-cdp-break", proves: "the DevTools connection broken with every process alive (TCP reset): cdp_lost, the exit closes, the page starts again by itself", needs: [], page: "main", moment: [0, 1500], run: controlLoss("cdp-break") },
  { name: "loss-planned-stop", proves: "stopPage: the exit closes, the page holds (owner_stop) until restartBrowser", needs: [], page: "main", moment: [0, 1500], run: plannedStop },
  { name: "proxy-down", proves: "the page's SOCKS5 gone: proxy_unavailable, the exit closes, the page stands while it is gone and resumes by itself when it is back with the same IP", needs: [], page: "main", moment: [0, 1500], run: proxyFault("down") },
  { name: "proxy-auth", proves: "the SOCKS5 refuses the login: proxy_auth, the exit closes, resumes by itself once the login is taken again", needs: [], page: "main", moment: [0, 1500], run: proxyFault("auth") },
  { name: "exit-ip-change", proves: "the exit IP changed: exit_ip_changed, a halt that holds even when the IP comes back, until restartBrowser", needs: [], page: "main", moment: [0, 1500], run: exitIpChange },
  { name: "engine-link-loss", proves: "the engine silent for 5 s with outcomes on their way: the operator counts the link lost and closes it, the page stays up, the outcomes come again on the next connection, each committed once", needs: [], page: "main", moment: [300, 1500], run: engineLinkLoss },
  { name: "engine-restart", proves: "the engine restarts with outcomes on their way (a new owner generation): quiesced, recover answered, the page stays up, every attempt resolved once", needs: [], page: "main", moment: [300, 1500], run: engineRestart(false) },
  { name: "db-unavailable", proves: "the stand's Postgres down: nothing acknowledged, the page stays up, the buffer keeps it, everything committed once after", needs: [], page: "main", moment: [0, 1500], run: databaseDown },
  { name: "disk-full", proves: "the buffer's disk full (a fixed-size tmpfs volume): disk_full, the exit closes, an alarm; room back: a disk_full gap first, then the page starts by itself", needs: [], page: "disk", moment: [0, 1500], run: diskFull },
  { name: "container-restart", proves: "the page's container restarts: the same profile and buffer, the owner generation remembered, the page stands until restartBrowser", needs: [], page: "main", moment: [0, 1500], run: containerRestart },
  { name: "control-leak", proves: "control: an unadmitted read, a closed write and a socket with a forbidden message reach the stand — C1, C2 and C3 must catch them", needs: [], page: "main", moment: [0, 500], control: { C1: ["arrived without any admission", "a socket ("], C2: ["a closed write reached Fansly"], C3: ["a forbidden socket message reached Fansly"] }, run: controlLeak },
  { name: "control-bypass", proves: "control: a hole in the page's rules and a connection past the proxy — the OS capture (C4) and the direct listener (C5) must catch it", needs: [], page: "main", moment: [0, 500], control: { C4: ["traffic past the proxy"], C5: ["a connection past the proxy reached the stand directly"] }, run: controlBypass },
  { name: "control-no-capture", proves: "control: the capture stops during the run — C4 must say there is no evidence, not pass on silence", needs: [], page: "main", moment: [0, 500], control: { C4: ["no live capture of the page covers the run"] }, run: controlNoCapture },
  { name: "control-double-open", proves: "control: one socket admitted, two opened under it from the page's address — C1 must catch the repeat", needs: [], page: "main", moment: [0, 500], control: { C1: ["arrived again under one admission"] }, run: controlDoubleOpen },
  { name: "control-duplicate", proves: "control: an engine that commits without a key and acknowledges late, dropped between — C6 must catch the duplicate", needs: [], page: "main", moment: [0, 0], control: { C6: ["committed 2 times"] }, run: controlDuplicate },
  { name: "control-hole", proves: "control: an engine that acknowledges events before it commits them, its database down — C7 must catch the lost tail", needs: [], page: "main", moment: [0, 500], control: { C7: ["were never committed (the tail"] }, run: controlHole },
  { name: "control-lost-frames", proves: "control: frames Fansly sends into a socket of the page that the engine never receives, and a site answer whose outcome is stored and whose site.response event never comes, no gap mark over them — C7 must catch both against the stand's own record of what it made", needs: [], page: "main", moment: [0, 500], control: { C7: ["not stored as ws.in events", "has no stored site.response event"] }, run: controlLostFrames },
  { name: "control-held-late", proves: "control: a request admitted for 6 s goes from the page's address through a CONNECT held 10 s — the run must show it arriving after its deadline over the CONNECT held across it; C1 must call it late, and C7 must miss the outcome of a request Fansly answered", needs: [], page: "main", moment: [0, 500], control: { C1: ["arrived outside its admission window"], C7: ["was answered by Fansly"] }, run: controlHeldLate },
  { name: "site-steady", proves: "the site works (reads, its socket, frames): every request and socket under its own admission, frames committed", needs: ["PR7"], page: "main", moment: [0, 0], site: SITE_TRAFFIC, run: withSite(siteSteady) },
  { name: "site-loss-operator-kill", proves: "as loss-operator-kill with the site's requests waiting and Hub requests in flight (condition №1)", needs: ["PR7"], page: "main", moment: [0, 1500], site: SITE_TRAFFIC, run: withSite(operatorLoss("kill")) },
  { name: "site-loss-cdp-break", proves: "as loss-cdp-break with the site's requests waiting and Hub requests in flight (condition №1, decision №10's residual counted)", needs: ["PR7"], page: "main", moment: [0, 1500], site: SITE_TRAFFIC, run: withSite(controlLoss("cdp-break")) },
  { name: "site-loss-chrome-kill", proves: "as loss-chrome-kill with the site's traffic: a chrome_restart gap where its socket was open", needs: ["PR7"], page: "main", moment: [0, 1500], site: SITE_TRAFFIC, run: withSite(controlLoss("chrome")) },
  { name: "site-proxy-down", proves: "as proxy-down with the site's requests waiting: what waited at the failure never goes after the proxy is back, whatever admission it gets then (plan §4.5)", needs: ["PR7"], page: "main", moment: [3000, 6000], site: SITE_TRAFFIC, run: withSite(proxyFault("down", true)) },
  { name: "site-admission-expiry", proves: "an admission (6 s) runs out while the site request waits for its connection (the operator journals it not sent for its deadline; the SOCKS5 held its host's CONNECT 10 s across that deadline — inside the operator's 15 s SOCKS5 timeout) — then the hold goes: that request never arrives, and nothing arrives after its deadline (condition №2)", needs: ["PR7"], page: "main", moment: [0, 1500], site: SITE_TRAFFIC, run: withSite(admissionExpiry(false)) },
  { name: "control-site-late-send", proves: "control: the same hold, the operator told 14 s while the engine journals 6 s — a request must be seen arriving after its journaled deadline over a CONNECT held across it, as an unchecked deadline looks, and C1 must catch it", needs: ["PR7"], page: "main", moment: [0, 1500], site: SITE_TRAFFIC, control: { C1: ["arrived outside its admission window"] }, run: admissionExpiry(true) },
  { name: "site-engine-restart", proves: "the engine restarts while a Hub request that reached Fansly waits for its answer (the answer held 8 s, the arrival confirmed first): recover never says not_sent of it", needs: ["PR7"], page: "main", moment: [300, 1500], site: SITE_TRAFFIC, run: withSite(engineRestart(true)) },
  { name: "site-closed-writes", proves: "the site tries its closed writes (message/ack; its own reports say so) and none reaches Fansly: the rules extension and the operator both refuse them", needs: ["PR6", "PR7"], page: "main", moment: [0, 0], site: { ...SITE_TRAFFIC, writeEveryMs: 2000 }, run: withSite(siteClosedWrites) },
  { name: "site-forbidden-ws", proves: "a forbidden socket message never leaves: the page stops with unknown_ws_message", needs: ["PR7"], page: "main", moment: [0, 0], site: { ...SITE_TRAFFIC, forbiddenWs: true }, run: withSite(siteForbidden) },
];
