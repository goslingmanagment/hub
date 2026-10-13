// What a scenario gets: the stand as the runner sees it (stand/stand.sh
// writes /stand/work/pages.json and the secrets), the page under test with
// its engine, and the levers — the stand's Fansly, Docker through the
// stand's proxy, the stand's Postgres.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STAND_EXIT_IP, STAND_SOCKS_USER, mono, sleep } from "../shared.ts";
import type { Docker } from "./docker.ts";
import { StandEngine, STAND_ENV } from "./engine.ts";
import type { StandFansly } from "./fansly.ts";
import type { Store } from "./store.ts";

export interface PageInfo {
  /** The page's name on the stand (p1, p2 … and disk). */
  name: string;
  pageId: number;
  container: string;
  capture: string;
  controlIp: string;
  egressIp: string;
  /** "tmpfs": its buffer volume is a fixed-size tmpfs (the disk-full page). */
  buffer: "volume" | "tmpfs";
}

export interface Topology {
  work: string;
  results: string;
  socksIp: string;
  socksPort: number;
  engineIp: string;
  rpcPort: number;
  socksPassword: string;
  caFile: string;
  pages: PageInfo[];
}

export function loadTopology(work = process.env.STAND_WORK ?? "/stand/work"): Topology {
  const raw = JSON.parse(readFileSync(join(work, "stand.json"), "utf8")) as Omit<Topology, "work" | "socksPassword" | "results" | "caFile">;
  return {
    ...raw,
    work,
    results: process.env.STAND_RESULTS ?? "/stand/results",
    caFile: process.env.STAND_CA_FILE ?? "/stand/ca/ca.crt",
    socksPassword: readFileSync(join(work, "secrets", "stand_socks_password"), "utf8").trim(),
  };
}

export function pageToken(topology: Topology, page: PageInfo): string {
  return readFileSync(join(topology.work, "pages", page.name, "secrets", "rpc_token"), "utf8").trim();
}

/** A page of the stand and the engine that owns it now. */
export class Page {
  readonly info: PageInfo;
  readonly #topology: Topology;
  readonly #store: Store;
  readonly #log: (event: string, fields?: Record<string, unknown>) => void;
  engine: StandEngine;
  /** Every engine that owned the page during the current run. */
  enginesOfRun: StandEngine[] = [];

  constructor(info: PageInfo, topology: Topology, store: Store, log: (event: string, fields?: Record<string, unknown>) => void) {
    this.info = info;
    this.#topology = topology;
    this.#store = store;
    this.#log = log;
    this.engine = this.newEngine();
  }

  /** An engine for this page; a restarted one takes the next generation
   *  when it connects (`takeOver`). */
  newEngine(options: { naive?: boolean; ackEarly?: boolean } = {}): StandEngine {
    const engine = new StandEngine({
      page: this.info.name,
      pageId: this.info.pageId,
      url: `ws://${this.info.controlIp}:${this.#topology.rpcPort}/rpc`,
      token: pageToken(this.#topology, this.info),
      socks: { ip: this.#topology.socksIp, port: this.#topology.socksPort, username: STAND_SOCKS_USER, password: this.#topology.socksPassword },
      pinnedExitIp: STAND_EXIT_IP,
      env: STAND_ENV,
      store: this.#store,
      ...(options.naive ? { naive: true } : {}),
      ...(options.ackEarly ? { ackEarly: true } : {}),
      log: this.#log,
    });
    this.enginesOfRun.push(engine);
    return engine;
  }

  /** The engine restarts: the old one is gone, a new one owns the page. */
  async restartEngine(options: { naive?: boolean; ackEarly?: boolean } = {}): Promise<StandEngine> {
    const previous = this.engine;
    await previous.drop("clean");
    const engine = this.newEngine(options);
    engine.run = previous.run;
    await engine.takeOver();
    this.engine = engine;
    return engine;
  }
}

/** The Hub requests a run keeps issuing while the fault happens: each is
 *  an attempt the engine records, sends, and must see resolved exactly
 *  once. With no site in the work tab (until PR 7) the operator answers
 *  each "not sent"; its outcome still goes through the buffer. */
export class Activity {
  readonly #page: Page;
  readonly #everyMs: number;
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  readonly issued: number[] = [];
  errors = 0;

  constructor(page: Page, everyMs = 300) {
    this.#page = page;
    this.#everyMs = everyMs;
  }

  start(): void {
    this.#timer = setInterval(() => void this.#tick(), this.#everyMs);
  }

  async #tick(): Promise<void> {
    if (this.#busy) return;
    const engine = this.#page.engine;
    if (!engine.connected) return;
    this.#busy = true;
    try {
      this.issued.push(...(await engine.sendHub(1)));
    } catch {
      // the database is down: an engine without it issues nothing
      this.errors += 1;
    } finally {
      this.#busy = false;
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = mono() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (mono() > deadline) return false;
    await sleep(stepMs);
  }
}

export interface Ctx {
  page: Page;
  pages: ReadonlyMap<string, Page>;
  stand: StandFansly;
  docker: Docker;
  store: Store;
  topology: Topology;
  /** The run's random moment of the fault, ms after the activity began. */
  momentMs: number;
  /** The stand's journal number where the run began. */
  journalSince: number;
  /** The stand's pages by the address the SOCKS5 sees them from. */
  pagesByAddress: ReadonlyMap<string, string>;
  /** A number in [0, 1) from the run's seed. */
  random: () => number;
  log: (event: string, fields?: Record<string, unknown>) => void;
  /** The fault is about to happen: an error from here on fails the run. */
  arm: () => void;
  /** What the run measured, kept with its result. */
  notes: Record<string, unknown>;
}

export interface ScenarioOutcome {
  /** The moment the fault took effect (CLOCK_MONOTONIC), for the checks. */
  faultMono: number | null;
  /** The scenario's own checks: name → violations. */
  checks: Record<string, string[]>;
  /** The attempts this run issued (resolved exactly once — a common check). */
  attempts: number[];
  /** The control that commits without a key: its outcomes are read from
   *  the naive table. */
  naive?: boolean;
}
