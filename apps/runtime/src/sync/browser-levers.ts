import {
  clearPageBrowserOwnerStop,
  expirePageBrowserCommands,
  findPageBrowserByPage,
  getPageBrowserCommand,
  getSyncPageBrowserLeave,
  getSyncPageTransport,
  insertAuditEvent,
  insertPageBrowserCommand,
  listPageBrowsersOfPages,
  listPageBrowserTransitions,
  listSyncPages,
  pageBrowserEnvOf,
  liftBrowserStopPause,
  pausePageForBrowserStop,
  readPageBrowserOwnerStop,
  requestBrowserDrain,
  setPageBrowserOwnerStop,
  setPageBrowserSettings,
  type Database,
  type PageBrowserCommandKind,
  type PageBrowserCommandRow,
  type PageBrowserEnv,
} from "@agency_hub_core/db";

import { readPageBrowserStatuses, type BrowserStatusView } from "./browser-status.ts";
import { findSyncPageByLabel, SyncOwnerLeverError } from "./inspect.ts";

// The owner's levers on a page's browser (Project Browser plan §4.11; stage 3
// PR 17), under `pnpm cli sync browser …`. Each writes what the engine is to
// do with its audit row in one transaction; the engine that owns the page
// carries it out over its link to the operator (a command reaches a browser
// only from the page's current owner, plan §4.8, §4.13) and the CLI waits for
// what it says:
//
// - `stop` (one page, or `--all` pages with a browser): the engine pauses the
//   page and the operator closes its exit, then stops Chrome (plan §4.11) —
//   kept so (`page_browsers.owner_stop_*`) until `start`. The pause is the
//   stop's (`sync_pages.browser_stop_paused`) when the page was not paused
//   before, and only while the owner does not change it himself. The stop
//   is confirmed by the operator's answer to this very request
//   (`page_browser_commands` `stopPage`, under the owner's generation),
//   which comes once Chrome is down — never by a state it says on the way.
// - `start`: the owner's decision — his stop and the pause still his stop's
//   lifted, and the halt the operator holds for his decision (as Hub mirrors
//   it now) cleared at the operator by its id (`clearHalt`, also during a
//   login), then a start of the browser, under the guard of every start.
// - `selftest`: the operator's self-test, with its exit closed for it.
// - `snapshot`: the browser stopped as by `stop`, and the profile quiet only
//   once that stop is confirmed (the volume is packed by the host's script —
//   Hub's containers have no Docker, plan §4.10); `start` brings it back.
// - `pin-ip`: the exit IP the page's browser may open its exit through, and
//   its environment (the hello's settings beside the proxy, 0277): until both
//   are set the page cannot be switched to its browser.
// - `drain`: what a stopped browser kept (its buffer marked not drained by
//   `sync page transport … node --browser-stopped`), taken while the page
//   stays on Node: Node's slot ends, a leave of the browser takes it (the
//   browser told to stand stopped), and Node takes the page again.
// - `history` (read only): the operator's transitions over a window
//   (`page_browser_transitions`, protocol minor 5) — its stops by reason,
//   Chrome's starts, the crash dumps counted then.

export const SYNC_BROWSER_AUDIT_EVENTS = {
  stop: "admin.sync_browser_stop",
  start: "admin.sync_browser_start",
  selftest: "admin.sync_browser_selftest",
  snapshot: "admin.sync_browser_snapshot",
  pinIp: "admin.sync_browser_pin_ip",
  drain: "admin.sync_browser_drain",
} as const;

/** How long an owner's command waits to be taken by the page's owner. */
export const SYNC_BROWSER_COMMAND_TTL_MS = 60_000;

/** The pause a stop puts on the page says so. */
export const SYNC_BROWSER_STOP_PAUSE_NOTE = "the owner stopped the page's browser (sync browser stop)";

interface PageOfLabel {
  pageId: number;
  label: string;
}

