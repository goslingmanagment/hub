// Node helpers for selftest.sh — the checks curl cannot do: WebSockets over
// HTTP/1.1 and HTTP/2, HTTP/2 RST_STREAM / GOAWAY / client cancel, and
// assertions over the journal. Each check prints one "PASS name" or
// "FAIL name — detail" line.
//
//   node --experimental-strip-types --no-warnings selftest-client.ts <command> …
//     mark                         print the journal's current last seq
//     expect <since> <name> <expr> evaluate a JS expression over the journal since <since>
//     ws-h1 <rid> | ws-h2 <rid>    WebSocket checks
//     h2-refused <rid>             expects RST_STREAM REFUSED_STREAM (arm the fault first)
//     h2-goaway <rid> warm|cold    expects GOAWAY below the stream (arm the fault first)
//     h2-cancel <rid>              resets a slow stream from the client side

import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import tls from "node:tls";
import {
  FrameParser,
  OPCODE,
  acceptKey,
  decodeClosePayload,
  encodeClosePayload,
  encodeFrame,
  generateKey,
} from "./ws-codec.ts";
import type { WsFrame } from "./ws-codec.ts";

const CA = fs.readFileSync(`${process.env.STAND_CA_DIR ?? "/stand/ca"}/ca.pem`);
const CONTROL_PORT = Number(process.env.STAND_CONTROL_PORT ?? 8080);
const TLS_PORT = Number(process.env.STAND_TLS_PORT ?? 443);

let failures = 0;

function report(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ------------------------------------------------------------- control API

interface JournalEvent {
  seq: number;
  mono: number;
  type: string;
  [k: string]: unknown;
}

function control(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port: CONTROL_PORT, method, path, headers: payload ? { "content-type": "application/json" } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: text });
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** The journal's last seq: events after it are "new". */
async function currentSeq(): Promise<number> {
  return (await control("GET", `/journal?since=${Number.MAX_SAFE_INTEGER}`)).json.next as number;
}

async function journalSince(since: number): Promise<JournalEvent[]> {
  return (await control("GET", `/journal?since=${since}`)).json.events as JournalEvent[];
}

async function waitForEvent(since: number, test: (e: JournalEvent) => boolean, ms = 2000): Promise<JournalEvent | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = (await journalSince(since)).find(test);
    if (hit) return hit;
    await sleep(20);
  }
  return null;
}

/** `expect`: the expression sees evs plus find/all/has helpers matching by fields. */
/** Retried for up to 2 s, so events that trail the client (tcp.close, socks.close) can land. */
async function expectJournal(since: number, name: string, expr: string): Promise<void> {
  const deadline = Date.now() + 2000;
  let evs: JournalEvent[] = [];
  let ok = false;
  let detail = "";
  for (;;) {
    evs = await journalSince(since);
    const fits = (e: JournalEvent, type: string, where: Record<string, unknown> = {}): boolean =>
      e.type === type && Object.entries(where).every(([k, v]) => e[k] === v);
    const find = (type: string, where?: Record<string, unknown>) => evs.find((e) => fits(e, type, where));
    const all = (type: string, where?: Record<string, unknown>) => evs.filter((e) => fits(e, type, where));
    const has = (type: string, where?: Record<string, unknown>) => evs.some((e) => fits(e, type, where));
    try {
      ok = Boolean(new Function("evs", "find", "all", "has", `return (${expr});`)(evs, find, all, has));
      detail = "";
    } catch (err) {
      ok = false;
      detail = `threw ${(err as Error).message}`;
    }
    if (ok || Date.now() > deadline) break;
    await sleep(50);
  }
  if (!ok && !detail) {
    detail = evs
      .slice(-14)
      .map((e) => `${e.seq}:${e.type}${e.rid !== undefined ? `(${String(e.rid)})` : ""}${e.connId !== undefined ? `#${String(e.connId)}` : ""}`)
      .join(" ");
  }
  report(name, ok, detail);
}

// ------------------------------------------------------------- WebSocket client

/** Frames from a byte stream, awaitable one at a time. */
class FrameQueue {
  #frames: WsFrame[] = [];
  #waiters: Array<(f: WsFrame) => void> = [];
  readonly parser = new FrameParser();

  constructor() {
    this.parser.on("frame", (frame: WsFrame) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.#frames.push(frame);
    });
  }

  next(ms = 2000): Promise<WsFrame | null> {
    const ready = this.#frames.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== done);
        resolve(null);
      }, ms);
      const done = (frame: WsFrame): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.#waiters.push(done);
    });
  }
}

