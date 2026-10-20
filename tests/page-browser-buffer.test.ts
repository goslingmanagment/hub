import { spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { EventBuffer, type BufferAlarm, type BufferOptions, type BufferRefusal, type BufferUnavailable, type CommittedOutcome, type Durable } from "../apps/page-browser/src/buffer/buffer.ts";
import { BufferVersionError, MIGRATIONS, type Migration } from "../apps/page-browser/src/buffer/schema.ts";
import { DB_FILE } from "../apps/page-browser/src/buffer/store.ts";
import { EventStream } from "../apps/page-browser/src/buffer/stream.ts";
import { type EventsRefused } from "../apps/page-browser/src/rpc/protocol.ts";
import { hubResult, quiet, tempDir, wsFrame } from "./helpers/page-browser-fakes.ts";

// The operator's buffer (Project Browser plan §4.4, §4.10, §4.14; spec §5;
// stage 3, PR 11): events numbered per buffer and kept in order across
// restarts; writes gathered for ≤ 20 ms and durable when they say so; the
// stream to the engine in bounded batches, resumed from the last ack, a
// foreign buffer's word refused; outcomes until resultAck; the caps with
// their alarms, and a full buffer that refuses, stops and marks its gap; a
// crash mid-write that loses nothing confirmed; an older format read.

const opened: EventBuffer[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const buffer of opened.splice(0)) await buffer.close();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function dir(): string {
  const temp = tempDir("pb-buffer-");
  cleanups.push(temp.remove);
  return temp.dir;
}

function open(root: string, options: Partial<BufferOptions> = {}): EventBuffer {
  const buffer = new EventBuffer({ dir: join(root, "store"), idFile: join(root, "buffer-id"), batchMs: 5, minFreeBytes: 0, log: quiet, ...options });
  opened.push(buffer);
  return buffer;
}

async function reopen(buffer: EventBuffer, root: string, options: Partial<BufferOptions> = {}): Promise<EventBuffer> {
  await buffer.close();
  return open(root, options);
}

async function written(appended: ReturnType<EventBuffer["append"]>): Promise<Durable> {
  if (!appended.ok) throw new Error(`refused: ${appended.reason}`);
  return appended.durable;
}

async function seqOf(appended: ReturnType<EventBuffer["append"]>): Promise<number> {
  const durable = await written(appended);
  if (!durable.ok || durable.seq === null) throw new Error("not written");
  return durable.seq;
}

function outcomesOf(buffer: EventBuffer) {
  return buffer.outcomePage(0, 1_000_000, Number.MAX_SAFE_INTEGER);
}

function all(buffer: EventBuffer): Array<Record<string, unknown>> {
  return buffer.readEvents(0, 1_000_000, Number.MAX_SAFE_INTEGER).map((event) => JSON.parse(event.json) as Record<string, unknown>);
}

/** A buffer whose committed batches go to a stream with a recording sink. */
function streamed(root: string, options: Partial<BufferOptions> = {}, stream: { maxEvents?: number; maxBytes?: number; inFlightBatches?: number; markRetryMs?: readonly number[] } = {}) {
  let pump = () => undefined as void;
  const buffer = open(root, { ...options, onCommitted: () => pump() });
  const sent: Array<{ type: string; bufferId: string; events: Array<Record<string, unknown>>; bytes: number }> = [];
  const events = new EventStream(
    buffer,
    (json) => {
      sent.push({ ...(JSON.parse(json) as { type: string; bufferId: string; events: Array<Record<string, unknown>> }), bytes: Buffer.byteLength(json) });
      return true;
    },
    { log: quiet, ...stream },
  );
  pump = () => events.pump();
  const seqs = () => sent.flatMap((message) => message.events.map((event) => event.seq as number));
  return { buffer, stream: events, sent, seqs };
}

const subscribe = (bufferId: string, afterSeq: number) => ({ type: "events.subscribe" as const, ownerGeneration: 1, bufferId, afterSeq });
const ack = (bufferId: string, uptoSeq: number) => ({ type: "ack" as const, ownerGeneration: 1, bufferId, uptoSeq });

describe("numbering and order", () => {
  it("numbers events from 1 in order, stamps them, and goes on across restarts — numbers are never given twice", async () => {
    const root = dir();
    let buffer = open(root);
    const kinds = [
      buffer.append({ kind: "ws.open", connectionId: "conn-1", attemptId: 41, sessionFingerprint: "f".repeat(64) }),
      buffer.append(wsFrame(1)),
      buffer.append({ kind: "ws.close", connectionId: "conn-1", code: 1006, reason: null }),
    ];
    expect(await Promise.all(kinds.map(seqOf))).toEqual([1, 2, 3]);
    const events = all(buffer);
    expect(events.map((event) => [event.seq, event.kind])).toEqual([
      [1, "ws.open"],
      [2, "ws.in"],
      [3, "ws.close"],
    ]);
    expect(events[1]).toMatchObject({ connectionId: "conn-1", frame: '{"t":2,"d":"{\\"n\\":1}"}', atMono: expect.any(Number), atWall: expect.any(Number) });
    const id = buffer.id;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(root, "buffer-id"), "utf8").trim()).toBe(id);

    buffer = await reopen(buffer, root);
    expect(buffer.id).toBe(id);
    expect(buffer.lastSeq).toBe(3);
    expect(all(buffer).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(await seqOf(buffer.append(wsFrame(4)))).toBe(4);

    // Everything acknowledged and deleted: the numbers still go on.
    buffer.acknowledge(4);
    await buffer.flush();
    expect(buffer.stats()).toMatchObject({ events: 0, bytes: 0, oldestAgeMs: 0 });
    buffer = await reopen(buffer, root);
    expect(await seqOf(buffer.append(wsFrame(5)))).toBe(5);
    expect(buffer.integrity()).toBe("ok");
  });

  it("gives a database made anew an id made anew, even with the old id left behind", async () => {
    const root = dir();
    // PR 4's file, from before the database existed.
    writeFileSync(join(root, "buffer-id"), "11111111-1111-4111-8111-111111111111\n");
    let buffer = open(root);
    expect(buffer.id).not.toBe("11111111-1111-4111-8111-111111111111");
    expect(readFileSync(join(root, "buffer-id"), "utf8").trim()).toBe(buffer.id);
    await seqOf(buffer.append(wsFrame(1)));
    const first = buffer.id;
    // The database is lost, its id file stays: the numbers start again, so
    // the id must not be the old one — (id, 1) would name two events.
    await buffer.close();
    rmSync(join(root, "store"), { recursive: true });
    buffer = open(root);
    expect(buffer.id).not.toBe(first);
    expect(await seqOf(buffer.append(wsFrame(1)))).toBe(1);
  });

  it("cannot be opened by a second operator while one holds it: that one reports it locked and takes nothing", async () => {
    const root = dir();
    const holder = open(root);
    await seqOf(holder.append(wsFrame(1)));
    const second = open(root);
    expect(second.unavailable).toMatchObject({ cause: "locked", recoverable: true, attempts: 1 });
    expect(second.refusal()).toBe("buffer_unavailable");
    expect(second.append(wsFrame(2))).toEqual({ ok: false, reason: "buffer_unavailable" });
    // It says the id the buffer had (its copy), not a new one.
    expect(second.id).toBe(holder.id);
  });
});