async function pageWithBrowser(db: Database, label: string): Promise<PageOfLabel> {
  const page = await findSyncPageByLabel(db, label);
  if ((await findPageBrowserByPage(db, page.pageId)) === null) {
    throw new SyncOwnerLeverError(`${label} has no browser: no browser profile is bound to the page`);
  }
  return { pageId: page.pageId, label };
}

/** The pages a lever acts on: one by its label, or every page with a browser. */
async function targets(db: Database, input: { pageLabel?: string; all?: boolean }): Promise<PageOfLabel[]> {
  if ((input.pageLabel === undefined) === (input.all !== true)) {
    throw new SyncOwnerLeverError("name one page, or --all (every page with a browser)");
  }
  if (input.pageLabel !== undefined) return [await pageWithBrowser(db, input.pageLabel)];
  return (await listPageBrowsersOfPages(db)).map((row) => ({ pageId: row.pageId, label: row.pageLabel ?? String(row.pageId) }));
}

function transaction<T>(db: Database, body: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (raw) => body(raw as unknown as Database));
}

async function audit(tx: Database, page: PageOfLabel, eventType: string, actor: string, note: string | null | undefined, extra: Record<string, unknown>) {
  await insertAuditEvent(tx, {
    platformAccountId: page.pageId,
    source: "cli",
    eventType,
    metadata: { actor, pageLabel: page.label, ...extra, ...(note === undefined || note === null ? {} : { note }) },
  });
}

export interface BrowserStopResult {
  page: string;
  stoppedAt: string;
  /** The page was stopped by the owner already (its first stop kept). */
  already: boolean;
  /** This stop put the page on its pause, or took over the one its open
   *  login put (`start` lifts it while it is still the stop's). */
  pausedByStop: boolean;
  /** The pause was the open login's: the stop's now, so the login's end does
   *  not lift it. */
  pauseFromLogin: boolean;
  /** The stop asked of the operator: its answer — once Chrome is down — is
   *  the stop's confirmation. */
  command: { id: number; kind: PageBrowserCommandKind; expiresAt: string };
}

/** `sync browser stop <page> | --all` (and `snapshot`): the owner's stop
 *  marked, the page paused (the pause the stop's when it was not paused),
 *  and a stop asked of the operator, whose answer confirms it.
 *
 *  `ifNoOwnerStop` (`snapshot --if-no-owner-stop [command]`; the Chrome
 *  update's stop, PR 18): never over another's stop — refused in the same
 *  transaction, nothing changed, while an owner's stop stands, unless the
 *  page's latest stop command is the one named (the update's own, asked
 *  again). A stop asked over the owner's would be the latest, and the
 *  update's start (`--if-stop`) could lift his. Nor of a page that is not
 *  on its browser: refused the same way unless its transport is `browser`
 *  with no leave of it pending — a page its owner moved to Node is never
 *  paused by the update. */
