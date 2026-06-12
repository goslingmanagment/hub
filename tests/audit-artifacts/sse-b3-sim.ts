// Deterministic control-flow simulation of the OFAPI webhook -> SSE pipeline.
// Each model fn mirrors specific source lines 1:1 (cited inline). Forcing the
// real module's async interleaving would require instrumenting app code (out of
// report-only scope), so this reproduces the SAME control flow deterministically
// and asserts concrete frame multisets to prove each B3 defect.
//
// Sources:
//   events-stream.ts:51-65  broadcast (monotonic-max watermark)
//   events-stream.ts:67-86  handleNotification (fetch -> broadcast)
//   events-stream.ts:154    void handleNotification(...).catch(log)  [swallowed]
//   events-stream.ts:90-107 catchUpFromJournal (pages from shared deliveredSeq)
//   ofapi.ts:261/268        replay: WHERE fanout_seq > afterSeq ORDER BY asc
//   server.ts:1200-1278     SSE replay + buffer + post-replay dedupe gap (1209)

type Frame = { id: number; pageId: number };
const PAGE = 1;
const f = (id: number): Frame => ({ id, pageId: PAGE });

let pass = 0, fail = 0;
function assert(label: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  PASS  ${label} — ${detail}`); }
  else { fail++; console.log(`  FAIL  ${label} — ${detail}`); }
}

// --- Journal + replay query (mirrors ofapi.ts:253-269) ---
function makeJournal(seqs: number[]) {
  return seqs.map((s) => ({ seq: s, pageId: PAGE, status: "processed" as const }));
}
function listForReplay(journal: ReturnType<typeof makeJournal>, afterSeq: number, limit = 500): Frame[] {
  return journal
    .filter((r) => r.seq > afterSeq && r.status === "processed")   // gt(), eq(status,'processed')
    .sort((a, b) => a.seq - b.seq)                                  // orderBy asc
    .slice(0, limit)                                               // limit
    .map((r) => f(r.seq));
}

// --- Hub (mirrors events-stream.ts) ---
function makeHub() {
  let deliveredSeq: number | null = null;            // :49
  const subs = new Set<(fr: Frame) => void>();
  function broadcast(frame: Frame) {                 // :51-65
    if (deliveredSeq === null || frame.id > deliveredSeq) deliveredSeq = frame.id;  // monotonic-max
    for (const deliver of subs) deliver(frame);      // (single page in this sim)
  }
  // void handleNotification(id).catch(log): a fetch throw or non-processed row
  // returns WITHOUT broadcasting and is never retried (NOTIFY is one-shot). :67-86,:154
  function handleNotification(id: number, opts?: { fetchThrows?: Set<number> }) {
    if (opts?.fetchThrows?.has(id)) return;          // swallowed by .catch — frame never broadcast
    broadcast(f(id));
  }
  return {
    subscribe: (d: (fr: Frame) => void) => { subs.add(d); return () => subs.delete(d); },
    broadcast, handleNotification,
    get deliveredSeq() { return deliveredSeq; },
    setDeliveredSeq: (v: number) => { deliveredSeq = v; },
  };
}

// --- SSE connection (mirrors server.ts:1200-1278) + EventSource client ---
// Returns the ordered list of frame ids the client received this connection.
function connect(hub: ReturnType<typeof makeHub>, journal: ReturnType<typeof makeJournal>, lastEventId: number | null) {
  const received: number[] = [];
  let replayDone = false;                            // :1200
  const bufferedLive: Frame[] = [];
  const replayedIds = new Set<number>();             // :1241
  const unsub = hub.subscribe((frame) => {           // :1202-1211
    if (!replayDone) { bufferedLive.push(frame); return; }  // buffer until replay done
    received.push(frame.id);                          // writeFrame (:1209) — NO dedup post-replay
  });
  // replay loop (:1245-1262)
  let cursor = lastEventId;
  if (cursor !== null) {
    for (;;) {
      const rows = listForReplay(journal, cursor, 500);
      for (const r of rows) { replayedIds.add(r.id); received.push(r.id); }  // :1251-1253
      const last = rows.at(-1);
      if (last) cursor = last.id;
      if (rows.length < 500) break;
    }
  }
  replayDone = true;                                 // :1271
  for (const frame of bufferedLive) {                // :1272-1277 flush with dedup
    const seenByClient = lastEventId !== null && frame.id <= lastEventId;
    if (!replayedIds.has(frame.id) && !seenByClient) received.push(frame.id);
  }
  bufferedLive.length = 0;
  return { received, unsub };
}
// EventSource semantics: lastEventId = the LAST `id:` line the client saw. :1193
const lastIdOf = (received: number[], prev: number | null) => (received.length ? received.at(-1)! : prev);

console.log("=== B3 SSE defect reproduction (deterministic) ===\n");

// ---------- Scenario A: swallowed fetch error -> PERMANENT loss for connected client ----------
console.log("A. Swallowed fetch error (events-stream.ts:154) + monotonic watermark + strict-> replay");
{
  const hub = makeHub();
  const journal = makeJournal([100, 101, 102]);
  // client already connected & past replay; baseline lastEventId=99
  let lastEventId: number | null = 99;
  const conn = connect(hub, journal, lastEventId);   // replay >99 delivers 100,101,102? No: live, not yet settled
  conn.received.length = 0;                           // clear replay; now simulate LIVE settles:
  hub.handleNotification(100, { fetchThrows: new Set([100]) }); // 100 lost (swallowed)
  hub.handleNotification(101);
  hub.handleNotification(102);
  conn.unsub();
  const liveSeen = [101, 102];
  lastEventId = lastIdOf(liveSeen, lastEventId);     // = 102
  // client reconnects (15-min lifetime, server.ts:1147)
  const re = connect(hub, journal, lastEventId);     // replay >102
  const everSaw100 = liveSeen.includes(100) || re.received.includes(100);
  assert("A frame 100 permanently lost", !everSaw100,
    `live=${JSON.stringify(liveSeen)} reconnect-replay(>102)=${JSON.stringify(re.received)} (strict > drops 100)`);
}

// ---------- Scenario B: out-of-order live -> loss on disconnect in the inter-frame gap ----------
console.log("\nB. Out-of-order fanout (independent void handleNotification) + disconnect in gap");
{
  const hub = makeHub();
  const journal = makeJournal([100, 101, 102]);
  hub.setDeliveredSeq(99);
  const seen: number[] = [];
  const unsub = hub.subscribe((fr) => seen.push(fr.id));
  // 101's fetch resolves before 100's -> broadcast(101) then broadcast(100)
  hub.broadcast(f(101));
  // client disconnects HERE (before 100) — lastEventId = 101
  unsub();
  hub.broadcast(f(100)); // delivered to nobody (client gone)
  const lastEventId = seen.at(-1)!; // 101
  const re = connect(hub, journal, lastEventId); // replay >101 -> [102]
  assert("B frame 100 lost (disconnect-in-gap)", !seen.includes(100) && !re.received.includes(100),
    `seen=${JSON.stringify(seen)} reconnect-replay(>101)=${JSON.stringify(re.received)}`);
}

// ---------- Scenario B': out-of-order live, client stays -> DUPLICATE on reconnect ----------
console.log("\nB'. Out-of-order fanout, client stays connected -> duplicate on reconnect");
{
  const hub = makeHub();
  const journal = makeJournal([100, 101]);
  hub.setDeliveredSeq(99);
  const seen: number[] = [];
  const unsub = hub.subscribe((fr) => seen.push(fr.id));
  hub.broadcast(f(101));
  hub.broadcast(f(100)); // both received, out of order
  unsub();
  const lastEventId = seen.at(-1)!; // 100 (last id line seen)
  const re = connect(hub, journal, lastEventId); // replay >100 -> [101] (dup)
  assert("B' frame 101 duplicated", seen.includes(101) && re.received.includes(101),
    `seen=${JSON.stringify(seen)} reconnect-replay(>100)=${JSON.stringify(re.received)} (101 redelivered)`);
}

// ---------- Scenario C: catch-up watermark skip (hub-wide, events-stream.ts:90-107) ----------
console.log("\nC. Catch-up watermark skip: live broadcast bumps shared deliveredSeq mid-catch-up");
{
  const hub = makeHub();
  // hub reconnected; baseline watermark 100; journal buffered 101..700 (>1 batch of 500)
  hub.setDeliveredSeq(100);
  const seqs: number[] = [];
  for (let s = 101; s <= 700; s++) seqs.push(s);
  const journal = makeJournal(seqs);
  const delivered: number[] = [];
  const unsub = hub.subscribe((fr) => delivered.push(fr.id));
  // catchUpFromJournal, batch 1: reads >100 -> 101..600, broadcasts them (deliveredSeq->600)
  for (const r of listForReplay(journal, hub.deliveredSeq!, 500)) hub.broadcast(r);
  // a LIVE NOTIFY for seq 999 arrives mid-catch-up -> broadcast -> deliveredSeq=999
  hub.handleNotification(999);
  // batch 2: reads > deliveredSeq(=999) -> [] ; rows 601..700 are in the gap and skipped
  for (const r of listForReplay(journal, hub.deliveredSeq!, 500)) hub.broadcast(r);
  unsub();
  const gap = [];
  for (let s = 601; s <= 700; s++) if (!delivered.includes(s)) gap.push(s);
  assert("C frames 601..700 skipped (never delivered)", gap.length === 100,
    `gap size=${gap.length}, delivered max=${Math.max(...delivered)} after live 999 bumped the shared watermark`);
}

// ---------- Scenario D: post-replay duplicate (server.ts:1209 bypasses replayedIds) ----------
console.log("\nD. Post-replay duplicate: frame in replay results AND live-delivered after flush");
{
  const hub = makeHub();
  const journal = makeJournal([100]);
  const received: number[] = [];
  let replayDone = false;
  const replayedIds = new Set<number>();
  hub.subscribe((frame) => {
    if (!replayDone) return; // (buffered case omitted; we exercise the after-flush path)
    received.push(frame.id); // :1209 — no replayedIds check
  });
  // replay >99 -> [100]
  for (const r of listForReplay(journal, 99, 500)) { replayedIds.add(r.id); received.push(r.id); }
  replayDone = true; // flush (empty buffer)
  // 100's live NOTIFY resolves AFTER replayDone+flush -> writeFrame again, no dedup
  hub.broadcast(f(100));
  const count100 = received.filter((x) => x === 100).length;
  assert("D frame 100 delivered twice", count100 === 2,
    `received=${JSON.stringify(received)} (replay wrote it; post-flush live wrote it again)`);
}

console.log(`\n=== B3 simulation: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
