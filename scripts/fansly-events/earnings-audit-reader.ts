import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const MAX_AUDIT_RESPONSES = 8;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** A single psql session keeps every batch in the same read-only snapshot. */
export class EarningsAuditReader {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly finished: Promise<void>;
  private closed = false;
  private buffer = Buffer.alloc(0);
  private failure: Error | null = null;
  private pending: {
    count: number; values: unknown[]; bytes: number;
    resolve: (values: unknown[]) => void; reject: (error: Error) => void;
  } | null = null;
  private stderr = "";

  constructor(sshHost: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]{0,253}$/.test(sshHost)) {
      throw new Error("Invalid audit SSH host");
    }
    this.child = spawn("ssh", [
      "-C", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", sshHost,
      "docker", "exec", "-i", "agency-hub-postgres-1",
      "timeout", "--kill-after=1s", "120s", "psql", "-XqAt",
      "-v", "ON_ERROR_STOP=1", "-U", "read_only", "-d", "agency_hub_core",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.finished = new Promise(resolve => {
      const finish = () => { this.closed = true; resolve(); };
      this.child.once("close", finish);
      this.child.once("error", () => { if (!this.child.pid) finish(); });
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-65536);
    });
    this.child.on("error", () => this.fail("Could not start the earnings audit reader"));
    this.child.on("exit", code => {
      if (code !== 0 || this.pending) this.fail("Earnings audit database session ended unexpectedly");
    });
    this.child.stdin.on("error", () => this.fail("Earnings audit input closed"));
    this.deadline = setTimeout(() => this.fail("Earnings audit exceeded its 120-second transaction limit"), 120_000);
  }

  private receive(chunk: Buffer) {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      const pending = this.pending;
      if (!pending || pending.values.length === pending.count) {
        this.fail("Unexpected earnings audit database output");
        return;
      }
      pending.bytes += newline + 1;
      if (newline + 1 > MAX_RESPONSE_BYTES || pending.bytes > MAX_RESPONSE_BYTES * pending.count) {
        this.fail("Earnings audit response exceeded its byte limit");
        return;
      }
      try {
        const value: unknown = JSON.parse(this.buffer.subarray(0, newline).toString("utf8"));
        pending.values.push(value);
      } catch {
        this.fail("Invalid earnings audit database response");
        return;
      }
      this.buffer = this.buffer.subarray(newline + 1);
    }
    if (this.buffer.length >= MAX_RESPONSE_BYTES) {
      this.fail("Earnings audit response exceeded its byte limit");
    } else if (this.pending && this.pending.values.length === this.pending.count) {
      if (this.buffer.length > 0) {
        this.fail("Unexpected earnings audit database output");
        return;
      }
      const pending = this.pending;
      this.pending = null;
      pending.resolve(pending.values);
    }
  }

  private fail(message: string) {
    this.failure ??= new Error(message);
    this.pending?.reject(this.failure);
    this.pending = null;
    this.child.kill("SIGTERM");
  }

  async read(sql: string): Promise<unknown> {
    const values = await this.readMany(sql, 1);
    return values[0];
  }

  async readMany(sql: string, count: number): Promise<unknown[]> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Earnings audit reader is closed");
    if (this.pending) throw new Error("Concurrent earnings audit reads are forbidden");
    if (!Number.isInteger(count) || count < 1 || count > MAX_AUDIT_RESPONSES) {
      throw new Error("Invalid earnings audit response count");
    }
    return new Promise((resolve, reject) => {
      this.pending = { count, values: [], bytes: 0, resolve, reject };
      this.child.stdin.write(sql + "\n");
    });
  }

  async close() {
    clearTimeout(this.deadline);
    if (!this.closed) {
      if (this.failure || this.pending) this.child.kill("SIGTERM");
      else this.child.stdin.end();
      await Promise.race([this.finished, delay(1000)]);
    }
    if (!this.closed) {
      this.child.kill("SIGTERM");
      await Promise.race([this.finished, delay(1000)]);
    }
    if (!this.closed) {
      this.child.kill("SIGKILL");
      await Promise.race([this.finished, delay(1000)]);
    }
    return {
      stderr: this.stderr,
      error: this.closed ? this.failure?.message ?? null : "Earnings audit reader cleanup timed out",
    };
  }
}

// SQL travels on stdin, never through a shell. The session pins standard strings.
export function auditSqlLiteral(value: unknown): string {
  return value === null ? "NULL" : "'" + String(value).replaceAll("'", "''") + "'";
}