function text(frame: WsFrame | null): string {
  return frame ? frame.payload.toString("utf8") : "<none>";
}

async function wsOpenId(since: number, rid: string): Promise<string | null> {
  const open = await waitForEvent(since, (e) => e.type === "ws.open" && e.rid === rid);
  return open ? String(open.wsId) : null;
}

async function wsH1(rid: string): Promise<void> {
  const since = await currentSeq();
  const socket = tls.connect({ host: "127.0.0.1", port: TLS_PORT, servername: "ws.stand.test", ca: CA, ALPNProtocols: ["http/1.1"] });
  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", () => resolve());
    socket.once("error", reject);
  });
  const key = generateKey();
  socket.write(
    `GET /ws?rid=${rid} HTTP/1.1\r\nHost: ws.stand.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: chat, superchat\r\n` +
      `Origin: https://site.stand.test\r\n\r\n`,
  );
  const queue = new FrameQueue();
  const head = await new Promise<{ status: number; headers: Record<string, string> }>((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      socket.on("data", (more: Buffer) => queue.parser.push(more));
      if (buf.length > end + 4) queue.parser.push(buf.subarray(end + 4));
      resolve({ status: Number(lines[0]!.split(" ")[1]), headers });
    };
    socket.on("data", onData);
  });
  const send = (opcode: number, payload: string | Buffer, fin = true): void => {
    socket.write(encodeFrame(opcode, payload, { mask: true, fin }));
  };

  report("ws-h1: 101 + Sec-WebSocket-Accept + subprotocol", head.status === 101 && head.headers["sec-websocket-accept"] === acceptKey(key) && head.headers["sec-websocket-protocol"] === "chat", JSON.stringify(head));
  send(OPCODE.TEXT, "hello");
  const echo = await queue.next();
  report("ws-h1: text echo", echo?.opcode === OPCODE.TEXT && text(echo) === "echo:hello", text(echo));
  send(OPCODE.TEXT, "fr", false);
  send(OPCODE.CONTINUATION, "ag", true);
  const frag = await queue.next();
  report("ws-h1: fragmented message echo", text(frag) === "echo:frag", text(frag));
  send(OPCODE.PING, "p1");
  const pong = await queue.next();
  report("ws-h1: ping → pong", pong?.opcode === OPCODE.PONG && text(pong) === "p1", `${pong?.opcode} ${text(pong)}`);
  const wsId = await wsOpenId(since, rid);
  const pushed = await control("POST", "/ws/push", { wsId, text: `pushed-${rid}` });
  const push = await queue.next();
  report("ws-h1: control push", pushed.json.sent === 1 && text(push) === `pushed-${rid}`, `${JSON.stringify(pushed.json)} ${text(push)}`);
  send(OPCODE.CLOSE, encodeClosePayload(1000, "bye"));
  const close = await queue.next();
  const ended = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  report("ws-h1: client close echoed, server ends TCP", close?.opcode === OPCODE.CLOSE && decodeClosePayload(close.payload).code === 1000 && ended);
  socket.destroy();
}

function h2Connect(servername: string): http2.ClientHttp2Session {
  return http2.connect(`https://${servername}`, {
    createConnection: () => tls.connect({ host: "127.0.0.1", port: TLS_PORT, servername, ca: CA, ALPNProtocols: ["h2"] }),
  });
}

