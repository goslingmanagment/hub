import argon2 from "argon2";
import { sql } from "drizzle-orm";

import {
  createPlatformPage,
  findPersonRowByCode,
  findUserByUsername,
  insertPersonLogin,
  insertPersonRow,
  setStaffingDay,
  type Database,
  type PersonRowRole,
} from "@agency_hub_core/db";

import { toBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { createAccountLinkForUserId } from "../account-links.ts";
import { createUserOrRefuseDuplicate } from "../auth.ts";
import { issueAgentKey, replaceAgentKey, updateAgentKeyPages } from "../agent-keys.ts";
import { AGENT_CAPABILITIES, joinLink, publicationContentSchema, type AgentCapability } from "@agency_hub_core/contracts";
import { recordCustomOrder } from "../custom-orders/index.ts";
import { ConflictError } from "../errors.ts";
import { approvePublications, createPublicationDraft } from "../publications.ts";
import { openMatter } from "@agency_hub_core/db";


/**
 * `sandbox:seed` — the test team on production (products plan 2026-11-13 §8; the wall: sandbox/realm.ts).
 *
 * ADDITIVE AND IDEMPOTENT. Every row it writes is findable later by the test marks: the model «Тест» (`is_test`), its
 * pages, the test people (`is_test`) and their logins, and rows hanging off those pages and logins (sales carry the
 * source `sandbox`). A second run adds what is missing and changes nothing that is there; a name taken by anything
 * live stops the run before it writes (`SandboxSeedRefused`). Nothing here deletes.
 *
 * Passwords come from the environment at run time (`SANDBOX_PASSWORD_T_OWNER`, `…_T_LEAD`, `…_T_CHAT_1`,
 * `…_T_CHAT_2`, `…_T_KM`), are never written to the repository and never printed. A login whose variable is not set keeps the
 * password it has (none on the first run: it cannot sign in until one is given).
 *
 * Scenarios write the INPUTS of a day «now» and let the ordinary jobs build the rest (shift rows, whose a sale is,
 * matters of the checks):
 *   shift    — two test chatters' activity minutes and messages with authors on both test pages, and sales of every
 *              kind the rule tells apart: an own PPV, a colleague's older PPV bought now, a tip in chat, a tip under a
 *              post, a subscription after a message, a sale nobody wrote for, sales before the shift began, one after
 *              the colleague's shift ended;
 *   customs  — custom orders on the steps the board of customs shows;
 *   matters  — what a team lead and a chatter find waiting;
 *   publications — posts on both test pages in the states «Публикации» shows (a draft with a finding, an approved one for
 *              tomorrow, one published yesterday, one whose outcome is unknown, a withdrawn one), with files of the test
 *              pages' own vault. Hub never hands a test page's post to a platform (publications.ts realm conditions).
 * Each is re-runnable for «now»: a run in another minute adds a new day's worth, the same minute adds nothing.
 *
 * Stand-in pages (`--stand-in <liveLabel…>`, 0435): a test page `test-<liveLabel>` of the test model standing in for a
 * live Fansly or OnlyFans page. The client bootstrap names the live page's platform account id on it (its Fansly proxy
 * is the live page's), so a test login's extension on the real site account binds to the stand-in. A stand-in stores
 * only the pulse and the board's own writes: what the extension reports of the real account (wallet sightings, send and
 * note attributions, captures) is accepted and dropped, and a test login reads nothing of a real fan. Every test person
 * who works gets the stand-ins, and `shift` writes its day on them.
 */

export const SANDBOX_MODEL = { slug: "test", name: "Тест" } as const;

export const SANDBOX_PAGES = [
  { label: "test-1", platform: "fansly" },
  { label: "test-of", platform: "onlyfans" },
] as const;

type LoginRole = "owner" | "team_lead" | "chatter" | "content_manager";

interface SandboxPersonSpec {
  code: string;
  displayName: string;
  role: PersonRowRole;
  state: "invited" | "working";
  /** The login, when the role has one today. `invited`: a login with no password, entered by an invitation link. */
  login: { username: string; role: LoginRole; invited?: true; passwordEnv?: string } | null;
  /** Works (and opens) both test pages. */
  works: boolean;
  /** Hands the shift in on the board («Сдаёт смену доской»), from a day before the seed's «now». */
  board?: true;
}

export const SANDBOX_PEOPLE: readonly SandboxPersonSpec[] = [
  { code: "t-owner", displayName: "Тест: владелец", role: "owner", state: "working", works: false,
    login: { username: "t-owner", role: "owner", passwordEnv: "SANDBOX_PASSWORD_T_OWNER" } },
  { code: "t-lead", displayName: "Тест: тимлид", role: "team_lead", state: "working", works: true,
    login: { username: "t-lead", role: "team_lead", passwordEnv: "SANDBOX_PASSWORD_T_LEAD" } },
  { code: "t-chat-1", displayName: "Тест: чаттер 1", role: "chatter", state: "working", works: true, board: true,
    login: { username: "t-chat-1", role: "chatter", passwordEnv: "SANDBOX_PASSWORD_T_CHAT_1" } },
  { code: "t-chat-2", displayName: "Тест: чаттер 2", role: "chatter", state: "working", works: true, board: true,
    login: { username: "t-chat-2", role: "chatter", passwordEnv: "SANDBOX_PASSWORD_T_CHAT_2" } },
  { code: "t-new", displayName: "Тест: новичок", role: "chatter", state: "invited", works: true,
    login: { username: "t-new", role: "chatter", invited: true } },
  // The content manager's login opens ContentOps alone (content-manager-operations.ts); its models are the test one.
  { code: "t-km", displayName: "Тест: КМ", role: "content_manager", state: "working", works: true,
    login: { username: "t-km", role: "content_manager", passwordEnv: "SANDBOX_PASSWORD_T_KM" } },
];

/**
 * The test team's checker: an AGENT of the test realm (it plays Gengar on the test team) with one key granted the test
 * pages only. Reads the team and, once the board's capability exists, reviews shift reports. Its key's value is minted
 * and printed only on `--print-checker-key` (a second time: the live key is replaced, the old one ends in 24 hours).
 * Without `review:shift_reports` in this build, add it later:
 *   cli.js agent-keys:capabilities sandbox-checker --add review:shift_reports --owner-user-id <owner> --note "test team"
 */
export const SANDBOX_CHECKER = { code: "sandbox-checker", displayName: "Тест: проверяющий агент", keyName: "sandbox-checker" } as const;
const CHECKER_CAPABILITIES = ["read:team", "read:money", "review:shift_reports"] as const;

/** The checker's capabilities this build knows (`review:shift_reports` comes with the board). */
export function sandboxCheckerCapabilities(): AgentCapability[] {
  return CHECKER_CAPABILITIES.filter((one) => (AGENT_CAPABILITIES as readonly string[]).includes(one)) as AgentCapability[];
}

export const SANDBOX_SCENARIOS = ["shift", "customs", "matters", "publications"] as const;
export type SandboxScenario = (typeof SANDBOX_SCENARIOS)[number];

/** Provenance of every sale the seed writes (0414). */
export const SANDBOX_TRANSACTION_SOURCE = "sandbox";

export class SandboxSeedRefused extends Error {}

export interface SandboxSeedInput {
  scenarios: readonly SandboxScenario[];
  /** Mint a fresh invitation link of `t-new` and answer it (for the coordinator only). */
  /**
   * Mint a fresh link of a test login and answer it (for the coordinator only): `true` — `t-new`'s invitation, as
   * before; a code (`t-km`) — that test person's login: an invitation while it has no password, else a new
   * password's link. It opens where Hub «Люди» would send that login (`joinLink`: ContentOps for a content manager).
   */
  printInvite?: boolean | string;
  /** Mint the checker's key (replacing its live one) and answer its value once (for the coordinator only). */
  printCheckerKey?: boolean;
  /** Live pages (by label) to make a stand-in for (0435): `test-<label>`, once each. */
  standIn?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

/** A stand-in page of the test model and the live page it stands in for. */
export interface SandboxStandIn {
  label: string;
  id: number;
  platform: "fansly" | "onlyfans";
  created: boolean;
  standsInFor: { label: string; id: number };
}

export interface SandboxSeedResult {
  model: { id: number; created: boolean };
  pages: Array<{ label: string; id: number; created: boolean }>;
  /** Every stand-in page of the test model (this run's and earlier ones). */
  standIns: SandboxStandIn[];
  people: Array<{ code: string; personId: number; created: boolean; login: string | null; passwordSet: boolean }>;
  scenarios: Record<string, Record<string, number>>;
  invite: string | null;
  checker: { personId: number; created: boolean; liveKey: boolean; capabilities: string[] };
  /** The checker key's value: only on `printCheckerKey`, this once. */
  checkerKey: string | null;
}

type Row = Record<string, unknown>;

async function rows(db: Database, query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute<Row>(query)).rows;
}

async function ensureModel(db: Database): Promise<{ id: number; created: boolean }> {
  const [found] = await rows(db, sql`select id, is_test from models where slug = ${SANDBOX_MODEL.slug}`);
  if (found) {
    if (found.is_test !== true) throw new SandboxSeedRefused(`A live model is called «${SANDBOX_MODEL.slug}»: nothing written`);
    return { id: Number(found.id), created: false };
  }
  const [created] = await rows(db, sql`
    insert into models (slug, name, sort_order, is_test)
    values (${SANDBOX_MODEL.slug}, ${SANDBOX_MODEL.name}, (select coalesce(max(sort_order), 0) + 10 from models), true)
    returning id`);
  return { id: Number(created!.id), created: true };
}

async function ensurePages(db: Database, modelId: number) {
  const result: SandboxSeedResult["pages"] = [];
  for (const spec of SANDBOX_PAGES) {
    const [found] = await rows(db, sql`select id, model_id from pages where label = ${spec.label}`);
    if (found) {
      if (Number(found.model_id) !== modelId) throw new SandboxSeedRefused(`A live page is called «${spec.label}»: nothing written`);
      result.push({ label: spec.label, id: Number(found.id), created: false });
      continue;
    }
    // No credentials, no egress endpoint, no OnlyFans API account: nothing ever syncs it (sandbox/realm.ts).
    const page = await createPlatformPage(db, { modelId, platform: spec.platform, label: spec.label });
    await db.execute(sql`update pages set display_name = ${`Тест ${spec.platform === "fansly" ? "Fansly" : "OnlyFans"}`},
      username = ${spec.label} where id = ${page.id}`);
    result.push({ label: spec.label, id: page.id, created: true });
  }
  return result;
}

/** The label of a live page's stand-in (0435). */
export function standInLabel(liveLabel: string): string {
  return `test-${liveLabel}`;
}

interface StandInTarget { id: number; label: string; platform: "fansly" | "onlyfans"; title: string }

/**
 * The live pages to make stand-ins for, read and checked before anything is written: each an active, not deleted live
 * page of Fansly or OnlyFans, whose stand-in label is free or already its own test stand-in, with no other stand-in.
 */
async function resolveStandInTargets(db: Database, liveLabels: readonly string[]): Promise<StandInTarget[]> {
  const out: StandInTarget[] = [];
  for (const liveLabel of new Set(liveLabels)) {
    const [page] = await rows(db, sql`select p.id, p.platform, p.display_name, p.status, p.deleted_at, m.is_test
      from pages p join models m on m.id = p.model_id where p.label = ${liveLabel}`);
    if (!page || page.status !== "active" || page.deleted_at !== null) throw new SandboxSeedRefused(`No live page «${liveLabel}»: nothing written`);
    if (page.is_test === true) throw new SandboxSeedRefused(`«${liveLabel}» is a test page, a stand-in stands in for a live one: nothing written`);
    if (page.platform !== "fansly" && page.platform !== "onlyfans") {
      throw new SandboxSeedRefused(`«${liveLabel}» is a ${String(page.platform)} page, only Fansly and OnlyFans pages get a stand-in: nothing written`);
    }
    const label = standInLabel(liveLabel);
    const [taken] = await rows(db, sql`select p.platform, p.stands_in_for_page_id, m.is_test from pages p join models m on m.id = p.model_id
      where p.label = ${label}`);
    if (taken && (taken.is_test !== true || taken.platform !== page.platform
      || (taken.stands_in_for_page_id !== null && Number(taken.stands_in_for_page_id) !== Number(page.id)))) {
      throw new SandboxSeedRefused(`A page called «${label}» is not the stand-in of «${liveLabel}»: nothing written`);
    }
    const [other] = await rows(db, sql`select label from pages where stands_in_for_page_id = ${page.id} and label <> ${label}`);
    if (other) throw new SandboxSeedRefused(`«${liveLabel}» already has the stand-in «${String(other.label)}»: nothing written`);
    const name = typeof page.display_name === "string" && page.display_name.trim() !== "" ? page.display_name.trim() : liveLabel;
    out.push({ id: Number(page.id), label: liveLabel, platform: page.platform, title: `${name} (тест)` });
  }
  return out;
}

/**
 * The stand-ins asked for, made where missing (a page of the test model; a page there already keeps its name), then
 * every stand-in of the test model. Only the live page's account id, platform and name reach the stand-in.
 */
async function ensureStandIns(db: Database, modelId: number, targets: readonly StandInTarget[]): Promise<SandboxStandIn[]> {
  const created = new Set<number>();
  for (const target of targets) {
    const label = standInLabel(target.label);
    const [found] = await rows(db, sql`select id from pages where label = ${label}`);
    if (found) {
      await db.execute(sql`update pages set stands_in_for_page_id = ${target.id} where id = ${Number(found.id)} and stands_in_for_page_id is null`);
      continue;
    }
    // No credentials, no egress endpoint, no platform account id of its own: nothing ever syncs it (sandbox/realm.ts).
    const page = await createPlatformPage(db, { modelId, platform: target.platform, label });
    await db.execute(sql`update pages set display_name = ${target.title}, username = ${label}, stands_in_for_page_id = ${target.id}
      where id = ${page.id}`);
    created.add(page.id);
  }
  const list = await rows(db, sql`select p.id, p.label, p.platform, t.id as target_id, t.label as target_label
    from pages p join pages t on t.id = p.stands_in_for_page_id
    where p.model_id = ${modelId} and p.status = 'active' and p.deleted_at is null order by p.id`);
  return list.map((row) => ({
    label: String(row.label), id: Number(row.id), platform: row.platform === "onlyfans" ? "onlyfans" : "fansly", created: created.has(Number(row.id)),
    standsInFor: { label: String(row.target_label), id: Number(row.target_id) },
  }));
}

/** Adds pages to a person's working pages after those they have, in order; a page they work already stays as it is. */
async function addWorkingPages(db: Database, personId: number, pageIds: readonly number[]) {
  if (pageIds.length === 0) return;
  await db.execute(sql`
    insert into person_working_pages (person_id, page_id, position)
    select ${personId}, listed.page_id,
      ((select coalesce(max(w.position), -1) from person_working_pages w where w.person_id = ${personId})
        + row_number() over (order by listed.ordinality))::smallint
    from unnest(${sql.param(pageIds.map(String))}::bigint[]) with ordinality as listed(page_id, ordinality)
    where not exists (select 1 from person_working_pages w where w.person_id = ${personId} and w.page_id = listed.page_id)`);
}

/** Refuses before anything is written when a name of the test team is taken by something live. */
async function assertNamesFree(db: Database) {
  for (const spec of SANDBOX_PEOPLE) {
    const person = await findPersonRowByCode(db, spec.code);
    if (person !== null && !person.isTest) throw new SandboxSeedRefused(`A live person has the code «${spec.code}»: nothing written`);
    if (spec.login === null) continue;
    const user = await findUserByUsername(db, spec.login.username);
    if (!user) continue;
    const [link] = await rows(db, sql`select pe.is_test from person_logins pl join people pe on pe.id = pl.person_id where pl.user_id = ${user.id}`);
    if (link?.is_test !== true) throw new SandboxSeedRefused(`A live login is called «${spec.login.username}»: nothing written`);
  }
  const [model] = await rows(db, sql`select is_test from models where slug = ${SANDBOX_MODEL.slug}`);
  if (model && model.is_test !== true) throw new SandboxSeedRefused(`A live model is called «${SANDBOX_MODEL.slug}»: nothing written`);
  for (const spec of SANDBOX_PAGES) {
    const [page] = await rows(db, sql`select m.is_test from pages p join models m on m.id = p.model_id where p.label = ${spec.label}`);
    if (page && page.is_test !== true) throw new SandboxSeedRefused(`A live page is called «${spec.label}»: nothing written`);
  }
}

async function ensurePerson(
  db: Database,
  spec: SandboxPersonSpec,
  pages: { all: readonly number[]; standIns: readonly number[] },
  env: NodeJS.ProcessEnv,
  now: Date,
) {
  const pageIds = pages.all;
  let person = await findPersonRowByCode(db, spec.code);
  const created = person === null;
  if (person === null) {
    // Born test (0414: the mark is fixed at birth). No Telegram: the database refuses one.
    person = await insertPersonRow(db, {
      code: spec.code, displayName: spec.displayName, kind: "human", role: spec.role, state: spec.state, leftOn: null,
      telegramUserId: null, telegramHandle: null, reportTag: null, onboarding: [], note: "Тестовая команда (sandbox:seed)",
      importNotes: [], origin: "owner", createdByUserId: null, isTest: true,
    });
  }
  let login: string | null = null;
  let passwordSet = false;
  if (spec.login !== null) {
    let user = await findUserByUsername(db, spec.login.username);
    if (!user) {
      const createdUser = await createUserOrRefuseDuplicate(db, { username: spec.login.username, role: spec.login.role, passwordHash: null });
      user = await findUserByUsername(db, createdUser.username);
    }
    // The person first, then the pages: the database checks a login's pages against its person's realm.
    const [linked] = await rows(db, sql`select person_id from person_logins where user_id = ${user!.id}`);
    if (!linked) await insertPersonLogin(db, { personId: person.id, userId: user!.id, linkedByUserId: null });
    if (spec.works) {
      for (const pageId of pageIds) {
        await db.execute(sql`insert into user_page_assignments (user_id, platform_account_id) values (${user!.id}, ${pageId})
          on conflict (user_id, platform_account_id) do nothing`);
      }
    }
    const password = spec.login.passwordEnv === undefined ? undefined : env[spec.login.passwordEnv];
    if (password !== undefined && password.length > 0) {
      const hash = await argon2.hash(password, { type: argon2.argon2id });
      await db.execute(sql`update users set password_hash = ${hash}, updated_at = now() where id = ${user!.id}`);
      passwordSet = true;
    }
    login = spec.login.username;
  }
  if (spec.works) {
    // A person with no working page gets every test page; one with some keeps them and gets the stand-ins they lack.
    const [has] = await rows(db, sql`select count(*)::int as n from person_working_pages where person_id = ${person.id}`);
    await addWorkingPages(db, person.id, Number(has?.n ?? 0) === 0 ? pageIds : pages.standIns);
  }
  if (spec.board) {
    // A shift is on the board only when the right was granted before it began (shift-report-board-view.ts), and the
    // scenarios' shifts begin hours before «now»: the right is dated a day back, and a later grant is moved back to it.
    const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    await db.execute(sql`insert into person_rights (person_id, "right", granted_at) values (${person.id}, 'submits_shift', ${since}::timestamptz)
      on conflict (person_id, "right") do update set granted_at = least(person_rights.granted_at, excluded.granted_at)`);
  }
  return { code: spec.code, personId: person.id, created, login, passwordSet };
}

// ── scenarios ───────────────────────────────────────────────────────────────

const MINUTE = 60_000;

/** Fans of the test pages: ids no live account can have (Fansly's are 18 digits, OnlyFans' far fewer than 12). */
function fanRef(platform: "fansly" | "onlyfans", n: number): string {
  return platform === "fansly" ? `9990000000000000${String(n).padStart(3, "0")}` : `99900000${String(n).padStart(4, "0")}`;
}

async function ensureFan(db: Database, platform: "fansly" | "onlyfans", n: number, pageId: number): Promise<{ id: number; ref: string }> {
  const ref = fanRef(platform, n);
  const [found] = await rows(db, sql`select id from fans where platform = ${platform} and platform_user_id = ${ref}`);
  let id: number;
  if (found) {
    id = Number(found.id);
    // A fan the seed did not make (one of a live page) is never touched.
    const [live] = await rows(db, sql`select 1 as x from page_fans pf join pages p on p.id = pf.platform_account_id
      join models m on m.id = p.model_id where pf.fan_id = ${id} and not m.is_test limit 1`);
    if (live) throw new SandboxSeedRefused(`Fan ${ref} is a live page's: nothing written`);
  } else {
    const [created] = await rows(db, sql`insert into fans (platform, platform_user_id, username, display_name)
      values (${platform}, ${ref}, ${`sbx_fan_${n}`}, ${`Тестовый фан ${n}`}) returning id`);
    id = Number(created!.id);
  }
  await db.execute(sql`insert into page_fans (fan_id, platform_account_id) values (${id}, ${pageId})
    on conflict do nothing`);
  return { id, ref };
}

interface ShiftContext {
  db: Database;
  stamp: string;
  now: number;
}

async function addMinutes(context: ShiftContext, userId: number, pageIds: readonly number[], from: number, to: number) {
  await context.db.execute(sql`
    insert into chatter_activity_minutes (user_id, page_id, minute, input)
    select ${userId}, page_id, minute, true
    from unnest(${sql.param(pageIds.map(String))}::bigint[]) as page_id,
      generate_series(date_trunc('minute', ${new Date(from).toISOString()}::timestamptz),
                      date_trunc('minute', ${new Date(to).toISOString()}::timestamptz), interval '1 minute') as minute
    on conflict (user_id, page_id, minute) do update set input = true`);
  await context.db.execute(sql`
    insert into chatter_activity_instances (user_id, instance_id, last_beat_at, closed_at)
    values (${userId}, ${`sandbox-${userId}`}, ${new Date(to).toISOString()}::timestamptz,
      ${to < context.now - 10 * MINUTE ? new Date(to).toISOString() : null}::timestamptz)
    on conflict (user_id, instance_id) do update set last_beat_at = greatest(chatter_activity_instances.last_beat_at, excluded.last_beat_at),
      closed_at = excluded.closed_at`);
}

/** A message with its author (the extension's attribution), and its archive copy. */
async function addMessage(
  context: ShiftContext,
  input: { userId: number; pageId: number; platform: "fansly" | "onlyfans"; fan: { ref: string }; at: number; ref: string; priced?: boolean },
) {
  await context.db.execute(sql`
    insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id, source,
      priced, with_media, observed_at, recorded_at, client_version)
    values (${input.platform}, ${input.pageId}, ${input.ref}, ${input.fan.ref}, ${input.fan.ref}, ${input.userId},
      ${input.platform === "fansly" ? "fansly-extension" : "chatspace-extension"},
      ${input.priced === true}, ${input.priced === true}, ${new Date(input.at).toISOString()}::timestamptz, now(), 'sandbox')
    on conflict do nothing`);
  await context.db.execute(sql`
    insert into message_archive (account_id, platform, conversation_ref, message_ref, fan_native_id, sender_role, is_sent_by_me,
      occurred_at, text_plain, price_mills, backfill_source)
    select ${input.pageId}, ${input.platform}, ${input.fan.ref}, ${input.ref}, ${input.fan.ref}, 'creator', true,
      ${new Date(input.at).toISOString()}::timestamptz, 'Тестовое сообщение', ${input.priced === true ? 12_000 : null}, 'sandbox'
    where not exists (select 1 from message_archive where account_id = ${input.pageId} and platform = ${input.platform}
      and message_ref = ${input.ref})`);
}

async function addSale(
  context: ShiftContext,
  input: { pageId: number; fan: { id: number }; kind: "tip" | "message_purchase" | "subscription"; dollars: number; at: number; ref: string; correlationId?: string },
) {
  const mills = BigInt(input.dollars * 1000);
  const net = (mills * 80n) / 100n;
  await context.db.execute(sql`
    insert into transactions (platform_account_id, fan_id, transaction_id, correlation_id, raw_type, canonical_type, transaction_state,
      raw_status, gross_amount_mills, source_destination_amount_mills, creator_net_amount_mills, occurred_at, source, is_active)
    values (${input.pageId}, ${input.fan.id}, ${input.ref}, ${input.correlationId ?? null}, ${`sandbox:${input.kind}`},
      ${input.kind}::transaction_type, 'posted'::transaction_state, 'posted', ${mills}, ${mills}, ${net},
      ${new Date(input.at).toISOString()}::timestamptz, ${SANDBOX_TRANSACTION_SOURCE}, true)
    on conflict (platform_account_id, transaction_id) do nothing`);
}

async function addPpvOffer(
  context: ShiftContext,
  input: { pageId: number; fan: { ref: string }; messageRef: string; offerRef: string; at: number },
) {
  await context.db.execute(sql`
    insert into message_media_offers (page_id, platform, message_ref, offer_ordinal, media_offer_ref, conversation_ref,
      fan_platform_user_id, message_created_at, price_mills, first_observed_at, last_observed_at, content_hash, source_event_id,
      source_observation_id, source_account_seq)
    values (${input.pageId}, 'fansly', ${input.messageRef}, 0, ${input.offerRef}, ${input.fan.ref}, ${input.fan.ref},
      ${new Date(input.at).toISOString()}::timestamptz, 12000, now(), now(), repeat('0', 64), 0, 0, 1)
    on conflict do nothing`);
}

/** A run's stamp: the minute of «now» (the same minute adds nothing twice). */
function stampOf(now: Date): string {
  return now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
}

/**
 * A fresh link of the named test person's login, as Hub «Люди» would give it: an invitation while the login has no
 * password, else «Сбросить пароль ссылкой»'s kind; opened where that login's role opens (`joinLink`, the one rule).
 * `SANDBOX_JOIN_ORIGIN` replaces the chatters' site (a stand), never ContentOps. Only a test login: anything else
 * is refused before a link is made.
 */
async function mintTestLink(app: AppContext, code: string, env: NodeJS.ProcessEnv): Promise<string> {
  const [row] = await rows(app.db, sql`select u.id, u.role, u.password_hash is not null as has_password
    from people pe join person_logins pl on pl.person_id = pe.id join users u on u.id = pl.user_id
    where pe.code = ${code} and pe.is_test and u.disabled_at is null and u.deleted_at is null
    order by u.id limit 1`);
  if (!row) throw new SandboxSeedRefused(`«${code}» is not a login of the test team: no link made`);
  const kind = row.has_password === true ? "password_reset" as const : "invite" as const;
  const link = await createAccountLinkForUserId(app, { userId: Number(row.id), kind, expiresInHours: 72 }, { source: "cli" });
  return joinLink(link.token, String(row.role), env.SANDBOX_JOIN_ORIGIN);
}

async function testLogin(db: Database, username: string): Promise<number> {
  const [row] = await rows(db, sql`select u.id from users u join person_logins pl on pl.user_id = u.id
    join people pe on pe.id = pl.person_id where u.username = ${username} and pe.is_test`);
  if (!row) throw new SandboxSeedRefused(`The test login «${username}» is missing: run the seed without a scenario first`);
  return Number(row.id);
}

/**
 * The pairs of pages `shift` writes its day on: the two fixed test pages; or, once the test model has stand-ins, the
 * stand-ins, Fansly with OnlyFans by index (the shorter list wraps around; a platform with no stand-in takes its fixed
 * test page), one day's set per pair.
 */
function shiftPairs(pages: SandboxSeedResult["pages"], standIns: readonly SandboxStandIn[]): Array<{ fansly: number; onlyfans: number }> {
  const fixed = { fansly: pages.find((page) => page.label === "test-1")!.id, onlyfans: pages.find((page) => page.label === "test-of")!.id };
  const fansly = standIns.filter((page) => page.platform === "fansly").map((page) => page.id);
  const onlyfans = standIns.filter((page) => page.platform === "onlyfans").map((page) => page.id);
  if (fansly.length === 0 && onlyfans.length === 0) return [fixed];
  return Array.from({ length: Math.max(fansly.length, onlyfans.length) }, (_, index) => ({
    fansly: fansly.length === 0 ? fixed.fansly : fansly[index % fansly.length]!,
    onlyfans: onlyfans.length === 0 ? fixed.onlyfans : onlyfans[index % onlyfans.length]!,
  }));
}

async function seedShift(db: Database, pages: SandboxSeedResult["pages"], standIns: readonly SandboxStandIn[], now: Date): Promise<Record<string, number>> {
  const context: ShiftContext = { db, stamp: stampOf(now), now: now.getTime() };
  const chat1 = await testLogin(db, "t-chat-1");
  const chat2 = await testLogin(db, "t-chat-2");
  // Platform refs are digits (the archive's checks): 9, the run's minute, a number per name. A page's own refs never
  // meet another page's, and Fansly's own are 18 digits below 9·10^17. One map for the run: a pair's names carry its
  // number (the first pair's none, as before stand-ins), so two pairs sharing a page never repeat a ref.
  const names = new Map<string, number>();
  let messages = 0;
  let sales = 0;
  for (const [index, pair] of shiftPairs(pages, standIns).entries()) {
    const ref = (what: string) => {
      const name = index === 0 ? what : `${index}:${what}`;
      if (!names.has(name)) names.set(name, names.size + 1);
      return `9${context.stamp}${String(names.get(name)).padStart(5, "0")}`;
    };
    const day = await seedShiftDay(context, pair, { chat1, chat2 }, ref);
    messages += day.messages;
    sales += day.sales;
  }
  return { messages, sales };
}

/** One day's set of `shift` on a Fansly page and an OnlyFans page. */
async function seedShiftDay(
  context: ShiftContext,
  pages: { fansly: number; onlyfans: number },
  logins: { chat1: number; chat2: number },
  ref: (what: string) => string,
): Promise<{ messages: number; sales: number }> {
  const { db } = context;
  const { fansly, onlyfans } = pages;
  const { chat1, chat2 } = logins;
  const n = context.now;
  // Twelve fans a page; the ids are the run's, so a later run talks to the same fans.
  const fFans = await Promise.all(Array.from({ length: 12 }, (_, index) => ensureFan(db, "fansly", index + 1, fansly)));
  const oFans = await Promise.all(Array.from({ length: 6 }, (_, index) => ensureFan(db, "onlyfans", index + 1, onlyfans)));

  // t-chat-2: the colleague's shift, 7 to 4 hours ago, closed. t-chat-1: from 3 hours ago, going on now.
  const colleague = { from: n - 7 * 60 * MINUTE, to: n - 4 * 60 * MINUTE };
  const own = { from: n - 3 * 60 * MINUTE, to: n };
  await addMinutes(context, chat2, [fansly, onlyfans], colleague.from, colleague.to);
  await addMinutes(context, chat1, [fansly, onlyfans], own.from, own.to);
  let messages = 0;
  for (const [userId, span] of [[chat2, colleague], [chat1, own]] as const) {
    for (let at = span.from + 2 * MINUTE, index = 0; at < span.to - MINUTE; at += 2 * MINUTE, index += 1) {
      const onFansly = index % 3 !== 2;
      const fan = onFansly ? fFans[index % 8]! : oFans[index % 4]!;
      await addMessage(context, {
        userId, pageId: onFansly ? fansly : onlyfans, platform: onFansly ? "fansly" : "onlyfans", fan, at,
        ref: ref(`m-${userId}-${index}`),
      });
      messages += 1;
    }
  }

  // The sales, each of a kind the rule tells apart (sale-rule.ts).
  const sales: Array<Parameters<typeof addSale>[1]> = [];
  // An own PPV: t-chat-1 sent it 40 minutes ago, fan 9 bought it 15 minutes ago.
  await addMessage(context, { userId: chat1, pageId: fansly, platform: "fansly", fan: fFans[8]!, at: n - 40 * MINUTE, ref: ref("ppv-own"), priced: true });
  await addPpvOffer(context, { pageId: fansly, fan: fFans[8]!, messageRef: ref("ppv-own"), offerRef: ref("offer-own"), at: n - 40 * MINUTE });
  sales.push({ pageId: fansly, fan: fFans[8]!, kind: "message_purchase", dollars: 25, at: n - 15 * MINUTE, ref: ref("t-ppv-own"), correlationId: ref("offer-own") });
  // A colleague's older PPV bought now: t-chat-2 sent it 5 hours ago, fan 10 bought it 10 minutes ago.
  await addMessage(context, { userId: chat2, pageId: fansly, platform: "fansly", fan: fFans[9]!, at: n - 5 * 60 * MINUTE, ref: ref("ppv-old"), priced: true });
  await addPpvOffer(context, { pageId: fansly, fan: fFans[9]!, messageRef: ref("ppv-old"), offerRef: ref("offer-old"), at: n - 5 * 60 * MINUTE });
  sales.push({ pageId: fansly, fan: fFans[9]!, kind: "message_purchase", dollars: 40, at: n - 10 * MINUTE, ref: ref("t-ppv-old"), correlationId: ref("offer-old") });
  // A tip in chat: t-chat-1 wrote to fan 1 (above), the fan tips.
  sales.push({ pageId: fansly, fan: fFans[0]!, kind: "tip", dollars: 15, at: n - 30 * MINUTE, ref: ref("t-tip-chat") });
  // A tip under a post: the post's tip (creator_post_tips) by fan 11.
  await db.execute(sql`
    insert into creator_post_tips (account_id, platform, platform_post_id, platform_tip_id, tip_sender_platform_user_id,
      post_tip_amount_mills, occurred_at, first_observed_at, last_observed_at, content_hash, source_event_id, source_observation_id,
      source_account_seq)
    values (${fansly}, 'fansly', ${ref("post")}, ${ref("post-tip")}, ${fFans[10]!.ref}, 10000,
      ${new Date(n - 50 * MINUTE).toISOString()}::timestamptz, now(), now(), repeat('0', 64), 0, 0, 1)
    on conflict do nothing`);
  sales.push({ pageId: fansly, fan: fFans[10]!, kind: "tip", dollars: 10, at: n - 50 * MINUTE, ref: ref("t-tip-post"), correlationId: ref("post-tip") });
  // A subscription after a message: t-chat-1 wrote to OnlyFans fan 5, who subscribes.
  await addMessage(context, { userId: chat1, pageId: onlyfans, platform: "onlyfans", fan: oFans[4]!, at: n - 25 * MINUTE, ref: ref("sub-msg") });
  sales.push({ pageId: onlyfans, fan: oFans[4]!, kind: "subscription", dollars: 10, at: n - 20 * MINUTE, ref: ref("t-sub") });
  // A sale nobody wrote for: fan 12 tips with no message to them.
  sales.push({ pageId: fansly, fan: fFans[11]!, kind: "tip", dollars: 5, at: n - 35 * MINUTE, ref: ref("t-nobody") });
  // Sales before t-chat-1's shift began (in the colleague's): a tip in chat and an OnlyFans tip.
  sales.push({ pageId: fansly, fan: fFans[1]!, kind: "tip", dollars: 20, at: n - 5 * 60 * MINUTE - 20 * MINUTE, ref: ref("t-before-1") });
  sales.push({ pageId: onlyfans, fan: oFans[2]!, kind: "tip", dollars: 30, at: n - 6 * 60 * MINUTE, ref: ref("t-before-2") });
  // One after the colleague's shift ended (and before t-chat-1's began).
  sales.push({ pageId: fansly, fan: fFans[3]!, kind: "tip", dollars: 7, at: n - 3 * 60 * MINUTE - 30 * MINUTE, ref: ref("t-after") });
  for (const sale of sales) await addSale(context, sale);
  return { messages, sales: sales.length };
}

async function seedCustoms(app: AppContext, pages: SandboxSeedResult["pages"], now: Date): Promise<Record<string, number>> {
  const db = app.db;
  const fansly = pages.find((page) => page.label === "test-1")!.id;
  const chat1 = await testLogin(db, "t-chat-1");
  const stamp = stampOf(now);
  const [done] = await rows(db, sql`select count(*)::int as n from custom_orders where page_id = ${fansly} and source_text = ${`sandbox ${stamp}`}`);
  if (Number(done?.n ?? 0) > 0) return { orders: 0 };
  const fans = await Promise.all([1, 2, 3, 4].map((n) => ensureFan(db, "fansly", n, fansly)));
  // A recorded order, a paid one, one at the model and one shot: the steps of the board.
  const states = ["recorded", "paid", "at_model", "shot"] as const;
  let orders = 0;
  for (const [index, state] of states.entries()) {
    let payment: number | null = null;
    if (state !== "recorded") {
      const saleRef = `9${stamp}${String(90_000 + index)}`;
      await addSale({ db, stamp, now: now.getTime() }, {
        pageId: fansly, fan: fans[index]!, kind: "tip", dollars: 50 + index * 10, at: now.getTime() - (index + 1) * 60 * MINUTE, ref: saleRef,
      });
      const [sale] = await rows(db, sql`select id from transactions where platform_account_id = ${fansly} and transaction_id = ${saleRef}`);
      payment = Number(sale!.id);
    }
    await recordCustomOrder(app, {
      pageId: fansly, fanId: fans[index]!.id, buyer: null, conversationRef: null,
      card: { task: `Тестовый кастом ${index + 1}`, price: `${50 + index * 10}$`, duration: "3 минуты" },
      deadlineOn: null, acceptedByUserId: chat1, origin: "workboard", sourceText: `sandbox ${stamp}`,
      state, paymentTransactionId: payment, actor: { door: "workboard", userId: chat1 }, now,
    });
    orders += 1;
  }
  return { orders };
}

async function seedMatters(db: Database, pages: SandboxSeedResult["pages"], now: Date): Promise<Record<string, number>> {
  const lead = await testLogin(db, "t-lead");
  const chat1 = await testLogin(db, "t-chat-1");
  const pageIds = pages.map((page) => page.id);
  const stamp = stampOf(now);
  const opened = [
    { kind: "sale.sandbox", owner: lead, title: "Тест: чаттер спрашивает, чья продажа", link: "/workboard/" },
    { kind: "shift.report.sandbox", owner: chat1, title: "Тест: подтвердите отчёт смены", link: "/workboard/" },
  ];
  for (const matter of opened) {
    await openMatter(db, {
      key: `${matter.kind}:${stamp}`, kind: matter.kind, source: "server", title: matter.title, object: null, pageIds,
      owner: { userId: matter.owner }, watcherUserIds: [], money: false, evidence: { sandbox: true }, link: matter.link,
    }, { door: "system" }, now);
  }
  return { matters: opened.length };
}

const APPROVABLE_DRAFT = "Тест: ждёт утверждения";

/**
 * Two drafts with no finding in the way — one on each test page — so «Утвердить» and the feed's «Утвердить выбранные»
 * have something to take. Kept waiting, not dated: a run adds the pair whenever none of them is a draft any more
 * (approved or cancelled in a walk), whatever the day. The Fansly one carries a file of this run's own (a file posted
 * again within the page's threshold would wait for a person's word); the OnlyFans one is text alone.
 */
async function seedApprovableDrafts(db: AppContext["db"], pages: SandboxSeedResult["pages"], km: number, now: Date): Promise<number> {
  const fansly = pages.find((page) => page.label === "test-1")!.id;
  const onlyfans = pages.find((page) => page.label === "test-of")!.id;
  const [waiting] = await rows(db, sql`
    select count(*)::int as n from publications
     where page_id in (${fansly}, ${onlyfans}) and status = 'draft' and text like ${`${APPROVABLE_DRAFT}%`}`);
  if (Number(waiting?.n ?? 0) > 0) return 0;
  const ref = `sandbox-test-1-${stampOf(now)}-m4`;
  await db.execute(sql`
    insert into creator_raw_media (page_id, platform, media_ref, source_kind, first_origin, first_observed_at,
                                   last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
    select ${fansly}, 'fansly', ${ref}, 'vault_media', 'vault', ${now}, ${now}, ${"0".repeat(64)}, 1, 1, 1
     where not exists (select 1 from creator_raw_media where page_id = ${fansly} and media_ref = ${ref})`);
  const dayStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const posts = [
    { pageId: fansly, text: `${APPROVABLE_DRAFT}`, hourUtc: 13, media: [ref] },
    { pageId: onlyfans, text: `${APPROVABLE_DRAFT}, без файлов`, hourUtc: 14, media: [] as string[] },
  ];
  for (const post of posts) {
    const made = await createPublicationDraft(db, {
      pageId: post.pageId, author: { kind: "human" as const, userId: km }, idempotencyKey: null, now,
      body: publicationContentSchema.parse({
        kind: "subscriber_post", text: post.text, media: post.media.map((mediaRef) => ({ source: "vault", mediaRef })),
        publishAt: new Date(dayStart + 2 * 24 * 60 * MINUTE + post.hourUtc * 60 * MINUTE).toISOString(),
      }),
    });
    const blocking = made.findings.filter((one) => one.severity === "blocking");
    if (blocking.length > 0) throw new SandboxSeedRefused(`A test draft meant to be approvable has a finding in the way: ${blocking.map((one) => one.code).join(", ")}`);
  }
  return posts.length;
}

/**
 * Posts of the test pages in every state the feed tells apart. A draft is made by Hub's own draft (its checks run), an
 * approval by Hub's own approval (as the test content manager); the states only a platform's answer gives (published,
 * unknown, withdrawn) are written directly with a journal row by «Hub». The test pages' vault holds three files the
 * seed names, so the posts show files. Once per UTC day: a second run that day adds nothing — except the pair of
 * drafts a person can approve (`seedApprovableDrafts`), which every run keeps waiting.
 */
async function seedPublications(app: AppContext, pages: SandboxSeedResult["pages"], now: Date): Promise<Record<string, number>> {
  const db = app.db;
  const km = await testLogin(db, "t-km");
  const stamp = stampOf(now);
  const mark = `sandbox ${stamp}`;
  // Once per UTC day of «now», whatever the minute: a second run that day (a retry on production, the test's second
  // call across a minute's edge) adds nothing. Every run marks its journal rows `sandbox <minute>` at «now», so a run
  // of any minute of the day is seen, earlier marks included. A later day adds one fresh set: its posts are dated
  // from that day («tomorrow», «yesterday»); nothing is deleted.
  const dayStart = new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * MINUTE);
  const [done] = await rows(db, sql`
    select count(*)::int as n from publication_status_events
     where reason like 'sandbox %' and at >= ${dayStart} and at < ${dayEnd}`);
  const fansly = pages.find((page) => page.label === "test-1")!.id;
  const onlyfans = pages.find((page) => page.label === "test-of")!.id;
  // The Fansly test page's one wall, as Fansly would name it: a post goes to the default wall.
  await db.execute(sql`
    insert into page_walls (page_id, platform, wall_ref, name, default_wall, main_wall, first_observed_at, last_observed_at,
                            content_hash, source_event_id, source_observation_id, source_account_seq)
    select ${fansly}, 'fansly', 'sandbox-wall', 'Posts', true, true, ${now}, ${now}, ${"0".repeat(64)}, 1, 1, 1
     where not exists (select 1 from page_walls where page_id = ${fansly})`);
  const waiting = await seedApprovableDrafts(db, pages, km, now);
  if (Number(done?.n ?? 0) > 0) return { publications: waiting };
  for (const page of pages.filter((one) => one.label === "test-1")) {
    const platform = "fansly";
    for (const n of [1, 2, 3]) {
      // Files of this run's own (a file posted again within the page's threshold would wait for a person's word).
      const ref = `sandbox-${page.label}-${stamp}-m${n}`;
      await db.execute(sql`
        insert into creator_raw_media (page_id, platform, media_ref, source_kind, first_origin, first_observed_at,
                                       last_observed_at, content_hash, source_event_id, source_observation_id, source_account_seq)
        select ${page.id}, ${platform}, ${ref}, 'vault_media', 'vault', ${now}, ${now}, ${"0".repeat(64)}, 1, 1, 1
         where not exists (select 1 from creator_raw_media where page_id = ${page.id} and media_ref = ${ref})`);
    }
  }
  const day = 24 * 60 * MINUTE;
  const author = { kind: "human" as const, userId: km };
  const at = (days: number, hourUtc: number) => new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) + days * day + hourUtc * 60 * MINUTE);
  const draft = (pageId: number, text: string, publishAt: Date, media: string[]) =>
    createPublicationDraft(db, {
      pageId, author, idempotencyKey: null, now,
      body: publicationContentSchema.parse({ kind: "subscriber_post", text, media: media.map((mediaRef) => ({ source: "vault", mediaRef })), publishAt: publishAt.toISOString() }),
    });
  const approve = async (made: { id: number; version: number; findings: ReadonlyArray<{ code: string; blocking?: boolean }> }) => {
    const [result] = await approvePublications(db, { items: [{ id: made.id, version: made.version }], userId: km, now });
    if (result?.outcome !== "approved") {
      throw new SandboxSeedRefused(`A test post was not approved: ${result?.reason ?? "no answer"} (${made.findings.map((one) => one.code).join(", ")})`);
    }
  };
  // A file the vault does not hold: the draft's check names it and approval waits.
  await draft(fansly, "Тест: пост с замечанием", at(1, 15), [`sandbox-test-1-${stamp}-m1`, "sandbox-not-in-vault"]);
  await approve(await draft(fansly, "Тест: утверждён на завтра", at(1, 17), [`sandbox-test-1-${stamp}-m2`]));
  const outcomes = [
    { pageId: onlyfans, label: "test-of", text: "Тест: вышел вчера", publishAt: at(-1, 16), status: "published", reason: null },
    { pageId: fansly, label: "test-1", text: "Тест: исход неизвестен", publishAt: at(-1, 18), status: "unknown", reason: "sandbox_unknown" },
    { pageId: onlyfans, label: "test-of", text: "Тест: снят с расписания", publishAt: at(2, 12), status: "withdrawn", reason: "withdrawn" },
  ] as const;
  for (const one of outcomes) {
    // The OnlyFans test page has no account at OnlyFansAPI, so no vault to name: its posts are text alone.
    const made = await draft(one.pageId, one.text, at(3, 12), one.label === "test-of" ? [] : [`sandbox-${one.label}-${stamp}-m3`]);
    await approve(made);
    // Only a platform's answer moves a post there; the test realm has none, so the seed writes the state with Hub's
    // journal row (its reason is the run's mark: the same minute adds nothing).
    await db.execute(sql`update publications set status = ${one.status}, status_reason = ${one.reason}, publish_at = ${one.publishAt},
                          status_changed_at = ${now}, version = version + 1, updated_at = ${now} where id = ${made.id}`);
    await db.execute(sql`insert into publication_status_events (publication_id, from_status, to_status, actor_kind, reason, at)
                          values (${made.id}, 'approved', ${one.status}, 'hub', ${mark}, ${now})`);
  }
  return { publications: waiting + 2 + outcomes.length };
}