export async function stopPageBrowsers(
  db: Database,
  input: { pageLabel?: string; all?: boolean; actor: string; note?: string | null; snapshot?: boolean; ifNoOwnerStop?: true | number },
): Promise<BrowserStopResult[]> {
  const pages = await targets(db, input);
  const results: BrowserStopResult[] = [];
  for (const page of pages) {
    results.push(await transaction(db, async (tx) => {
      const paused = await pausePageForBrowserStop(tx, { pageId: page.pageId, note: SYNC_BROWSER_STOP_PAUSE_NOTE });
      if (paused === null) throw new SyncOwnerLeverError(`${page.label}: no engine row`);
      if (input.ifNoOwnerStop !== undefined) {
        // Under the page row's lock, taken by the pause — the lock every
        // change of its transport takes: an owner's stop or a transport
        // change asked concurrently is seen here, or comes after this one.
        const transport = await getSyncPageTransport(tx, page.pageId);
        const leave = await getSyncPageBrowserLeave(tx, page.pageId);
        if (transport !== "browser" || leave !== null) {
          throw new SyncOwnerLeverError(
            `${page.label} is not on its browser (transport ${transport ?? "none"}${leave === null ? "" : `, a leave of it pending since generation ${leave.generation}`}): `
            + "the update's stop is asked only of a page on its browser — refused, nothing changed",
          );
        }
        const current = await readPageBrowserOwnerStop(tx, { pageId: page.pageId });
        if (current === null) throw new SyncOwnerLeverError(`${page.label} has no browser`);
        const own = typeof input.ifNoOwnerStop === "number" ? input.ifNoOwnerStop : null;
        if (current.stopped && current.lastStopCommandId !== own) {
          throw new SyncOwnerLeverError(
            `${page.label}: an owner's stop stands on its browser (the page's latest stop is command ${current.lastStopCommandId ?? "none"}): `
            + "this stop is never asked over another's — refused, nothing changed",
          );
        }
      }
      const stop = await setPageBrowserOwnerStop(tx, { pageId: page.pageId, by: input.actor });
      if (stop === null) throw new SyncOwnerLeverError(`${page.label} has no browser`);
      const command = await insertPageBrowserCommand(tx, {
        pageId: page.pageId,
        kind: "stopPage",
        requestedBy: input.actor,
        note: input.note ?? null,
        ttlMs: SYNC_BROWSER_COMMAND_TTL_MS,
      });
      if (command === null) throw new SyncOwnerLeverError(`${page.label} has no browser`);
      await audit(tx, page, input.snapshot === true ? SYNC_BROWSER_AUDIT_EVENTS.snapshot : SYNC_BROWSER_AUDIT_EVENTS.stop, input.actor, input.note, {
        all: input.all === true,
        already: stop.already,
        pausedByStop: paused.pausedByStop,
        pauseFromLogin: paused.fromLogin,
        profileId: stop.profileId,
        ...(input.ifNoOwnerStop === undefined ? {} : { ifNoOwnerStop: input.ifNoOwnerStop }),
        commandId: command.id,
      });
      return {
        page: page.label,
        stoppedAt: stop.stoppedAt.toISOString(),
        already: stop.already,
        pausedByStop: paused.pausedByStop,
        pauseFromLogin: paused.fromLogin,
        command: { id: command.id, kind: command.kind, expiresAt: command.expiresAt.toISOString() },
      };
    }));
  }
  return results;
}

export interface BrowserCommandAsked {
  page: string;
  command: { id: number; kind: PageBrowserCommandKind; expiresAt: string };
}

/** `sync browser start <page>` — the owner's decision: his stop lifted, the
 *  page's pause lifted only while it is still the one his stop put (a pause
 *  he changed since is his; while a login of the browser is open the pause
 *  goes back to the login, which lifts it at its end), and a start asked:
 *  the engine clears the halt the operator holds — the one Hub mirrors now,
 *  named by its id (a newer one stays) — then starts the browser under the
 *  same guard as any start (during a login, the login starts it).
 *
 *  `ifNoHalt` (`--if-no-halt`; the Chrome update's start, PR 18): a start
 *  that never clears a halt — while Hub mirrors one for the owner's
 *  decision it is refused in the same transaction, nothing changed (the
 *  owner's stop and its pause stay); a halt the operator holds and Hub has
 *  not mirrored yet refuses it at the operator, as any start.
 *
 *  `ifStop` (`--if-stop <command>`; the Chrome update's start, PR 18): a
 *  start that lifts only the stop that command made — refused in the same
 *  transaction, nothing changed, unless the owner's stop stands and the
 *  page's latest stop command is that one (a stop asked since is the
 *  owner's, and so is a start that lifted it). */
