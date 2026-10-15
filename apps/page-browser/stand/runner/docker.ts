// The runner's levers on the stand's containers: the Docker Engine API
// through the stand's Docker proxy (docker-proxy.ts), which passes only these
// calls and only for the stand's own containers. The runner never sees
// Docker's own socket.

import { request } from "node:http";

export interface ExecResult {
  output: string;
  exitCode: number | null;
}

function call(socketPath: string, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { socketPath, method, path, headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: timeoutMs },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, raw }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`docker ${method} ${path}: no answer in ${timeoutMs} ms`)));
    req.end(payload);
  });
}

export class Docker {
  readonly #socket: string;

  constructor(socketPath: string) {
    this.#socket = socketPath;
  }

  /** A command in a container; its output (stdout and stderr together) and
   *  its exit code. */
  async exec(container: string, cmd: string[], user: "root" | "pb-operator" | "pb-chrome" = "root", timeoutMs = 60_000): Promise<ExecResult> {
    const created = await call(this.#socket, "POST", `/containers/${encodeURIComponent(container)}/exec`, { Cmd: cmd, User: user });
    if (created.status !== 201) throw new Error(`docker exec ${container}: ${created.status} ${created.raw.trim()}`);
    const id = (JSON.parse(created.raw) as { Id: string }).Id;
    const started = await call(this.#socket, "POST", `/exec/${id}/start`, {}, timeoutMs);
    if (started.status !== 200) throw new Error(`docker exec start ${container}: ${started.status} ${started.raw.trim()}`);
    const inspected = await call(this.#socket, "GET", `/exec/${id}/json`);
    const exitCode = inspected.status === 200 ? ((JSON.parse(inspected.raw) as { ExitCode: number | null }).ExitCode ?? null) : null;
    return { output: started.raw, exitCode };
  }

  /** A command that must succeed: its output. */
  async run(container: string, cmd: string[], user: "root" | "pb-operator" | "pb-chrome" = "root"): Promise<string> {
    const result = await this.exec(container, cmd, user);
    if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} in ${container} exited ${result.exitCode ?? "?"}: ${result.output.trim().slice(0, 400)}`);
    return result.output;
  }

  async action(container: string, what: "start" | "stop" | "restart", seconds = 10): Promise<void> {
    const reply = await call(this.#socket, "POST", `/containers/${encodeURIComponent(container)}/${what}?t=${seconds}`, undefined, (seconds + 60) * 1000);
    if (reply.status !== 204 && reply.status !== 304) throw new Error(`docker ${what} ${container}: ${reply.status} ${reply.raw.trim()}`);
  }

  async inspect(container: string): Promise<{ running: boolean; oomKilled: boolean; restartCount: number; health: string | null; startedAt: string }> {
    const reply = await call(this.#socket, "GET", `/containers/${encodeURIComponent(container)}/json`);
    if (reply.status !== 200) throw new Error(`docker inspect ${container}: ${reply.status}`);
    const json = JSON.parse(reply.raw) as { State: { Running: boolean; OOMKilled: boolean; StartedAt: string; Health?: { Status: string } }; RestartCount: number };
    return { running: json.State.Running, oomKilled: json.State.OOMKilled, restartCount: json.RestartCount, health: json.State.Health?.Status ?? null, startedAt: json.State.StartedAt };
  }

  /** One sample of the container's cgroup counters (Docker's stats). */
  async stats(container: string): Promise<ContainerSample> {
    const reply = await call(this.#socket, "GET", `/containers/${encodeURIComponent(container)}/stats?stream=false&one-shot=false`);
    if (reply.status !== 200) throw new Error(`docker stats ${container}: ${reply.status}`);
    const json = JSON.parse(reply.raw) as {
      read: string;
      cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
      precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
      memory_stats: { usage?: number; limit?: number; max_usage?: number; stats?: Record<string, number> };
      pids_stats?: { current?: number };
    };
    const cpuDelta = json.cpu_stats.cpu_usage.total_usage - json.precpu_stats.cpu_usage.total_usage;
    const systemDelta = (json.cpu_stats.system_cpu_usage ?? 0) - (json.precpu_stats.system_cpu_usage ?? 0);
    const cpus = json.cpu_stats.online_cpus ?? 1;
    const inactiveFile = json.memory_stats.stats?.inactive_file ?? json.memory_stats.stats?.total_inactive_file ?? 0;
    return {
      atWall: Date.parse(json.read),
      cpuPercent: systemDelta > 0 ? (cpuDelta / systemDelta) * cpus * 100 : 0,
      memoryBytes: Math.max(0, (json.memory_stats.usage ?? 0) - inactiveFile),
      memoryLimitBytes: json.memory_stats.limit ?? 0,
      pids: json.pids_stats?.current ?? 0,
    };
  }
}

export interface ContainerSample {
  atWall: number;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  pids: number;
}