describe("writes", () => {
  it("are gathered for at most the batch time: a burst is one commit, durable within the bound", async () => {
    const buffer = open(dir(), { batchMs: 20 });
    const start = performance.now();
    const burst = Array.from({ length: 200 }, (_, n) => buffer.append(wsFrame(n)));
    const seqs = await Promise.all(burst.map(seqOf));
    const elapsed = performance.now() - start;
    expect(seqs).toEqual(Array.from({ length: 200 }, (_, n) => n + 1));
    expect(buffer.stats().commits).toBe(1);
    // 20 ms of gathering and one fsync (generous for a loaded machine).
    expect(elapsed).toBeLessThan(500);
    // Two writes apart in time are two commits.
    await seqOf(buffer.append(wsFrame(201)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await seqOf(buffer.append(wsFrame(202)));
    expect(buffer.stats().commits).toBe(3);
  });

  it("commit a large burst at the next turn, without waiting the batch time", async () => {
    const buffer = open(dir(), { batchMs: 20 });
    const pending = Array.from({ length: 2500 }, (_, n) => buffer.append(wsFrame(n)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(buffer.stats()).toMatchObject({ commits: 1, pending: 0, lastSeq: 2500 });
    expect(await Promise.all(pending.map(seqOf))).toEqual(Array.from({ length: 2500 }, (_, n) => n + 1));
  });

  it("keep an attempt's outcome until its resultAck — the first outcome stands, across a restart", async () => {
    const root = dir();
    let buffer = open(root);
    await written(buffer.putOutcome(hubResult(11)));
    await written(buffer.putOutcome({ type: "siteDone", siteRequestId: "s-1", attemptId: 12, sent: true, sentMono: 1, sentWall: 2, connectionReused: false, status: 200, retryAfter: null, error: null, body: "buffered" }));
    // A second outcome of attempt 11 is not stored again.
    await written(buffer.putOutcome(hubResult(11, 500)));
    expect(outcomesOf(buffer).map((outcome) => [outcome.attemptId, (JSON.parse(outcome.json) as { outcome?: { status?: number } }).outcome?.status ?? null])).toEqual([
      [11, 200],
      [12, null],
    ]);
    expect(buffer.stats().outcomes).toBe(2);
    buffer.acknowledgeOutcome(11);
    await buffer.flush();
    buffer = await reopen(buffer, root);
    expect(outcomesOf(buffer).map((outcome) => outcome.attemptId)).toEqual([12]);
    expect(buffer.stats().bytes).toBe(outcomesOf(buffer)[0]!.bytes);
    // Outcomes are not events: no number.
    expect(await written(buffer.putOutcome(hubResult(13)))).toEqual({ ok: true, seq: null });
    expect(buffer.lastSeq).toBe(0);
  });

  it("tell the producers only once the batch is durable, and say what was committed", async () => {
    const committed: Array<{ events: number; outcomes: CommittedOutcome[] }> = [];
    const buffer = open(dir(), { batchMs: 10, onCommitted: (batch) => committed.push(batch) });
    let settled = false;
    const appended = buffer.append(wsFrame(1));
    void written(appended).then(() => (settled = true));
    buffer.putOutcome(hubResult(7));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(committed).toEqual([]);
    await written(appended);
    expect(committed).toEqual([{ events: 1, outcomes: [{ attemptId: 7, json: JSON.stringify(hubResult(7)), bodyId: null }] }]);
  });
});

describe("the stream (plan §4.4, step 4)", () => {
  it("sends durable events only, in order, ≤ 500 events a batch", async () => {
    const { buffer, stream, sent, seqs } = streamed(dir(), {}, { inFlightBatches: 10 });
    expect(stream.subscribe(subscribe(buffer.id, 0))).toBeNull();
    const pending = Array.from({ length: 1200 }, (_, n) => buffer.append(wsFrame(n + 1)));
    // Nothing is sent before it is durable.
    expect(sent).toEqual([]);
    await Promise.all(pending.map(seqOf));
    expect(seqs()).toEqual(Array.from({ length: 1200 }, (_, n) => n + 1));
    expect(sent.every((message) => message.type === "events" && message.bufferId === buffer.id)).toBe(true);
    expect(Math.max(...sent.map((message) => message.events.length))).toBeLessThanOrEqual(500);
  });

  it("keeps a batch within its bytes, a single bigger event alone", async () => {
    const { buffer, stream, sent } = streamed(dir(), {}, { inFlightBatches: 100 });
    stream.setBatch(500, 4096);
    for (let n = 1; n <= 10; n++) buffer.append(wsFrame(n, 1000));
    buffer.append(wsFrame(11, 10_000));
    buffer.append(wsFrame(12, 10));
    await buffer.flush();
    expect(stream.subscribe(subscribe(buffer.id, 0))).toBeNull();
    const big = sent.find((message) => message.events.some((event) => event.seq === 11))!;
    expect(big.events).toHaveLength(1);
    for (const message of sent.filter((one) => one !== big)) expect(message.bytes).toBeLessThanOrEqual(4096);
    // ~1 KB events: three to a 4 KB batch, not one at a time.
    expect(sent[0]!.events).toHaveLength(3);
    expect(sent.flatMap((message) => message.events.map((event) => event.seq))).toEqual(Array.from({ length: 12 }, (_, n) => n + 1));
  });

  it("has a few batches on their way at most: the engine's acks pace it", async () => {
    const { buffer, stream, seqs } = streamed(dir(), {}, { maxEvents: 10, inFlightBatches: 2 });
    for (let n = 1; n <= 50; n++) buffer.append(wsFrame(n));
    await buffer.flush();
    stream.subscribe(subscribe(buffer.id, 0));
    expect(seqs().at(-1)).toBe(20);
    expect(stream.ack(ack(buffer.id, 5))).toBeNull(); // part of the first batch: it stays on its way
    expect(seqs().at(-1)).toBe(20);
    expect(stream.ack(ack(buffer.id, 10))).toBeNull();
    expect(seqs().at(-1)).toBe(30);
    expect(stream.position).toEqual({ sentSeq: 30, ackedSeq: 10, inFlight: 2 });
  });

  it("deletes what the engine acknowledged, and only that; after a reconnect it resumes from the last ack", async () => {
    const root = dir();
    const { buffer, stream, sent, seqs } = streamed(root, {}, { maxEvents: 10, inFlightBatches: 3 });
    for (let n = 1; n <= 40; n++) buffer.append(wsFrame(n));
    await buffer.flush();
    stream.subscribe(subscribe(buffer.id, 0));
    expect(seqs()).toEqual(Array.from({ length: 30 }, (_, n) => n + 1));
    stream.ack(ack(buffer.id, 12));
    await buffer.flush();
    expect(buffer.stats().events).toBe(28);
    expect(all(buffer)[0]!.seq).toBe(13);
    // The connection breaks: 13..40 were sent or not, none acknowledged.
    stream.reset();
    sent.length = 0;
    expect(stream.ack(ack(buffer.id, 20))).toMatchObject({ type: "events.refused", of: "ack", reason: "not_subscribed" });
    stream.subscribe(subscribe(buffer.id, 12));
    expect(seqs()[0]).toBe(13);
    stream.ack(ack(buffer.id, 40));
    await buffer.flush();
    expect(seqs().at(-1)).toBe(40);
    expect(buffer.stats().events).toBe(0);
  });

  it("takes a subscription's afterSeq as the engine's word: what is before it goes", async () => {
    const { buffer, stream, sent, seqs } = streamed(dir());
    for (let n = 1; n <= 10; n++) buffer.append(wsFrame(n));
    await buffer.flush();
    // Sent once; the engine committed up to 6 and its link broke.
    stream.subscribe(subscribe(buffer.id, 0));
    stream.reset();
    sent.length = 0;
    stream.subscribe(subscribe(buffer.id, 6));
    await buffer.flush();
    expect(seqs()).toEqual([7, 8, 9, 10]);
    expect(all(buffer).map((event) => event.seq)).toEqual([7, 8, 9, 10]);
  });

  it("refuses a foreign buffer's subscription and ack — a late ack of the old buffer after the volume was made anew deletes nothing", async () => {
    // The old volume: the engine acknowledged up to 5000 of buffer A.
    const old = open(dir());
    const oldId = old.id;
    await old.close();
    // The volume made anew: buffer B, numbers from 1.
    const { buffer, stream, seqs } = streamed(dir());
    for (let n = 1; n <= 10; n++) buffer.append(wsFrame(n));
    await buffer.flush();
    const refusedAck = stream.ack(ack(oldId, 5000));
    expect(refusedAck).toEqual({ type: "events.refused", of: "ack", reason: "foreign_buffer", bufferId: buffer.id, givenBufferId: oldId, givenSeq: 5000 } satisfies EventsRefused);
    expect(stream.subscribe(subscribe(oldId, 5000))).toMatchObject({ of: "events.subscribe", reason: "foreign_buffer", bufferId: buffer.id });
    expect(stream.subscribe(subscribe(oldId, 5))).toMatchObject({ reason: "foreign_buffer" });
    await buffer.flush();
    expect(all(buffer)).toHaveLength(10);
    expect(seqs()).toEqual([]);
    // Told the operator's id, the engine starts over with it.
    expect(stream.subscribe(subscribe(buffer.id, 0))).toBeNull();
    expect(seqs()).toEqual(Array.from({ length: 10 }, (_, n) => n + 1));
    // A foreign ack while subscribed is refused too.
    expect(stream.ack(ack(oldId, 3))).toMatchObject({ reason: "foreign_buffer" });
    await buffer.flush();
    expect(all(buffer)).toHaveLength(10);
  });

  it("refuses an ack past what was sent and a subscription past the last number", async () => {
    const { buffer, stream } = streamed(dir(), {}, { maxEvents: 5, inFlightBatches: 1 });
    for (let n = 1; n <= 10; n++) buffer.append(wsFrame(n));
    await buffer.flush();
    expect(stream.subscribe(subscribe(buffer.id, 11))).toMatchObject({ reason: "ahead", givenSeq: 11 });
    stream.subscribe(subscribe(buffer.id, 0));
    // Sent 1..5 only: an ack of 8 would delete events the engine never had.
    expect(stream.ack(ack(buffer.id, 8))).toMatchObject({ of: "ack", reason: "beyond_sent" });
    await buffer.flush();
    expect(all(buffer)).toHaveLength(10);
    // A repeated or lower ack is no harm.
    expect(stream.ack(ack(buffer.id, 5))).toBeNull();
    expect(stream.ack(ack(buffer.id, 3))).toBeNull();
  });
});

// The engine's intake (PR 13, Astra's review): the buffer keeps durably the
// highest number it ever sent; a subscription past it is refused.
describe("the sent mark (schema v4)", () => {
  it("is raised durably before any event past it is sent, once per advance, and survives a reopen", async () => {
    const root = dir();
    const { buffer, stream, seqs } = streamed(root, {}, { maxEvents: 5, inFlightBatches: 1 });
    for (let n = 1; n <= 12; n++) buffer.append(wsFrame(n));
    await buffer.flush();
    expect(buffer.sentMax).toBe(0);
    stream.subscribe(subscribe(buffer.id, 0));
    // One batch on its way (1..5), the mark over everything stored then.
    expect(seqs()).toEqual([1, 2, 3, 4, 5]);
    expect(buffer.sentMax).toBe(12);
    stream.ack(ack(buffer.id, 5));
    expect(seqs().at(-1)).toBe(10);
    expect(buffer.sentMax).toBe(12);
    const reopened = await reopen(buffer, root);
    expect(reopened.sentMax).toBe(12);
  });

  it("nothing is sent past the mark when it cannot be written; it goes once it can", async () => {
    const root = dir();
    let failMarks = true;
    const { buffer, stream, seqs } = streamed(root);
    const raise = buffer.raiseSentMax.bind(buffer);
    buffer.raiseSentMax = () => (failMarks ? false : raise());
    for (let n = 1; n <= 3; n++) buffer.append(wsFrame(n));
    await buffer.flush();
    stream.subscribe(subscribe(buffer.id, 0));
    expect(seqs()).toEqual([]);
    expect(buffer.sentMax).toBe(0);
    failMarks = false;
    stream.pump();
    expect(seqs()).toEqual([1, 2, 3]);
    expect(buffer.sentMax).toBe(3);
  });

  it("a crash between the mark and the send: the mark covers what may have gone, and an engine's position within it is taken", async () => {
    const root = dir();
    let crash = true;
    const buffer = open(root);
    // The send itself never happens: the process dies right after the mark.
    const real = new EventStream(buffer, () => {
      if (crash) throw new Error("the process died before the send");
      return true;
    }, { log: quiet });
    for (let n = 1; n <= 4; n++) buffer.append(wsFrame(n));
    await buffer.flush();
    expect(() => real.subscribe(subscribe(buffer.id, 0))).toThrow(/process died/);
    crash = false;
    const reopened = await reopen(buffer, root);
    expect(reopened.sentMax).toBe(4);
    const again = new EventStream(reopened, () => true, { log: quiet });
    expect(again.subscribe(subscribe(reopened.id, 2))).toBeNull();
  });
});

describe("the caps (spec §5; plan §4.14)", () => {
  /** Fills with ~1 KB frames until refused; returns how many went in. */
  async function fill(buffer: EventBuffer, upTo = 1000): Promise<{ count: number; refusal: BufferRefusal | null }> {
    for (let n = 1; n <= upTo; n++) {
      const appended = buffer.append(wsFrame(n, 900));
      if (!appended.ok) return { count: n - 1, refusal: appended.reason };
      await appended.durable;
      buffer.check();
    }
    return { count: upTo, refusal: null };
  }

  it("full by bytes: refuses at once, says so (the page stops), keeps everything, and marks the gap from the last saved event once there is room", async () => {
    const full: Array<[BufferRefusal, BufferAlarm]> = [];
    const room: BufferRefusal[] = [];
    const buffer = open(dir(), { caps: { bytes: 10_000, ageMs: 3_600_000, alarmPercents: [50, 80] }, onFull: (reason, alarm) => full.push([reason, alarm]), onRoom: (reason) => room.push(reason) });
    const { count, refusal } = await fill(buffer);
    expect(refusal).toBe("buffer_full");
    expect(count).toBeGreaterThan(5);
    expect(full).toHaveLength(1);
    expect(full[0]![0]).toBe("buffer_full");
    expect(full[0]![1]).toMatchObject({ percent: 100, by: "bytes", capBytes: 10_000 });
    expect(buffer.refusal()).toBe("buffer_full");
    expect(buffer.append(wsFrame(0)).ok).toBe(false);
    expect(buffer.putOutcome(hubResult(1))).toEqual({ ok: false, reason: "buffer_full" });
    expect(buffer.markGap("ws_reconnect")).toEqual({ ok: false, reason: "buffer_full" });
    expect((await buffer.ready()).ok).toBe(false);
    // Nothing unacknowledged is deleted to make room.
    buffer.check();
    expect(all(buffer)).toHaveLength(count);
    const lastSaved = all(buffer).at(-1)!;
    // The engine takes half: below the room mark (90 % of the cap), the gap
    // goes in first and writes are taken again.
    buffer.acknowledge(Math.floor(count / 2));
    await buffer.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(room).toEqual(["buffer_full"]);
    expect(buffer.refusal()).toBeNull();
    const gap = all(buffer).at(-1)!;
    expect(gap).toMatchObject({ kind: "gap", seq: count + 1, fromSeq: count, fromWall: lastSaved.atWall, reason: "buffer_full" });
    expect(await seqOf(buffer.append(wsFrame(1)))).toBe(count + 2);
    expect((await buffer.ready()).ok).toBe(true);
  });
});

describe("a crash mid-write", () => {
  const child = fileURLToPath(new URL("./helpers/page-browser-buffer-child.ts", import.meta.url));

  /** The child writes until it has `confirmations` confirmed, then dies by
   *  SIGKILL; returns the numbers it was told were durable. */
  function crash(root: string, pad: number, confirmations: number): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ["--no-warnings", child, root, String(pad)], { stdio: ["ignore", "pipe", "pipe"] });
      const confirmed: number[] = [];
      let tail = "";
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      proc.stdout.on("data", (chunk: Buffer) => {
        tail += chunk.toString();
        const lines = tail.split("\n");
        tail = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^ok (\d+)$/.exec(line);
          if (match) confirmed.push(Number(match[1]));
          else if (!line.startsWith("open ")) reject(new Error(`the child said ${line}`));
        }
        if (confirmed.length >= confirmations && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      });
      proc.on("exit", (code, signal) => {
        if (signal !== "SIGKILL") reject(new Error(`the child exited ${code} ${signal}: ${stderr}`));
        else resolve(confirmed);
      });
    });
  }

  it.each([
    ["small frames", 200, 400],
    ["64 KiB frames", 64 * 1024, 80],
  ])("with %s, loses nothing confirmed and leaves no torn row; the numbers go on", async (_what, pad, confirmations) => {
    const root = dir();
    let id: string | null = null;
    let lastSeq = 0;
    for (let round = 0; round < 2; round++) {
      const confirmed = await crash(root, pad, confirmations);
      expect(confirmed.length).toBeGreaterThanOrEqual(confirmations);
      const buffer = open(root);
      expect(buffer.integrity()).toBe("ok");
      id ??= buffer.id;
      expect(buffer.id).toBe(id);
      const events = all(buffer);
      // Every number from 1 to the last, each with its own frame, whole.
      expect(events.map((event) => event.seq)).toEqual(Array.from({ length: events.length }, (_, n) => n + 1));
      for (const event of events) expect(event.frame).toBe(`frame ${event.seq as number} ${"x".repeat(pad)}`);
      expect(buffer.lastSeq).toBe(events.length);
      // What was confirmed is there, this round's and the one before.
      expect(Math.max(...confirmed)).toBeLessThanOrEqual(buffer.lastSeq);
      expect(Math.min(...confirmed)).toBe(lastSeq + 1);
      lastSeq = buffer.lastSeq;
      await buffer.close();
    }
  }, 60_000);
});