export async function startPageBrowser(
  db: Database,
  input: { pageLabel: string; actor: string; note?: string | null; ifNoHalt?: boolean; ifStop?: number },
): Promise<BrowserCommandAsked & { wasStopped: boolean; resumed: boolean; pauseToLogin: boolean; halt: { id: string | null; reason: string; at: string } | null }> {
  const page = await pageWithBrowser(db, input.pageLabel);
  return transaction(db, async (tx) => {
    // The page row first (the stop's order): its pause and its owner.
    const lifted = await liftBrowserStopPause(tx, { pageId: page.pageId });
    if (input.ifStop !== undefined) {
      // Under the page row's lock (the stop's order): a stop asked
      // concurrently either is seen here, or comes after this start.
      const stop = await readPageBrowserOwnerStop(tx, { pageId: page.pageId });
      if (stop === null) throw new SyncOwnerLeverError(`${page.label} has no browser`);
      if (!stop.stopped || stop.lastStopCommandId !== input.ifStop) {
        throw new SyncOwnerLeverError(
          `${page.label}: the stop in force is not command ${input.ifStop}'s `
          + `(${stop.stopped ? `the page's latest stop is command ${stop.lastStopCommandId ?? "none"}` : "the browser is not stopped by the owner now"}): `
          + "this start lifts only that stop — refused, nothing changed",
        );
      }
    }
    const resumed = lifted === "lifted";
    const pauseToLogin = lifted === "to_login";
    const cleared = await clearPageBrowserOwnerStop(tx, { pageId: page.pageId });
    if (cleared === null) throw new SyncOwnerLeverError(`${page.label} has no browser`);
    if (input.ifNoHalt === true && cleared.halt !== null) {
      throw new SyncOwnerLeverError(
        `${page.label}: its browser stands for the owner's decision (${cleared.halt.reason}${cleared.halt.id === null ? "" : `, halt ${cleared.halt.id}`}): `
        + "a start that clears no halt is refused, nothing changed — the owner's own `sync browser start` decides it",
      );
    }
    const command = await insertPageBrowserCommand(tx, {
      pageId: page.pageId,
      kind: "restartBrowser",
      requestedBy: input.actor,
      note: input.note ?? null,
      ttlMs: SYNC_BROWSER_COMMAND_TTL_MS,
      haltId: cleared.halt?.id ?? null,
    });
    if (command === null) throw new SyncOwnerLeverError(`${page.label} has no browser`);
    const halt = cleared.halt === null ? null : { id: cleared.halt.id, reason: cleared.halt.reason, at: cleared.halt.at.toISOString() };
    await audit(tx, page, SYNC_BROWSER_AUDIT_EVENTS.start, input.actor, input.note, {
      wasStopped: cleared.wasStopped,
      resumed,
      pauseToLogin,
      halt,
      ...(input.ifNoHalt === true ? { ifNoHalt: true } : {}),
      ...(input.ifStop === undefined ? {} : { ifStop: input.ifStop }),
      commandId: command.id,
    });
    return {
      page: page.label,
      wasStopped: cleared.wasStopped,
      resumed,
      pauseToLogin,
      halt,
      command: { id: command.id, kind: command.kind, expiresAt: command.expiresAt.toISOString() },
    };
  });
}

/** `sync browser selftest <page>`. */
export async function askPageBrowserSelfTest(
  db: Database,
  input: { pageLabel: string; actor: string; note?: string | null },
): Promise<BrowserCommandAsked> {
  const page = await pageWithBrowser(db, input.pageLabel);
  return transaction(db, async (tx) => {
    const command = await insertPageBrowserCommand(tx, {
      pageId: page.pageId,
      kind: "selfTest",
      requestedBy: input.actor,
      note: input.note ?? null,
      ttlMs: SYNC_BROWSER_COMMAND_TTL_MS,
    });
    if (command === null) throw new SyncOwnerLeverError(`${page.label} has no browser`);
    await audit(tx, page, SYNC_BROWSER_AUDIT_EVENTS.selftest, input.actor, input.note, { commandId: command.id });
    return { page: page.label, command: { id: command.id, kind: command.kind, expiresAt: command.expiresAt.toISOString() } };
  });
}

/** `sync browser pin-ip <page> --ip … [--env …]`: what the page's hello
 *  tells its operator beside its proxy (0277). */
