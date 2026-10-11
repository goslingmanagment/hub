// The engine of the test on a real Fansly account (plan §5, stage 1, items
// 4–17), PROTOTYPE. Not Hub: a stand-alone RPC peer of one page's operator.
//
// Pacing (the owner's rule), conservative for the first sessions (Astra
// review 2, F): one operation in flight — a site request (with its
// preflight), a Hub request or a socket's handshake — and the next starts
// at least S (2.5 s, plus 0–20 %) after the previous one ended, so after its
// actual send too. Site requests wait at most 60 s and at most 300 start in
// an hour (spec §3). An operation without an end, a 429 (on a request or its
// preflight), the operator's halt, a changed fansly-client-check or a second
// lost CDP within 10 minutes stop the session: the operator closes its exit
// for good (`stop`) until the owner restarts it.
//
// The journal (/stand/results/live-<time>.jsonl) has no secrets and no
// bodies: methods, hosts and paths (query parameter names only), statuses,
// sizes, alarms, the guard's reports (message type and key names).
//
// Control, from the runner container (127.0.0.1:7801):
//   GET  /status
//   POST /hub      {"path": "/api/v1/account/me"}   (reviewed paths only)
//   POST /stop     the exit closes, the page stays stopped
//   POST /pause    no new admissions;  POST /resume
//   POST /command  {"name": "restart"}

import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";

import { StandEngine, type Decision } from "../runner/engine.ts";
import { monoMs } from "../../src/shared/util.ts";

const OPERATOR = process.env.LIVE_OPERATOR ?? "ws://10.250.240.20:7700/rpc";
const TOKEN = process.env.PB_RPC_TOKEN ?? "";
const PAUSE_MS = Number(process.env.LIVE_PAUSE_MS ?? "2500");
const API = process.env.LIVE_API ?? "https://apiv3.fansly.com";
/** Admission waits, shorter than the operator's own (60 s for a site
 *  request, 10 s for a socket's CONNECT): an admission is never given to a
 *  request the operator has already let go (Astra review 3, item 6). */
const WAIT_MS = 55_000;
const WS_WAIT_MS = 8_000;
/** Fields of the identity read returned to the owner's terminal (in memory
 *  only; never in the journal). */
const HUB_EXTRACT = (process.env.LIVE_HUB_EXTRACT ?? "response.account.id,response.account.username").split(",").filter(Boolean);
const SITE_PER_HOUR = 300;
const WINDOW_MS = 15_000;
/** An operation that reports no end in this long stops the session. */
const STUCK_MS = 25_000;
const WS_STUCK_MS = 15_000;
/** Hub requests of the test: reviewed paths only (a GET is not always a
 *  read — /emails/unsubscribe is one). */
const HUB_PATHS = new RegExp(process.env.LIVE_HUB_PATHS ?? "^/api/v1/account/me$");

/** The stand's rehearsal: the stand's short token and its navigation hook. */
const REHEARSAL = process.env.LIVE_REHEARSAL === "1";
if (PAUSE_MS < 2000) throw new Error("LIVE_PAUSE_MS below the owner's 2 s minimum");
if (TOKEN.length < 16 && !REHEARSAL) throw new Error("PB_RPC_TOKEN is required");