describe("the format (plan §4.10)", () => {
  /** A next version after the real ones, additive. */
  const NEXT: Migration = {
    version: MIGRATIONS.length + 1,
    readableFrom: 1,
    up: (db) => db.exec("CREATE TABLE later_things (id INTEGER PRIMARY KEY) STRICT"),
  };

  it("migrates an older buffer forward once, keeping what it holds", async () => {
    const root = dir();
    let buffer = open(root);
    for (let n = 1; n <= 3; n++) buffer.append(wsFrame(n));
    await written(buffer.putOutcome(hubResult(5)));
    const id = buffer.id;
    buffer = await reopen(buffer, root, { migrations: [...MIGRATIONS, NEXT] });
    expect(buffer.id).toBe(id);
    expect(all(buffer).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(outcomesOf(buffer)).toHaveLength(1);
    // Opened again: no version is applied twice.
    buffer = await reopen(buffer, root, { migrations: [...MIGRATIONS, NEXT] });
    expect(await seqOf(buffer.append(wsFrame(4)))).toBe(4);
    await buffer.close();
    const db = new DatabaseSync(join(root, "store", DB_FILE));
    expect(db.prepare("SELECT version, readable_from FROM schema_version ORDER BY version").all().map((row) => ({ ...row }))).toEqual([
      ...MIGRATIONS.map((migration) => ({ version: migration.version, readable_from: migration.readableFrom })),
      { version: NEXT.version, readable_from: 1 },
    ]);
    db.close();
  });

  it("lets an older operator (an image rolled back) use a newer buffer only when the newer one allows it", async () => {
    const additive = dir();
    let buffer = open(additive, { migrations: [...MIGRATIONS, NEXT] });
    await seqOf(buffer.append(wsFrame(1)));
    buffer = await reopen(buffer, additive, { migrations: MIGRATIONS });
    expect(await seqOf(buffer.append(wsFrame(2)))).toBe(2);
    await buffer.close();

    const breaking = dir();
    buffer = open(breaking, { migrations: [...MIGRATIONS, { ...NEXT, readableFrom: NEXT.version }] });
    await seqOf(buffer.append(wsFrame(1)));
    await buffer.close();
    const before = readFileSync(join(breaking, "store", DB_FILE));
    const unavailable: BufferUnavailable[] = [];
    const older = open(breaking, { migrations: MIGRATIONS, openRetryMs: [10], onUnavailable: (reason) => unavailable.push(reason) });
    older.start();
    expect(unavailable).toEqual([expect.objectContaining({ cause: "too_new", recoverable: false })]);
    expect(unavailable[0]!.detail).toContain(`schema version ${NEXT.version}, readable from ${NEXT.version}`);
    expect(await older.ready()).toMatchObject({ ok: false, reason: "buffer_unavailable" });
    // Not tried again, and the file is as it was: it is the owner's.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(older.unavailable?.attempts).toBe(1);
    await older.close();
    expect(readFileSync(join(breaking, "store", DB_FILE)).equals(before)).toBe(true);
    expect(new BufferVersionError("x")).toBeInstanceOf(Error);
  });
});

describe("bodies and Hub attempts (PR 9)", () => {
  it("an attempt's steps are durable, seen before their commit, never undone, and kept a day past the resultAck", async () => {
    const root = dir();
    let now = 1_791_800_000_000;
    let buffer = open(root, { now: () => now });
    expect(buffer.attempt(5)).toBeNull();
    const issued = buffer.markAttempt(5, "issued");
    expect(buffer.attempt(5)).toEqual({ issued: true, released: false, acked: false, outcome: false });
    expect(await written(issued)).toEqual({ ok: true, seq: null });
    buffer.markAttempt(5, "released");
    buffer.markAttempt(5, "received");
    await buffer.flush();
    expect(buffer.attempt(5)).toEqual({ issued: true, released: true, acked: false, outcome: false });
    buffer = await reopen(buffer, root, { now: () => now });
    expect(buffer.attempt(5)).toEqual({ issued: true, released: true, acked: false, outcome: false });
    await written(buffer.putOutcome(hubResult(5)));
    expect(buffer.attempt(5)).toMatchObject({ outcome: true });
    buffer.acknowledgeOutcome(5);
    await buffer.flush();
    expect(buffer.attempt(5)).toEqual({ issued: true, released: true, acked: true, outcome: false });
    // An attempt that never got an outcome (a crash) stays a week.
    buffer.markAttempt(6, "issued");
    await buffer.flush();
    now += 25 * 3600_000;
    buffer = await reopen(buffer, root, { now: () => now });
    buffer.check();
    await buffer.flush();
    expect(buffer.attempt(5)).toBeNull();
    expect(buffer.attempt(6)).toMatchObject({ issued: true });
    now += 7 * 24 * 3600_000;
    buffer = await reopen(buffer, root, { now: () => now });
    buffer.check();
    await buffer.flush();
    expect(buffer.attempt(6)).toBeNull();
  });
});

describe("the site's answers and requests (PR 7; schema v5)", () => {
  const FP = "f".repeat(64);

  /** A sealed body and the `site.response` that names it. */
  function siteResponse(buffer: EventBuffer, data: Buffer, complete = true) {
    const writer = buffer.beginBody()!;
    writer.write(data);
    const sealed = writer.seal()!;
    const event = {
      kind: "site.response" as const,
      siteRequestId: "0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
      attemptId: 7,
      route: "account.me",
      method: "GET",
      path: "/api/v1/account/me",
      query: "",
      status: 200,
      headers: { "content-type": "application/json" },
      body: { bodyId: sealed.bodyId, decodedBytes: sealed.bytes, sha256: sealed.sha256 },
      complete,
      source: "network" as const,
      sessionFingerprint: FP,
    };
    return { sealed, event };
  }

  it("an event's body counts in its bytes, is kept over a restart's sweep, and goes with the engine's ack of the event", async () => {
    const root = dir();
    let buffer = open(root);
    const data = Buffer.alloc(5000, 7);
    const { sealed, event } = siteResponse(buffer, data);
    const before = buffer.stats().bytes;
    const seq = await seqOf(buffer.append(event, undefined, { body: { bodyId: sealed.bodyId, bytes: sealed.bytes } }));
    expect(buffer.stats().bytes - before).toBeGreaterThanOrEqual(5000);
    expect(buffer.readEvents(0, 10, Number.MAX_SAFE_INTEGER)).toEqual([expect.objectContaining({ seq, bodyId: sealed.bodyId, bytes: expect.any(Number) })]);
    // A body nothing names goes at the next open; the event's stays.
    const orphan = buffer.beginBody()!;
    orphan.write(Buffer.from("orphan"));
    const orphaned = orphan.seal()!;
    buffer = await reopen(buffer, root);
    expect(readdirSync(join(root, "store", "bodies"))).toEqual([sealed.bodyId]);
    expect(buffer.bodySize(orphaned.bodyId)).toBeNull();
    expect(buffer.readBody(sealed.bodyId, 0, 1 << 20)?.equals(data)).toBe(true);
    buffer.acknowledge(seq);
    await buffer.flush();
    expect(all(buffer)).toEqual([]);
    expect(readdirSync(join(root, "store", "bodies"))).toEqual([]);
    expect(buffer.stats().bytes).toBe(before);
  });
});
