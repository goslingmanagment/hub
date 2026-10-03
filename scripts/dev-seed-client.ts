// Seeds a keyless LOCAL hub for client smoke tests (chat-extension, desktop).
// Runbook: docs/runbooks/client-dev-hub.md.
//
// What it writes: an owner and a chatter with known dev passwords, the bundled
// persona catalog, one model with two OnlyFans pages shaped like lora-of /
// lora-vip-of (synthetic 9-digit platform ids, no OFAPI binding, no keys), and
// seven synthetic fans with subscriptions, ledger rows, DM threads, archive
// messages and one stored recap pair, so bootstrap, Spenders, the archive feed,
// recaps and the AI context all have something to read. Rows go straight into
// the tables the OFAPI pipeline would fill; nothing is journaled, nothing is
// fetched.
//
// Idempotent: a re-run converges on the same rows and re-anchors every time to
// "now" (so "2 hours ago" stays 2 hours ago). Passwords are set when a user is
// created; a re-run leaves them alone unless --reset-passwords. Rows a later
// version of these fixtures no longer names are left behind: start from an
// empty database after the fixtures change.
//
// Refuses to run unless DATABASE_URL points at this machine or the dev compose
// network, NODE_ENV is not production, and the database holds no page the
// seed did not create (--allow-existing-pages seeds next to them anyway).

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  createModel,
  createOnlyFansPage,
  deleteProxyConfig,
  findAiPersonaByKey,
  findModelBySlug,
  findPageByLabel,
  findUserByUsername,
  insertAiGenerationContent,
  rebuildRevenueRollups,
  rebuildSpenderProjections,
  refreshFanPageSubscriberState,
  refreshPageDmConversationWindow,
  refreshPageSubscriberCount,
  seedBundledAiPersona,
  storeProxyConfig,
  updatePageMetadata,
  upsertFanPages,
  upsertFans,
  upsertPageDmConversation,
  upsertPageDmMessages,
  upsertPageSubscription,
  upsertTransaction,
} from "@agency_hub_core/db";
import { loadConfig, millsFromDollars, redactSensitiveText, type Mills } from "@agency_hub_core/shared";

import { createAppContext, type AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createBundledPersonalities } from "../apps/runtime/src/modules/ai/index.ts";
import { aiPersonaDefinitionId } from "../apps/runtime/src/modules/ai/persona-definition.ts";
import {
  assignPageToUser,
  createUserAccount,
  listEffectivePageAssignments,
  setUserPassword,
  type AuditContext,
} from "../apps/runtime/src/services/auth.ts";
import {
  mapOfapiSpendCategoryToTransactionType,
  mapOfapiSpendStatusToTransactionState,
} from "../apps/runtime/src/services/ofapi-spend-transaction-mapping.ts";

// ─── Guards ─────────────────────────────────────────────────────────────────

/** Hosts a dev database may live on: this machine, or the `postgres` service
 * of docker-compose.yml when the seed runs inside the dev compose network.
 * Production's compose service has the same name, which is why the
 * NODE_ENV and foreign-page guards exist too. */
export const DEV_SEED_DATABASE_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "postgres"];

export class DevSeedRefusedError extends Error {
  override name = "DevSeedRefusedError";
}

export function assertLocalDevDatabaseTarget(input: {
  databaseUrl: string;
  nodeEnv: string | undefined;
}): void {
  if (input.nodeEnv?.trim().toLowerCase() === "production") {
    throw new DevSeedRefusedError("NODE_ENV is production: the dev seed never runs in a production process");
  }
  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw new DevSeedRefusedError("DATABASE_URL is not a postgres:// URL; the dev seed only accepts one it can check");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DevSeedRefusedError(`DATABASE_URL scheme "${url.protocol}" is not postgres:`);
  }
  // node-postgres lets ?host= override the URL host (another server or a
  // socket directory), so the host checked below would not be the one used.
  if (url.searchParams.has("host") || url.searchParams.has("hostaddr")) {
    throw new DevSeedRefusedError("DATABASE_URL overrides its host with a query parameter; name the host in the URL itself");
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!DEV_SEED_DATABASE_HOSTS.includes(host)) {
    throw new DevSeedRefusedError(
      `DATABASE_URL host "${host || "(none)"}" is not a local dev database `
        + `(allowed: ${DEV_SEED_DATABASE_HOSTS.join(", ")})`,
    );
  }
}

/** A database that already holds pages the seed did not create is somebody's
 * real hub (an SSH tunnel to production looks like localhost too). */