/** Seeds the test team (and the scenarios asked for). Additive, idempotent; refuses before writing on a live name. */
export async function seedSandbox(app: AppContext, input: SandboxSeedInput): Promise<SandboxSeedResult> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  await assertNamesFree(app.db);
  const targets = await resolveStandInTargets(app.db, input.standIn ?? []);
  const result = await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await setStaffingDay(db, toBusinessDate(now));
    const model = await ensureModel(db);
    const pages = await ensurePages(db, model.id);
    const standIns = await ensureStandIns(db, model.id, targets);
    const pageIds = { all: [...pages, ...standIns].map((page) => page.id), standIns: standIns.map((page) => page.id) };
    const people = [];
    for (const spec of SANDBOX_PEOPLE) people.push(await ensurePerson(db, spec, pageIds, env, now));
    return { model, pages, standIns, people };
  });
  const scenarios: SandboxSeedResult["scenarios"] = {};
  for (const scenario of input.scenarios) {
    if (scenario === "shift") scenarios.shift = await seedShift(app.db, result.pages, result.standIns, now);
    if (scenario === "customs") scenarios.customs = await seedCustoms(app, result.pages, now);
    if (scenario === "matters") scenarios.matters = await seedMatters(app.db, result.pages, now);
    if (scenario === "publications") scenarios.publications = await seedPublications(app, result.pages, now);
  }
  const checker = await ensureChecker(app);
  const testPages = [...result.pages, ...result.standIns];
  await ensureCheckerPages(app, checker, testPages);
  let checkerKey: string | null = null;
  if (input.printCheckerKey === true) checkerKey = await mintCheckerKey(app, checker, testPages.map((page) => page.label));
  let invite: string | null = null;
  if (input.printInvite !== undefined && input.printInvite !== false) {
    invite = await mintTestLink(app, input.printInvite === true ? "t-new" : input.printInvite, env);
  }
  const live = await liveCheckerKey(app.db, checker.personId);
  return {
    ...result, scenarios, invite, checkerKey,
    checker: { personId: checker.personId, created: checker.created, liveKey: live !== null, capabilities: live?.capabilities ?? [] },
  };
}

