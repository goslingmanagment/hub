// The stand's Postgres, as the runner's engine commits to it: the simple
// query protocol of Postgres 3.0 over one TCP connection, nothing more. The
// stand has no npm packages (apps/page-browser runs on Node alone), and its
// database trusts the stand's internal network (POSTGRES_HOST_AUTH_METHOD
// trust): there is no password anywhere. Queries go one at a time, in order.

import { connect, type Socket } from "node:net";

export class PgError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "PgError";
    this.code = code;
  }
}

export interface PgResult {
  /** Every row as text values (null for SQL NULL). */
  rows: Array<Array<string | null>>;
  command: string;
}

interface Pending {
  sql: string;
  resolve: (result: PgResult) => void;
  reject: (error: Error) => void;
}

/** A string as an SQL literal (standard_conforming_strings is on). */
export function lit(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("a number that is not finite");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value.includes("\0")) throw new Error("a string with a NUL byte");
  return `'${value.replaceAll("'", "''")}'`;
}

export class Pg {
  readonly #socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #queue: Pending[] = [];
  #current: Pending | null = null;
  #rows: Array<Array<string | null>> = [];
  #command = "";
  #error: PgError | null = null;
  #ready = false;
  #closed: Error | null = null;
  #onReady: ((error: Error | null) => void) | null = null;

  private constructor(socket: Socket) {
    this.#socket = socket;
  }

  static connect(host: string, port: number, user: string, database: string, timeoutMs = 5000): Promise<Pg> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const pg = new Pg(socket);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Postgres at ${host}:${port}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pg.#onReady = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(pg);
      };
      socket.setNoDelay(true);
      socket.on("data", (chunk: Buffer) => pg.#feed(chunk));
      socket.on("error", (error) => pg.#fail(error));
      socket.on("close", () => pg.#fail(new Error("the connection to Postgres closed")));
      socket.on("connect", () => {
        const params = Buffer.from(`user\0${user}\0database\0${database}\0application_name\0pb-suite-runner\0\0`, "utf8");
        const head = Buffer.alloc(8);
        head.writeInt32BE(8 + params.length, 0);
        head.writeInt32BE(196608, 4);
        socket.write(Buffer.concat([head, params]));
      });
    });
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  query(sql: string): Promise<PgResult> {
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      this.#queue.push({ sql, resolve, reject });
      this.#next();
    });
  }

  close(): void {
    if (!this.#closed) {
      const terminate = Buffer.from([0x58, 0, 0, 0, 4]);
      this.#socket.end(terminate);
    }
    this.#fail(new Error("closed by the runner"));
  }

  #next(): void {
    if (!this.#ready || this.#current !== null || this.#closed) return;
    const pending = this.#queue.shift();
    if (!pending) return;
    this.#current = pending;
    this.#rows = [];
    this.#command = "";
    this.#error = null;
    const body = Buffer.from(`${pending.sql}\0`, "utf8");
    const head = Buffer.alloc(5);
    head[0] = 0x51;
    head.writeInt32BE(4 + body.length, 1);
    this.#socket.write(Buffer.concat([head, body]));
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    this.#socket.destroy();
    this.#onReady?.(error);
    this.#onReady = null;
    for (const pending of [...(this.#current ? [this.#current] : []), ...this.#queue]) pending.reject(error);
    this.#current = null;
    this.#queue = [];
  }

  #feed(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 5) {
      const type = this.#buffer[0]!;
      const length = this.#buffer.readInt32BE(1);
      if (this.#buffer.length < 1 + length) return;
      const body = this.#buffer.subarray(5, 1 + length);
      this.#buffer = this.#buffer.subarray(1 + length);
      this.#message(type, body);
    }
  }

  #message(type: number, body: Buffer): void {
    switch (String.fromCharCode(type)) {
      case "R": {
        const code = body.readInt32BE(0);
        if (code !== 0) this.#fail(new Error(`Postgres asks for authentication (method ${code}): the stand's database must trust its network`));
        return;
      }
      case "Z":
        if (!this.#ready) {
          this.#ready = true;
          this.#onReady?.(null);
          this.#onReady = null;
        } else if (this.#current) {
          const current = this.#current;
          this.#current = null;
          if (this.#error) current.reject(this.#error);
          else current.resolve({ rows: this.#rows, command: this.#command });
        }
        this.#next();
        return;
      case "D": {
        const count = body.readInt16BE(0);
        const row: Array<string | null> = [];
        let offset = 2;
        for (let i = 0; i < count; i++) {
          const size = body.readInt32BE(offset);
          offset += 4;
          if (size < 0) row.push(null);
          else {
            row.push(body.subarray(offset, offset + size).toString("utf8"));
            offset += size;
          }
        }
        this.#rows.push(row);
        return;
      }
      case "C":
        this.#command = body.subarray(0, body.length - 1).toString("utf8");
        return;
      case "E": {
        const fields = new Map<string, string>();
        let offset = 0;
        while (offset < body.length && body[offset] !== 0) {
          const key = String.fromCharCode(body[offset]!);
          const end = body.indexOf(0, offset + 1);
          fields.set(key, body.subarray(offset + 1, end).toString("utf8"));
          offset = end + 1;
        }
        const error = new PgError(fields.get("M") ?? "a Postgres error", fields.get("C") ?? "");
        if (!this.#ready) this.#fail(error);
        else this.#error = error;
        return;
      }
      default:
        // S (parameters), K (backend key), T (columns), N (notice), I (empty).
        return;
    }
  }
}