export function assertSeedableDatabase(input: {
  foreignPageLabels: readonly string[];
  allowExistingPages: boolean;
}): void {
  if (input.foreignPageLabels.length === 0 || input.allowExistingPages) {
    return;
  }
  const sample = input.foreignPageLabels.slice(0, 5).join(", ");
  throw new DevSeedRefusedError(
    `the database already holds ${input.foreignPageLabels.length} page(s) the dev seed did not create `
      + `(${sample}${input.foreignPageLabels.length > 5 ? ", …" : ""}); it looks like a real hub. `
      + "Pass --allow-existing-pages only if it is your own local scratch database.",
  );
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

// Fixture times are minutes before "now".
const MS_PER_MINUTE = 60_000;
const HOUR = 60;
const DAY = 24 * HOUR;
const BILLING_CYCLE_DAYS = 30;

export const DEV_SEED_MODEL = { slug: "dev-lora", name: "Dev Lora" } as const;
export const DEV_SEED_OWNER_USERNAME = "dev-owner";
export const DEV_SEED_CHATTER_USERNAME = "dev-chatter";
const DEFAULT_OWNER_PASSWORD = "dev-owner-password";
const DEFAULT_CHATTER_PASSWORD = "dev-chatter-password";
/** The fake provider's default address (scripts/dev-fake-ai-provider.mjs). */
export const DEV_SEED_DEFAULT_AI_PROXY_URL = "http://127.0.0.1:8787";

type PageKey = "main" | "vip";
type FanKey = "mark" | "jake" | "sam" | "alex" | "chris" | "daniel" | "ryan";

interface PageFixture {
  label: string;
  /** Synthetic OnlyFans creator id. The real lora-of / lora-vip-of ids must
   * never appear in a dev database. */
  externalId: string;
  username: string;
  displayName: string;
  subscriptionPrice: string;
}

export const DEV_SEED_PAGES: Record<PageKey, PageFixture> = {
  main: { label: "dev-lora-of", externalId: "990000001", username: "devlora", displayName: "Dev Lora", subscriptionPrice: "0" },
  vip: { label: "dev-lora-vip-of", externalId: "990000002", username: "devloravip", displayName: "Dev Lora VIP", subscriptionPrice: "9.99" },
};

export const DEV_SEED_FANS: Record<FanKey, { id: string; username: string; displayName: string }> = {
  mark: { id: "990100001", username: "dev_mark", displayName: "Mark" },
  jake: { id: "990100002", username: "dev_jake", displayName: "Jake" },
  sam: { id: "990100003", username: "dev_sam", displayName: "Sam" },
  alex: { id: "990100004", username: "dev_alex", displayName: "Alex" },
  chris: { id: "990100005", username: "dev_chris", displayName: "Chris" },
  daniel: { id: "990100006", username: "dev_daniel", displayName: "Daniel" },
  ryan: { id: "990100007", username: "dev_ryan", displayName: "Ryan" },
};

interface MessageFixture {
  /** Minutes before "now". */
  ago: number;
  from: "fan" | "model";
  text: string;
  tip?: string;
  price?: string;
}

interface MembershipFixture {
  page: PageKey;
  fan: FanKey;
  /** What a client developer should see this fan as. */
  scenario: string;
  subscribedAgo: number;
  expiredAgo?: number;
  autoRenew: boolean;
  /** [OFAPI spend category, dollars, minutes before now]. */
  spend: Array<["tip" | "message" | "subscription", string, number]>;
  messages: MessageFixture[];
}

function renewals(subscribedAgo: number, price: string): MembershipFixture["spend"] {
  const charges: MembershipFixture["spend"] = [];
  for (let ago = subscribedAgo; ago >= 0; ago -= BILLING_CYCLE_DAYS * DAY) {
    charges.push(["subscription", price, ago]);
  }
  return charges;
}

export const DEV_SEED_MEMBERSHIPS: MembershipFixture[] = [
  {
    page: "main", fan: "mark", scenario: "whale ($600+), 33 messages, two unanswered", subscribedAgo: 120 * DAY, autoRenew: true,
    spend: [["tip", "20", 15 * DAY], ["message", "25", 10 * DAY], ["tip", "100", 7 * DAY], ["message", "35", 5 * DAY], ["message", "180", 3 * DAY], ["tip", "250", DAY]],
    messages: [
      // 30+ messages: Recap (fan-summary) and Review (chat-review) refuse shorter chats.
      { ago: 118 * DAY, from: "fan", text: "hey gorgeous, just found your page" },
      { ago: 118 * DAY - 5, from: "model", text: "hiii welcome!! so glad you're here 😊 where are you from?" },
      { ago: 118 * DAY - 12, from: "fan", text: "Austin. you?" },
      { ago: 118 * DAY - 15, from: "model", text: "no way, I love Austin! I'm on the west coast" },
      { ago: 104 * DAY, from: "fan", text: "what's your favorite thing to do on a day off?" },
      { ago: 104 * DAY - 8, from: "model", text: "beach, a book and zero plans 🌊 you?" },
      { ago: 104 * DAY - 20, from: "fan", text: "fishing with my brother usually" },
      { ago: 104 * DAY - 25, from: "model", text: "that sounds so peaceful honestly" },
      { ago: 90 * DAY, from: "fan", text: "you look amazing in the new post" },
      { ago: 90 * DAY - 6, from: "model", text: "stoppp 🙈 thank you, that one took forever" },
      { ago: 75 * DAY, from: "fan", text: "rough week at work" },
      { ago: 75 * DAY - 4, from: "model", text: "ugh I'm sorry 😮‍💨 what happened?" },
      { ago: 75 * DAY - 15, from: "fan", text: "boss moved a deadline up two weeks" },
      { ago: 75 * DAY - 18, from: "model", text: "that's so unfair. you'll crush it though" },
      { ago: 60 * DAY, from: "fan", text: "crushed it 😎" },
      { ago: 60 * DAY - 3, from: "model", text: "told you!! proud of you 🥳" },
      { ago: 45 * DAY, from: "fan", text: "any trips coming up?" },
      { ago: 45 * DAY - 5, from: "model", text: "maybe San Diego next month, can't wait" },
      { ago: 30 * DAY, from: "fan", text: "how was San Diego?" },
      { ago: 30 * DAY - 6, from: "model", text: "sooo good, I got way too tan 😂" },
      { ago: 15 * DAY, from: "fan", text: "for that smile", tip: "20" },
      { ago: 15 * DAY - 3, from: "model", text: "omg thank you babe 🥰 you just made my morning" },
      { ago: 10 * DAY, from: "model", text: "made something just for you today… 🙈", price: "25" },
      { ago: 10 * DAY - 40, from: "fan", text: "unlocked it. wow" },
      { ago: 7 * DAY, from: "fan", text: "you deserve it", tip: "100" },
      { ago: 7 * DAY - 2, from: "model", text: "you're too sweet to me 😘" },
      { ago: 5 * DAY, from: "model", text: "behind the scenes from today's shoot 📸", price: "35" },
      { ago: 3 * DAY, from: "model", text: "the full set, only for my favorites", price: "180" },
      { ago: 3 * DAY - 30, from: "fan", text: "best one yet" },
      { ago: DAY, from: "fan", text: "happy friday", tip: "250" },
      { ago: DAY - 5, from: "model", text: "I'm speechless… thank you Mark 💕 any plans for the weekend?" },
      { ago: DAY - 20, from: "fan", text: "maybe a game, nothing big" },
      { ago: 2 * HOUR, from: "fan", text: "thinking about you. what are you up to tonight?" },
    ],
  },
  {
    page: "main", fan: "jake", scenario: "regular ($50-150), answered yesterday", subscribedAgo: 40 * DAY, autoRenew: true,
    spend: [["message", "15", 8 * DAY], ["tip", "10", 3 * DAY], ["message", "30", DAY]],
    messages: [
      { ago: 9 * DAY, from: "fan", text: "hi there" },
      { ago: 9 * DAY - 4, from: "model", text: "hey Jake! how's your day going?" },
      { ago: 9 * DAY - 10, from: "fan", text: "long one at work. you?" },
      { ago: 8 * DAY, from: "model", text: "this might help you relax 😌", price: "15" },
      { ago: 3 * DAY, from: "fan", text: "coffee's on me", tip: "10" },
      { ago: 3 * DAY - 5, from: "model", text: "aww thank you! oat latte it is ☕" },
      { ago: DAY, from: "model", text: "new set dropped, you get it first", price: "30" },
      { ago: 22 * HOUR, from: "fan", text: "love it" },
      { ago: 21 * HOUR, from: "model", text: "glad you do 😊 talk tomorrow?" },
    ],
  },
  {
    page: "main", fan: "sam", scenario: "gone quiet ($25-50): fan silent 12 days, ping 6 days ago", subscribedAgo: 60 * DAY, autoRenew: true,
    spend: [["tip", "5", 40 * DAY], ["message", "20", 30 * DAY]],
    messages: [
      { ago: 41 * DAY, from: "fan", text: "hey" },
      { ago: 41 * DAY - 10, from: "model", text: "hey you! welcome 💕" },
      { ago: 40 * DAY, from: "fan", text: "nice pics", tip: "5" },
      { ago: 30 * DAY, from: "model", text: "something a little special", price: "20" },
      { ago: 12 * DAY, from: "fan", text: "been busy lately, sorry" },
      { ago: 12 * DAY - 30, from: "model", text: "no worries at all! hope things calm down soon" },
      { ago: 6 * DAY, from: "model", text: "hey stranger, miss chatting with you 🙈" },
    ],
  },
  {
    page: "main", fan: "alex", scenario: "new subscriber 5 hours ago, only the welcome message", subscribedAgo: 5 * HOUR, autoRenew: true,
    spend: [],
    messages: [
      { ago: 5 * HOUR - 1, from: "model", text: "hey love, welcome to my page 💕 so happy to have you here! tell me a bit about yourself?" },
    ],
  },
  {
    page: "main", fan: "chris", scenario: "expired subscriber ($0-25)", subscribedAgo: 70 * DAY, expiredAgo: 10 * DAY, autoRenew: false,
    spend: [["message", "12", 50 * DAY]],
    messages: [
      { ago: 52 * DAY, from: "fan", text: "hi" },
      { ago: 52 * DAY - 3, from: "model", text: "hi Chris! 😊" },
      { ago: 50 * DAY, from: "model", text: "a little gift for you", price: "12" },
      { ago: 50 * DAY - 60, from: "fan", text: "thanks" },
    ],
  },
  {
    page: "vip", fan: "mark", scenario: "the same whale on VIP ($150-350)", subscribedAgo: 88 * DAY, autoRenew: true,
    spend: [...renewals(88 * DAY, "9.99"), ["tip", "100", 20 * DAY], ["message", "150", 12 * DAY]],
    messages: [
      { ago: 88 * DAY, from: "model", text: "welcome to VIP, Mark 💎 this is where I post my favorite things" },
      { ago: 87 * DAY, from: "fan", text: "glad to be here" },
      { ago: 20 * DAY, from: "fan", text: "for the VIP queen", tip: "100" },
      { ago: 20 * DAY - 4, from: "model", text: "you spoil me 🥹" },
      { ago: 12 * DAY, from: "model", text: "VIP exclusive, 20 min video", price: "150" },
      { ago: 12 * DAY - 120, from: "fan", text: "worth every penny" },
    ],
  },
  {
    page: "vip", fan: "daniel", scenario: "VIP ($25-50), auto-renew off, two unanswered messages from 3 days ago", subscribedAgo: 45 * DAY, autoRenew: false,
    spend: [...renewals(45 * DAY, "9.99"), ["message", "20", 5 * DAY]],
    messages: [
      { ago: 45 * DAY, from: "model", text: "welcome to VIP 💎" },
      { ago: 44 * DAY, from: "fan", text: "hey Lora" },
      { ago: 44 * DAY - 10, from: "model", text: "hey Daniel! what made you join VIP?" },
      { ago: 5 * DAY, from: "model", text: "VIP-only teaser 😏", price: "20" },
      { ago: 4 * DAY, from: "fan", text: "nice" },
      { ago: 3 * DAY, from: "fan", text: "are you doing customs?" },
    ],
  },
  {
    page: "vip", fan: "ryan", scenario: "new VIP subscriber 2 hours ago, no messages yet", subscribedAgo: 2 * HOUR, autoRenew: true,
    spend: renewals(2 * HOUR, "9.99"),
    messages: [],
  },
];

/** The stored recap pair (feature fan-summary) the shared-recaps read and the
 * Coach attach find for Mark on the main page. */
const RECAP_FIXTURE = {
  page: "main" as const,
  fan: "mark" as const,
  full: {
    ago: DAY - 30,
    text: "[dev seed] Mark, from Austin. Subscribed four months ago; the page's top spender "
      + "(~$610: big tips, buys most PPV within a day). Warm, short messages, likes being "
      + "thanked by name. Weekend plans: \"maybe a game\". Two messages are waiting for a reply.",
  },
  short: {
    ago: 3 * HOUR,
    text: "[dev seed] Top spender, warm and loyal; reply to tonight's message and keep it personal.",
  },
};

// ─── Seeding ────────────────────────────────────────────────────────────────

export interface DevSeedOptions {
  now?: Date;
  ownerPassword?: string;
  chatterPassword?: string;
  resetPasswords?: boolean;
  /** Stored as both pages' egress proxy (the AI gateway calls the provider
   * through it); null removes it. */
  aiProxyUrl?: string | null;
  allowExistingPages?: boolean;
}

export interface DevSeedSummary {
  users: Array<{ username: string; role: "owner" | "chatter"; id: number; password: string | null }>;
  pages: Array<{ label: string; id: number; externalId: string; displayName: string }>;
  fans: Array<{ page: string; fanId: string; username: string; scenario: string }>;
  personas: Array<{ key: string; displayName: string; definitionId: string }>;
  recap: { page: string; fanId: string; personaDefinitionId: string };
  aiProxyUrl: string | null;
}

const SEED_AUDIT: AuditContext = { source: "cli" };

/** Message ids keep the OnlyFans shape (numeric, increasing with time inside
 * a chat) and never collide across the seeded chats. */
function messageRef(pageIndex: number, fanIndex: number, seq: number): string {
  return String(990_000_000_000 + pageIndex * 1_000_000 + fanIndex * 1_000 + seq);
}

/** A deterministic UUID-shaped ref so a re-run finds the rows it wrote. */
function stableRef(name: string): string {
  const hex = createHash("sha256").update(`agency-hub:dev-seed-client:${name}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function netOf(gross: Mills): bigint {
  return (gross * 80n) / 100n;
}

async function listForeignPageLabels(app: AppContext): Promise<string[]> {
  const ours = Object.values(DEV_SEED_PAGES).map((page) => page.label);
  const result = await app.pool.query<{ label: string }>(
    "select label from pages where not (label = any($1::text[])) order by label",
    [ours],
  );
  return result.rows.map((row) => row.label);
}

async function ensureUser(
  app: AppContext,
  input: { username: string; role: "owner" | "chatter"; password: string; resetPassword: boolean },
): Promise<{ id: number; password: string | null }> {
  const existing = await findUserByUsername(app.db, input.username);
  if (existing) {
    if (existing.role !== input.role || existing.disabledAt !== null) {
      throw new DevSeedRefusedError(
        `user "${input.username}" exists as ${existing.role}${existing.disabledAt ? " (deactivated)" : ""}; `
          + `the seed expects an active ${input.role}`,
      );
    }
    if (!input.resetPassword) {
      return { id: existing.id, password: null };
    }
    await setUserPassword(app, { userId: existing.id, password: input.password }, SEED_AUDIT);
    return { id: existing.id, password: input.password };
  }
  // A chatter is created without a password and gets one through the
  // admin-set-password path, as the cabinet's invite does.
  const created = await createUserAccount(app, {
    username: input.username,
    role: input.role,
    password: input.role === "owner" ? input.password : null,
  }, SEED_AUDIT);
  if (input.role !== "owner") {
    await setUserPassword(app, { userId: created.id, password: input.password }, SEED_AUDIT);
  }
  return { id: created.id, password: input.password };
}

async function ensurePage(app: AppContext, modelId: number, fixture: PageFixture): Promise<number> {
  const existing = await findPageByLabel(app.db, fixture.label);
  let pageId: number;
  if (existing) {
    if (existing.page.platform !== "onlyfans" || existing.page.modelId !== modelId) {
      throw new DevSeedRefusedError(`page "${fixture.label}" exists but is not the seed's OnlyFans page of model ${DEV_SEED_MODEL.slug}`);
    }
    pageId = existing.page.id;
  } else {
    const created = await createOnlyFansPage(app.db, { modelId, label: fixture.label });
    if (!created) {
      throw new Error(`page ${fixture.label} could not be created`);
    }
    pageId = created.id;
  }
  // The identity writer keeps external_page_id immutable and unique, as the
  // OFAPI onboarding does. No ofapi_account_id: this hub has no OFAPI key.
  await updatePageMetadata(app.db, pageId, {
    platformAccountIdValue: fixture.externalId,
    username: fixture.username,
    displayName: fixture.displayName,
    followerCount: null,
    subscriberCount: null,
    earningsBalanceMills: 0n,
    metadata: { onlyfansUserId: fixture.externalId },
  });
  return pageId;
}

