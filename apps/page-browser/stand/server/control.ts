// Control API (plain HTTP JSON, not journaled): journal reads, fault
// injection, WebSocket pushes, runtime config, open-connection listing.

import http from "node:http";
import type { FaultStore } from "./faults.ts";
import { TOGGLE_KINDS, parseFaultSpec } from "./faults.ts";
import type { Journal } from "./journal.ts";
import type { StandConfig } from "./routes.ts";
import type { SocksServer } from "./socks5.ts";
import type { Front } from "./tls-front.ts";
import type { WsRegistry } from "./websocket.ts";

export interface ControlDeps {
  journal: Journal;
  faults: FaultStore;
  config: StandConfig;
  ws: WsRegistry;
  socks: SocksServer;
  front: Front;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createControlServer(deps: ControlDeps): http.Server {
  return http.createServer((req, res) => {
    handle(deps, req)
      .then((body) => send(res, 200, body))
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 400;
        send(res, status, { error: err instanceof Error ? err.message : String(err) });
      });
  });
}

async function handle(deps: ControlDeps, req: http.IncomingMessage): Promise<unknown> {
  const url = new URL(req.url ?? "/", "http://control");
  const method = req.method ?? "GET";
  const route = `${method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
  const { journal, faults, config, ws, socks, front } = deps;

  switch (route) {
    case "GET /health":
      return { ok: true };

    case "GET /journal": {
      const since = Number(url.searchParams.get("since") ?? "0");
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw === null ? Infinity : Number(limitRaw);
      if (!Number.isFinite(since) || Number.isNaN(limit)) throw new Error("since/limit must be numbers");
      return journal.since(since, limit);
    }
    case "POST /journal/clear":
      journal.clear();
      return { ok: true, lastSeq: journal.lastSeq };

    case "POST /faults": {
      const spec = parseFaultSpec(await readJson(req));
      if (TOGGLE_KINDS.has(spec.kind)) {
        // Toggles act at once; they are journaled like applied faults.
        if (spec.kind === "socksDown") {
          const destroyed = socks.setDown();
          journal.log("fault", { faultId: null, kind: "socksDown", destroyed });
        } else {
          await socks.setUp();
          journal.log("fault", { faultId: null, kind: "socksUp" });
        }
        return { id: null, socksDown: socks.isDown };
      }
      return { id: faults.add(spec).id };
    }
    case "GET /faults":
      return { faults: faults.list(), socksDown: socks.isDown };
    case "DELETE /faults":
      return { cleared: faults.clear() };

    case "POST /ws/push": {
      const body = (await readJson(req)) as { wsId?: unknown; text?: unknown };
      if (typeof body.text !== "string") throw new Error("text must be a string");
      const sessions = ws.select(optionalString(body.wsId, "wsId"));
      if (body.wsId !== undefined && sessions.length === 0) throw new HttpError(404, `no open WebSocket ${String(body.wsId)}`);
      let sent = 0;
      for (const session of sessions) if (session.pushText(body.text)) sent += 1;
      return { sent };
    }
    case "POST /ws/close": {
      const body = (await readJson(req)) as { wsId?: unknown; code?: unknown };
      const code = body.code === undefined ? 1000 : body.code;
      if (typeof code !== "number" || !Number.isInteger(code)) throw new Error("code must be an integer");
      const sessions = ws.select(optionalString(body.wsId, "wsId"));
      if (body.wsId !== undefined && sessions.length === 0) throw new HttpError(404, `no open WebSocket ${String(body.wsId)}`);
      let closed = 0;
      for (const session of sessions) if (session.close(code)) closed += 1;
      return { closed };
    }

    case "GET /config":
      return config;
    case "POST /config": {
      const body = (await readJson(req)) as Record<string, unknown>;
      for (const key of Object.keys(body)) {
        if (key !== "corsMaxAge" && key !== "exitIp" && key !== "h1Hosts") throw new Error(`unknown config key ${key}`);
      }
      if (body.corsMaxAge !== undefined) {
        if (typeof body.corsMaxAge !== "number" || !Number.isInteger(body.corsMaxAge) || body.corsMaxAge < 0) {
          throw new Error("corsMaxAge must be an integer ≥ 0");
        }
        config.corsMaxAge = body.corsMaxAge;
      }
      if (body.exitIp !== undefined) {
        if (typeof body.exitIp !== "string" || body.exitIp === "") throw new Error("exitIp must be a non-empty string");
        config.exitIp = body.exitIp;
      }
      if (body.h1Hosts !== undefined) {
        if (!Array.isArray(body.h1Hosts) || !body.h1Hosts.every((h) => typeof h === "string")) {
          throw new Error("h1Hosts must be an array of host names");
        }
        config.h1Hosts = body.h1Hosts.map((h: string) => h.toLowerCase());
      }
      return config;
    }

    case "GET /conns":
      return { conns: front.listConns(), ws: ws.list(), socks: socks.list(), socksDown: socks.isDown };
  }

  const faultId = /^\/faults\/([^/]+)$/.exec(url.pathname);
  if (method === "DELETE" && faultId) {
    if (!faults.remove(decodeURIComponent(faultId[1]!))) throw new HttpError(404, `no fault ${faultId[1]}`);
    return { deleted: true };
  }
  throw new HttpError(404, `no route ${route}`);
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("body is not valid JSON");
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(data.length), "cache-control": "no-store" });
  res.end(data);
}
