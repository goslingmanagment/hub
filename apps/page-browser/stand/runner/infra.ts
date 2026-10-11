// The stand's levers: the stand server's control API (journal, faults) and
// the Docker Engine API over the mounted socket (signals into the browser
// container for fault injection).

import { request } from "node:http";

import { sleep } from "../../src/shared/util.ts";

// ── stand server ──────────────────────────────────────────────────────────

export interface JournalEvent {
  seq: number;
  t: string;
  mono: number;
  connId?: number | string;
  streamId?: number | null;
  proto?: string;
  method?: string;
  authority?: string;
  path?: string;
  rid?: string | null;
  reused?: boolean;
  headers?: Array<[string, string]>;
  [key: string]: unknown;
}

function httpJson(options: { host: string; port: number; path: string; method?: string; body?: unknown; socketPath?: string }): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      {
        host: options.socketPath ? undefined : options.host,
        port: options.socketPath ? undefined : options.port,
        socketPath: options.socketPath,
        path: options.path,
        method: options.method ?? "GET",
        headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
        timeout: 30_000,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          let body: unknown = raw;
          try {
            body = raw === "" ? null : JSON.parse(raw);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, body, raw });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export class StandServer {
  readonly host: string;
  readonly port: number;
  #since = 0;
  constructor(host: string, port = 8080) {
    this.host = host;
    this.port = port;
  }

  async health(): Promise<boolean> {
    try {
      return (await httpJson({ host: this.host, port: this.port, path: "/health" })).status === 200;
    } catch {
      return false;
    }
  }

  /** Mark the start of a run: later `journal()` calls return events after it. */
  async mark(): Promise<void> {
    const reply = await httpJson({ host: this.host, port: this.port, path: `/journal?since=${Number.MAX_SAFE_INTEGER}` });
    const next = (reply.body as { next?: number }).next;
    if (typeof next === "number" && next < Number.MAX_SAFE_INTEGER) {
      this.#since = next;
    } else {
      const all = await httpJson({ host: this.host, port: this.port, path: `/journal?since=0` });
      this.#since = (all.body as { next: number }).next;
    }
  }

  async journal(): Promise<JournalEvent[]> {
    const reply = await httpJson({ host: this.host, port: this.port, path: `/journal?since=${this.#since}` });
    // The server names the event kind `type`; the scenarios read `t`.
    return (reply.body as { events: Array<JournalEvent & { type: string }> }).events.map((event) => ({ ...event, t: event.type }));
  }

  async clearJournal(): Promise<void> {
    await httpJson({ host: this.host, port: this.port, path: "/journal/clear", method: "POST" });
    this.#since = 0;
  }

  async fault(fault: Record<string, unknown>): Promise<string> {
    const reply = await httpJson({ host: this.host, port: this.port, path: "/faults", method: "POST", body: fault });
    if (reply.status >= 300) throw new Error(`fault ${JSON.stringify(fault)} refused: ${reply.raw}`);
    return String((reply.body as { id: unknown }).id);
  }

  async clearFaults(): Promise<void> {
    await httpJson({ host: this.host, port: this.port, path: "/faults", method: "DELETE" });
  }

  async config(config: Record<string, unknown>): Promise<void> {
    await httpJson({ host: this.host, port: this.port, path: "/config", method: "POST", body: config });
  }

  async wsPush(text: string, wsId?: string): Promise<void> {
    await httpJson({ host: this.host, port: this.port, path: "/ws/push", method: "POST", body: wsId ? { wsId, text } : { text } });
  }

  async wsClose(wsId?: string, code = 1001): Promise<void> {
    await httpJson({ host: this.host, port: this.port, path: "/ws/close", method: "POST", body: wsId ? { wsId, code } : { code } });
  }
}

// ── docker ────────────────────────────────────────────────────────────────

const DOCKER_SOCK = "/var/run/docker.sock";

export class Docker {
  readonly container: string;
  constructor(container: string) {
    this.container = container;
  }

  /** Run a command in the container as root; returns its output. */
  async exec(cmd: string[]): Promise<string> {
    const created = await httpJson({
      host: "",
      port: 0,
      socketPath: DOCKER_SOCK,
      path: `/containers/${this.container}/exec`,
      method: "POST",
      body: { AttachStdout: true, AttachStderr: true, Cmd: cmd, User: "root" },
    });
    if (created.status !== 201) throw new Error(`docker exec create: ${created.status} ${created.raw}`);
    const id = (created.body as { Id: string }).Id;
    const started = await httpJson({ host: "", port: 0, socketPath: DOCKER_SOCK, path: `/exec/${id}/start`, method: "POST", body: { Detach: false, Tty: true } });
    return started.raw;
  }

  /** Restart the whole container (a stand that got stuck). */
  async restart(): Promise<void> {
    await httpJson({ host: "", port: 0, socketPath: DOCKER_SOCK, path: `/containers/${this.container}/restart?t=2`, method: "POST" });
  }

  async pids(): Promise<Record<string, number | null>> {
    for (let i = 0; i < 20; i++) {
      try {
        return JSON.parse(await this.exec(["cat", "/run/pb/pids.json"])) as Record<string, number | null>;
      } catch {
        await sleep(200);
      }
    }
    throw new Error("cannot read pids.json");
  }

  async signal(name: string, signal: string): Promise<number | null> {
    const pid = (await this.pids())[name] ?? null;
    if (pid === null) return null;
    await this.exec(["kill", `-${signal}`, String(pid)]);
    return pid;
  }

  /** The renderer processes of Chrome (for "page process hangs"). */
  async rendererPids(): Promise<number[]> {
    const out = await this.exec(["sh", "-c", "pgrep -u pb-chrome -f -- '--type=renderer' || true"]);
    return out
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  async networkServicePid(): Promise<number | null> {
    const out = await this.exec(["sh", "-c", "pgrep -u pb-chrome -f -- 'network.mojom.NetworkService' || true"]);
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
}