async function seedMembership(
  app: AppContext,
  input: {
    membership: MembershipFixture;
    pageId: number;
    page: PageFixture;
    fanRowId: number;
    pageIndex: number;
    fanIndex: number;
    now: Date;
  },
): Promise<void> {
  const { membership, pageId, page, fanRowId, now } = input;
  const fan = DEV_SEED_FANS[membership.fan];
  const at = (ago: number) => new Date(now.getTime() - ago * MS_PER_MINUTE);

  // Subscription: the OFAPI projection's shape (one row per fan, keyed by the fan id).
  const subscribedAt = at(membership.subscribedAgo);
  const cycle = BILLING_CYCLE_DAYS * DAY;
  const lastRenewalAgo = membership.subscribedAgo % cycle;
  const expired = membership.expiredAgo !== undefined;
  const priceMills = millsFromDollars(page.subscriptionPrice);
  await upsertFanPages(app.db, [{ fanId: fanRowId, platformAccountId: pageId }]);
  await upsertPageSubscription(app.db, {
    platformSubscriptionId: fan.id,
    platformAccountId: pageId,
    fanId: fanRowId,
    rawStatus: 0,
    canonicalStatus: expired ? "expired" : "active",
    isCurrent: !expired,
    priceMills,
    renewPriceMills: priceMills,
    autoRenew: membership.autoRenew,
    billingCycleDays: BILLING_CYCLE_DAYS,
    durationDays: BILLING_CYCLE_DAYS,
    renewDate: expired ? null : at(lastRenewalAgo - cycle),
    sourceCreatedAt: subscribedAt,
    sourceUpdatedAt: expired ? at(membership.expiredAgo ?? 0) : at(lastRenewalAgo),
    endsAt: expired ? at(membership.expiredAgo ?? 0) : at(lastRenewalAgo - cycle),
  });

  // Ledger: what the OFAPI REST backfill writes for a settled charge.
  for (const [index, [category, dollars, ago]] of membership.spend.entries()) {
    const gross = millsFromDollars(dollars);
    const net = netOf(gross);
    await upsertTransaction(app.db, {
      platformAccountId: pageId,
      source: "ofapi:rest",
      fanId: fanRowId,
      transactionId: `devseed-${page.label}-${fan.id}-${index + 1}`,
      correlationAccountId: fan.id,
      rawType: `ofapi:${category}`,
      canonicalType: mapOfapiSpendCategoryToTransactionType(category, "settled"),
      transactionState: mapOfapiSpendStatusToTransactionState("settled"),
      rawStatus: "settled",
      grossAmountMills: gross,
      sourceDestinationAmountMills: gross,
      creatorNetAmountMills: net,
      platformFeeMills: gross - net,
      senderId: fan.id,
      occurredAt: at(ago),
      sourceUpdatedAt: at(ago),
    });
  }

  if (membership.messages.length === 0) {
    return;
  }

  // Messages: the archive (AI context, feed) and the hot store + thread head
  // (dashboard, Spenders, inbox) hold the same chat. OnlyFans chat id = fan id.
  const messages = membership.messages.map((message, seq) => ({
    ...message,
    ref: messageRef(input.pageIndex, input.fanIndex, seq + 1),
    occurredAt: at(message.ago),
    tipMills: message.tip ? millsFromDollars(message.tip) : 0n,
    priceMills: message.price ? millsFromDollars(message.price) : null,
  }));
  for (const message of messages) {
    const fromFan = message.from === "fan";
    await app.pool.query(
      `insert into message_archive (
         account_id, platform, conversation_ref, message_ref, native_message_id, fan_native_id,
         sender_role, is_sent_by_me, occurred_at, text_plain, text_html, price_mills, is_opened,
         is_tip, tip_amount_mills, material_observed_at, serving_contract_version
       ) values ($1, 'onlyfans', $2::text, $3::text, $3::text::bigint, $2::text, $4, $5, $6, $7, $7, $8, $9, $10, $11, $6, 1)
       on conflict (account_id, platform, message_ref) do update set
         conversation_ref = excluded.conversation_ref,
         native_message_id = excluded.native_message_id,
         fan_native_id = excluded.fan_native_id,
         sender_role = excluded.sender_role,
         is_sent_by_me = excluded.is_sent_by_me,
         occurred_at = excluded.occurred_at,
         text_plain = excluded.text_plain,
         text_html = excluded.text_html,
         price_mills = excluded.price_mills,
         is_opened = excluded.is_opened,
         is_tip = excluded.is_tip,
         tip_amount_mills = excluded.tip_amount_mills,
         material_observed_at = excluded.material_observed_at,
         deleted_at = null,
         content_pending = false,
         updated_at = now()`,
      [
        pageId,
        fan.id,
        message.ref,
        fromFan ? "fan" : "model",
        !fromFan,
        message.occurredAt,
        message.text,
        message.priceMills === null ? null : message.priceMills.toString(),
        message.priceMills === null ? null : true,
        message.tipMills > 0n,
        message.tipMills.toString(),
      ],
    );
  }

  const head = messages[messages.length - 1]!;
  let unread = 0;
  for (let index = messages.length - 1; index >= 0 && messages[index]!.from === "fan"; index -= 1) {
    unread += 1;
  }
  const conversation = await upsertPageDmConversation(app.db, {
    platformAccountId: pageId,
    fanId: fanRowId,
    platformConversationId: fan.id,
    partnerPlatformUserId: fan.id,
    partnerUsername: fan.username,
    partnerDisplayName: fan.displayName,
    conversationFlags: 0,
    unreadCount: unread,
    subscriptionTierId: null,
    lastMessageId: head.ref,
    lastUnreadMessageId: unread > 0 ? head.ref : null,
    lastMessageAt: head.occurredAt,
    lastMessageSenderId: head.from === "fan" ? fan.id : page.externalId,
    lastMessageSenderRole: head.from,
    lastMessagePreview: head.text.slice(0, 200),
    messageCoverageStatus: "complete",
    lastMessageSyncAt: now,
    lastSeenGeneration: null,
    metadata: { provider: "ofapi" },
  });
  if (!conversation) {
    throw new Error(`thread upsert for fan ${fan.id} on ${page.label} returned no row`);
  }
  await upsertPageDmMessages(app.db, messages.map((message) => ({
    conversationId: conversation.id,
    platformAccountId: pageId,
    platformMessageId: message.ref,
    senderPlatformUserId: message.from === "fan" ? fan.id : page.externalId,
    senderRole: message.from,
    createdAt: message.occurredAt,
    content: message.text,
    totalTipAmountCents: Number(message.tipMills / 10n),
    inReplyToMessageId: null,
    inReplyToRootMessageId: null,
  })));
  await refreshPageDmConversationWindow(app.db, { conversationId: conversation.id, enforceRetention: false });
}

