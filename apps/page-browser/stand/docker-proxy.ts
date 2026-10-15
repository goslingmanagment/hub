// The stand runner's only way to Docker (owner's decision №14: the stand on
// the production server never reaches Hub's containers). A Unix socket that
// passes exactly what the runner does to the stand's own containers — and
// refuses everything else:
//
//   POST /containers/<name>/exec      a command in a stand container, as root,
//                                     pb-operator or pb-chrome; the body is
//                                     rebuilt: no Privileged, no Env, no Tty
//   POST /exec/<id>/start, GET /exec/<id>/json   only of execs created here
//   POST /containers/<name>/start|stop|restart
//   GET  /containers/<name>/json      its state (running, OOM, health)
//   GET  /containers/<name>/stats     one sample of its cgroup counters
//
// PROXY_CONTAINERS: the container names (comma-separated), all of them the
// stand's. PROXY_SOCKET: where to listen (a volume shared with the runner).
//
//   node --no-warnings docker-proxy.ts

import { chmodSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";

const DOCKER = process.env.PROXY_DOCKER ?? "/var/run/docker.sock";
const LISTEN = process.env.PROXY_SOCKET ?? "/proxy/docker.sock";
const ALLOWED = new Set((process.env.PROXY_CONTAINERS ?? "").split(",").filter(Boolean));
const USERS = new Set(["root", "pb-operator", "pb-chrome"]);
const MAX_BODY = 64 * 1024;
/** The execs created through this proxy, oldest first: only these start. */
const execs = new Set<string>();

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...fields }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function forward(res: ServerResponse, method: string, path: string, body: unknown, onJson?: (status: number, json: unknown) => void): void {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const upstream = request(
    { socketPath: DOCKER, method, path, headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
    (answer) => {
      const type = answer.headers["content-type"];
      res.writeHead(answer.statusCode ?? 502, type ? { "content-type": type } : {});
      if (!onJson) {
        answer.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => {
        const raw = Buffer.concat(chunks);
        try {
          onJson(answer.statusCode ?? 0, JSON.parse(raw.toString("utf8")));
        } catch {
          // not JSON: passed on as it is
        }
        res.end(raw);
      });
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`stand proxy: ${error.message}\n`);
  });
  upstream.end(payload);
}

const server = createServer((req, res) => {
  const deny = (why: string) => {
    log({ denied: why, method: req.method, url: req.url });
    res.writeHead(403, { "content-type": "text/plain" });
    res.end(`stand proxy: ${why}\n`);
  };
  void readBody(req).then(
    (raw) => {
      const url = new URL(req.url ?? "/", "http://docker");
      // Docker takes the same paths with or without an API version.
      const path = url.pathname.replace(/^\/v1\.\d+(?=\/)/, "");
      const method = req.method ?? "";

      let match = /^\/containers\/([^/]+)\/(exec|start|stop|restart|json|stats)$/.exec(path);
      if (match) {
        const name = decodeURIComponent(match[1]!);
        const what = match[2]!;
        if (!ALLOWED.has(name)) return deny(`container ${name}`);
        const target = `/containers/${encodeURIComponent(name)}`;
        if (what === "exec" && method === "POST") {
          let body: { Cmd?: unknown; User?: unknown };
          try {
            body = JSON.parse(raw) as { Cmd?: unknown; User?: unknown };
          } catch {
            return deny("exec body is not JSON");
          }
          const cmd = body.Cmd;
          if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((part) => typeof part === "string")) return deny("exec needs Cmd");
          const user = typeof body.User === "string" ? body.User : "root";
          if (!USERS.has(user)) return deny(`exec as ${user}`);
          log({ exec: name, user, cmd: (cmd as string[]).join(" ").slice(0, 200) });
          return forward(res, "POST", `${target}/exec`, { AttachStdout: true, AttachStderr: true, Cmd: cmd, User: user, Tty: true }, (status, json) => {
            const id = (json as { Id?: unknown }).Id;
            if (status === 201 && typeof id === "string") {
              execs.add(id);
              if (execs.size > 1000) execs.delete(execs.values().next().value!);
            }
          });
        }
        if ((what === "start" || what === "stop" || what === "restart") && method === "POST") {
          const seconds = Math.min(Math.max(Number.parseInt(url.searchParams.get("t") ?? "10", 10) || 0, 0), 30);
          log({ [what]: name, timeoutS: seconds });
          return forward(res, "POST", `${target}/${what}${what === "start" ? "" : `?t=${seconds}`}`, undefined);
        }
        if (what === "json" && method === "GET") return forward(res, "GET", `${target}/json`, undefined);
        if (what === "stats" && method === "GET") return forward(res, "GET", `${target}/stats?stream=false`, undefined);
        return deny(`${method} ${path}`);
      }

      match = /^\/exec\/([0-9a-f]{64})\/(start|json)$/.exec(path);
      if (match) {
        const id = match[1]!;
        if (!execs.has(id)) return deny("exec not created here");
        if (match[2] === "start" && method === "POST") return forward(res, "POST", `/exec/${id}/start`, { Detach: false, Tty: true });
        if (match[2] === "json" && method === "GET") {
          execs.delete(id);
          return forward(res, "GET", `/exec/${id}/json`, undefined);
        }
      }
      return deny(`${method} ${path}`);
    },
    (error: unknown) => deny(error instanceof Error ? error.message : String(error)),
  );
});

if (ALLOWED.size === 0) {
  console.error("PROXY_CONTAINERS is empty");
  process.exit(1);
}
rmSync(LISTEN, { force: true });
server.listen(LISTEN, () => {
  chmodSync(LISTEN, 0o600);
  log({ listening: LISTEN, containers: [...ALLOWED] });
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => process.exit(0)));
