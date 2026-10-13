import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { EventBuffer, type BufferAlarm, type BufferOptions, type BufferRefusal, type BufferUnavailable, type Durable } from "../apps/page-browser/src/buffer/buffer.ts";
import { BufferVersionError, MIGRATIONS, type Migration } from "../apps/page-browser/src/buffer/schema.ts";
import { DB_FILE } from "../apps/page-browser/src/buffer/store.ts";
import { EventStream } from "../apps/page-browser/src/buffer/stream.ts";
import type { EventsRefused } from "../apps/page-browser/src/rpc/protocol.ts";
import { hubResult, quiet, tempDir, until, wsFrame } from "./helpers/page-browser-fakes.ts";

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
function streamed(root: string, options: Partial<BufferOptions> = {}, stream: { maxEvents?: number; maxBytes?: number; inFlightBatches?: number } = {}) {
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
    const committed: Array<{ events: number; outcomes: string[] }> = [];
    const buffer = open(dir(), { batchMs: 10, onCommitted: (batch) => committed.push(batch) });
    let settled = false;
    const appended = buffer.append(wsFrame(1));
    void written(appended).then(() => (settled = true));
    buffer.putOutcome(hubResult(7));
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(committed).toEqual([]);
    await written(appended);
    expect(committed).toEqual([{ events: 1, outcomes: [JSON.stringify(hubResult(7))] }]);
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
    const { buffer, stream, seqs } = streamed(dir());
    for (let n = 1; n <= 10; n++) buffer.append(wsFrame(n));
    await buffer.flush();
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

  it("alarm at 50 % and 80 % of the bytes cap, once each, and again after the buffer drained well below", async () => {
    const alarms: BufferAlarm[] = [];
    const buffer = open(dir(), { caps: { bytes: 10_000, ageMs: 3_600_000, alarmPercents: [50, 80] }, onAlarm: (alarm) => alarms.push(alarm) });
    await fill(buffer, 6);
    expect(alarms.map((alarm) => [alarm.percent, alarm.by])).toEqual([[50, "bytes"]]);
    buffer.check();
    expect(alarms).toHaveLength(1);
    await fill(buffer, 3);
    expect(alarms.map((alarm) => alarm.percent)).toEqual([50, 80]);
    expect(alarms[1]).toMatchObject({ capBytes: 10_000, bytes: expect.any(Number) });
    buffer.acknowledge(buffer.lastSeq);
    await buffer.flush();
    buffer.check();
    await fill(buffer, 6);
    expect(alarms.map((alarm) => alarm.percent)).toEqual([50, 80, 50]);
  });

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

  it("full by age: 50 %, 80 %, then full at the oldest unacknowledged record's cap; room once it is acknowledged", async () => {
    let now = 1_000_000;
    const alarms: number[] = [];
    const full: Array<[BufferRefusal, BufferAlarm["by"]]> = [];
    const buffer = open(dir(), { now: () => now, caps: { bytes: 1024 * 1024, ageMs: 10_000, alarmPercents: [50, 80] }, onAlarm: (alarm) => alarms.push(alarm.percent), onFull: (reason, alarm) => full.push([reason, alarm.by]) });
    await seqOf(buffer.append(wsFrame(1)));
    now += 5000;
    buffer.check();
    expect(buffer.stats().oldestAgeMs).toBe(5000);
    now += 3000;
    buffer.check();
    expect(alarms).toEqual([50, 80]);
    now += 2000;
    buffer.check();
    expect(full).toEqual([["buffer_full", "age"]]);
    expect(buffer.append(wsFrame(2))).toEqual({ ok: false, reason: "buffer_full" });
    buffer.acknowledge(1);
    await buffer.flush();
    await new Promise((resolve) => setImmediate(resolve));
    expect(buffer.refusal()).toBeNull();
    expect(all(buffer)).toEqual([expect.objectContaining({ seq: 2, kind: "gap", fromSeq: 1, reason: "buffer_full" })]);
  });

  it("counts outcomes in the age too", async () => {
    let now = 5_000_000;
    const buffer = open(dir(), { now: () => now });
    await written(buffer.putOutcome(hubResult(3)));
    now += 7000;
    expect(buffer.stats()).toMatchObject({ oldestAgeMs: 7000, outcomes: 1 });
  });

  it("full disk: below the reserve the buffer takes nothing (disk_full); room again at twice the reserve, the gap first", async () => {
    let free = 10_000_000;
    const full: BufferRefusal[] = [];
    const room: BufferRefusal[] = [];
    const buffer = open(dir(), { diskFree: () => free, minFreeBytes: 1000, onFull: (reason) => full.push(reason), onRoom: (reason) => room.push(reason) });
    await seqOf(buffer.append(wsFrame(1)));
    free = 500;
    buffer.check();
    expect(full).toEqual(["disk_full"]);
    expect(buffer.append(wsFrame(2))).toEqual({ ok: false, reason: "disk_full" });
    expect(await buffer.ready()).toMatchObject({ ok: false, reason: "disk_full" });
    free = 1500;
    buffer.check();
    expect(buffer.refusal()).toBe("disk_full");
    free = 2500;
    buffer.check();
    expect(room).toEqual(["disk_full"]);
    expect(all(buffer).map((event) => [event.seq, event.kind, event.reason ?? null])).toEqual([
      [1, "ws.in", null],
      [2, "gap", "disk_full"],
    ]);
  });

  it("SQLite's own full: the batch fails — nothing of it confirmed or kept — and its numbers are given again once the gap is written", async () => {
    const full: Array<[BufferRefusal, string]> = [];
    const buffer = open(dir(), { maxPages: 40, onFull: (reason, _alarm, detail) => full.push([reason, detail]) });
    let failed: Durable | null = null;
    let last = 0;
    for (let n = 1; n <= 200 && failed === null; n++) {
      const durable = await written(buffer.append(wsFrame(n, 8000)));
      if (durable.ok) last = durable.seq!;
      else failed = durable;
    }
    expect(failed).toEqual({ ok: false, reason: "disk_full" });
    expect(full).toHaveLength(1);
    expect(full[0]![1]).toMatch(/SQLite 13/);
    expect(buffer.refusal()).toBe("disk_full");
    expect(buffer.lastSeq).toBe(last);
    expect(all(buffer).map((event) => event.seq)).toEqual(Array.from({ length: last }, (_, n) => n + 1));
    // The engine takes most of it: pages are free again.
    buffer.acknowledge(last - 1);
    await buffer.flush();
    buffer.check();
    expect(buffer.refusal()).toBeNull();
    expect(all(buffer).map((event) => [event.seq, event.kind])).toEqual([
      [last, "ws.in"],
      [last + 1, "gap"],
    ]);
    expect(await seqOf(buffer.append(wsFrame(1)))).toBe(last + 2);
    expect(buffer.integrity()).toBe("ok");
  });

  it("marks a producer's gap from the event before it, or from where it says", async () => {
    const buffer = open(dir());
    buffer.append(wsFrame(1));
    buffer.append({ kind: "ws.close", connectionId: "conn-1", code: 1006, reason: null });
    buffer.markGap("ws_reconnect");
    buffer.markGap("chrome_restart", { seq: 1, wall: 42 });
    await buffer.flush();
    const events = all(buffer);
    expect(events[2]).toMatchObject({ seq: 3, kind: "gap", fromSeq: 2, fromWall: events[1]!.atWall, reason: "ws_reconnect" });
    expect(events[3]).toMatchObject({ seq: 4, kind: "gap", fromSeq: 1, fromWall: 42, reason: "chrome_restart" });
    // A first event that is a gap has nothing before it.
    const fresh = open(dir());
    await seqOf(fresh.markGap("operator_start"));
    expect(all(fresh)[0]).toMatchObject({ seq: 1, fromSeq: null, fromWall: null });
  });
});

