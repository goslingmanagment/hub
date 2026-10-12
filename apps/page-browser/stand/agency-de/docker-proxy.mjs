// The stand runner's only way to Docker on a shared server (agency-de, the
// production host; owner's decision №14): a Unix socket that passes exactly
// what the runner does — run a command as root in the stand's browser
// container, start that command, restart that container — and refuses
// everything else. The runner never sees Docker's own socket, so nothing in
// the stand can reach Hub's containers through it.
//
// PROXY_CONTAINERS: the container names the runner may touch (comma-separated).
// PROXY_SOCKET: where to listen (a volume shared with the runner).

import { chmodSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";

const DOCKER = "/var/run/docker.sock";
const LISTEN = process.env.PROXY_SOCKET ?? "/proxy/docker.sock";
const ALLOWED = new Set((process.env.PROXY_CONTAINERS ?? "").split(",").filter(Boolean));
const MAX_BODY = 64 * 1024;
// The commands created through this proxy, oldest first; only these start.
const execs = new Set();

function log(fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...fields }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
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

/** Send one request to Docker; the answer streams back to the runner. */
function forward(res, method, path, body, onJson) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const upstream = request(
    {
      socketPath: DOCKER,
      method,
      path,
      headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    },
    (answer) => {
      const type = answer.headers["content-type"];
      res.writeHead(answer.statusCode ?? 502, type ? { "content-type": type } : {});
      if (!onJson) {
        answer.pipe(res);
        return;
      }
      const chunks = [];
      answer.on("data", (chunk) => chunks.push(chunk));
      answer.on("end", () => {
        const raw = Buffer.concat(chunks);
        try {
          onJson(answer.statusCode, JSON.parse(raw.toString("utf8")));
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

const server = createServer(async (req, res) => {
  const deny = (why) => {
    log({ denied: why, method: req.method, url: req.url });
    res.writeHead(403, { "content-type": "text/plain" });
    res.end(`stand proxy: ${why}\n`);
  };
  let raw;
  try {
    raw = await readBody(req);
  } catch (error) {
    deny(error.message);
    return;
  }
  const url = new URL(req.url ?? "/", "http://docker");
  // Docker takes the same paths with or without an API version.
  const path = url.pathname.replace(/^\/v1\.\d+(?=\/)/, "");
  if (req.method !== "POST") {
    deny("only POST");
    return;
  }

  let match = path.match(/^\/containers\/([^/]+)\/exec$/);
  if (match) {
    if (!ALLOWED.has(match[1])) return deny(`container ${match[1]}`);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return deny("exec body is not JSON");
    }
    const cmd = body?.Cmd;
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((part) => typeof part === "string")) return deny("exec needs Cmd");
    // Rebuilt, not passed on: no Privileged, no Env, no other user.
    forward(res, "POST", `/containers/${encodeURIComponent(match[1])}/exec`, { AttachStdout: true, AttachStderr: true, Cmd: cmd, User: "root" }, (status, json) => {
      if (status === 201 && typeof json?.Id === "string") {
        execs.add(json.Id);
        if (execs.size > 1000) execs.delete(execs.values().next().value);
      }
    });
    log({ exec: match[1], cmd: cmd.join(" ").slice(0, 200) });
    return;
  }

  match = path.match(/^\/exec\/([0-9a-f]{64})\/start$/);
  if (match) {
    if (!execs.delete(match[1])) return deny("exec not created here");
    forward(res, "POST", `/exec/${match[1]}/start`, { Detach: false, Tty: true });
    return;
  }

  match = path.match(/^\/containers\/([^/]+)\/restart$/);
  if (match) {
    if (!ALLOWED.has(match[1])) return deny(`container ${match[1]}`);
    const t = Math.min(Math.max(Number.parseInt(url.searchParams.get("t") ?? "2", 10) || 0, 0), 30);
    log({ restart: match[1], timeoutS: t });
    forward(res, "POST", `/containers/${encodeURIComponent(match[1])}/restart?t=${t}`);
    return;
  }

  deny(`path ${path}`);
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
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