async function wsH2(rid: string): Promise<void> {
  const since = await currentSeq();
  const session = h2Connect("ws.stand.test");
  session.on("error", () => {});
  const settings = await new Promise<http2.Settings>((resolve) => session.once("remoteSettings", resolve));
  report("ws-h2: server SETTINGS_ENABLE_CONNECT_PROTOCOL=1", settings.enableConnectProtocol === true, JSON.stringify(settings));
  const stream = session.request({
    ":method": "CONNECT",
    ":protocol": "websocket",
    ":scheme": "https",
    ":path": `/ws?rid=${rid}`,
    ":authority": "ws.stand.test",
    "sec-websocket-version": "13",
    "sec-websocket-protocol": "chat",
  });
  stream.on("error", () => {});
  const queue = new FrameQueue();
  stream.on("data", (chunk: Buffer) => queue.parser.push(chunk));
  const response = await new Promise<http2.IncomingHttpHeaders>((resolve) => stream.once("response", resolve));
  report("ws-h2: extended CONNECT → 200", Number(response[":status"]) === 200 && response["sec-websocket-protocol"] === "chat", JSON.stringify(response));
  stream.write(encodeFrame(OPCODE.TEXT, "hello-h2", { mask: true }));
  const echo = await queue.next();
  report("ws-h2: text echo", text(echo) === "echo:hello-h2", text(echo));
  const wsId = await wsOpenId(since, rid);
  await control("POST", "/ws/close", { wsId, code: 4001 });
  const close = await queue.next();
  const code = close?.opcode === OPCODE.CLOSE ? decodeClosePayload(close.payload).code : null;
  stream.write(encodeFrame(OPCODE.CLOSE, encodeClosePayload(code ?? 1000), { mask: true }));
  const ended = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    stream.once("end", () => {
      clearTimeout(timer);
      resolve(true);
    });
    stream.resume();
  });
  stream.end();
  report("ws-h2: server-initiated close 4001, stream ended", code === 4001 && ended, `code=${code} ended=${ended}`);
  session.close();
}

// ------------------------------------------------------------- HTTP/2 faults

function h2Request(session: http2.ClientHttp2Session, path: string): Promise<{ status: number | null; rstCode: number; body: string; error: string | null }> {
  return new Promise((resolve) => {
    const req = session.request({ ":path": path });
    let status: number | null = null;
    let body = "";
    let error: string | null = null;
    req.on("response", (h) => (status = Number(h[":status"])));
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("error", (e) => (error = (e as NodeJS.ErrnoException).code ?? e.message));
    req.on("close", () => resolve({ status, rstCode: req.rstCode ?? 0, body, error }));
    req.end();
  });
}

async function h2Refused(rid: string): Promise<void> {
  const session = h2Connect("api.stand.test");
  session.on("error", () => {});
  const result = await h2Request(session, `/api/x?rid=${rid}`);
  report("h2RefusedStream: client sees RST_STREAM code 7", result.status === null && result.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM, JSON.stringify(result));
  session.close();
}

async function h2Goaway(rid: string, warm: boolean): Promise<void> {
  const session = h2Connect("api.stand.test");
  session.on("error", () => {});
  let goaway: { code: number; lastStreamId: number } | null = null;
  session.on("goaway", (code: number, lastStreamId: number) => (goaway ??= { code, lastStreamId }));
  if (warm) {
    const first = await h2Request(session, `/api/x?rid=${rid}-warm`);
    if (first.status !== 200) return report("h2Goaway (stream 3): warm-up", false, JSON.stringify(first));
  }
  const result = await h2Request(session, `/api/x?rid=${rid}`);
  await sleep(50);
  const g = goaway as { code: number; lastStreamId: number } | null;
  const name = warm ? "h2Goaway (stream 3): GOAWAY last-stream-id 1, stream refused" : "h2Goaway (stream 1, emulated): RST REFUSED_STREAM + GOAWAY";
  report(name, g !== null && g.lastStreamId === 1 && result.status === null && result.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM, JSON.stringify({ goaway: g, result }));
  session.destroy();
}

async function h2Cancel(rid: string): Promise<void> {
  const session = h2Connect("api.stand.test");
  session.on("error", () => {});
  const req = session.request({ ":path": `/api/x?rid=${rid}&slow=2000&size=5000` });
  req.on("error", () => {});
  await new Promise((resolve) => req.once("response", resolve));
  req.close(http2.constants.NGHTTP2_CANCEL);
  await new Promise((resolve) => req.once("close", resolve));
  report("h2 client cancel sent", true);
  await sleep(100);
  session.close();
}

// ------------------------------------------------------------- main

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "mark":
    console.log(await currentSeq());
    break;
  case "expect":
    await expectJournal(Number(args[0]), args[1]!, args[2]!);
    break;
  case "ws-h1":
    await wsH1(args[0]!);
    break;
  case "ws-h2":
    await wsH2(args[0]!);
    break;
  case "h2-refused":
    await h2Refused(args[0]!);
    break;
  case "h2-goaway":
    await h2Goaway(args[0]!, args[1] === "warm");
    break;
  case "h2-cancel":
    await h2Cancel(args[0]!);
    break;
  default:
    console.error(`unknown command ${command}`);
    process.exit(2);
}
process.exit(failures > 0 ? 1 : 0);