export async function seedDevClientHub(app: AppContext, options: DevSeedOptions = {}): Promise<DevSeedSummary> {
  assertSeedableDatabase({
    foreignPageLabels: await listForeignPageLabels(app),
    allowExistingPages: options.allowExistingPages === true,
  });
  const now = options.now ?? new Date();
  const aiProxyUrl = options.aiProxyUrl === undefined ? DEV_SEED_DEFAULT_AI_PROXY_URL : options.aiProxyUrl;

  // Personas: the bundled default catalog, create-only (the CLI's ai:personas-seed).
  const personas: DevSeedSummary["personas"] = [];
  for (const persona of createBundledPersonalities()) {
    if (persona.builtinVersion === undefined) {
      throw new Error(`bundled persona ${persona.id} has no builtinVersion`);
    }
    const { persona: row } = await seedBundledAiPersona(app.db, {
      key: persona.id,
      displayName: persona.name,
      systemBlock: persona.content,
      bundledVersion: persona.builtinVersion,
    });
    personas.push({ key: row.key, displayName: row.displayName, definitionId: aiPersonaDefinitionId(row) });
  }

  const model = await findModelBySlug(app.db, DEV_SEED_MODEL.slug)
    ?? await createModel(app.db, { slug: DEV_SEED_MODEL.slug, name: DEV_SEED_MODEL.name });
  if (!model) {
    throw new Error(`model ${DEV_SEED_MODEL.slug} could not be created`);
  }
  const pageKeys = Object.keys(DEV_SEED_PAGES) as PageKey[];
  const pageIds = {} as Record<PageKey, number>;
  for (const key of pageKeys) {
    const page = DEV_SEED_PAGES[key];
    pageIds[key] = await ensurePage(app, model.id, page);
    if (aiProxyUrl === null) {
      await deleteProxyConfig(app.db, pageIds[key]);
    } else {
      await storeProxyConfig(app.db, pageIds[key], { url: aiProxyUrl, encryptedAuth: null, keyVersion: null });
    }
  }

  const owner = await ensureUser(app, {
    username: DEV_SEED_OWNER_USERNAME,
    role: "owner",
    password: options.ownerPassword ?? DEFAULT_OWNER_PASSWORD,
    resetPassword: options.resetPasswords === true,
  });
  const chatter = await ensureUser(app, {
    username: DEV_SEED_CHATTER_USERNAME,
    role: "chatter",
    password: options.chatterPassword ?? DEFAULT_CHATTER_PASSWORD,
    resetPassword: options.resetPasswords === true,
  });
  const assigned = new Set((await listEffectivePageAssignments(app, chatter.id)).map((page) => page.pageId));
  for (const key of pageKeys) {
    if (!assigned.has(pageIds[key])) {
      await assignPageToUser(app, { userId: chatter.id, pageLabel: DEV_SEED_PAGES[key].label }, SEED_AUDIT);
    }
  }

  const fanKeys = Object.keys(DEV_SEED_FANS) as FanKey[];
  const fanRows = await upsertFans(app.db, fanKeys.map((key) => ({
    platform: "onlyfans" as const,
    platformUserId: DEV_SEED_FANS[key].id,
    username: DEV_SEED_FANS[key].username,
    displayName: DEV_SEED_FANS[key].displayName,
  })));
  const fanRowIdByPlatformId = new Map(fanRows.map((row) => [row.platformUserId, row.id]));
  for (const membership of DEV_SEED_MEMBERSHIPS) {
    const fanRowId = fanRowIdByPlatformId.get(DEV_SEED_FANS[membership.fan].id);
    if (fanRowId === undefined) {
      throw new Error(`fan ${membership.fan} was not upserted`);
    }
    await seedMembership(app, {
      membership,
      pageId: pageIds[membership.page],
      page: DEV_SEED_PAGES[membership.page],
      fanRowId,
      pageIndex: pageKeys.indexOf(membership.page) + 1,
      fanIndex: fanKeys.indexOf(membership.fan) + 1,
      now,
    });
  }
  for (const key of pageKeys) {
    await refreshFanPageSubscriberState(app.db, pageIds[key]);
    await refreshPageSubscriberCount(app.db, pageIds[key]);
    await rebuildSpenderProjections(app.db, pageIds[key]);
    await rebuildRevenueRollups(app.db, pageIds[key]);
  }

  // Recaps: a completed full + short fan-summary under the bundled persona,
  // generated by the chatter, as the gateway would have stored them.
  const recapPersona = await findAiPersonaByKey(app.db, createBundledPersonalities()[0]!.id);
  if (!recapPersona) {
    throw new Error("the bundled persona is missing after seeding it");
  }
  const personaDefinitionId = aiPersonaDefinitionId(recapPersona);
  const recapFan = DEV_SEED_FANS[RECAP_FIXTURE.fan].id;
  for (const mode of ["full", "short"] as const) {
    const generationRef = stableRef(`recap:${RECAP_FIXTURE.page}:${recapFan}:${mode}`);
    await insertAiGenerationContent(app.db, {
      usageEventId: null,
      generationRef,
      feature: "fan-summary",
      model: "anthropic:claude-sonnet-5",
      provider: "anthropic",
      userId: chatter.id,
      pageId: pageIds[RECAP_FIXTURE.page],
      conversationRef: recapFan,
      fanRef: recapFan,
      promptBlocks: [],
      completion: RECAP_FIXTURE[mode].text,
      params: { summaryMode: mode, personaDefinitionId, outcome: "completed", stopReason: "end_turn" },
    });
    // The insert keeps a row it already holds; re-anchor its time and catch
    // up its text and persona (an owner may have edited the persona since).
    await app.pool.query(
      `update ai_generation_content
          set created_at = $1, completion = $2, params = params || $3::jsonb
        where generation_ref = $4`,
      [
        new Date(now.getTime() - RECAP_FIXTURE[mode].ago * MS_PER_MINUTE),
        RECAP_FIXTURE[mode].text,
        JSON.stringify({ personaDefinitionId }),
        generationRef,
      ],
    );
  }

  return {
    users: [
      { username: DEV_SEED_OWNER_USERNAME, role: "owner", ...owner },
      { username: DEV_SEED_CHATTER_USERNAME, role: "chatter", ...chatter },
    ],
    pages: pageKeys.map((key) => ({
      label: DEV_SEED_PAGES[key].label,
      id: pageIds[key],
      externalId: DEV_SEED_PAGES[key].externalId,
      displayName: DEV_SEED_PAGES[key].displayName,
    })),
    fans: DEV_SEED_MEMBERSHIPS.map((membership) => ({
      page: DEV_SEED_PAGES[membership.page].label,
      fanId: DEV_SEED_FANS[membership.fan].id,
      username: DEV_SEED_FANS[membership.fan].username,
      scenario: membership.scenario,
    })),
    personas,
    recap: { page: DEV_SEED_PAGES[RECAP_FIXTURE.page].label, fanId: recapFan, personaDefinitionId },
    aiProxyUrl,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `Usage: pnpm dev:seed-client [options]

Seeds the local hub in DATABASE_URL (from the environment or .env) for client
smoke tests. Safe to re-run. See docs/runbooks/client-dev-hub.md.

  --reset-passwords        set both dev users' passwords back to the dev values
  --ai-proxy-url <url>     page egress proxy for AI calls (default ${DEV_SEED_DEFAULT_AI_PROXY_URL},
                           the fake provider: pnpm dev:fake-ai)
  --no-ai-proxy            remove the pages' egress proxy
  --allow-existing-pages   seed even though the database holds other pages
  -h, --help               this text

Env: DEV_SEED_OWNER_PASSWORD, DEV_SEED_CHATTER_PASSWORD override the dev passwords.`;

function printSummary(summary: DevSeedSummary, apiPort: number, aiGatewayEnabled: boolean): void {
  const lines = [
    "Dev client hub seeded.",
    "",
    `API:        http://localhost:${apiPort}/api/v1 (health: /api/v1/health, docs: /documentation)`,
    "",
    "Users (sign in with POST /api/v1/auth/device-tokens/password, or the dashboard):",
    ...summary.users.map((user) => `  ${user.role.padEnd(8)} ${user.username.padEnd(12)} id=${user.id}  password: ${
      user.password ?? "(unchanged; --reset-passwords sets the dev value again)"}`),
    "",
    "OnlyFans pages (synthetic ids, no OFAPI binding):",
    ...summary.pages.map((page) => `  ${page.label.padEnd(16)} pageId=${page.id}  platformAccountId=${page.externalId}  "${page.displayName}"`),
    "",
    "Fans (OnlyFans chat id = fan id):",
    ...summary.fans.map((fan) => `  ${fan.page.padEnd(16)} ${fan.fanId}  ${fan.username.padEnd(11)} ${fan.scenario}`),
    "",
    `Personas:   ${summary.personas.map((persona) => `${persona.key} (${persona.displayName}) ${persona.definitionId}`).join("; ")}`,
    `Recap:      full + short fan-summary for ${summary.recap.fanId} on ${summary.recap.page}`,
    `AI:         gateway ${aiGatewayEnabled ? "enabled" : "disabled (CHATMUSE_AI_GATEWAY_ENABLED=false)"}; `
      + `page proxy ${summary.aiProxyUrl ?? "none"}`,
  ];
  console.log(lines.join("\n"));
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "reset-passwords": { type: "boolean", default: false },
      "ai-proxy-url": { type: "string" },
      "no-ai-proxy": { type: "boolean", default: false },
      "allow-existing-pages": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values["no-ai-proxy"] && values["ai-proxy-url"] !== undefined) {
    throw new DevSeedRefusedError("--ai-proxy-url and --no-ai-proxy contradict each other");
  }
  // loadConfig merges .env into process.env, so both checks below see what
  // the app context is about to use.
  const config = loadConfig();
  assertLocalDevDatabaseTarget({ databaseUrl: config.databaseUrl, nodeEnv: process.env.NODE_ENV });

  const app = await createAppContext({ processRole: "cli" });
  try {
    const ownerPassword = process.env.DEV_SEED_OWNER_PASSWORD?.trim();
    const chatterPassword = process.env.DEV_SEED_CHATTER_PASSWORD?.trim();
    const summary = await seedDevClientHub(app, {
      resetPasswords: values["reset-passwords"],
      aiProxyUrl: values["no-ai-proxy"] ? null : values["ai-proxy-url"] ?? DEV_SEED_DEFAULT_AI_PROXY_URL,
      allowExistingPages: values["allow-existing-pages"],
      ...(ownerPassword ? { ownerPassword } : {}),
      ...(chatterPassword ? { chatterPassword } : {}),
    });
    printSummary(summary, app.config.apiPort, app.config.chatMuseAiGatewayEnabled === true);
  } finally {
    await app.close();
  }
}

const isMain = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const refused = error instanceof DevSeedRefusedError;
    console.error(`${refused ? "Refused" : "Failed"}: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
