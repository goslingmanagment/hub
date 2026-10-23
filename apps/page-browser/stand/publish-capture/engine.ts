// The stand's engine for the publish capture session (docs/plans/
// 2026-10-23-wall-posts/stand-session-0.2.md): Hub's `sync` as the
// operator meets it (src/rpc/protocol.ts), cut down to what a person's
// manual session on the test account needs — and it never sends a request
// of Hub's: no `send`, so Hub writes nothing, reads nothing, and the page's
// browser does only what the person does on its screen.
//
//   node --no-warnings engine.ts --operator ws://<ip>:7700/rpc \
//     --token-file <file> --settings <file> --journal <file>
//
// - hello: the page's RPC token, an owner generation of this start (the
//   Unix second: each start's is higher), the page's SOCKS5, its pinned
//   exit IP and its environment from the settings file (the owner's; never
//   printed), the default params; page 0 unless the settings name a page and
//   its account (page 0 is a profile no page has yet: whatever account the
//   person logs into confirms it);
// - ping and pong, so the operator keeps the link;
// - the page started once the hello is taken and the previous generation's
//   work is over (`quiesced`), in the manual login (`setMode manual_login`,
//   then `restartBrowser`): a person is in the page the whole session, as
//   in a new profile's onboarding — the site's sign-in and sign-out are
//   theirs, never a halt — and Hub has nothing to send anyway. A halt this
//   engine's own stop left is cleared first; any other halt is the person's
//   to look at — SIGHUP clears it and starts the page;
// - the site's observations (`siteSent`, `siteEnded`, `siteIdentity`)
//   confirmed (`siteObservedAck`) once written to the journal;
// - the event stream not subscribed: the site's answers stay in the page's
//   buffer, on the stand's own volume;
// - SIGTERM or SIGINT: the page stopped (`stopPage`), then out.
//
// The journal (JSON Lines) holds the page's states as they change, alarms,
// commands, the account the site showed, and the site's requests as the
// operator saw them leave and end — paths, never a query, never a secret.

import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { DEFAULT_PARAMS, PROTOCOL, SITE_OBSERVED_ACK_MAX, type Hello, type OperatorToEngine, type State } from "../../src/rpc/protocol.ts";
import { validateEnv } from "../../src/env/rules.ts";

const { values } = parseArgs({
  options: { operator: { type: "string" }, "token-file": { type: "string" }, settings: { type: "string" }, journal: { type: "string" } },
  strict: true,
});
if (!values.operator || !values["token-file"] || !values.settings || !values.journal) {
  console.error("usage: engine.ts --operator ws://<ip>:7700/rpc --token-file <file> --settings <file> --journal <file>");
  process.exit(2);
}
const OPERATOR = values.operator;
const JOURNAL = values.journal;

interface Settings {
  socks5: { ip: string; port: number; username: string; password: string };
  pinnedExitIp: string;
  env: Hello["env"];
  pageId?: number;
  expectedAccountId?: string;
}

const token = readFileSync(values["token-file"], "utf8").trim();
const settings = JSON.parse(readFileSync(values.settings, "utf8")) as Settings;
validateEnv(settings.env);
const generation = Math.floor(Date.now() / 1000);

function mono(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function journal(kind: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), kind, ...fields });
  appendFileSync(JOURNAL, `${line}\n`, { mode: 0o600 });
  console.log(line);
}

let ws: WebSocket | null = null;
let lastState: State | null = null;
let started = false;
let stopping = false;
let commandN = 0;
const commandWaiters = new Map<string, (ok: boolean, detail: string | null) => void>();
let pendingAcks: number[] = [];

function send(message: Record<string, unknown>): boolean {
  if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ ownerGeneration: generation, ...message }));
  return true;
}

function command(kind: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; detail: string | null }> {
  const commandId = `capture-${generation}-${++commandN}`;
  journal("command", { command: kind, commandId });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      commandWaiters.delete(commandId);
      resolve({ ok: false, detail: "no answer in 60 s" });
    }, 60_000);
    commandWaiters.set(commandId, (ok, detail) => {
      clearTimeout(timer);
      resolve({ ok, detail });
    });
    if (!send({ type: "command", commandId, notAfterMono: mono() + 30_000, command: { kind, ...extra } })) {
      clearTimeout(timer);
      commandWaiters.delete(commandId);
      resolve({ ok: false, detail: "no link to the operator" });
    }
  });
}

/** Start the page: a halt of this engine's own stop is cleared first;
 *  `anyHalt` (SIGHUP, the person's word) clears any. */
async function startPage(anyHalt: boolean): Promise<void> {
  const halt = lastState?.halt ?? null;
  if (halt) {
    if (halt.reason !== "owner_stop" && !anyHalt) {
      journal("halt_held", { reason: halt.reason, haltId: halt.id, note: "the page stands: look at the screen, then send SIGHUP to clear it and start" });
      return;
    }
    const cleared = await command("clearHalt", { haltId: halt.id });
    journal("command_result", { command: "clearHalt", ...cleared });
    if (!cleared.ok) return;
  }
  const mode = await command("setMode", { mode: "manual_login" });
  journal("command_result", { command: "setMode manual_login", ...mode });
  if (!mode.ok) return;
  const result = await command("restartBrowser");
  journal("command_result", { command: "restartBrowser", ...result });
}

