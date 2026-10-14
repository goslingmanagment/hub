import {
  assertBrowserLeft,
  findPageById,
  insertAuditEvent,
  markPageBrowserUndrained,
  setPageHold,
  setSyncPageTransport,
  SYNC_PAGE_TRANSPORTS,
  type Database,
  type SyncPageTransport,
} from "@agency_hub_core/db";
import { credentialsFailureDetail } from "@agency_hub_core/shared";

import { readFanslyPageGeneration } from "../services/egress/fansly-probe-context.ts";
import { readPageBrowserPageSettings } from "../services/egress/page-browser-link.ts";
import { findSyncPageByLabel, SyncOwnerLeverError } from "./inspect.ts";

// `pnpm cli sync page transport <page> browser|node [--prepare]` (Project
// Browser plan §3.2 «Выбор транспорта страницы», «Переключение транспорта
// страницы и откат», §4.7, owner decision №12; stage 3 PR 14): the owner's
// lever on which sender a page's requests leave through. The change, any
// hold it writes and its audit row (`admin.sync_page_transport`) commit
// together; the host follows within 2 s — the page's slot ends (the request
// in flight finishes), the page is taken again with the other sender, a new
// owner generation and the takeover floor (≥ 1.2 × S after every send the
// database knows of, I5), and no admission of the sender it left commits
// after the change.
//
// - `browser`: the page's browser must be ready to be its sender — a profile
//   bound to the page, a pinned exit IP and an environment (0277). Its first
//   requests are the identity check of the browser's session (the trusted
//   digest is the Node one: checks-only until the browser's proof).
// - `node`: the page's stored Node session must be there. The engine then
//   verifies it first (the trusted digest is the browser's: checks-only);
//   a stale one is an `auth` hold and the owner's new session, as for any
//   page (owner decision №12).
// - `node --prepare` (a page connected through its browser, or whose stored
//   session is not to be tried): the page goes to Node under a credentials
//   hold (`auth`, reason `transport_prepare`) that admits nothing but the
//   identity check of a candidate session: the owner pastes the session of
//   his own browser (the credentials change), the engine checks it through
//   Node by that session (`account.identity`), and only a match is stored
//   and trusted, in one transaction that is a CAS on what it stood on
//   (`saveVerifiedFanslyCredentials`). The verify of what is stored then
//   lifts the hold (A3), and ordinary work begins on Node. A stored session
//   is never tried under it: the hold names its digest as refused.
// - Leaving `browser` records a pending leave: Node takes the page only once
//   it is confirmed — by the operator (the host's leave: exit closed, Chrome
//   stopped, no socket, its kept outcomes and buffer taken), or by
//   `--browser-stopped`: the owner's word that the page's container is
//   stopped (`scripts/deploy-page-browser.sh to-node` says it right after it
//   removed the container). Then what the operator kept was not taken: the
//   page's browser buffer is marked not drained (alert 2,
//   `browser_buffer_undrained`) until its operator says its open buffer
//   keeps nothing and the intake committed its last event.

export const SYNC_PAGE_TRANSPORT_AUDIT_EVENT = "admin.sync_page_transport";

export interface SyncPageTransportChange {
  page: string;
  from: SyncPageTransport;
  to: SyncPageTransport;
  changed: boolean;
  /** The pending leave of the page's browser after the change: the
   *  generation it leaves at (null: none — or confirmed by the owner). */
  pendingLeave: bigint | null;
  /** `--browser-stopped`: the leave the owner confirmed (its generation),
   *  the buffer marked not drained. */
  browserStopped: { leftGeneration: bigint; bufferUndrained: boolean } | null;
  /** `--prepare`: the credentials hold written, and the stored digest it
   *  names as refused (null: no Node session stored). */
  prepared: { hold: "auth"; refusedDigest: string | null } | null;
}

export async function changeSyncPageTransport(
  db: Database,
  input: { pageLabel: string; to: string; prepare: boolean; browserStopped?: boolean; actor: string; note?: string | null },
): Promise<SyncPageTransportChange> {
  if (!(SYNC_PAGE_TRANSPORTS as readonly string[]).includes(input.to)) {
    throw new SyncOwnerLeverError(`a page's transport is one of ${SYNC_PAGE_TRANSPORTS.join(", ")} (asked: ${input.to})`);
  }
  const to = input.to as SyncPageTransport;
  if (input.prepare && to !== "node") {
    throw new SyncOwnerLeverError("--prepare goes with node: it readies a page's way back from its browser");
  }
  const browserStopped = input.browserStopped === true;
  if (browserStopped && to !== "node") {
    throw new SyncOwnerLeverError("--browser-stopped goes with node: it confirms a page's leave of its browser");
  }
  const page = await findSyncPageByLabel(db, input.pageLabel);
  const label = input.pageLabel;
  if (to === "browser") {
    const ready = await readPageBrowserPageSettings(db, page.pageId);
    if ("problem" in ready) throw new SyncOwnerLeverError(`${label}: its browser cannot be its transport: ${ready.problem}`);
  }
  const stored = await findPageById(db, page.pageId);
  const hasNodeSession = stored?.credentials != null;
  if (to === "node" && !input.prepare && !hasNodeSession) {
    throw new SyncOwnerLeverError(
      `${label} has no Node session stored (it was connected through its browser): `
      + `sync page transport ${label} node --prepare, then the owner's session through the credentials change`,
    );
  }
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const changed = await setSyncPageTransport(tx, { pageId: page.pageId, to });
    if (changed.kind === "no_page") throw new SyncOwnerLeverError(`${label}: the page row is gone`);
    let prepared: SyncPageTransportChange["prepared"] = null;
    if (input.prepare) {
      const refusedDigest = hasNodeSession ? await readFanslyPageGeneration(tx, label) : null;
      await setPageHold(tx, {
        pageId: page.pageId,
        kind: "auth",
        until: "infinity",
        detail: credentialsFailureDetail({ attemptId: null, at: new Date(), digest: refusedDigest }, { reason: "transport_prepare" }),
      });
      prepared = { hold: "auth", refusedDigest };
    }
    let stopped: SyncPageTransportChange["browserStopped"] = null;
    if (browserStopped) {
      const leftGeneration = await assertBrowserLeft(tx, { pageId: page.pageId });
      if (leftGeneration === null) throw new SyncOwnerLeverError(`${label}: no leave of its browser is pending: nothing to confirm`);
      stopped = { leftGeneration, bufferUndrained: await markPageBrowserUndrained(tx, { pageId: page.pageId }) };
    }
    const pendingLeave = stopped !== null ? null : changed.leave;
    const from = changed.kind === "changed" ? changed.from : changed.transport;
    await insertAuditEvent(tx, {
      platformAccountId: page.pageId,
      source: "cli",
      eventType: SYNC_PAGE_TRANSPORT_AUDIT_EVENT,
      metadata: {
        actor: input.actor,
        pageLabel: label,
        from,
        to,
        changed: changed.kind === "changed",
        prepare: input.prepare,
        browserStopped,
        pendingLeave: pendingLeave === null ? null : pendingLeave.toString(),
        ...(stopped === null ? {} : { leftGeneration: stopped.leftGeneration.toString() }),
        ...(prepared === null ? {} : { refusedDigest: prepared.refusedDigest }),
        ...(input.note === undefined || input.note === null ? {} : { note: input.note }),
      },
    });
    return { page: label, from, to, changed: changed.kind === "changed", pendingLeave, browserStopped: stopped, prepared };
  });
}