describe("space, failures and a buffer that cannot be opened (Astra's review of PR 11)", () => {
  /** What the buffer's files take on the disk: the database and its WAL. */
  const onDisk = (root: string) => readdirSync(join(root, "store")).reduce((sum, name) => sum + statSync(join(root, "store", name)).size, 0);
  const sqliteFull = () => Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13, errstr: "database or disk is full" });

  it("gives the space of acknowledged records back to the disk, step by step, until none is left: a drained buffer is not disk_full any more", async () => {
    const root = dir();
    // The disk's free space in units of a reserve (minFreeBytes 1): full
    // below one unit, room again at two.
    let capacity = Number.MAX_SAFE_INTEGER;
    let unit = 1;
    const buffer = open(root, { diskFree: () => Math.floor((capacity - onDisk(root)) / unit), minFreeBytes: 1, checkEveryMs: 20, reclaimEveryMs: 1 });
    buffer.start();
    // Big records: most of the file is theirs.
    for (let n = 1; n <= 300; n++) buffer.append(wsFrame(n, 64 * 1024));
    await buffer.flush();
    const filled = onDisk(root);
    expect(filled).toBeGreaterThan(20 * 1024 * 1024);
    // The disk around the buffer fills up: 1 MiB left, a reserve of 45 %
    // of what the buffer took — room again only once nearly all of it is
    // the disk's again.
    capacity = filled + 1024 * 1024;
    unit = Math.floor(filled * 0.45);
    buffer.check();
    expect(buffer.refusal()).toBe("disk_full");
    // The engine takes everything: the space must reach the disk, not stay
    // inside SQLite's free pages and its WAL.
    buffer.acknowledge(buffer.lastSeq);
    await until(() => buffer.refusal() === null, 10_000, "room on the disk");
    expect(all(buffer).map((event) => event.kind)).toEqual(["gap"]);
    // And the rest follows, until no free page is left.
    await until(() => onDisk(root) < 1024 * 1024, 10_000, "all of it given back");
    expect(buffer.integrity()).toBe("ok");
  });

  it("gives back space left from before it opened, with nothing deleted since", async () => {
    const root = dir();
    let buffer = open(root);
    for (let n = 1; n <= 200; n++) buffer.append(wsFrame(n, 32 * 1024));
    await buffer.flush();
    await buffer.close();
    // A previous operator deleted it all and stopped before giving it back.
    const db = new DatabaseSync(join(root, "store", DB_FILE));
    db.exec("DELETE FROM events");
    db.close();
    const before = onDisk(root);
    expect(before).toBeGreaterThan(6 * 1024 * 1024);
    buffer = open(root, { reclaimEveryMs: 1 });
    buffer.start();
    await until(() => onDisk(root) < 1024 * 1024, 10_000, "the free pages given back");
    expect(buffer.integrity()).toBe("ok");
  });

  it("tries a deletion that failed again until it goes, whatever the caps say — at a start, before any page start", async () => {
    const root = dir();
    let now = 10_000_000;
    const first = open(root, { now: () => now });
    await seqOf(first.append(wsFrame(1)));
    await first.close();
    // The operator starts again three days later: full by age.
    now += 72 * 3600_000;
    let faults = 1;
    const room: string[] = [];
    const buffer = open(root, {
      now: () => now,
      checkEveryMs: 20,
      retryMs: [50],
      onRoom: (reason) => room.push(reason),
      // The engine's ack: its deletion fails once (a full disk).
      commitFault: (batch) => (batch.deleteEventsUpTo !== null && faults-- > 0 ? sqliteFull() : null),
    });
    buffer.start();
    expect(buffer.refusal()).toBe("buffer_full");
    buffer.acknowledge(1);
    await until(() => faults <= 0, 2000, "the deletion to fail once");
    // Nothing more comes from the engine (its repeated ack would be the
    // same number): the deletion is tried again by itself.
    await until(() => buffer.refusal() === null, 3000, "the deletion tried again");
    expect(room).toEqual(["buffer_full"]);
    expect(all(buffer).map((event) => [event.seq, event.kind, event.reason])).toEqual([[2, "gap", "buffer_full"]]);
  });

  it("an open whose first read fails lets go of the file: the retry opens it", async () => {
    const root = dir();
    const first = open(root);
    await seqOf(first.append(wsFrame(1)));
    await first.close();
    let faults = 1;
    let opened = 0;
    const buffer = open(root, {
      openRetryMs: [20],
      onOpened: () => (opened += 1),
      // The file opens; reading it right after fails once (an I/O error).
      totalsFault: () => (faults-- > 0 ? Object.assign(new Error("disk I/O error"), { code: "ERR_SQLITE_ERROR", errcode: 10 }) : null),
    });
    expect(buffer.unavailable).toMatchObject({ cause: "io", recoverable: true, attempts: 1 });
    buffer.start();
    await until(() => opened === 1, 3000, "the retry to open it");
    expect(buffer.unavailable).toBeNull();
    expect(buffer.lastSeq).toBe(1);
    expect(await seqOf(buffer.append(wsFrame(2)))).toBe(2);
  });

  it("opens a buffer that was locked once the lock goes, and says so", async () => {
    const root = dir();
    const holder = open(root);
    await seqOf(holder.append(wsFrame(1)));
    let opened = 0;
    const unavailable: BufferUnavailable[] = [];
    const second = open(root, { openRetryMs: [20], onOpened: () => (opened += 1), onUnavailable: (reason) => unavailable.push(reason) });
    second.start();
    expect(unavailable).toEqual([expect.objectContaining({ cause: "locked", recoverable: true })]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second.unavailable?.attempts).toBeGreaterThan(1);
    expect(unavailable).toHaveLength(1); // the same cause is not said again
    await holder.close();
    await until(() => opened === 1, 3000, "the open");
    expect(second.refusal()).toBeNull();
    expect(second.lastSeq).toBe(1);
    expect(await seqOf(second.append(wsFrame(2)))).toBe(2);
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
  /** Schema version 1 as PR 11 writes it — frozen here: a later operator
   *  must still read a buffer made like this. */
  function writeV1(root: string): void {
    mkdirSync(join(root, "store"), { recursive: true });
    const db = new DatabaseSync(join(root, "store", DB_FILE));
    db.exec("PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, readable_from INTEGER NOT NULL, applied_wall INTEGER NOT NULL, operator_version TEXT NOT NULL) STRICT;
      CREATE TABLE events (seq INTEGER PRIMARY KEY, at_wall INTEGER NOT NULL, kind TEXT NOT NULL, format INTEGER NOT NULL, bytes INTEGER NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE TABLE outcomes (attempt_id INTEGER PRIMARY KEY, at_wall INTEGER NOT NULL, type TEXT NOT NULL, format INTEGER NOT NULL, bytes INTEGER NOT NULL, json TEXT NOT NULL) STRICT;
      CREATE INDEX outcomes_by_age ON outcomes (at_wall);
      INSERT INTO schema_version VALUES (1, 1, 1791800000000, 'pr-11');
      INSERT INTO meta VALUES ('buffer_id', '22222222-2222-4222-8222-222222222222'), ('created_wall', '1791800000000'), ('last_seq', '7'), ('last_wall', '1791800000700'), ('opened_wall', '1791800000000');
    `);
    const event = (seq: number, kind: string, body: string) => {
      const json = `{"seq":${seq},"atMono":${seq}.5,"atWall":${1791800000000 + seq * 100},${body}`;
      db.prepare("INSERT INTO events VALUES (?, ?, ?, 1, ?, ?)").run(seq, 1791800000000 + seq * 100, kind, Buffer.byteLength(json), json);
    };
    // 1..5 were acknowledged and deleted; 6 and 7 wait.
    event(6, "ws.in", '"kind":"ws.in","connectionId":"c","frame":"six"}');
    event(7, "gap", '"kind":"gap","fromSeq":6,"fromWall":1791800000600,"reason":"ws_reconnect"}');
    const outcome = JSON.stringify(hubResult(99));
    db.prepare("INSERT INTO outcomes VALUES (99, 1791800000650, 'result', 1, ?, ?)").run(Buffer.byteLength(outcome), outcome);
    db.close();
  }

  it("reads a buffer of schema version 1, frozen as PR 11 made it, and goes on with it", async () => {
    const root = dir();
    writeV1(root);
    const { buffer, stream, seqs } = streamed(root);
    expect(buffer.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(buffer.lastSeq).toBe(7);
    expect(buffer.stats()).toMatchObject({ events: 2, outcomes: 1 });
    expect(outcomesOf(buffer)[0]!.json).toBe(JSON.stringify(hubResult(99)));
    stream.subscribe(subscribe(buffer.id, 5));
    expect(seqs()).toEqual([6, 7]);
    expect(await seqOf(buffer.append(wsFrame(8)))).toBe(8);
    expect(buffer.integrity()).toBe("ok");
  });

  const V2: Migration = {
    version: 2,
    readableFrom: 1,
    up: (db) => db.exec("CREATE TABLE bodies (body_id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (body_id, part)) STRICT"),
  };

  it("migrates an older buffer forward once, keeping what it holds", async () => {
    const root = dir();
    let buffer = open(root);
    for (let n = 1; n <= 3; n++) buffer.append(wsFrame(n));
    await written(buffer.putOutcome(hubResult(5)));
    const id = buffer.id;
    buffer = await reopen(buffer, root, { migrations: [...MIGRATIONS, V2] });
    expect(buffer.id).toBe(id);
    expect(all(buffer).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(outcomesOf(buffer)).toHaveLength(1);
    // Opened again: version 2 is not applied twice.
    buffer = await reopen(buffer, root, { migrations: [...MIGRATIONS, V2] });
    expect(await seqOf(buffer.append(wsFrame(4)))).toBe(4);
    await buffer.close();
    const db = new DatabaseSync(join(root, "store", DB_FILE));
    expect(db.prepare("SELECT version, readable_from FROM schema_version ORDER BY version").all().map((row) => ({ ...row }))).toEqual([
      { version: 1, readable_from: 1 },
      { version: 2, readable_from: 1 },
    ]);
    db.close();
  });

  it("lets an older operator (an image rolled back) use a newer buffer only when the newer one allows it", async () => {
    const additive = dir();
    let buffer = open(additive, { migrations: [...MIGRATIONS, V2] });
    await seqOf(buffer.append(wsFrame(1)));
    buffer = await reopen(buffer, additive, { migrations: MIGRATIONS });
    expect(await seqOf(buffer.append(wsFrame(2)))).toBe(2);
    await buffer.close();

    const breaking = dir();
    buffer = open(breaking, { migrations: [...MIGRATIONS, { ...V2, readableFrom: 2 }] });
    await seqOf(buffer.append(wsFrame(1)));
    await buffer.close();
    const before = readFileSync(join(breaking, "store", DB_FILE));
    const unavailable: BufferUnavailable[] = [];
    const older = open(breaking, { migrations: MIGRATIONS, openRetryMs: [10], onUnavailable: (reason) => unavailable.push(reason) });
    older.start();
    expect(unavailable).toEqual([expect.objectContaining({ cause: "too_new", recoverable: false })]);
    expect(unavailable[0]!.detail).toMatch(/schema version 2, readable from 2/);
    expect(await older.ready()).toMatchObject({ ok: false, reason: "buffer_unavailable" });
    // Not tried again, and the file is as it was: it is the owner's.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(older.unavailable?.attempts).toBe(1);
    await older.close();
    expect(readFileSync(join(breaking, "store", DB_FILE)).equals(before)).toBe(true);
    expect(new BufferVersionError("x")).toBeInstanceOf(Error);
  });
});