function stateChanged(state: State): boolean {
  const last = lastState;
  return last === null || last.step !== state.step || last.stopReason !== state.stopReason || last.exitOpen !== state.exitOpen || last.mode !== state.mode || last.accountId !== state.accountId || (last.halt?.id ?? null) !== (state.halt?.id ?? null);
}

function noteState(state: State): void {
  if (stateChanged(state)) {
    journal("state", {
      step: state.step,
      stopReason: state.stopReason,
      exitOpen: state.exitOpen,
      mode: state.mode,
      accountId: state.accountId,
      exitIp: state.exitIp,
      chromeVersion: state.chromeVersion,
      operatorVersion: state.operatorVersion,
      halt: state.halt ?? null,
      hubSend: state.hubSend?.allowed === false ? state.hubSend.reason : "allowed",
      egressDnrBlocks: state.egressFailures?.dnr.reduce((sum, entry) => sum + entry.count, 0) ?? null,
    });
  }
  lastState = state;
}

function onMessage(message: OperatorToEngine): void {
  switch (message.type) {
    case "helloResult":
      if (!message.ok) {
        journal("hello_refused", { reason: message.reason });
        process.exit(1);
      }
      journal("hello", { protocol: message.protocol, bufferId: message.bufferId, generation });
      noteState(message.state);
      return;
    case "state":
      noteState(message);
      return;
    case "ping":
      send({ type: "pong", n: message.n });
      return;
    case "pong":
      return;
    case "quiesced":
      journal("quiesced", { previousGeneration: message.previousGeneration });
      if (!started) {
        started = true;
        void startPage(false);
      }
      return;
    case "commandResult":
      commandWaiters.get(message.commandId)?.(message.ok, message.detail);
      commandWaiters.delete(message.commandId);
      return;
    case "alarm":
      journal("alarm", { alarm: message.kind, detail: message.detail });
      return;
    case "siteSent":
      journal("site_sent", { method: message.method, host: message.host, path: message.path, route: message.route, requestKey: message.requestKey ?? null, hop: message.hop ?? 0 });
      if (typeof message.deliverySeq === "number") pendingAcks.push(message.deliverySeq);
      return;
    case "siteEnded":
      journal("site_ended", { requestKey: message.requestKey ?? null, hop: message.hop ?? 0, status: message.status, error: message.error, retryAfter: message.retryAfter });
      if (typeof message.deliverySeq === "number") pendingAcks.push(message.deliverySeq);
      return;
    case "siteIdentity":
      journal("site_identity", { accountId: message.accountId });
      if (typeof message.deliverySeq === "number") pendingAcks.push(message.deliverySeq);
      return;
    default:
      // Nothing of a Hub request or an admission is asked of this engine;
      // anything else is written down by its type only.
      journal("other", { type: message.type });
  }
}

/** The observations written are confirmed, a batch at a time. */
setInterval(() => {
  while (pendingAcks.length > 0) {
    const batch = pendingAcks.slice(0, SITE_OBSERVED_ACK_MAX);
    if (!send({ type: "siteObservedAck", deliverySeqs: batch })) return;
    pendingAcks = pendingAcks.slice(batch.length);
  }
}, 1000).unref();

function connect(): void {
  const socket = new WebSocket(OPERATOR);
  socket.binaryType = "arraybuffer";
  ws = socket;
  socket.onopen = () => {
    pendingAcks = [];
    const hello: Hello = {
      type: "hello",
      ownerGeneration: generation,
      protocol: { majors: [PROTOCOL.major], minor: PROTOCOL.minor },
      token,
      pageId: settings.pageId ?? 0,
      expectedAccountId: settings.expectedAccountId ?? "0",
      pinnedExitIp: settings.pinnedExitIp,
      params: DEFAULT_PARAMS,
      socks5: settings.socks5,
      env: settings.env,
    };
    socket.send(JSON.stringify(hello));
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    try {
      onMessage(JSON.parse(event.data) as OperatorToEngine);
    } catch (error) {
      journal("message_unread", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  socket.onerror = () => undefined;
  socket.onclose = (event) => {
    if (ws === socket) ws = null;
    journal("link_closed", { code: event.code });
    if (!stopping) setTimeout(connect, 2000);
  };
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const result = await command("stopPage");
  journal("command_result", { command: "stopPage", ...result });
  ws?.close();
  process.exit(result.ok ? 0 : 1);
}

process.on("SIGHUP", () => void startPage(true));
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

journal("engine_start", { operator: OPERATOR, generation, pageId: settings.pageId ?? 0, socks: `${settings.socks5.ip}:${settings.socks5.port}`, pinnedExitIp: settings.pinnedExitIp, env: { timeZone: settings.env.timeZone, languages: settings.env.languages } });
connect();