mkdirSync("/stand/results", { recursive: true });
const journalFile = `/stand/results/live-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;

function journal(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), mono: Math.round(monoMs()), event, ...fields });
  appendFileSync(journalFile, `${line}\n`);
  if (!["paused", "frame"].includes(event)) console.log(line);
}

/** Host and path, query parameter names only (values can be IDs and CDN
 *  signatures). */
function safeUrl(url: unknown): string {
  try {
    const parsed = new URL(String(url));
    const names = [...new Set([...parsed.searchParams.keys()])];
    return `${parsed.host}${parsed.pathname}${names.length > 0 ? `?${names.join("&")}` : ""}`;
  } catch {
    return "?";
  }
}

type Kind = "site" | "hub" | "ws";
interface Queued {
  kind: Kind;
  id: string;
  label: string;
  askedMono: number;
  /** A Hub request waits here for its turn and is sent only then, as Hub's
   *  pacer does (the operator gives a check 5 s). */
  launch?: () => void;
}

const engine = new StandEngine(OPERATOR, TOKEN, Date.now());
const hold = (): Decision => "hold";
/** Hub requests whose turn has come: their check passes at once. */
const hubAdmitted = new Set<string>();
engine.decideSite = hold;
engine.decideCheck = (attemptId): Decision => (hubAdmitted.has(attemptId) ? { grant: true, windowMs: WINDOW_MS } : { grant: false, reason: "not this engine's request" });
engine.decideWs = hold;

const queue: Queued[] = [];
const seen = new Set<string>();
let inFlight: (Queued & { startedMono: number }) | null = null;
let lastStart = -Infinity;
let lastEnd = -Infinity;
let gap = PAUSE_MS;
const cdpLosses: number[] = [];
const siteStarts: number[] = [];
let paused: string | null = null;
const counts = { site: 0, hub: 0, ws: 0, refused: 0, paused: 0 };
const hubLabels = new Map<string, string>();
let alarmsSeen = 0;
let observedSeen = 0;
let wsEventsSeen = 0;
let statesSeen = 0;
let lastStateKey = "";

function nextGap(): number {
  return PAUSE_MS * (1 + 0.2 * Math.random());
}

function refuse(item: Queued, reason: string): void {
  counts.refused += 1;
  if (item.kind === "site") engine.releaseSite(item.id, { grant: false, reason });
  if (item.kind === "hub") hubRefused.get(item.id)?.(reason);
  if (item.kind === "ws") engine.releaseWs(item.id, { grant: false, reason });
  journal("refused", { kind: item.kind, what: item.label, reason });
}

function admit(item: Queued): void {
  const now = monoMs();
  const decision = { grant: true as const, windowMs: WINDOW_MS };
  if (item.kind === "site") engine.releaseSite(item.id, decision);
  if (item.kind === "hub") {
    hubAdmitted.add(item.id);
    item.launch?.();
  }
  if (item.kind === "ws") engine.releaseWs(item.id, decision);
  counts[item.kind] += 1;
  if (item.kind === "site") siteStarts.push(now);
  journal("admitted", { kind: item.kind, what: item.label, waitedMs: Math.round(now - item.askedMono), sinceLastEndMs: Number.isFinite(lastEnd) ? Math.round(now - lastEnd) : null });
  inFlight = { ...item, startedMono: now };
  lastStart = now;
  gap = nextGap();
}

function done(item: Queued): boolean {
  if (item.kind === "site") return engine.siteDone.has(item.id);
  if (item.kind === "hub") return engine.results.has(item.id);
  return wsOutcomes.has(item.id);
}

/** Socket handshakes by admission id: answered 101 ("open") or failed. */
const wsOutcomes = new Map<string, { event: string; status: number | null; error: string | null }>();

let stopped: string | null = null;

/** Stop the session: no admissions, and the operator closes its exit for
 *  good (every tunnel, the site's socket too). */
function stopSession(reason: string): void {
  if (stopped !== null) return;
  stopped = reason;
  paused = `stopped: ${reason}`;
  journal("session.stop", { reason });
  void engine.command("stop").then((result) => journal("command", { name: "stop", ok: result.ok ?? null }));
}

/** The type of a socket frame from the site's server (`t` of its JSON), not
 *  its content. */
function frameType(data: unknown): string | number | null {
  if (typeof data !== "string" || !data.startsWith("{")) return null;
  try {
    const value = JSON.parse(data) as { t?: unknown };
    return typeof value.t === "number" || typeof value.t === "string" ? value.t : null;
  } catch {
    return null;
  }
}

function collect(): void {
  for (const ask of engine.heldSite.values()) {
    if (seen.has(ask.siteRequestId)) continue;
    seen.add(ask.siteRequestId);
    queue.push({ kind: "site", id: ask.siteRequestId, label: `${ask.method} ${safeUrl(ask.url)}`, askedMono: ask.askedMono });
  }
  for (const ws of engine.heldWs.values()) {
    if (seen.has(ws.connId)) continue;
    seen.add(ws.connId);
    // A socket connection goes first, as the engine's urgent class.
    queue.unshift({ kind: "ws", id: ws.connId, label: `socket ${ws.connId}`, askedMono: ws.askedMono });
  }
}

function report(): void {
  for (; alarmsSeen < engine.alarms.length; alarmsSeen++) {
    const alarm = engine.alarms[alarmsSeen]!;
    journal("alarm", { kind: alarm.kind, detail: alarm.detail });
    if (alarm.kind === "halted" || alarm.kind === "client_check_mismatch" || alarm.kind === "ws_blocked_send") stopSession(`alarm ${String(alarm.kind)}`);
    if (alarm.kind === "cdp_lost") {
      const now = monoMs();
      cdpLosses.push(now);
      if (cdpLosses.filter((at) => now - at < 600_000).length >= 2) stopSession("CDP lost twice in 10 minutes");
    }
  }
  for (; statesSeen < engine.states.length; statesSeen++) {
    const state = engine.states[statesSeen]!;
    // The operator repeats its state every few seconds: changes only.
    const key = `${String(state.state)}|${String(state.reason)}|${String(state.exit)}`;
    if (key === lastStateKey) continue;
    lastStateKey = key;
    journal("state", { state: state.state, reason: state.reason, exit: state.exit });
  }
  for (; wsEventsSeen < engine.wsEvents.length; wsEventsSeen++) {
    const e = engine.wsEvents[wsEventsSeen]!;
    if (e.kind === "in") journal("frame", { dir: "in", connId: e.connId, opcode: e.opcode, len: typeof e.data === "string" ? e.data.length : null, msgType: frameType(e.data) });
    else if (e.kind === "out") journal("frame", { dir: "out", connId: e.connId, opcode: e.opcode, len: e.len ?? null });
    else journal("socket", { kind: e.kind, connId: e.connId, target: e.target ?? null, status: e.status ?? null, error: e.error ?? null, url: e.url ? safeUrl(e.url) : null });
  }
  for (; observedSeen < engine.observed.length; observedSeen++) {
    const o = engine.observed[observedSeen]!;
    if (o.type === "wsTunnel") {
      if ((o.event === "open" || o.event === "failed") && !wsOutcomes.has(String(o.connId))) {
        wsOutcomes.set(String(o.connId), { event: String(o.event), status: typeof o.status === "number" ? o.status : null, error: typeof o.error === "string" ? o.error : null });
      }
      journal("ws.tunnel", { connId: o.connId, event: o.event, status: o.status ?? null, error: o.error ?? null });
      continue;
    }
    if (o.kind === "paused") journal("paused", { cls: o.cls, method: o.method, what: safeUrl(o.url), type: o.resourceType });
    else if (o.kind === "guard") journal("guard", { k: o.k, target: o.target, form: o.form ?? null, len: o.len ?? null, msgType: o.msgType ?? null, keys: o.keys ?? null, dKeys: o.dKeys ?? null });
    else if (o.kind === "gate" && o.gateEvent !== "first_bytes") journal("gate", { gateEvent: o.gateEvent, window: o.window, phase: o.phase ?? null, length: o.length ?? null, cut: o.cut ?? null });
    else if (o.kind === "headers") journal("headers", { op: o.op, opKind: o.opKind, role: o.role, path: o.path, names: o.names });
  }
}

function finished(item: Queued): void {
  if (item.kind === "ws") {
    const outcome = wsOutcomes.get(item.id)!;
    journal("ws.done", { what: item.label, ...outcome });
    // A socket that could not open would be tried again and again: the
    // pilot stops on the first failure, a 429 among them.
    if (outcome.event !== "open") stopSession(`socket handshake failed${outcome.status ? ` (${outcome.status})` : ""}: ${item.label}`);
    return;
  }
  const d = item.kind === "site" ? engine.siteDone.get(item.id)! : engine.results.get(item.id)!;
  const preflightStatus = (d.preflight as { status?: number } | null)?.status ?? null;
  journal(item.kind === "site" ? "site.done" : "hub.done", {
    what: item.label,
    outcome: d.outcome,
    status: d.status ?? null,
    preflightStatus,
    source: d.source ?? null,
    error: d.error ?? d.errorText ?? null,
  });
  if (d.status === 429 || preflightStatus === 429) stopSession(`429 on ${item.label}`);
}

function pump(): void {
  if (!engine.connected) {
    // The link to the operator is gone. The operator stops its page on that
    // (PB_HALT_ON_ENGINE_LOSS): this engine's pacing and stop live in its
    // memory, a fresh one would start blank next to an operation still
    // running. The owner starts both again (Astra review 3, item 1).
    journal("rpc.lost", {});
    process.exit(0);
  }
  collect();
  report();
  const now = monoMs();
  if (inFlight && done(inFlight)) {
    finished(inFlight);
    inFlight = null;
    lastEnd = now;
  } else if (inFlight && now - inFlight.startedMono > (inFlight.kind === "ws" ? WS_STUCK_MS : STUCK_MS)) {
    // An operation without an end may still be running: the slot is not
    // freed, the session stops.
    stopSession(`no end of ${inFlight.label} in ${inFlight.kind === "ws" ? WS_STUCK_MS : STUCK_MS} ms`);
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i]!;
    if ((item.kind === "site" && engine.siteDone.has(item.id)) || (item.kind === "ws" && wsOutcomes.has(item.id))) {
      // The operator let it go while it waited here.
      queue.splice(i, 1);
      journal("expired", { kind: item.kind, what: item.label });
    } else if (paused !== null) {
      counts.paused += 1;
      queue.splice(i, 1);
      refuse(item, `paused: ${paused}`);
    } else if (now - item.askedMono > (item.kind === "ws" ? WS_WAIT_MS : WAIT_MS)) {
      queue.splice(i, 1);
      refuse(item, "waited too long");
    }
  }
  while (siteStarts.length > 0 && now - siteStarts[0]! > 3_600_000) siteStarts.shift();
  if (inFlight || queue.length === 0 || now < lastStart + gap || now < lastEnd + gap) return;
  const item = queue.shift()!;
  if (item.kind === "site" && siteStarts.length >= SITE_PER_HOUR) {
    refuse(item, "site hour cap");
    return;
  }
  admit(item);
}

let hubSeq = 0;
const hubRefused = new Map<string, (reason: string) => void>();
function hubRequest(path: string, query: string, method: string): Promise<unknown> {
  const id = `live-${Date.now()}-${++hubSeq}`;
  const url = `${API}${path}${query ? `?${query}` : ""}`;
  hubLabels.set(id, `${method} ${safeUrl(url)}`);
  journal("hub.queued", { id, what: hubLabels.get(id) });
  return new Promise((resolve) => {
    hubRefused.set(id, (reason) => resolve({ outcome: "refused", reason }));
    queue.push({
      kind: "hub",
      id,
      label: hubLabels.get(id)!,
      askedMono: monoMs(),
      launch: () => {
        void engine.sendHub(id, url, {}, method, { session: true, extract: HUB_EXTRACT }).then((r) =>
          resolve({
            outcome: r.outcome,
            status: r.status ?? null,
            reason: r.reason ?? null,
            error: r.error ?? null,
            source: r.source ?? null,
            preflightStatus: (r.preflight as { status?: number } | null)?.status ?? null,
            // The identity fields, for the owner to compare (not journalled).
            extracted: r.extracted ?? null,
          }),
        );
      },
    });
  });
}

function control(): void {
  createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
      const reply = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(`${JSON.stringify(value, null, 2)}\n`);
      if (req.method === "GET" && req.url === "/status") {
        return reply(200, { state: engine.lastState?.state ?? null, reason: engine.lastState?.reason ?? null, exit: engine.lastState?.exit ?? null, stopped, paused, queue: queue.length, inFlight: inFlight?.label ?? null, counts, sitesLastHour: siteStarts.length, journal: journalFile });
      }
      if (req.method === "POST" && req.url === "/hub") {
        const path = String(body.path ?? "");
        if (!HUB_PATHS.test(path)) return reply(400, { error: `not a reviewed path: ${HUB_PATHS}` });
        if (stopped !== null) return reply(409, { error: `session stopped: ${stopped}` });
        void hubRequest(path, "", "GET").then((result) => reply(200, result));
        return;
      }
      if (req.method === "POST" && req.url === "/stop") {
        stopSession("owner");
        return reply(200, { stopped });
      }
      if (req.method === "POST" && req.url === "/pause") {
        paused = "owner";
        journal("paused.on", { by: "control" });
        return reply(200, { paused });
      }
      if (req.method === "POST" && req.url === "/resume") {
        if (stopped !== null) return reply(409, { error: `session stopped: ${stopped}; restart the page with /command restart first` });
        paused = null;
        journal("paused.off", { by: "control" });
        return reply(200, { paused });
      }
      if (req.method === "POST" && req.url === "/command") {
        const name = String(body.name ?? "");
        if (!["restart", "closeExit"].includes(name) && !(REHEARSAL && name === "test.navigate")) return reply(400, { error: "unknown command" });
        void engine.command(name, name === "test.navigate" ? { url: String(body.url ?? "") } : {}).then((result) => {
          journal("command", { name, ok: result.ok ?? null });
          if (name === "restart" && result.ok === true) {
            stopped = null;
            paused = null;
          }
          reply(200, result);
        });
        return;
      }
      reply(404, { error: "not found" });
    });
  }).listen(7801, "127.0.0.1");
}

async function main(): Promise<void> {
  journal("start", { operator: OPERATOR, pauseMs: PAUSE_MS, api: API });
  await engine.connect(300_000);
  journal("connected", {});
  // A fresh start waits one full pause before its first admission.
  lastEnd = monoMs();
  control();
  setInterval(pump, 20);
}

void main();
