// Stage-1 scenarios. Each run starts from a ready operator with the site
// loaded, sets up its situation, injects its fault and checks the two
// journals: what the engine admitted and what reached the stand server.

import { checkAdmitted, type Ctx, type RunResult, type Scenario } from "./main.ts";
import { monoMs, sleep } from "../../src/shared/util.ts";
import type { JournalEvent } from "./infra.ts";

const API = "https://api.stand.test";

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = monoMs() + timeoutMs;
  while (!(await predicate())) {
    if (monoMs() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

function reqs(events: JournalEvent[], rid: string): JournalEvent[] {
  return events.filter((event) => event.t === "req" && event.rid === rid);
}

/** A ready operator, the site loaded, every admission granted. */
async function fresh(ctx: Ctx): Promise<void> {
  ctx.engine.decideSite = () => ({ grant: true });
  ctx.engine.decideCheck = () => ({ grant: true });
  ctx.engine.decideWs = () => ({ grant: true });
  await ctx.engine.waitReady();
  // A clean page every run: sockets, workers and frames of the previous run
  // close with the document (they pile up otherwise — 125 open sockets
  // stalled the 26th run of a series).
  // The new document is recognised by a marker in its address: a request
  // issued in the old one would be cancelled by the navigation.
  const marker = `run${Date.now()}`;
  await ctx.engine.command("test.navigate", { url: `https://site.stand.test/?${marker}` });
  await until(
    async () => {
      try {
        return (await ctx.engine.eval<boolean>(`typeof site === "object" && location.search.includes(${JSON.stringify(marker)}) && document.readyState === "complete"`, false)) === true;
      } catch {
        return false;
      }
    },
    30_000,
    "the fresh page",
  );
  await ctx.stand.mark();
}

/** One admitted request so the API connection is warm (HTTP/2). */
async function warm(ctx: Ctx, tag: string): Promise<void> {
  const result = await ctx.engine.eval<{ status?: number; error?: string }>(`site.api(${JSON.stringify(`warm-${tag}`)})`);
  if (result.status !== 200) throw new Error(`warm-up request failed: ${JSON.stringify(result)}`);
}

// ── smoke: the whole path once ────────────────────────────────────────────

const smoke: Scenario = async (ctx) => {
  await fresh(ctx);
  const notes: Record<string, unknown> = {};
  const violations: string[] = [];
  const tag = `s${ctx.run}-${Date.now() % 100000}`;

  const siteResult = await ctx.engine.eval<Record<string, unknown>>(`site.api(${JSON.stringify(`smoke-site-${tag}`)})`);
  notes.site = siteResult;
  if (siteResult.status !== 200) violations.push(`site request: ${JSON.stringify(siteResult)}`);

  const hub = await ctx.engine.sendHub(`hub-${tag}`, `${API}/api/item?rid=smoke-hub-${tag}`, { authorization: "stand-token", "fansly-client-id": "1", "fansly-client-check": "abc" });
  notes.hub = hub;
  if (hub.outcome !== "response" || hub.status !== 200) violations.push(`hub request: ${JSON.stringify(hub)}`);

  const wsIndex = await ctx.engine.eval<number>(`site.ws(${JSON.stringify(`smoke-ws-${tag}`)})`, false);
  await until(async () => (await ctx.engine.eval<{ readyState: number }>(`site.wsState(${wsIndex})`, false)).readyState !== 0, 10_000, "socket open");
  notes.wsOpen = await ctx.engine.eval(`site.wsState(${wsIndex})`, false);
  notes.wsPing = await ctx.engine.eval(`site.wsSend(${wsIndex}, "p")`, false);
  notes.wsForbidden = await ctx.engine.eval(`site.wsSend(${wsIndex}, JSON.stringify({ t: 99, d: "read" }))`, false);
  notes.detect = await ctx.engine.eval(`site.detect()`, false);
  await sleep(1000);

  const events = await ctx.stand.journal();
  // Sockets are admitted per tunnel (no URL known there): checked by count.
  const admitted = checkAdmitted(events, ctx.engine.grants, "smoke-site-");
  const admittedHub = checkAdmitted(events, ctx.engine.grants, "smoke-hub-");
  violations.push(...admitted.violations, ...admittedHub.violations);
  const wsOpens = events.filter((event) => event.t === "ws.open" && String(event.rid ?? "").startsWith("smoke-ws-")).length;
  const wsGrants = ctx.engine.grants.filter((grant) => grant.kind === "ws").length;
  if (wsOpens > wsGrants) violations.push(`${wsOpens} sockets opened, ${wsGrants} socket admissions`);
  const hubArrival = reqs(events, `smoke-hub-${tag}`).find((event) => event.method === "GET");
  if (hubArrival && typeof hub.sendMono === "number") notes.hubSendMonoMinusServer = Math.round((hub.sendMono as number) - hubArrival.mono);
  // Header parity (stage 1 item 15): the Hub request vs the site's request
  // to the same route — names and order, values of the browser's own ones.
  const siteArrival = reqs(events, `smoke-site-${tag}`).find((event) => event.method === "GET");
  if (siteArrival && hubArrival) {
    const names = (event: JournalEvent) => (event.headers ?? []).map(([name]) => name);
    const browserOwn = (event: JournalEvent) =>
      Object.fromEntries((event.headers ?? []).filter(([name]) => /^(sec-|user-agent|accept|origin|referer)/.test(name)));
    notes.headerParity = {
      same: JSON.stringify(names(siteArrival)) === JSON.stringify(names(hubArrival)),
      site: names(siteArrival),
      hub: names(hubArrival),
      browserOwnSite: browserOwn(siteArrival),
      browserOwnHub: browserOwn(hubArrival),
    };
  }
  const frames = events.filter((event) => event.t === "ws.frame").map((event) => event.text);
  notes.wsFrames = frames;
  if (!frames.includes("p")) violations.push("the allowed socket message did not arrive");
  if (frames.some((text) => typeof text === "string" && text.includes('"t":99'))) violations.push("a forbidden socket message reached the server");
  notes.preflights = events.filter((event) => event.t === "req" && event.method === "OPTIONS").length;
  notes.arrivals = admitted.arrivals + admittedHub.arrivals;
  notes.grants = ctx.engine.grants.map((grant) => `${grant.kind}:${grant.rid ?? grant.id}`);
  notes.guardReports = ctx.engine.observed.filter((o) => o.kind === "guard").map((o) => ({ k: o.k, target: o.target, href: o.href, t: o.t }));
  notes.tunnels = (await ctx.engine.command("test.tunnels")).tunnels;
  return { ok: violations.length === 0, violations, notes };
};

// ── condition №1: control lost while requests are held ──────────────────────

type LossFault = "operator-kill" | "operator-hang" | "holder-kill" | "cdp-break" | "cdp-drop" | "chrome-kill" | "planned-stop";

async function injectLoss(ctx: Ctx, fault: LossFault): Promise<void> {
  switch (fault) {
    case "operator-kill":
      await ctx.docker.signal("operator", "KILL");
      return;
    case "operator-hang":
      // The watchdog kills it within ~5.5 s (heartbeat file).
      await ctx.docker.signal("operator", "STOP");
      return;
    case "holder-kill":
      await ctx.docker.signal("holder", "KILL");
      return;
    case "cdp-break":
      await ctx.engine.command("test.breakCdp", {}, 3000);
      return;
    case "cdp-drop":
      await ctx.engine.command("test.dropCdp", {}, 3000);
      return;
    case "chrome-kill":
      await ctx.docker.signal("chrome", "KILL");
      return;
    case "planned-stop":
      await ctx.engine.command("closeExit", {}, 3000);
      await ctx.engine.command("test.dropCdp", {}, 3000);
      return;
  }
}

function controlLoss(fault: LossFault, releaseOne: boolean, opts: { lossDelayMs?: number; gate?: boolean } = {}): Scenario {
  return async (ctx) => {
    await fresh(ctx);
    const tag = `${fault}-${ctx.run}-${Date.now() % 100000}`;
    await ctx.engine.command("test.config", { lossDelayMs: opts.lossDelayMs ?? 0, gate: opts.gate ?? true });
    await warm(ctx, tag);
    const sitePrefix = `p-${tag}-`;
    const hubId = `h-${tag}`;
    ctx.engine.decideSite = (ask) => (ask.rid?.startsWith(sitePrefix) ? "hold" : { grant: true });
    ctx.engine.decideCheck = (id) => (id === hubId ? "hold" : { grant: true });
    const rids = [0, 1, 2, 3, 4].map((i) => `${sitePrefix}${i}`);
    await ctx.engine.eval(`(${JSON.stringify(rids)}).forEach((r) => site.api(r)), true`, false);
    void ctx.engine.sendHub(hubId, `${API}/api/hub?rid=${hubId}`, { authorization: "stand-token" });
    await until(
      () => [...ctx.engine.heldSite.values()].filter((ask) => ask.rid?.startsWith(sitePrefix)).length >= 5 && ctx.engine.heldChecks.has(hubId),
      10_000,
      "5 site requests and 1 Hub request held",
    );
    const delay = Math.random() * 1500;
    let released: string | null = null;
    if (releaseOne) {
      // Grant one request a moment before the fault: the fault then hits
      // while an admitted request is on its way.
      const lead = Math.random() * 60;
      await sleep(Math.max(0, delay - lead));
      const [first] = [...ctx.engine.heldSite.values()].filter((ask) => ask.rid?.startsWith(sitePrefix));
      if (first) {
        ctx.engine.releaseSite(first.siteRequestId, { grant: true });
        released = first.rid;
      }
      await sleep(lead);
    } else {
      await sleep(delay);
    }
    ctx.arm();
    const faultMono = monoMs();
    await injectLoss(ctx, fault);
    ctx.engine.heldSite.clear();
    ctx.engine.heldChecks.clear();
    await sleep(fault === "operator-hang" ? 9000 : 4000);
    const events = await ctx.stand.journal();
    const checked = checkAdmitted(events, ctx.engine.grants, `p-${tag}`);
    const hubChecked = checkAdmitted(events, ctx.engine.grants, hubId);
    const arrived = events.filter((event) => event.t === "req" && event.rid && (event.rid.startsWith(sitePrefix) || event.rid === hubId)).map((event) => `${event.method} ${event.rid} +${Math.round(event.mono - faultMono)}ms`);
    // Back to a ready operator for the next run.
    ctx.engine.close();
    await ctx.engine.waitReady(180_000);
    const violations = [...checked.violations, ...hubChecked.violations];
    return {
      ok: violations.length === 0,
      violations,
      notes: { fault, lossDelayMs: opts.lossDelayMs ?? 0, gate: opts.gate ?? true, delayMs: Math.round(delay), released, arrived },
    };
  };
}

/** The residual window of the gate: CDP is lost right after an admitted
 *  request was released, while its gate window is still open (its "sent"
 *  never comes — CDP is gone). What Chrome releases then meets an open
 *  window until the operator reacts. */
function openWindow(lossDelayMs: number): Scenario {
  return async (ctx) => {
    await fresh(ctx);
    const tag = `ow-${lossDelayMs}-${ctx.run}-${Date.now() % 100000}`;
    await ctx.engine.command("test.config", { lossDelayMs, gate: true });
    await warm(ctx, tag);
    const sitePrefix = `p-${tag}-`;
    ctx.engine.decideSite = (ask) => (ask.rid?.startsWith(sitePrefix) ? "hold" : { grant: true });
    const rids = [0, 1, 2, 3, 4].map((i) => `${sitePrefix}${i}`);
    // Simple requests (no custom headers): no preflight, so the request
    // itself is the physical request released straight into the window. (The
    // earlier version cached preflights per URL — every rid is a new URL, so
    // it exercised the preflight's window; Astra review, finding 13.)
    await ctx.engine.eval(`(${JSON.stringify(rids)}).forEach((r) => site.api(r, { plain: true })), true`, false);
    await until(() => [...ctx.engine.heldSite.values()].filter((ask) => ask.rid?.startsWith(sitePrefix)).length >= 5, 10_000, "5 held");
    const [first] = [...ctx.engine.heldSite.values()].filter((ask) => ask.rid?.startsWith(sitePrefix));
    ctx.engine.releaseSite(first!.siteRequestId, { grant: true });
    ctx.arm();
    const faultMono = monoMs();
    await ctx.engine.command("test.breakCdp", {}, 3000);
    ctx.engine.heldSite.clear();
    await sleep(4000);
    const events = await ctx.stand.journal();
    const checked = checkAdmitted(events, ctx.engine.grants, sitePrefix);
    const arrived = events.filter((event) => event.t === "req" && String(event.rid ?? "").startsWith(sitePrefix)).map((event) => `${event.method} ${event.rid} +${Math.round(event.mono - faultMono)}ms`);
    // Was the window open at the loss (the case this scenario exists for)?
    const alarm = ctx.engine.alarms.find((a) => a.kind === "cdp_lost" && Number(a.recvMono) >= faultMono);
    ctx.engine.close();
    await ctx.engine.waitReady(180_000);
    return { ok: checked.violations.length === 0, violations: checked.violations, notes: { lossDelayMs, released: first!.rid, arrived, windowOpenAtLoss: (alarm?.detail as { windowOpen?: boolean } | undefined)?.windowOpen ?? null } };
  };
}

/** CDP is lost while the admitted request's answer is still coming (its body
 *  streams for 1.5 s): the gate is in its responding phase, and what Chrome
 *  releases then must stay held. */
function respondingLoss(lossDelayMs: number): Scenario {
  return async (ctx) => {
    await fresh(ctx);
    const tag = `resp-${lossDelayMs}-${ctx.run}-${Date.now() % 100000}`;
    await ctx.engine.command("test.config", { lossDelayMs, gate: true });
    await warm(ctx, tag);
    const sitePrefix = `p-${tag}-`;
    ctx.engine.decideSite = (ask) => (ask.rid?.startsWith(sitePrefix) ? "hold" : { grant: true });
    const slow = `${sitePrefix}0`;
    const rest = [1, 2, 3, 4].map((i) => `${sitePrefix}${i}`);
    await ctx.engine.eval(`site.api(${JSON.stringify(slow)}, { query: "size=200000&slow=1500" }), (${JSON.stringify(rest)}).forEach((r) => site.api(r)), true`, false);
    await until(() => [...ctx.engine.heldSite.values()].filter((ask) => ask.rid?.startsWith(sitePrefix)).length >= 5, 10_000, "5 held");
    const first = [...ctx.engine.heldSite.values()].find((ask) => ask.rid === slow);
    ctx.engine.releaseSite(first!.siteRequestId, { grant: true });
    // The answer starts within milliseconds on the stand and streams for 1.5 s.
    const delay = 300 + Math.random() * 700;
    await sleep(delay);
    ctx.arm();
    const faultMono = monoMs();
    await ctx.engine.command("test.breakCdp", {}, 3000);
    ctx.engine.heldSite.clear();
    await sleep(4000);
    const events = await ctx.stand.journal();
    const checked = checkAdmitted(events, ctx.engine.grants, sitePrefix);
    const arrived = events.filter((event) => event.t === "req" && String(event.rid ?? "").startsWith(sitePrefix)).map((event) => `${event.method} ${event.rid} +${Math.round(event.mono - faultMono)}ms`);
    const held = ctx.engine.observed.filter((o) => o.kind === "gate" && o.gateEvent === "held").map((o) => `${String(o.phase)}:${String(o.length)}`);
    ctx.engine.close();
    await ctx.engine.waitReady(180_000);
    return { ok: checked.violations.length === 0, violations: checked.violations, notes: { lossDelayMs, delayMs: Math.round(delay), arrived, held } };
  };
}

/** A CDP loss while the released request opens a new connection to the API
 *  (SOCKS answers in 150 ms): that window forwards its whole connection
 *  until Chrome's announcement — the residual of the gate. */
function newConnectionLoss(lossDelayMs: number): Scenario {
  return async (ctx) => {
    await fresh(ctx);
    const tag = `nc-${lossDelayMs}-${ctx.run}-${Date.now() % 100000}`;
    await ctx.engine.command("test.config", { lossDelayMs, gate: true });
    await warm(ctx, tag);
    const sitePrefix = `p-${tag}-`;
    ctx.engine.decideSite = (ask) => (ask.rid?.startsWith(sitePrefix) ? "hold" : { grant: true });
    const rids = [0, 1, 2, 3, 4].map((i) => `${sitePrefix}${i}`);
    await ctx.engine.eval(`(${JSON.stringify(rids)}).forEach((r) => site.api(r)), true`, false);
    await until(() => [...ctx.engine.heldSite.values()].filter((ask) => ask.rid?.startsWith(sitePrefix)).length >= 5, 10_000, "5 held");
    await ctx.engine.command("test.cutApi");
    await sleep(200);
    await ctx.stand.fault({ kind: "socksConnectDelay", ms: 150, count: 2 });
    const [first] = [...ctx.engine.heldSite.values()].filter((ask) => ask.rid?.startsWith(sitePrefix));
    ctx.engine.releaseSite(first!.siteRequestId, { grant: true });
    const delay = Math.random() * 120;
    await sleep(delay);
    ctx.arm();
    const faultMono = monoMs();
    await ctx.engine.command("test.breakCdp", {}, 3000);
    ctx.engine.heldSite.clear();
    await sleep(4000);
    const events = await ctx.stand.journal();
    const checked = checkAdmitted(events, ctx.engine.grants, sitePrefix);
    const arrived = events.filter((event) => event.t === "req" && String(event.rid ?? "").startsWith(sitePrefix)).map((event) => `${event.method} ${event.rid} +${Math.round(event.mono - faultMono)}ms`);
    ctx.engine.close();
    await ctx.engine.waitReady(180_000);
    return { ok: checked.violations.length === 0, violations: checked.violations, notes: { lossDelayMs, delayMs: Math.round(delay), released: first!.rid, arrived } };
  };
}

/** Chrome writes a PING before a request on a connection it read nothing from
 *  for 10 s (SpdySession::MaybeSendPrefacePing). The window must still let
 *  the request itself through, for a site request and a Hub request. */
const idlePing: Scenario = async (ctx) => {
  await fresh(ctx);
  const tag = `idle-${ctx.run}-${Date.now() % 100000}`;
  await warm(ctx, tag);
  await sleep(11_000);
  const rid = `i-${tag}`;
  const siteStarted = monoMs();
  const site = await ctx.engine.eval<{ status?: number; error?: string }>(`site.api(${JSON.stringify(rid)})`);
  const siteMs = Math.round(monoMs() - siteStarted);
  await sleep(11_000);
  const hubId = `ih-${tag}`;
  const hubStarted = monoMs();
  const hub = await ctx.engine.sendHub(hubId, `${API}/api/hub?rid=${hubId}`, { authorization: "stand-token" });
  const hubMs = Math.round(monoMs() - hubStarted);
  const events = await ctx.stand.journal();
  const violations = [...checkAdmitted(events, ctx.engine.grants, rid).violations, ...checkAdmitted(events, ctx.engine.grants, hubId).violations];
  if (site.status !== 200 || siteMs > 3000) violations.push(`site request after 11 s of quiet: ${JSON.stringify(site)} in ${siteMs} ms`);
  if (hub.outcome !== "response" || hubMs > 3000) violations.push(`Hub request after 11 s of quiet: ${String(hub.outcome)} ${String(hub.errorText ?? hub.error ?? "")} in ${hubMs} ms`);
  const arrivals = [...reqs(events, rid), ...reqs(events, hubId)].map((event) => `${event.method} ${event.rid} conn ${event.connId} reused ${String(event.reused)}`);
  const held = ctx.engine.observed.filter((o) => o.kind === "gate" && o.gateEvent === "held").map((o) => `${String(o.phase)}:${String(o.length)}`);
  return { ok: violations.length === 0, violations, notes: { siteMs, hubMs, arrivals, held } };
};

// ── condition №2: Chrome's own retries, the send moment, the deadline ──────

/** `rttMs`: how long the server waits before it refuses — the round trip a
 *  real network has and the stand has not (0 = the stand's sub-millisecond). */
function retry(fault: "h2RefusedStream" | "h2Goaway" | "resetAfterHeaders", gate: boolean, rttMs = 30): Scenario {
  return async (ctx) => {
    await fresh(ctx);
    const tag = `${fault}-${gate ? "g" : "n"}${rttMs}-${ctx.run}-${Date.now() % 100000}`;
    await ctx.engine.command("test.config", { gate });
    await warm(ctx, tag);
    const rid = `r-${tag}`;
    await ctx.stand.fault({ kind: fault, match: { rid, method: "GET" }, ms: rttMs });
    ctx.arm();
    const result = await ctx.engine.eval<Record<string, unknown>>(`site.api(${JSON.stringify(rid)})`);
    await sleep(1500);
    const events = await ctx.stand.journal();
    const arrivals = reqs(events, rid).filter((event) => event.method !== "OPTIONS");
    const grants = ctx.engine.grants.filter((grant) => grant.rid === rid);
    const retries = ctx.engine.observed.filter((o) => o.kind === "retry");
    const gateEvents = ctx.engine.observed.filter((o) => o.kind === "gate");
    await ctx.engine.command("test.config", { gate: true });
    // Criterion: one admission → at most one operation on the server, and
    // the fault really met the request (otherwise the run proves nothing).
    const faulted = events.some((event) => event.t === "fault" || event.t === "h2.rst" || event.t === "h2.goaway");
    const violations = arrivals.length > grants.length ? [`${arrivals.length} arrivals of ${rid} for ${grants.length} admission(s) — Chrome repeated the request`] : [];
    if (arrivals.length === 0 || !faulted) violations.push(`the fault did not meet the request (arrivals ${arrivals.length}, fault seen ${faulted})`);
    return {
      ok: violations.length === 0,
      violations,
      notes: {
        gate,
        rttMs,
        site: result,
        arrivals: arrivals.map((event) => ({ conn: event.connId, stream: event.streamId, reused: event.reused })),
        faults: events.filter((event) => event.t === "fault" || event.t === "h2.rst" || event.t === "h2.goaway").map((event) => event.t),
        operatorSaw: retries.map((o) => ({ sends: o.sends })),
        gateCuts: gateEvents.filter((o) => o.gateEvent !== "first_bytes" && o.gateEvent !== "hold").map((o) => String(o.gateEvent)),
        siteDone: [...ctx.engine.siteDone.values()].filter((d) => String(d.siteRequestId) && grants.some((g) => g.id === d.siteRequestId)).map((d) => ({ outcome: d.outcome, sends: d.sends, errorText: d.errorText })),
      },
    };
  };
}

/** A request with a body (the login, the only write of stage 1) refused by
 *  the server (REFUSED_STREAM) while the operator handles CDP events late:
 *  Chrome repeats it on the same connection before its announcement is
 *  handled (Astra review of the prototype, finding 5). The window's budget
 *  — its HEADERS and DATA records — must stop the repeat. */
function retryPost(cdpDelayMs: number): Scenario {
  return async (ctx) => {
    await fresh(ctx);
    const tag = `post-${cdpDelayMs}-${ctx.run}-${Date.now() % 100000}`;
    await warm(ctx, tag);
    const rid = `rp-${tag}`;
    await ctx.stand.fault({ kind: "h2RefusedStream", match: { rid, method: "POST" }, ms: 0 });
    await ctx.engine.command("test.config", { cdpDelayMs });
    ctx.arm();
    const result = await ctx.engine.eval<Record<string, unknown>>(`site.raw(${JSON.stringify(rid)}, "POST", "/api/v1/login")`);
    await sleep(1500);
    await ctx.engine.command("test.config", { cdpDelayMs: 0 });
    const events = await ctx.stand.journal();
    const arrivals = reqs(events, rid).filter((event) => event.method === "POST");
    const faulted = events.some((event) => event.t === "fault" || event.t === "h2.rst");
    const checked = checkAdmitted(events, ctx.engine.grants, rid);
    const violations = [...checked.violations];
    if (arrivals.length === 0 || !faulted) violations.push(`the fault did not meet the request (arrivals ${arrivals.length}, fault seen ${faulted})`);
    return { ok: violations.length === 0, violations, notes: { cdpDelayMs, site: result, arrivals: arrivals.map((event) => ({ conn: event.connId, stream: event.streamId })) } };
  };
}

/** Does a garbage collection in the renderer cancel a Hub fetch nobody in
 *  the isolated world holds on to? `at`: while paused before the admission,
 *  or while the response body is still coming. */
function hubGc(at: "paused" | "body" | "body-nogc"): Scenario {
  return async (ctx) => {
    await fresh(ctx);
    const tag = `gc-${at}-${ctx.run}-${Date.now() % 100000}`;
    await warm(ctx, tag);
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `${tag}-${i}`;
      if (at === "paused") {
        ctx.engine.decideCheck = (attemptId) => (attemptId === id ? "hold" : { grant: true });
        const done = ctx.engine.sendHub(id, `${API}/api/hub?rid=${id}`, { authorization: "stand-token" });
        await until(() => ctx.engine.heldChecks.has(id), 5000, "check held");
        await ctx.engine.command("test.gc");
        ctx.engine.releaseCheck(id, { grant: true });
        const result = await done;
        outcomes.push(String(result.outcome === "response" ? result.status : `${String(result.outcome)}:${String(result.errorText ?? result.error)}`));
      } else {
        // A response streamed over 1.5 s; the collection runs in the middle.
        const done = ctx.engine.sendHub(id, `${API}/api/hub?rid=${id}&size=200000&slow=1500`, { authorization: "stand-token" });
        await sleep(600);
        if (at === "body") await ctx.engine.command("test.gc");
        const result = await done;
        outcomes.push(String(result.outcome === "response" ? result.status : `${String(result.outcome)}:${String(result.errorText ?? result.error)}`));
      }
    }
    ctx.engine.decideCheck = () => ({ grant: true });
    const failed = outcomes.filter((outcome) => outcome !== "200");
    return { ok: failed.length === 0, violations: failed.length ? [`${failed.length} of 10 Hub requests did not complete`] : [], notes: { at, outcomes } };
  };
}

const sendTime: Scenario = async (ctx) => {
  await fresh(ctx);
  const tag = `st-${ctx.run}-${Date.now() % 100000}`;
  await warm(ctx, tag);
  const diffs: number[] = [];
  const siteDiffs: number[] = [];
  const odd: unknown[] = [];
  for (let i = 0; i < 20; i++) {
    const rid = `${tag}-h${i}`;
    const result = await ctx.engine.sendHub(`${tag}-h${i}`, `${API}/api/hub?rid=${rid}`, { authorization: "stand-token" });
    if (result.outcome !== "response" || typeof result.sendMono !== "number") odd.push(result);
    const srid = `${tag}-s${i}`;
    await ctx.engine.eval(`site.api(${JSON.stringify(srid)})`);
    await sleep(100);
    const events = await ctx.stand.journal();
    const arrival = reqs(events, rid).find((event) => event.method === "GET");
    if (arrival && typeof result.sendMono === "number") diffs.push(Math.round((arrival.mono - (result.sendMono as number)) * 10) / 10);
    const sarrival = reqs(events, srid).find((event) => event.method === "GET");
    const done = [...ctx.engine.siteDone.values()].find((d) => {
      const grant = ctx.engine.grants.find((g) => g.id === d.siteRequestId);
      return grant?.rid === srid;
    });
    if (sarrival && done && typeof done.sendMono === "number") siteDiffs.push(Math.round((sarrival.mono - (done.sendMono as number)) * 10) / 10);
  }
  const worst = Math.max(...diffs.map(Math.abs), ...siteDiffs.map(Math.abs));
  const firstHub = `${tag}-h0`;
  const debug = {
    timing: ctx.engine.observed.filter((o) => o.kind === "timing" && o.op === firstHub),
    gate: ctx.engine.observed.filter((o) => o.kind === "gate" && String(o.window ?? "").includes(firstHub)).map((o) => `${String(o.gateEvent)} ${String(o.window)} @${Math.round((o.mono as number) * 100) / 100}`),
    sent: ctx.engine.observed.filter((o) => o.kind === "send" && o.op === firstHub),
    arrivals: reqs(await ctx.stand.journal(), firstHub).map((event) => ({ method: event.method, mono: event.mono, conn: event.connId, reused: event.reused })),
    grant: ctx.engine.grants.find((g) => g.id === firstHub),
  };
  const violations = worst > 50 ? [`send moment off by ${worst} ms (> 50 ms)`] : diffs.length < 20 ? [`only ${diffs.length} Hub send moments measured`] : [];
  return { ok: violations.length === 0, violations, notes: { hubServerMinusChromeMs: diffs, siteServerMinusChromeMs: siteDiffs, worst, odd, debug } };
};

type ExpiryDelay = "socks" | "tcp";

/** The admission lasts 5 s; the new connection takes 8 s (under the
 *  operator's 15 s SOCKS timeout), so it completes after the deadline. */
const EXPIRY_WINDOW_MS = 5000;
const EXPIRY_DELAY_MS = 8000;

function expiry(kind: "site" | "hub", delayAt: ExpiryDelay, gate: boolean, hubAbort = true): Scenario {
  return async (ctx) => {
    await fresh(ctx);
    ctx.engine.decideSite = (ask) => (ask.rid?.startsWith("e-") ? { grant: true, windowMs: EXPIRY_WINDOW_MS } : { grant: true });
    ctx.engine.decideCheck = (id) => (id.startsWith("e-") ? { grant: true, windowMs: EXPIRY_WINDOW_MS } : { grant: true });
    const tag = `exp-${kind}-${delayAt}-${gate ? "g" : "n"}${hubAbort ? "a" : ""}-${ctx.run}-${Date.now() % 100000}`;
    await ctx.engine.command("test.config", { gate, hubAbort });
    await warm(ctx, tag);
    // A fresh connection is needed and it takes 20 s; the admission lasts 15 s.
    await ctx.engine.command("test.cutApi");
    await sleep(300);
    await ctx.stand.fault(delayAt === "socks" ? { kind: "socksConnectDelay", ms: EXPIRY_DELAY_MS, count: 2 } : { kind: "tcpDelay", ms: EXPIRY_DELAY_MS, count: 2 });
    const rid = `e-${tag}`;
    ctx.arm();
    let outcome: unknown;
    if (kind === "site") {
      outcome = await ctx.engine.eval(`site.api(${JSON.stringify(rid)}, { plain: true })`);
    } else {
      outcome = await ctx.engine.sendHub(rid, `${API}/api/hub?rid=${rid}`, {});
    }
    await sleep(8000);
    const events = await ctx.stand.journal();
    const checked = checkAdmitted(events, ctx.engine.grants, rid, 50);
    await ctx.engine.command("test.config", { gate: true, hubAbort: true });
    return {
      ok: checked.violations.length === 0,
      violations: checked.violations,
      notes: {
        gate,
        hubAbort,
        outcome,
        arrivals: reqs(events, rid).map((event) => `${event.method} +${Math.round(event.mono - (ctx.engine.grants.find((g) => g.rid === rid)?.deadlineMono ?? 0))}ms vs deadline`),
        gateEvents: ctx.engine.observed.filter((o) => o.kind === "gate" && o.gateEvent !== "first_bytes" && o.gateEvent !== "hold").map((o) => ({ event: o.gateEvent, cut: o.cut })),
        aborts: ctx.engine.observed.filter((o) => o.kind === "hub.abort_before_deadline").length,
      },
    };
  };
}

// ── stage 1 item 17: response bodies are captured whole ─────────────────────

interface BodyCase {
  name: string;
  query: string;
  how?: "arrayBuffer" | "stream";
  /** Ask twice: the second answer is a 304 served from the browser's cache. */
  twice?: boolean;
  /** What the capture must say about itself. */
  expect?: "complete" | "shape";
}

const BODY_CASES: BodyCase[] = [
  { name: "small", query: "size=5000" },
  { name: "gzip", query: "size=300000&enc=gzip" },
  { name: "brotli", query: "size=300000&enc=br" },
  { name: "chunked", query: "size=300000&chunked=1" },
  { name: "slow", query: "size=200000&slow=1200" },
  { name: "slow, read as a stream", query: "size=200000&slow=1200", how: "stream" },
  { name: "gzip, read as a stream", query: "size=300000&enc=gzip&slow=800", how: "stream", expect: "shape" },
  { name: "revalidated (304)", query: "size=40000&etag=v1", twice: true },
  { name: "40 MB (over the 32 MiB limit of Hub requests)", query: "size=40000000" },
];

const bodyCapture: Scenario = async (ctx) => {
  await fresh(ctx);
  ctx.engine.serialize = true;
  const tag = `bc-${ctx.run}-${Date.now() % 100000}`;
  const violations: string[] = [];
  const rows: unknown[] = [];
  try {
    for (const [index, c] of BODY_CASES.entries()) {
      const rid = `${tag}-${index}`;
      const call = `site.apiHash(${JSON.stringify(rid)}, ${JSON.stringify(c.query)}, ${JSON.stringify(c.how ?? "arrayBuffer")})`;
      let page = await ctx.engine.eval<{ status?: number; bytes?: number; sha256?: string; error?: string }>(call);
      if (c.twice) page = await ctx.engine.eval(call);
      await sleep(400);
      const done = ctx.engine.siteDoneOf(rid);
      const body = (done?.body ?? null) as { bytes: number; sha256: string; complete: boolean; how: string; ended: string; encodedBytes: number; contentEncoding: string | null; contentLength: number | null; chunks: number } | null;
      const same = body !== null && body.sha256 === page.sha256 && body.bytes === page.bytes;
      rows.push({ case: c.name, pageBytes: page.bytes ?? page.error, captured: body?.bytes ?? null, same, complete: body?.complete ?? null, how: body?.how ?? null, ended: body?.ended ?? null, status: done?.status ?? null, source: done?.source ?? null, encodedBytes: body?.encodedBytes ?? null, enc: body?.contentEncoding ?? null, chunks: body?.chunks ?? null });
      if (!same) violations.push(`${c.name}: the captured body differs from what the page read (${body?.bytes ?? "none"} vs ${page.bytes ?? page.error} bytes)`);
      else if ((c.expect ?? "complete") === "complete" && body?.complete !== true) violations.push(`${c.name}: the capture is whole but not marked complete (${body?.how})`);
      if (c.twice && done?.source !== "revalidated_304") violations.push(`${c.name}: the source is ${String(done?.source)}, not revalidated_304`);
    }
    // Hub requests: the limit by the declared size and while receiving.
    await ctx.engine.command("test.config", { hubBodyLimit: 2_000_000 });
    const declared = await ctx.engine.sendHub(`${tag}-hub-declared`, `${API}/api/body?rid=${tag}-hub-declared&size=5000000`, { authorization: "stand-token" });
    const streamed = await ctx.engine.sendHub(`${tag}-hub-chunked`, `${API}/api/body?rid=${tag}-hub-chunked&size=5000000&chunked=1`, { authorization: "stand-token" });
    const fits = await ctx.engine.sendHub(`${tag}-hub-fits`, `${API}/api/body?rid=${tag}-hub-fits&size=500000&enc=gzip`, { authorization: "stand-token" });
    await ctx.engine.command("test.config", { hubBodyLimit: 32 * 1024 * 1024 });
    const hubRow = (r: Record<string, unknown>) => ({ outcome: r.outcome, status: r.status, bodyOverflow: r.bodyOverflow ?? false, bytes: (r.body as { bytes?: number } | null)?.bytes ?? null, complete: (r.body as { complete?: boolean } | null)?.complete ?? null });
    rows.push({ case: "Hub, 5 MB declared, limit 2 MB", ...hubRow(declared) });
    rows.push({ case: "Hub, 5 MB chunked, limit 2 MB", ...hubRow(streamed) });
    rows.push({ case: "Hub, 0.5 MB gzip, limit 2 MB", ...hubRow(fits) });
    if (declared.bodyOverflow !== true) violations.push("Hub: a response declared over the limit was not cancelled before its body");
    if (streamed.bodyOverflow !== true) violations.push("Hub: a chunked response over the limit was not cancelled while receiving");
    const streamedBytes = (streamed.body as { bytes?: number } | null)?.bytes ?? 0;
    if (streamedBytes > 3_000_000) violations.push(`Hub: ${streamedBytes} bytes of a chunked response were taken with a 2 MB limit`);
    if (fits.outcome !== "response" || (fits.body as { complete?: boolean } | null)?.complete !== true) violations.push(`Hub: a response under the limit was not captured whole (${JSON.stringify(fits).slice(0, 200)})`);
  } finally {
    ctx.engine.serialize = false;
  }
  return { ok: violations.length === 0, violations, notes: { rows } };
};

/** Ten 15 MB responses in a row (150 MB, over Chrome's own 100 MB buffer of
 *  bodies) with the operator handling every CDP message 300 ms late. */
const bodyBurst: Scenario = async (ctx) => {
  await fresh(ctx);
  ctx.engine.serialize = true;
  const tag = `bb-${ctx.run}-${Date.now() % 100000}`;
  const violations: string[] = [];
  const rows: unknown[] = [];
  try {
    await ctx.engine.command("test.config", { cdpDelayMs: 300 });
    const calls = Array.from({ length: 10 }, (_, i) => `site.apiHash(${JSON.stringify(`${tag}-${i}`)}, "size=15000000")`);
    const reply = await ctx.engine.command("test.eval", { expression: `Promise.all([${calls.join(",")}])`, await: true }, 300_000);
    if (reply.ok !== true) throw new Error(`burst failed: ${String(reply.error)}`);
    const pages = reply.value as Array<{ bytes?: number; sha256?: string; error?: string }>;
    await sleep(2500);
    for (const [i, page] of pages.entries()) {
      const done = ctx.engine.siteDoneOf(`${tag}-${i}`);
      const body = (done?.body ?? null) as { bytes: number; sha256: string; complete: boolean } | null;
      const same = body !== null && body.sha256 === page.sha256;
      rows.push({ i, pageBytes: page.bytes ?? page.error, captured: body?.bytes ?? null, same, complete: body?.complete ?? null });
      if (!same || body?.complete !== true) violations.push(`response ${i}: captured ${body?.bytes ?? "none"} of ${page.bytes ?? page.error} bytes, complete=${body?.complete}`);
    }
  } finally {
    await ctx.engine.command("test.config", { cdpDelayMs: 0 }, 60_000);
    ctx.engine.serialize = false;
  }
  return { ok: violations.length === 0, violations, notes: { rows } };
};

// ── stage 1 item 6: the rules extension ─────────────────────────────────────

interface RuleCase {
  name: string;
  method: string;
  path: string;
  /** Must the request reach the server? */
  reaches: boolean;
}

const RULE_CASES: RuleCase[] = [
  { name: "never: read ack", method: "POST", path: "/api/v1/message/ack", reaches: false },
  { name: "never: typing", method: "POST", path: "/api/v1/message/typing", reaches: false },
  { name: "never: status", method: "POST", path: "/api/v1/status", reaches: false },
  { name: "unknown write (POST)", method: "POST", path: "/api/v1/group", reaches: false },
  { name: "unknown write (PUT)", method: "PUT", path: "/api/v1/notes", reaches: false },
  { name: "unknown write (PATCH)", method: "PATCH", path: "/api/v1/account", reaches: false },
  { name: "unknown write (DELETE)", method: "DELETE", path: "/api/v1/post/1", reaches: false },
  { name: "login operation", method: "POST", path: "/api/v1/login", reaches: true },
  { name: "read", method: "GET", path: "/api/v1/account/me", reaches: true },
];

/** `bypass`: the operator releases every API request unasked and its gate is
 *  off — only the extension stands in the way. */
function rules(bypass: boolean): Scenario {
  return async (ctx) => {
    await fresh(ctx);
    const tag = `dnr-${bypass ? "b" : "n"}-${ctx.run}-${Date.now() % 100000}`;
    await ctx.engine.command("test.config", { siteBypass: bypass, gate: !bypass });
    const violations: string[] = [];
    const rows: unknown[] = [];
    const pausedBefore = ctx.engine.observed.length;
    try {
      for (const [index, c] of RULE_CASES.entries()) {
        const rid = `${tag}-${index}`;
        const page = await ctx.engine.eval<{ status?: number; error?: string }>(`site.raw(${JSON.stringify(rid)}, ${JSON.stringify(c.method)}, ${JSON.stringify(c.path)})`);
        await sleep(200);
        const events = await ctx.stand.journal();
        const arrived = reqs(events, rid).map((event) => String(event.method));
        const seenByOperator = ctx.engine.observed.slice(pausedBefore).filter((o) => o.kind === "paused" && String(o.url).includes(rid)).map((o) => String(o.method));
        rows.push({ case: c.name, page: page.status ?? page.error, arrived, operatorSaw: seenByOperator });
        const mainArrived = arrived.includes(c.method);
        if (mainArrived !== c.reaches) violations.push(`${c.name}: ${c.method} ${c.path} ${mainArrived ? "reached" : "did not reach"} the server`);
      }
      // The same rules for requests Hub issues (released from the
      // placeholder host): the operator is not the only barrier for them.
      for (const [name, method, path, reaches] of [
        ["Hub: never (read ack)", "POST", "/api/v1/message/ack", false],
        ["Hub: unknown write", "POST", "/api/v1/group", false],
        ["Hub: read", "GET", "/api/v1/account/me", true],
      ] as const) {
        const rid = `${tag}-hub-${method}-${path.split("/").pop()}`;
        const result = await ctx.engine.sendHub(rid, `${API}${path}?rid=${rid}`, { authorization: "stand-token" }, method);
        await sleep(200);
        const arrived = reqs(await ctx.stand.journal(), rid).map((event) => String(event.method));
        rows.push({ case: name, result: result.outcome === "response" ? result.status : `${String(result.outcome)} ${String(result.errorText ?? result.error ?? "")}`, arrived });
        if (arrived.includes(method) !== reaches) violations.push(`${name}: ${method} ${path} ${arrived.includes(method) ? "reached" : "did not reach"} the server`);
      }
      // Local and private addresses from the page.
      const local = await ctx.engine.eval<string[]>(
        `Promise.all(["http://localhost:9222/json/version", "http://127.0.0.1:7700/", "http://10.0.0.1/", "http://192.168.1.1/"].map((u) => fetch(u, { mode: "no-cors" }).then(() => "reached " + u, (e) => "blocked " + u)))`,
      );
      rows.push({ case: "local and private addresses", page: local });
      for (const line of local) if (line.startsWith("reached")) violations.push(`the page ${line}`);
    } finally {
      await ctx.engine.command("test.config", { siteBypass: false, gate: true });
    }
    return { ok: violations.length === 0, violations, notes: { bypass, rows } };
  };
}

// ── condition №3: the socket ─────────────────────────────────────────────

const FORBIDDEN = JSON.stringify({ t: 99, d: "read-ack" });

const wsContexts: Scenario = async (ctx) => {
  await fresh(ctx);
  const tag = `wsc-${ctx.run}-${Date.now() % 100000}`;
  const violations: string[] = [];
  const notes: Record<string, unknown> = {};
  // main world
  const index = await ctx.engine.eval<number>(`site.ws(${JSON.stringify(`${tag}-main`)})`, false);
  await until(async () => (await ctx.engine.eval<{ readyState: number }>(`site.wsState(${index})`, false)).readyState === 1, 10_000, "main socket open");
  notes.main = {
    forbiddenFirst: await ctx.engine.eval(`site.wsSend(${index}, ${JSON.stringify(FORBIDDEN)})`, false),
    ping: await ctx.engine.eval(`site.wsSend(${index}, "p")`, false),
  };
  // same-origin iframe
  await ctx.engine.eval(`site.iframe("/frame.html")`);
  const fIndex = await ctx.engine.eval<number>(`site.frameSite(0).ws(${JSON.stringify(`${tag}-frame`)})`, false);
  await until(async () => (await ctx.engine.eval<{ readyState: number }>(`site.frameSite(0).wsState(${fIndex})`, false)).readyState === 1, 10_000, "frame socket open");
  notes.frame = {
    forbidden: await ctx.engine.eval(`site.frameSite(0).wsSend(${fIndex}, ${JSON.stringify(FORBIDDEN)})`, false),
    sendToString: await ctx.engine.eval(`Function.prototype.toString.call(site.frameSite(0) && document.querySelector("iframe").contentWindow.WebSocket.prototype.send)`, false),
  };
  // dedicated worker
  notes.workerReady = await ctx.engine.eval(`site.worker()`);
  const w = await ctx.engine.eval<{ index: number }>(`site.inWorker({ op: "ws", rid: ${JSON.stringify(`${tag}-worker`)} })`);
  notes.worker = { open: w, forbidden: await ctx.engine.eval(`site.inWorker({ op: "wsSend", index: ${w.index}, data: ${JSON.stringify(FORBIDDEN)} })`) };
  // shared worker
  notes.sharedReady = await ctx.engine.eval(`site.sharedWorker()`);
  const sw = await ctx.engine.eval<{ index: number }>(`site.inShared({ op: "ws", rid: ${JSON.stringify(`${tag}-shared`)} })`);
  notes.shared = { open: sw, forbidden: await ctx.engine.eval(`site.inShared({ op: "wsSend", index: ${sw.index}, data: ${JSON.stringify(FORBIDDEN)} })`) };
  // service worker
  notes.swReady = await ctx.engine.eval(`site.serviceWorker()`);
  const svc = await ctx.engine.eval<{ index: number }>(`site.inServiceWorker({ op: "ws", rid: ${JSON.stringify(`${tag}-sw`)} })`);
  notes.serviceWorker = { open: svc, probe: await ctx.engine.eval(`site.inServiceWorker({ op: "probe" })`), forbidden: await ctx.engine.eval(`site.inServiceWorker({ op: "wsSend", index: ${svc.index}, data: ${JSON.stringify(FORBIDDEN)} })`) };
  await sleep(1500);
  const events = await ctx.stand.journal();
  const opened = events.filter((event) => event.t === "ws.open" && String(event.rid ?? "").startsWith(tag)).map((event) => `${event.rid}:${event.proto}`);
  notes.opened = opened;
  for (const where of ["main", "frame", "worker", "shared", "sw"]) {
    if (!opened.some((entry) => entry.startsWith(`${tag}-${where}:`))) violations.push(`no socket opened from ${where}`);
  }
  const frames = events.filter((event) => event.t === "ws.frame").map((event) => String(event.text));
  if (frames.some((text) => text.includes('"t":99'))) violations.push("a forbidden socket message reached the server");
  const wsGrants = ctx.engine.grants.filter((grant) => grant.kind === "ws").length;
  notes.wsAdmissions = wsGrants;
  if (wsGrants < opened.length) violations.push(`${opened.length} sockets opened, ${wsGrants} admissions`);
  notes.guard = ctx.engine.observed.filter((o) => o.kind === "guard").map((o) => `${o.k}@${o.target}`);
  const blocked = ctx.engine.observed.filter((o) => o.kind === "guard" && o.k === "blocked_send").length;
  if (blocked < 5) violations.push(`only ${blocked} of 5 forbidden messages reported as blocked`);
  return { ok: violations.length === 0, violations, notes };
};

/** A service worker Chrome stopped and started again is a new run of its
 *  script: is the socket guard there again before the script? */
const wsSwRestart: Scenario = async (ctx) => {
  await fresh(ctx);
  const tag = `wssw-${ctx.run}-${Date.now() % 100000}`;
  const violations: string[] = [];
  const notes: Record<string, unknown> = {};
  const guardsBefore = ctx.engine.observed.filter((o) => o.kind === "guard" && o.k === "installed" && o.target === "service_worker").length;
  await ctx.engine.eval(`site.serviceWorker()`);
  const first = await ctx.engine.eval<{ index: number }>(`site.inServiceWorker({ op: "ws", rid: ${JSON.stringify(`${tag}-a`)} })`);
  await ctx.engine.eval(`site.inServiceWorker({ op: "wsSend", index: ${first.index}, data: ${JSON.stringify(FORBIDDEN)} })`);
  const guardsBeforeStop = ctx.engine.observed.filter((o) => o.kind === "guard" && o.k === "installed" && o.target === "service_worker").length;
  const blockedBeforeStop = ctx.engine.observed.filter((o) => o.kind === "guard" && o.k === "blocked_send" && o.target === "service_worker").length;
  notes.stop = (await ctx.engine.command("test.stopServiceWorkers")).ok;
  await sleep(1500);
  // The next message starts the worker again.
  notes.probeAfterRestart = await ctx.engine.eval(`site.inServiceWorker({ op: "probe" })`);
  const second = await ctx.engine.eval<{ index: number; readyState: number }>(`site.inServiceWorker({ op: "ws", rid: ${JSON.stringify(`${tag}-b`)} })`);
  notes.socketAfterRestart = second;
  notes.sendAfterRestart = await ctx.engine.eval(`site.inServiceWorker({ op: "wsSend", index: ${second.index}, data: ${JSON.stringify(FORBIDDEN)} })`);
  await ctx.engine.eval(`site.inServiceWorker({ op: "wsSend", index: ${second.index}, data: "p" })`);
  await sleep(1000);
  const events = await ctx.stand.journal();
  const frames = events.filter((event) => event.t === "ws.frame").map((event) => String(event.text));
  if (frames.some((text) => text.includes('"t":99'))) violations.push("a forbidden message left a restarted service worker");
  if (!events.some((event) => event.t === "ws.open" && event.rid === `${tag}-b`)) violations.push("the restarted service worker opened no socket (nothing was tested)");
  if (!frames.includes("p")) violations.push("the allowed message of the restarted service worker did not arrive");
  void guardsBefore;
  const guards = ctx.engine.observed.filter((o) => o.kind === "guard" && o.k === "installed" && o.target === "service_worker").length - guardsBeforeStop;
  const blocked = ctx.engine.observed.filter((o) => o.kind === "guard" && o.k === "blocked_send" && o.target === "service_worker").length - blockedBeforeStop;
  notes.guardInstallsAfterRestart = guards;
  notes.blockedAfterRestart = blocked;
  notes.restarts = ctx.engine.observed.filter((o) => o.kind === "worker.restarted").length;
  if (guards < 1) violations.push("the guard was not installed again in the restarted service worker");
  if (blocked < 1) violations.push("the forbidden message of the restarted service worker was not reported");
  return { ok: violations.length === 0, violations, notes };
};

/** Stage 1 item 5: every frame the server sends reaches the engine, in
 *  order and once — in a burst, after a reconnect and on a worker's socket. */
const wsFrames: Scenario = async (ctx) => {
  await fresh(ctx);
  const tag = `wsf-${ctx.run}-${Date.now() % 100000}`;
  const violations: string[] = [];
  const notes: Record<string, unknown> = {};
  const startSeq = ctx.engine.wsEvents.length;
  const wsIdOf = async (rid: string) => {
    let id: string | null = null;
    await until(async () => {
      const open = (await ctx.stand.journal()).find((event) => event.t === "ws.open" && event.rid === rid);
      id = open ? String(open.wsId) : null;
      return id !== null;
    }, 10_000, `socket ${rid} on the server`);
    return id!;
  };
  const push = async (wsId: string, prefix: string, n: number) => {
    for (let base = 0; base < n; base += 50) {
      await Promise.all(Array.from({ length: Math.min(50, n - base) }, (_, i) => ctx.stand.wsPush(`${prefix}-${String(base + i).padStart(5, "0")}`, wsId)));
    }
  };
  // 1. a burst of 1 000 frames on the page's socket
  const first = await ctx.engine.eval<number>(`site.ws(${JSON.stringify(`${tag}-a`)})`, false);
  const idA = await wsIdOf(`${tag}-a`);
  await push(idA, "a", 1000);
  // 2. the server drops the socket; the site opens a new one; 200 more
  await ctx.stand.wsClose(idA);
  await until(async () => (await ctx.engine.eval<{ readyState: number }>(`site.wsState(${first})`, false)).readyState === 3, 10_000, "socket closed");
  await ctx.engine.eval<number>(`site.ws(${JSON.stringify(`${tag}-b`)})`, false);
  const idB = await wsIdOf(`${tag}-b`);
  await push(idB, "b", 200);
  // 3. a worker's socket
  await ctx.engine.eval(`site.worker()`);
  await ctx.engine.eval(`site.inWorker({ op: "ws", rid: ${JSON.stringify(`${tag}-w`)} })`);
  const idW = await wsIdOf(`${tag}-w`);
  await push(idW, "w", 100);
  await sleep(1500);
  const events = await ctx.stand.journal();
  const got = ctx.engine.wsEvents.slice(startSeq);
  for (const [name, wsId, prefix, n] of [["burst", idA, "a", 1000], ["after reconnect", idB, "b", 200], ["worker", idW, "w", 100]] as const) {
    const sent = events.filter((event) => event.t === "ws.send" && event.wsId === wsId && String(event.text).startsWith(`${prefix}-`)).map((event) => String(event.text));
    const received = got.filter((event) => event.kind === "in" && String(event.data).startsWith(`${prefix}-`)).map((event) => String(event.data));
    const sameOrder = sent.length === received.length && sent.every((text, i) => text === received[i]);
    notes[name] = { sent: sent.length, received: received.length, sameOrder, unique: new Set(received).size };
    if (sent.length !== n) violations.push(`${name}: the server sent ${sent.length} of ${n}`);
    if (!sameOrder) violations.push(`${name}: ${received.length} frames reached the engine of ${sent.length} sent (or out of order)`);
  }
  const seqs = got.map((event) => Number(event.seq));
  if (seqs.some((seq, i) => i > 0 && seq !== seqs[i - 1]! + 1)) violations.push("the operator's event numbers have a gap");
  notes.lifecycle = got.filter((event) => event.kind !== "in" && event.kind !== "out").map((event) => `${String(event.kind)}@${String(event.target)}`);
  notes.out = got.filter((event) => event.kind === "out").length;
  return { ok: violations.length === 0, violations, notes };
};

const wsOverH2: Scenario = async (ctx) => {
  await fresh(ctx);
  const tag = `wsh2-${ctx.run}-${Date.now() % 100000}`;
  const notes: Record<string, unknown> = {};
  const violations: string[] = [];
  for (const refuse of [true, false]) {
    await ctx.engine.command("test.config", { wsHostRefuse: refuse });
    // No session to the socket host left from an earlier run with the rule
    // switched off (with the rule on, none can appear).
    await ctx.engine.command("test.cutWs");
    const before = ctx.engine.grants.filter((grant) => grant.kind === "ws").length;
    const fetched = await ctx.engine.eval(`site.wsHostFetch(${JSON.stringify(`${tag}-${refuse}-f`)})`);
    const index = await ctx.engine.eval<number>(`site.ws(${JSON.stringify(`${tag}-${refuse}-s`)})`, false);
    await until(async () => (await ctx.engine.eval<{ readyState: number }>(`site.wsState(${index})`, false)).readyState !== 0, 10_000, "socket settled");
    await sleep(500);
    const events = await ctx.stand.journal();
    const open = events.find((event) => event.t === "ws.open" && event.rid === `${tag}-${refuse}-s`);
    const admissions = ctx.engine.grants.filter((grant) => grant.kind === "ws").length - before;
    notes[refuse ? "refused" : "allowed"] = { fetched, proto: open?.proto ?? null, admissions };
    // With the operator's rule (refuse) every socket needs its own tunnel and
    // admission. Without it (evidence only) a socket may ride the session.
    if (refuse && open && admissions === 0) violations.push(`a socket opened over ${open.proto} without an admission`);
    await ctx.engine.eval(`location.reload(), true`, false).catch(() => undefined);
    await ctx.engine.waitReady();
  }
  await ctx.engine.command("test.config", { wsHostRefuse: true });
  await ctx.engine.command("test.cutWs");
  return { ok: violations.length === 0, violations, notes };
};

const wsRefused: Scenario = async (ctx) => {
  await fresh(ctx);
  ctx.engine.decideWs = () => ({ grant: false, reason: "stand: not now" });
  const tag = `wsr-${ctx.run}-${Date.now() % 100000}`;
  const index = await ctx.engine.eval<number>(`site.ws(${JSON.stringify(tag)})`, false);
  await until(async () => (await ctx.engine.eval<{ readyState: number }>(`site.wsState(${index})`, false)).readyState === 3, 15_000, "socket closed");
  const state = await ctx.engine.eval(`site.wsState(${index})`, false);
  const events = await ctx.stand.journal();
  const reached = events.some((event) => event.t === "ws.open" && event.rid === tag);
  ctx.engine.decideWs = () => ({ grant: true });
  return { ok: !reached, violations: reached ? ["a refused socket reached the server"] : [], notes: { state } };
};

const wsBlankIframe: Scenario = async (ctx) => {
  await fresh(ctx);
  const tag = `wsb-${ctx.run}-${Date.now() % 100000}`;
  const index = await ctx.engine.eval<number>(`site.ws(${JSON.stringify(tag)})`, false);
  await until(async () => (await ctx.engine.eval<{ readyState: number }>(`site.wsState(${index})`, false)).readyState === 1, 10_000, "socket open");
  const bypass = await ctx.engine.eval(`site.blankIframeSend(${index}, ${JSON.stringify(FORBIDDEN)})`, false);
  await sleep(800);
  const events = await ctx.stand.journal();
  const leaked = events.some((event) => event.t === "ws.frame" && String(event.text).includes('"t":99'));
  return { ok: !leaked, violations: leaked ? ["a forbidden message left through a fresh about:blank iframe's WebSocket"] : [], notes: { bypass } };
};

const wsDetect: Scenario = async (ctx) => {
  await fresh(ctx);
  const detect = await ctx.engine.eval(`site.detect()`, false);
  return { ok: true, violations: [], notes: { detect } };
};

/** The site's own scripts run after the guard and may replace any built-in
 *  it uses (Astra review of the prototype, finding 1): a spy on
 *  Reflect.apply, a lying JSON.parse, a `t` getter on Object.prototype, a spy
 *  on WeakMap.prototype.get, Set/Map methods that say yes. No tampered
 *  message may reach the server, and a captured function must not be the
 *  native send. */
const wsTamper: Scenario = async (ctx) => {
  await fresh(ctx);
  const tag = `wst-${ctx.run}-${Date.now() % 100000}`;
  const index = await ctx.engine.eval<number>(`site.ws(${JSON.stringify(tag)})`, false);
  await until(async () => (await ctx.engine.eval<{ readyState: number }>(`site.wsState(${index})`, false)).readyState === 1, 10_000, "socket open");
  const attack = `(() => {
    const out = {};
    const ws = site.sockets[${index}].socket || site.sockets[${index}];
    const msg = (n) => JSON.stringify({ t: 99, d: "tamper-" + n });
    const realApply = Reflect.apply;
    let captured = null;
    Reflect.apply = function (target, thisArg, args) { if (captured === null && typeof target === "function" && target !== WebSocket.prototype.send && target.name === "send") captured = target; return realApply(target, thisArg, args); };
    try { ws.send("p"); } finally { Reflect.apply = realApply; }
    out.capturedSend = captured !== null;
    if (captured) { try { captured.call(ws, msg(1)); out.sentViaApply = true; } catch (e) { out.applyError = String(e); } }
    const realParse = JSON.parse;
    JSON.parse = function () { return { t: 1, d: '{"token":"x","v":3}' }; };
    try { ws.send(msg(2)); } finally { JSON.parse = realParse; }
    Object.defineProperty(Object.prototype, "t", { configurable: true, get() { return 1; } });
    try { ws.send(JSON.stringify({ d: '{"token":"x","v":3}', x: "tamper-3" })); } finally { delete Object.prototype.t; }
    const realGet = WeakMap.prototype.get;
    let map = null;
    WeakMap.prototype.get = function (key) { map = this; return realGet.call(this, key); };
    try { Function.prototype.toString.call(WebSocket.prototype.send); } finally { WeakMap.prototype.get = realGet; }
    out.capturedMap = map !== null;
    if (map) { const n = realGet.call(map, WebSocket.prototype.send); if (typeof n === "function") { try { n.call(ws, msg(4)); out.sentViaMap = true; } catch (e) { out.mapError = String(e); } } }
    const realHas = Set.prototype.has;
    Set.prototype.has = function () { return true; };
    try { ws.send(msg(5)); } finally { Set.prototype.has = realHas; }
    const realMapGet = Map.prototype.get;
    Map.prototype.get = function () { return { keys: ["t", "d"], dKeys: null }; };
    try { ws.send(msg(6)); } finally { Map.prototype.get = realMapGet; }
    const realOwnKeys = Reflect.ownKeys;
    Reflect.ownKeys = function () { return ["t", "d"]; };
    try { ws.send(JSON.stringify({ t: 1, d: '{"token":"x","v":3,"x":"tamper-7"}' })); } finally { Reflect.ownKeys = realOwnKeys; }
    return out;
  })()`;
  ctx.arm();
  const armedMono = monoMs();
  const out = await ctx.engine.eval<Record<string, unknown>>(attack, false);
  await sleep(1000);
  const events = await ctx.stand.journal();
  // The journal starts at this run's fresh page (fresh() marks it).
  const frames = events.filter((event) => event.t === "ws.frame").map((event) => String(event.text));
  const violations: string[] = [];
  const leaked = frames.filter((text) => text.includes("tamper"));
  if (leaked.length > 0) violations.push(`${leaked.length} tampered message(s) reached the server: ${leaked.map((text) => text.slice(0, 60)).join(" | ")}`);
  if (out.sentViaApply === true || out.sentViaMap === true) violations.push("the native send was reached from the page");
  const blocked = ctx.engine.observed.filter((o) => o.kind === "guard" && o.k === "blocked_send" && Number(o.recvMono) >= armedMono).length;
  if (blocked < 5) violations.push(`only ${blocked} of the 5 tampered sends reported as blocked`);
  return { ok: violations.length === 0, violations, notes: { out, frames: frames.map((text) => text.slice(0, 60)), blocked } };
};

export const scenarios: Record<string, Scenario> = {
  smoke,
  "loss-operator-kill": controlLoss("operator-kill", false),
  "loss-operator-kill-inflight": controlLoss("operator-kill", true),
  "loss-operator-hang": controlLoss("operator-hang", false),
  "loss-holder-kill": controlLoss("holder-kill", false),
  "loss-holder-kill-inflight": controlLoss("holder-kill", true),
  "loss-cdp-break": controlLoss("cdp-break", false),
  "loss-cdp-break-inflight": controlLoss("cdp-break", true),
  "loss-cdp-drop": controlLoss("cdp-drop", false),
  // The gate alone: the operator reacts 300 ms late on purpose.
  "loss-cdp-break-late": controlLoss("cdp-break", false, { lossDelayMs: 300 }),
  "loss-cdp-break-late-inflight": controlLoss("cdp-break", true, { lossDelayMs: 300 }),
  "loss-cdp-break-late-nogate": controlLoss("cdp-break", false, { lossDelayMs: 300, gate: false }),
  "loss-holder-kill-late": controlLoss("holder-kill", false, { lossDelayMs: 300 }),
  "loss-open-window": openWindow(0),
  "loss-open-window-late": openWindow(300),
  "loss-responding": respondingLoss(0),
  "loss-responding-late": respondingLoss(300),
  "loss-new-connection": newConnectionLoss(0),
  "loss-new-connection-late": newConnectionLoss(300),
  "idle-ping": idlePing,
  "loss-chrome-kill": controlLoss("chrome-kill", false),
  "loss-planned-stop": controlLoss("planned-stop", false),
  "retry-refused": retry("h2RefusedStream", true),
  "retry-refused-nogate": retry("h2RefusedStream", false),
  "retry-goaway": retry("h2Goaway", true),
  "retry-goaway-nogate": retry("h2Goaway", false),
  "retry-reset": retry("resetAfterHeaders", true),
  "retry-reset-nogate": retry("resetAfterHeaders", false),
  // The same with the stand's own round trip (< 1 ms): how short a round
  // trip the quiet window of the gate still covers.
  "retry-refused-rtt0": retry("h2RefusedStream", true, 0),
  "retry-goaway-rtt0": retry("h2Goaway", true, 0),
  "retry-reset-rtt0": retry("resetAfterHeaders", true, 0),
  "retry-post": retryPost(0),
  "retry-post-slowcdp": retryPost(50),
  "send-time": sendTime,
  "hub-gc-paused": hubGc("paused"),
  "hub-gc-body": hubGc("body"),
  "hub-slow-body": hubGc("body-nogc"),
  "expiry-site-socks": expiry("site", "socks", true),
  "expiry-site-socks-nogate": expiry("site", "socks", false),
  "expiry-site-tcp": expiry("site", "tcp", true),
  "expiry-site-tcp-nogate": expiry("site", "tcp", false),
  "expiry-hub-socks": expiry("hub", "socks", true),
  "expiry-hub-socks-abortonly": expiry("hub", "socks", false, true),
  "expiry-hub-socks-nothing": expiry("hub", "socks", false, false),
  rules: rules(false),
  "rules-bypass": rules(true),
  "body-capture": bodyCapture,
  "body-burst": bodyBurst,
  "ws-contexts": wsContexts,
  "ws-h2": wsOverH2,
  "ws-frames": wsFrames,
  "ws-sw-restart": wsSwRestart,
  "ws-refused": wsRefused,
  "ws-blank-iframe": wsBlankIframe,
  "ws-detect": wsDetect,
  "ws-tamper": wsTamper,
};
