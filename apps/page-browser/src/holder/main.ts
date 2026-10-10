// The CDP connection holder (plan §4.1, §3.1). One DevTools connection to
// Chrome's browser target; it outlives the operator, so a crashed or hung
// operator does not detach the Fetch interception (a detach makes Chrome
// release every held request unchanged — InterceptionJob::Detach).
//
// It knows nothing of CDP. It reads Chrome continuously (Chrome silently drops
// DevTools messages once its 256 MB send buffer is full), numbers every
// message and keeps it until the operator acknowledges that number; a
// restarted operator gets every unacknowledged message again — CDP has no
// list of paused requests, so this replay is how it learns about them.
// Operator messages go to Chrome unchanged. Over the store limit the holder
// asks the supervisor to kill Chrome (held requests die with it, none is
// released) and exits.
//
// Link to the operator: a unix socket, length-prefixed JSON (shared/frames.ts):
//   holder → operator: {t:"hello", cdp:"up"|"down", stored, firstSeq, lastSeq}
//                      {t:"m", seq, d:<CDP message as sent by Chrome>}
//                      {t:"cdp.up"} {t:"cdp.down", reason} {t:"overflow"}
//   operator → holder: {t:"send", d:<CDP command>} {t:"ack", seqs:[…]}
//                      {t:"test.breakCdp"} (an unmasked frame: Chrome closes)
//                      {t:"test.dropCdp"} (the holder closes the TCP socket)

import { get as httpGet } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";

import { encodeMessage, readMessages } from "../shared/frames.ts";
import { connectWebSocket, encodeFrame, OP_TEXT, type WsConnection } from "../shared/ws.ts";
import { envInt, envStr, makeLog, sleep } from "../shared/util.ts";

const log = makeLog("holder");
const CDP_PORT = envInt("PB_CDP_PORT", 9222);
const SOCK = envStr("PB_HOLDER_SOCK", "/run/pb/holder.sock");
const CTL_SOCK = envStr("PB_CTL_SOCK", "/run/pb/ctl.sock");
const MAX_BYTES = envInt("PB_HOLDER_MAX_BYTES", 128 * 1024 * 1024);

let cdp: WsConnection | null = null;
let seq = 0;
/** Unacknowledged Chrome messages, in arrival order. */
const store = new Map<number, string>();
let storeBytes = 0;
let operator: Socket | null = null;
/** Seqs not yet written to the current operator. */
let sendQueue: number[] = [];
let exiting = false;

function toOperator(json: string): boolean {
  if (!operator || operator.destroyed) return false;
  return operator.write(encodeMessage(json));
}

function pump(): void {
  while (operator && !operator.destroyed && !operator.writableNeedDrain && sendQueue.length > 0) {
    const next = sendQueue.shift()!;
    const raw = store.get(next);
    if (raw === undefined) continue;
    toOperator(`{"t":"m","seq":${next},"d":${raw}}`);
  }
}

function onChromeMessage(raw: string): void {
  seq += 1;
  store.set(seq, raw);
  storeBytes += raw.length;
  sendQueue.push(seq);
  if (storeBytes > MAX_BYTES) {
    overflow();
    return;
  }
  pump();
}

function overflow(): void {
  log("overflow", { storeBytes, stored: store.size });
  toOperator(JSON.stringify({ t: "overflow" }));
  // Kill Chrome rather than let go of the connection: held requests die with
  // the browser instead of being released by a detach.
  supervisorCommand({ cmd: "chrome.kill", reason: "holder overflow" }).finally(() => shutdown(3));
}

function supervisorCommand(command: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const socket = createConnection(CTL_SOCK);
    socket.on("connect", () => socket.end(encodeMessage(JSON.stringify(command))));
    socket.on("close", () => resolve());
    socket.on("error", () => resolve());
    setTimeout(() => {
      socket.destroy();
      resolve();
    }, 3000);
  });
}

function shutdown(code: number): void {
  if (exiting) return;
  exiting = true;
  setTimeout(() => process.exit(code), 100);
}

async function browserWsPath(): Promise<string> {
  for (;;) {
    try {
      const path = await new Promise<string>((resolve, reject) => {
        const req = httpGet({ host: "127.0.0.1", port: CDP_PORT, path: "/json/version", timeout: 1000 }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (body += chunk));
          res.on("end", () => {
            try {
              const url = new URL((JSON.parse(body) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
              resolve(url.pathname);
            } catch (error) {
              reject(error);
            }
          });
        });
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("timeout")));
      });
      return path;
    } catch {
      await sleep(100);
    }
  }
}

async function connectChrome(): Promise<void> {
  const path = await browserWsPath();
  const ws = await connectWebSocket("127.0.0.1", CDP_PORT, path);
  cdp = ws;
  log("cdp.up", { path });
  toOperator(JSON.stringify({ t: "cdp.up" }));
  ws.onText = onChromeMessage;
  ws.onClose = (reason) => {
    log("cdp.down", { reason, stored: store.size });
    toOperator(JSON.stringify({ t: "cdp.down", reason }));
    cdp = null;
    // The session and every interception of it are gone in Chrome. Restart
    // clean; the operator closes the exit and restarts Chrome (plan §4.1).
    shutdown(2);
  };
}

function onOperatorMessage(value: unknown): void {
  const message = value as { t: string; d?: unknown; seqs?: number[] };
  switch (message.t) {
    case "send":
      if (cdp && !cdp.closed) cdp.sendText(JSON.stringify(message.d));
      break;
    case "ack":
      for (const acked of message.seqs ?? []) {
        const raw = store.get(acked);
        if (raw !== undefined) {
          store.delete(acked);
          storeBytes -= raw.length;
        }
      }
      break;
    case "test.breakCdp":
      // An unmasked client frame is a protocol error: Chrome's DevTools
      // server closes the connection on its side.
      log("test.breakCdp");
      cdp?.writeRaw(encodeFrame(OP_TEXT, Buffer.from("{}"), false));
      break;
    case "test.dropCdp":
      log("test.dropCdp");
      cdp?.destroy("test.dropCdp");
      break;
    default:
      log("operator.unknown", { t: message.t });
  }
}

function listen(): void {
  if (existsSync(SOCK)) unlinkSync(SOCK);
  const server = createServer((socket) => {
    if (operator && !operator.destroyed) {
      log("operator.replaced");
      operator.destroy();
    }
    operator = socket;
    socket.setNoDelay?.(true);
    const keys = [...store.keys()];
    log("operator.connected", { stored: keys.length });
    toOperator(
      JSON.stringify({ t: "hello", cdp: cdp && !cdp.closed ? "up" : "down", stored: keys.length, firstSeq: keys[0] ?? null, lastSeq: seq }),
    );
    sendQueue = keys;
    pump();
    socket.on("drain", pump);
    readMessages(socket, onOperatorMessage, (error) => log("operator.bad_message", { error: error.message }));
    socket.on("close", () => {
      if (operator === socket) {
        operator = null;
        log("operator.gone", { stored: store.size });
      }
    });
    socket.on("error", () => undefined);
  });
  server.listen(SOCK, () => {
    chmodSync(SOCK, 0o600);
    log("listening", { sock: SOCK });
  });
}

process.on("SIGTERM", () => shutdown(0));
listen();
connectChrome().catch((error) => {
  log("cdp.connect_failed", { error: (error as Error).message });
  shutdown(1);
});