export async function pinPageBrowser(
  db: Database,
  input: { pageLabel: string; ip?: string; env?: PageBrowserEnv; actor: string; note?: string | null },
): Promise<{ page: string; pinnedExitIp: string | null; env: PageBrowserEnv | null; ready: boolean }> {
  if (input.ip === undefined && input.env === undefined) throw new SyncOwnerLeverError("pin-ip sets --ip, the environment, or both");
  if (input.env !== undefined && pageBrowserEnvOf(input.env as unknown as Record<string, unknown>) === null) {
    throw new SyncOwnerLeverError("not a browser environment: a time zone, languages and a geolocation (latitude, longitude, accuracy in metres)");
  }
  const page = await pageWithBrowser(db, input.pageLabel);
  return transaction(db, async (tx) => {
    const browser = await findPageBrowserByPage(tx, page.pageId);
    if (browser === null) throw new SyncOwnerLeverError(`${page.label} has no browser`);
    try {
      await setPageBrowserSettings(tx, {
        profileId: browser.profileId,
        ...(input.ip === undefined ? {} : { pinnedExitIp: input.ip }),
        ...(input.env === undefined ? {} : { env: input.env }),
      });
    } catch (error) {
      throw new SyncOwnerLeverError(error instanceof Error ? error.message : String(error));
    }
    const after = (await findPageBrowserByPage(tx, page.pageId))!;
    const env = pageBrowserEnvOf(after.env);
    await audit(tx, page, SYNC_BROWSER_AUDIT_EVENTS.pinIp, input.actor, input.note, {
      profileId: browser.profileId,
      from: { pinnedExitIp: browser.pinnedExitIp, env: pageBrowserEnvOf(browser.env) },
      to: { pinnedExitIp: after.pinnedExitIp, env },
    });
    return { page: page.label, pinnedExitIp: after.pinnedExitIp, env, ready: after.pinnedExitIp !== null && env !== null };
  });
}

/** `sync browser drain <page>`: what the page's stopped browser kept, taken
 *  while it stays on Node. */
export async function drainPageBrowser(
  db: Database,
  input: { pageLabel: string; actor: string; note?: string | null },
): Promise<{ page: string; leave: string }> {
  const page = await pageWithBrowser(db, input.pageLabel);
  return transaction(db, async (tx) => {
    const browser = await findPageBrowserByPage(tx, page.pageId);
    if (browser?.bufferUndrainedSince == null) {
      throw new SyncOwnerLeverError(`${page.label}: its browser's buffer is not marked undrained: nothing to drain`);
    }
    const drain = await requestBrowserDrain(tx, { pageId: page.pageId });
    if (drain.kind === "not_node") throw new SyncOwnerLeverError(`${page.label} runs on its browser: its own slot takes what it keeps`);
    if (drain.kind === "pending") throw new SyncOwnerLeverError(`${page.label}: a leave of its browser is pending already`);
    if (drain.kind === "login_open") throw new SyncOwnerLeverError(`${page.label}: a login of its browser is open — close it first (the drain stops the browser)`);
    if (drain.kind !== "requested") throw new SyncOwnerLeverError(`${page.label}: no engine row`);
    await audit(tx, page, SYNC_BROWSER_AUDIT_EVENTS.drain, input.actor, input.note, {
      profileId: browser.profileId,
      leave: drain.leave.toString(),
      undrainedSince: browser.bufferUndrainedSince.toISOString(),
    });
    return { page: page.label, leave: drain.leave.toString() };
  });
}

/** The browser of one page, or of every page that has one. */
export async function readPageBrowserStatusesByLabel(
  db: Database,
  input: { pageLabel?: string },
): Promise<Array<{ page: string; browser: BrowserStatusView }>> {
  const pages = input.pageLabel === undefined ? await listSyncPages(db) : [await findSyncPageByLabel(db, input.pageLabel)];
  const views = await readPageBrowserStatuses(db, pages);
  if (input.pageLabel !== undefined && views.size === 0) {
    throw new SyncOwnerLeverError(`${input.pageLabel} has no browser: no browser profile is bound to the page`);
  }
  return pages.flatMap((page) => {
    const browser = views.get(page.pageId);
    return browser === undefined ? [] : [{ page: page.pageLabel ?? String(page.pageId), browser }];
  });
}