async function ensureChecker(app: AppContext): Promise<{ personId: number; created: boolean }> {
  const found = await findPersonRowByCode(app.db, SANDBOX_CHECKER.code);
  let personId: number;
  let created = false;
  if (found !== null) {
    if (!found.isTest) throw new SandboxSeedRefused(`A live person has the code «${SANDBOX_CHECKER.code}»: nothing written`);
    personId = found.id;
  } else {
    const person = await insertPersonRow(app.db, {
      code: SANDBOX_CHECKER.code, displayName: SANDBOX_CHECKER.displayName, kind: "agent", role: "agent", state: "working",
      leftOn: null, telegramUserId: null, telegramHandle: null, reportTag: null, onboarding: [],
      note: "Тестовая команда (sandbox:seed): играет Генгара", importNotes: [], origin: "owner", createdByUserId: null, isTest: true,
    });
    personId = person.id;
    created = true;
  }
  await app.db.execute(sql`insert into person_rights (person_id, "right") values (${personId}, 'reviews_shift_reports') on conflict do nothing`);
  return { personId, created };
}

async function liveCheckerKey(db: Database, personId: number): Promise<{ id: number; capabilities: string[]; pageIds: number[] } | null> {
  const [row] = await rows(db, sql`select a.id, a.capabilities, a.page_ids from person_agent_keys k join agent_keys a on a.id = k.agent_key_id
    where k.person_id = ${personId} and a.revoked_at is null and a.replaced_at is null and a.expires_at > now()
    order by a.id desc limit 1`);
  return row
    ? { id: Number(row.id), capabilities: (row.capabilities as string[] | null) ?? [], pageIds: ((row.page_ids as Array<string | number> | null) ?? []).map(Number) }
    : null;
}

