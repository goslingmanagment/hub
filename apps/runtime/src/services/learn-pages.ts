import type { LearnPageMeta, LearnPageResponse, LearnPagesResponse } from "@agency_hub_core/contracts";
import { findLearnPage, listLearnPages, setLearnPageApproval, type LearnPageRow } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { recordAudit, type AuditContext, type AuthPrincipal } from "./auth.ts";
import { agentReportWire } from "./agent-reports.ts";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { isTestPrincipal } from "./sandbox/realm.ts";
import { requireTeamReader } from "./teams.ts";

/**
 * «Обучение» (products plan 2026-11-13 §2.3): the agent's pages of the section `learn` (agent-reports.ts publishes them,
 * nothing here writes a page), read in Workboard. The owner's full session sees every page of the section and approves
 * each for the team (0421); anyone else — a team lead, a chatter, the extension's narrow session — reads only the
 * approved ones, and another page is the same 404 as one that does not exist. The test realm reads none: the pages are
 * the live agency's. Database only.
 */

type LearnApp = Pick<AppContext, "db">;

function ownerOf(principal: AuthPrincipal): boolean {
  return principal.kind === undefined && principal.user.role === "owner" && principal.narrowDeviceTokenId === undefined && !isTestPrincipal(principal);
}

function wire(row: LearnPageRow, now: Date): LearnPageMeta {
  return { ...agentReportWire(row, now), approved: row.approvedAt !== null };
}

export async function readLearnPages(app: LearnApp, principal: AuthPrincipal, now: Date = new Date()): Promise<LearnPagesResponse> {
  requireTeamReader(principal);
  const owner = ownerOf(principal);
  const rows = isTestPrincipal(principal) ? [] : await listLearnPages(app.db, { approvedOnly: !owner });
  return { pages: rows.map((row) => wire(row, now)), canApprove: owner, serverNow: now.toISOString() };
}

export async function readLearnPage(app: LearnApp, principal: AuthPrincipal, slug: string, now: Date = new Date()): Promise<LearnPageResponse> {
  requireTeamReader(principal);
  const owner = ownerOf(principal);
  const row = isTestPrincipal(principal) ? null : await findLearnPage(app.db, slug);
  if (row === null || (!owner && row.approvedAt === null)) throw new NotFoundError("No such page");
  return { page: { ...wire(row, now), body: row.body }, canApprove: owner, serverNow: now.toISOString() };
}

/**
 * The owner approves a page for the team, or takes the approval back. `audit` — a door that names who acted beside the
 * owner (the owner's agent door: the key, `owner_agent`): its row `learn_page.approval` is written with the approval, in
 * its transaction.
 */
export async function approveLearnPage(
  app: LearnApp, principal: AuthPrincipal, slug: string, approved: boolean, now: Date = new Date(), audit?: AuditContext,
): Promise<{ page: LearnPageMeta; savedAt: string }> {
  requireTeamReader(principal);
  if (!ownerOf(principal)) throw new ForbiddenError("Only the owner approves «Обучение»");
  await app.db.transaction(async (tx) => {
    const db = tx as unknown as LearnApp["db"];
    if (!(await setLearnPageApproval(db, { slug, approved, byUserId: principal.user.id, at: now }))) throw new NotFoundError("No such page");
    if (audit !== undefined) await recordAudit({ db }, { ...audit, eventType: "learn_page.approval", metadata: { slug, approved } });
  });
  const row = (await findLearnPage(app.db, slug))!;
  return { page: wire(row, now), savedAt: now.toISOString() };
}
