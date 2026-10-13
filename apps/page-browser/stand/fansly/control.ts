// The runner's control of the stand's Fansly: plain HTTP and JSON on the
// stand's control network (never journaled).
//
//   GET  /health
//   GET  /journal?since=<seq>[&limit=<n>]   what arrived since
//   GET  /state                             settings, faults, open connections
//   POST /config  { exitIp?, accountId?, corsMaxAge?, wsPush?: { perMinute, bytes },
//                   site?: { readEveryMs, writeEveryMs, socket, forbiddenWs } | null }
//   POST /socks   { down?, refuseAuth?, connectDelayMs? }      the faults
//   POST /reset                             no fault, the settings of the start
//   POST /ws/push { text? | bytes?, wsId? } a frame into the open sockets
//   POST /ws/close { code?, wsId? }

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Front, FrontConfig } from "./front.ts";
import { mono, type Journal } from "./journal.ts";
import type { StandSocks } from "./socks.ts";

export interface ControlDeps {
  host: string;
  port: number;
  journal: Journal;
  config: FrontConfig;
  defaults: FrontConfig;
  socks: StandSocks;
  front: Front;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "the body is not an object");
  return value as Record<string, unknown>;
}

function count(value: unknown, name: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) throw new HttpError(400, `${name} is not a number in [0, ${max}]`);
  return value;
}

function state(deps: ControlDeps): Record<string, unknown> {
  return {
    mono: mono(),
    config: deps.config,
    socks: { down: deps.socks.down, refuseAuth: deps.socks.refuseAuth, connectDelayMs: deps.socks.connectDelayMs, open: deps.socks.open },
    sockets: deps.front.openSockets,
    lastSeq: deps.journal.lastSeq,
  };
}

async function handle(deps: ControlDeps, req: IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://control");
  const { journal, config, socks, front } = deps;
  switch (`${req.method ?? "GET"} ${url.pathname}`) {
    case "GET /health":
      return { ok: true, mono: mono(), lastSeq: journal.lastSeq };
    case "GET /journal": {
      const since = Number(url.searchParams.get("since") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50000");
      if (!Number.isFinite(since) || !Number.isFinite(limit)) throw new HttpError(400, "since and limit are numbers");
      return journal.since(since, limit);
    }
    case "GET /state":
      return state(deps);
    case "POST /config": {
      const body = await readJson(req);
      for (const key of Object.keys(body)) if (!["exitIp", "accountId", "corsMaxAge", "wsPush", "site"].includes(key)) throw new HttpError(400, `an unknown setting ${key}`);
      if (body.site !== undefined) {
        const site = body.site as Record<string, unknown> | null;
        config.site = site === null ? null : { readEveryMs: count(site.readEveryMs ?? 0, "site.readEveryMs", 3_600_000), writeEveryMs: count(site.writeEveryMs ?? 0, "site.writeEveryMs", 3_600_000), socket: site.socket === true, forbiddenWs: site.forbiddenWs === true };
      }
      if (body.exitIp !== undefined) {
        if (typeof body.exitIp !== "string" || body.exitIp === "") throw new HttpError(400, "exitIp is not a string");
        config.exitIp = body.exitIp;
      }
      if (body.accountId !== undefined) {
        if (typeof body.accountId !== "string" || body.accountId === "") throw new HttpError(400, "accountId is not a string");
        config.accountId = body.accountId;
      }
      if (body.corsMaxAge !== undefined) config.corsMaxAge = count(body.corsMaxAge, "corsMaxAge", 86_400);
      if (body.wsPush !== undefined) {
        const push = body.wsPush as Record<string, unknown>;
        config.wsPush = { perMinute: count(push.perMinute, "wsPush.perMinute", 600_000), bytes: count(push.bytes ?? 256, "wsPush.bytes", 1024 * 1024) };
        front.applyPush();
      }
      journal.log("stand.config", { exitIp: config.exitIp, corsMaxAge: config.corsMaxAge, wsPush: config.wsPush });
      return state(deps);
    }
    case "POST /socks": {
      const body = await readJson(req);
      for (const key of Object.keys(body)) if (!["down", "refuseAuth", "connectDelayMs"].includes(key)) throw new HttpError(400, `an unknown fault ${key}`);
      let cut = 0;
      if (body.refuseAuth !== undefined) socks.refuseAuth = body.refuseAuth === true;
      if (body.connectDelayMs !== undefined) socks.connectDelayMs = count(body.connectDelayMs, "connectDelayMs", 120_000);
      if (body.down !== undefined) cut = await socks.setDown(body.down === true);
      journal.log("stand.fault", { down: socks.down, refuseAuth: socks.refuseAuth, connectDelayMs: socks.connectDelayMs, cut });
      return state(deps);
    }
    case "POST /reset": {
      socks.refuseAuth = false;
      socks.connectDelayMs = 0;
      await socks.setDown(false);
      Object.assign(config, structuredClone(deps.defaults));
      front.applyPush();
      journal.log("stand.reset");
      return state(deps);
    }
    case "POST /ws/push": {
      const body = await readJson(req);
      const wsId = typeof body.wsId === "string" ? body.wsId : undefined;
      if (typeof body.text === "string") return { sent: front.pushText(body.text, wsId) };
      return { sent: front.push(count(body.bytes ?? 256, "bytes", 1024 * 1024), wsId) };
    }
    case "POST /ws/close": {
      const body = await readJson(req);
      return { closed: front.closeSockets(typeof body.code === "number" ? body.code : 1001, typeof body.wsId === "string" ? body.wsId : undefined) };
    }
    default:
      throw new HttpError(404, `no ${req.method ?? ""} ${url.pathname}`);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(data.length), "cache-control": "no-store" }).end(data);
}

export function startControl(deps: ControlDeps): Promise<void> {
  const server = createServer((req, res) => {
    handle(deps, req).then(
      (body) => send(res, 200, body),
      (error: unknown) => send(res, error instanceof HttpError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) }),
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host, () => resolve());
  });
}