/**
 * The checker's live key holds every test page, the stand-ins too (its pages change in place, `updateAgentKeyPages`).
 * While the key is in a replacement the pair stays equal and nothing changes: a later run adds them.
 */
async function ensureCheckerPages(app: AppContext, checker: { personId: number }, pages: ReadonlyArray<{ id: number; label: string }>) {
  const live = await liveCheckerKey(app.db, checker.personId);
  if (live === null) return;
  const missing = pages.filter((page) => !live.pageIds.includes(page.id)).map((page) => page.label);
  if (missing.length === 0) return;
  try {
    await updateAgentKeyPages(app, { id: live.id, add: missing, remove: [], note: "sandbox:seed: the test pages" }, { source: "cli" });
  } catch (error) {
    if (!(error instanceof ConflictError && error.reason === "agent_key_being_replaced")) throw error;
  }
}

async function mintCheckerKey(app: AppContext, checker: { personId: number }, pageLabels: readonly string[]): Promise<string> {
  const existing = await liveCheckerKey(app.db, checker.personId);
  if (existing !== null) {
    const replaced = await replaceAgentKey(app, { id: existing.id, name: `${SANDBOX_CHECKER.keyName}-${Date.now()}`, expiresInDays: 90 }, { source: "cli" });
    return replaced.token;
  }
  const issued = await issueAgentKey(app, {
    name: SANDBOX_CHECKER.keyName, agentCode: SANDBOX_CHECKER.code, capabilities: sandboxCheckerCapabilities(),
    pageLabels: [...pageLabels], expiresInDays: 90,
  }, { source: "cli" });
  return issued.token;
}
