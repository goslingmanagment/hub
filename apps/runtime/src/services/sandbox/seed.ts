import argon2 from "argon2";
import { sql } from "drizzle-orm";

import {
  createPlatformPage,
  findPageSummaryByLabel,
  findPersonRowByCode,
  findUserByUsername,
  insertPersonLogin,
  insertPersonRow,
  replacePersonWorkingPages,
  type Database,
  type PersonRowRole,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { createAccountLinkForUserId } from "../account-links.ts";
import { createUserOrRefuseDuplicate } from "../auth.ts";
import { recordCustomOrder } from "../custom-orders/index.ts";
import { openMatter } from "@agency_hub_core/db";

/** Where an invitation is opened (packages/ui/src/sites.ts `CHATTER_SITE_ORIGIN`); `SANDBOX_JOIN_ORIGIN` overrides it. */
const JOIN_ORIGIN = "https://chatgoose.gosling-agency.ru";

/**
 * `sandbox:seed` — the test team on production (products plan 2026-11-13 §8; the wall: sandbox/realm.ts).
 *
 * ADDITIVE AND IDEMPOTENT. Every row it writes is findable later by the test marks: the model «Тест» (`is_test`), its
 * pages, the test people (`is_test`) and their logins, and rows hanging off those pages and logins (sales carry the
 * source `sandbox`). A second run adds what is missing and changes nothing that is there; a name taken by anything
 * live stops the run before it writes (`SandboxSeedRefused`). Nothing here deletes.
 *
 * Passwords come from the environment at run time (`SANDBOX_PASSWORD_T_OWNER`, `…_T_LEAD`, `…_T_CHAT_1`,
 * `…_T_CHAT_2`), are never written to the repository and never printed. A login whose variable is not set keeps the
 * password it has (none on the first run: it cannot sign in until one is given).
 *
 * Scenarios write the INPUTS of a day «now» and let the ordinary jobs build the rest (shift rows, whose a sale is,
 * matters of the checks):
 *   shift    — two test chatters' activity minutes and messages with authors on both test pages, and sales of every
 *              kind the rule tells apart: an own PPV, a colleague's older PPV bought now, a tip in chat, a tip under a
 *              post, a subscription after a message, a sale nobody wrote for, sales before the shift began, one after
 *              the colleague's shift ended;
 *   customs  — custom orders on the steps the board of customs shows;
 *   matters  — what a team lead and a chatter find waiting.
 * Each is re-runnable for «now»: a run in another minute adds a new day's worth, the same minute adds nothing.
 */

export const SANDBOX_MODEL = { slug: "test", name: "Тест" } as const;

export const SANDBOX_PAGES = [
  { label: "test-1", platform: "fansly" },
  { label: "test-of", platform: "onlyfans" },
] as const;

type LoginRole = "owner" | "team_lead" | "chatter";

interface SandboxPersonSpec {
  code: string;
  displayName: string;
  role: PersonRowRole;
  state: "invited" | "working";
  /** The login, when the role has one today. `invited`: a login with no password, entered by an invitation link. */
  login: { username: string; role: LoginRole; invited?: true; passwordEnv?: string } | null;
  /** Works (and opens) both test pages. */
  works: boolean;
}

export const SANDBOX_PEOPLE: readonly SandboxPersonSpec[] = [
  { code: "t-owner", displayName: "Тест: владелец", role: "owner", state: "working", works: false,
    login: { username: "t-owner", role: "owner", passwordEnv: "SANDBOX_PASSWORD_T_OWNER" } },
  { code: "t-lead", displayName: "Тест: тимлид", role: "team_lead", state: "working", works: true,
    login: { username: "t-lead", role: "team_lead", passwordEnv: "SANDBOX_PASSWORD_T_LEAD" } },
  { code: "t-chat-1", displayName: "Тест: чаттер 1", role: "chatter", state: "working", works: true,
    login: { username: "t-chat-1", role: "chatter", passwordEnv: "SANDBOX_PASSWORD_T_CHAT_1" } },
  { code: "t-chat-2", displayName: "Тест: чаттер 2", role: "chatter", state: "working", works: true,
    login: { username: "t-chat-2", role: "chatter", passwordEnv: "SANDBOX_PASSWORD_T_CHAT_2" } },
  { code: "t-new", displayName: "Тест: новичок", role: "chatter", state: "invited", works: true,
    login: { username: "t-new", role: "chatter", invited: true } },
  // The content manager's sign-in role is not back yet: the person now, the login on a later run of a later seed.
  { code: "t-km", displayName: "Тест: КМ", role: "content_manager", state: "working", works: false, login: null },
];

export const SANDBOX_SCENARIOS = ["shift", "customs", "matters"] as const;
export type SandboxScenario = (typeof SANDBOX_SCENARIOS)[number];

/** Provenance of every sale the seed writes (0414). */
export const SANDBOX_TRANSACTION_SOURCE = "sandbox";

export class SandboxSeedRefused extends Error {}

export interface SandboxSeedInput {
  scenarios: readonly SandboxScenario[];
  /** Mint a fresh invitation link of `t-new` and answer it (for the coordinator only). */
  printInvite?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface SandboxSeedResult {
  model: { id: number; created: boolean };
  pages: Array<{ label: string; id: number; created: boolean }>;
  people: Array<{ code: string; personId: number; created: boolean; login: string | null; passwordSet: boolean }>;
  scenarios: Record<string, Record<string, number>>;
  invite: string | null;
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

async function ensurePerson(db: Database, spec: SandboxPersonSpec, pageIds: readonly number[], env: NodeJS.ProcessEnv) {
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
    const [has] = await rows(db, sql`select count(*)::int as n from person_working_pages where person_id = ${person.id}`);
    if (Number(has?.n ?? 0) === 0) await replacePersonWorkingPages(db, person.id, pageIds);
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

async function testLogin(db: Database, username: string): Promise<number> {
  const [row] = await rows(db, sql`select u.id from users u join person_logins pl on pl.user_id = u.id
    join people pe on pe.id = pl.person_id where u.username = ${username} and pe.is_test`);
  if (!row) throw new SandboxSeedRefused(`The test login «${username}» is missing: run the seed without a scenario first`);
  return Number(row.id);
}

async function seedShift(db: Database, pages: SandboxSeedResult["pages"], now: Date): Promise<Record<string, number>> {
  const context: ShiftContext = { db, stamp: stampOf(now), now: now.getTime() };
  const fansly = pages.find((page) => page.label === "test-1")!.id;
  const onlyfans = pages.find((page) => page.label === "test-of")!.id;
  const chat1 = await testLogin(db, "t-chat-1");
  const chat2 = await testLogin(db, "t-chat-2");
  const n = now.getTime();
  // Platform refs are digits (the archive's checks): 9, the run's minute, a number per name. A page's own refs never
  // meet another page's, and Fansly's own are 18 digits below 9·10^17.
  const names = new Map<string, number>();
  const ref = (what: string) => {
    if (!names.has(what)) names.set(what, names.size + 1);
    return `9${context.stamp}${String(names.get(what)).padStart(5, "0")}`;
  };
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

/** Seeds the test team (and the scenarios asked for). Additive, idempotent; refuses before writing on a live name. */
export async function seedSandbox(app: AppContext, input: SandboxSeedInput): Promise<SandboxSeedResult> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  await assertNamesFree(app.db);
  const result = await app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    const model = await ensureModel(db);
    const pages = await ensurePages(db, model.id);
    const people = [];
    for (const spec of SANDBOX_PEOPLE) people.push(await ensurePerson(db, spec, pages.map((page) => page.id), env));
    return { model, pages, people };
  });
  const scenarios: SandboxSeedResult["scenarios"] = {};
  for (const scenario of input.scenarios) {
    if (scenario === "shift") scenarios.shift = await seedShift(app.db, result.pages, now);
    if (scenario === "customs") scenarios.customs = await seedCustoms(app, result.pages, now);
    if (scenario === "matters") scenarios.matters = await seedMatters(app.db, result.pages, now);
  }
  let invite: string | null = null;
  if (input.printInvite === true) {
    const userId = await testLogin(app.db, "t-new");
    const link = await createAccountLinkForUserId(app, { userId, kind: "invite", expiresInHours: 72 }, { source: "cli" });
    invite = `${env.SANDBOX_JOIN_ORIGIN ?? JOIN_ORIGIN}/join#${link.token}`;
  }
  return { ...result, scenarios, invite };
}

/** The page ids of the test realm, for a caller that has only the labels. */
export async function sandboxPageIds(db: Database): Promise<number[]> {
  const found = await Promise.all(SANDBOX_PAGES.map((spec) => findPageSummaryByLabel(db, spec.label)));
  return found.filter((page) => page !== null).map((page) => page!.id);
}