/** What a page's browser did over a window, as its operator's transitions
 *  say it (0288). */
export interface PageBrowserHistory {
  page: string;
  profileId: string;
  since: string;
  /** Oldest first: at most `limit`, the newest of the window. */
  transitions: Array<{
    at: string;
    from: string;
    to: string;
    stopReason: string | null;
    halted: boolean;
    retryAt: string | null;
    note: string;
    chromeVersion: string;
    operatorVersion: string;
    crashDumps: number | null;
  }>;
  summary: {
    transitions: number;
    /** Stops (back to the first step with a reason), by reason. */
    stopsByReason: Record<string, number>;
    chromeStarts: number;
    readies: number;
    /** Chrome's crash dumps as the first and the last transition counted
     *  them (null: none counted). */
    crashDumps: { first: number | null; last: number | null };
  };
}

/** A page's browser over a window: its operator's transitions and their sums. */
export async function readPageBrowserHistory(
  db: Database,
  input: { pageLabel: string; since: Date; limit?: number },
): Promise<PageBrowserHistory> {
  const page = await findSyncPageByLabel(db, input.pageLabel);
  const browser = await findPageBrowserByPage(db, page.pageId);
  if (browser === null) throw new SyncOwnerLeverError(`${input.pageLabel} has no browser: no browser profile is bound to the page`);
  const rows = await listPageBrowserTransitions(db, { profileId: browser.profileId, since: input.since, ...(input.limit === undefined ? {} : { limit: input.limit }) });
  const stopsByReason: Record<string, number> = {};
  for (const row of rows) if (row.to === "exit_closed" && row.stopReason !== null) stopsByReason[row.stopReason] = (stopsByReason[row.stopReason] ?? 0) + 1;
  const counted = rows.flatMap((row) => (row.crashDumps === null ? [] : [row.crashDumps]));
  return {
    page: page.pageLabel ?? String(page.pageId),
    profileId: browser.profileId,
    since: input.since.toISOString(),
    transitions: rows.map((row) => ({
      at: row.at.toISOString(),
      from: row.from,
      to: row.to,
      stopReason: row.stopReason,
      halted: row.halted,
      retryAt: row.retryAt?.toISOString() ?? null,
      note: row.note,
      chromeVersion: row.chromeVersion,
      operatorVersion: row.operatorVersion,
      crashDumps: row.crashDumps,
    })),
    summary: {
      transitions: rows.length,
      stopsByReason,
      chromeStarts: rows.filter((row) => row.to === "chrome_started").length,
      readies: rows.filter((row) => row.to === "ready").length,
      crashDumps: { first: counted[0] ?? null, last: counted.at(-1) ?? null },
    },
  };
}

/** Wait for the page's owner to run a command (polling the row): its row
 *  once done, or — nobody took it before its expiry — closed as not run.
 *  Null: still running when the wait ended. */
export async function awaitPageBrowserCommand(
  db: Database,
  id: number,
  input: { waitMs: number; everyMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<PageBrowserCommandRow | null> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + input.waitMs;
  for (;;) {
    const row = await getPageBrowserCommand(db, id);
    if (row === null) return null;
    if (row.doneAt !== null) return row;
    // Past its expiry: ended (expired, or unknown once its answer can no
    // longer come) — nothing stays taken.
    if (row.expiresAt.getTime() <= Date.now() && (await expirePageBrowserCommands(db, { id })) > 0) return getPageBrowserCommand(db, id);
    if (Date.now() >= deadline) return null;
    await sleep(input.everyMs ?? 500);
  }
}
