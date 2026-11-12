import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { addCustomOrderMessage, createFanslyPage, createModel } from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import { recordCustomOrder } from "../apps/runtime/src/services/custom-orders/index.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";
import { fixtureUserId } from "./helpers/user-identity.ts";

// Заказ кастома, a fan's erasure and the orders known only by a buyer's string (final review, round 2). Such an
// order was taken as the erased fan's whenever the string matched his login — though the login was three fans' of
// that page, or the string was another fan's name («Alex») that happened to equal the login `alex`. Erasing any of
// them blanked the order: its buyer, what was asked, the notes, the messages' words. Every name and number is made up.

vi.mock("argon2", () => import("./helpers/cheap-argon2.ts"));

let testDb: StartedTestDatabase | null = null;
let app: AppContext;
let ownerId = 0;
const pages: Record<string, number> = {};
let nextRef = 7_600_000_001;
let nextMessage = 1;

/** A fan of the page: his platform number and login. */
async function fanOn(pageLabel: string, username: string): Promise<string> {
  const ref = String(nextRef++);
  const id = (await testDb!.pool.query<{ id: string }>(
    "insert into fans (platform, platform_user_id, username) values ('fansly', $1, $2) returning id", [ref, username],
  )).rows[0]!.id;
  await testDb!.pool.query("insert into page_fans (fan_id, platform_account_id, is_subscriber) values ($1, $2, true)", [id, pages[pageLabel]]);
  return ref;
}

/** An order no fan was matched for: the buyer as the card names him, the fan's words in its card and in a message. */
async function orderOf(pageLabel: string | null, buyer: string): Promise<number> {
  const id = await recordCustomOrder(app, {
    pageId: pageLabel === null ? null : pages[pageLabel]!, fanId: null, buyer, conversationRef: null, deadlineOn: null,
    card: { task: "Ролик, скажи «привет» по имени", notes: "просил в чёрном", price: "100$" }, acceptedByUserId: null, origin: "import",
    actor: { door: "system" },
  });
  await addCustomOrderMessage(app.db, {
    orderId: id, telegramRef: `tg:2600000001/3/${2000 + nextMessage++}`, ordinal: 0, kind: "note", part: null, postedAt: null,
    author: "Чаттер", excerpt: "фан просил назвать его по имени", at: new Date(),
  });
  return id;
}

const read = async (id: number) => {
  const order = (await testDb!.pool.query("select buyer, card, fan_erased_at from custom_orders where id = $1", [id])).rows[0];
  const messages = (await testDb!.pool.query("select excerpt, author from custom_order_messages where order_id = $1", [id])).rows;
  return { buyer: order.buyer, task: order.card.task ?? null, erased: order.fan_erased_at !== null, excerpt: messages[0]?.excerpt ?? null };
};
const erase = async (fanRef: string) => {
  const erasureApp = { db: app.db, pool: testDb!.pool, config: app.config, logger: app.logger } as never;
  const scope = { scopeType: "fan", platform: "fansly", fanRef } as const;
  const plan = await planErasure(erasureApp, scope);
  await executeErasure(erasureApp, scope, { initiatedBy: ownerId });
  return plan;
};
const KEPT = { task: "Ролик, скажи «привет» по имени", erased: false, excerpt: "фан просил назвать его по имени" };
const TAKEN = { buyer: null, task: null, erased: true, excerpt: null };
const ordersIn = (plan: Awaited<ReturnType<typeof planErasure>>) => plan.targets.find((target) => target.target === "custom_orders")?.rows;

describe("a fan's erasure and the custom orders known only by a buyer's string", () => {
  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
    if (!testDb) return;
    app = createTestAppContext(testDb);
    await createUserAccount(app, { username: "boss", role: "owner", password: "boss-secret" }, { source: "cli" });
    ownerId = await fixtureUserId(app, "boss");
    const model = await createModel(app.db, { slug: "lora", name: "Lora" });
    for (const label of ["lora-1", "lora-2"]) pages[label] = (await createFanslyPage(app.db, { modelId: model!.id, label }))!.id;
  }, 180_000);

  afterAll(async () => {
    await testDb?.stop();
  });

  it("leaves an order alone when its buyer's login is more than one fan's of the order's page, and the plan says so", async (context) => {
    if (!testDb) return context.skip();
    // Three fans of the page carry one login (the platform gives a freed login to the next account).
    const [first, second, third] = [await fanOn("lora-1", "twin_login"), await fanOn("lora-1", "Twin_Login"), await fanOn("lora-1", "twin_login")];
    const byLogin = await orderOf("lora-1", "twin_login");
    const byLink = await orderOf("lora-1", "https://fansly.com/twin_login/posts");
    // His number names him alone, whatever his login: this order is his.
    const byNumber = await orderOf("lora-1", `Том (${first})`);

    const plan = await erase(first);
    expect(await read(byLogin)).toEqual({ ...KEPT, buyer: "twin_login" });
    expect(await read(byLink)).toEqual({ ...KEPT, buyer: "https://fansly.com/twin_login/posts" });
    expect(await read(byNumber)).toEqual(TAKEN);
    // The plan counts the order it takes and says how many it left because the login is not his alone.
    expect(ordersIn(plan)).toBe(1);
    expect(plan.customOrdersLeftAmbiguous).toBe(2);
    // The second of them: the link still names two fans of the page (the bare word is not his spelling at all).
    expect((await erase(second)).customOrdersLeftAmbiguous).toBe(1);
    expect(await read(byLogin)).toEqual({ ...KEPT, buyer: "twin_login" });
    expect(await read(byLink)).toEqual({ ...KEPT, buyer: "https://fansly.com/twin_login/posts" });
    // The last one: the login is his alone now, and the orders are his.
    expect((await erase(third)).customOrdersLeftAmbiguous).toBe(0);
    expect(await read(byLogin)).toEqual(TAKEN);
    expect(await read(byLink)).toEqual(TAKEN);

    // The login is one fan's of the order's page: a fan of another page with the same login does not get the order.
    const here = await fanOn("lora-1", "solo_login");
    const elsewhere = await fanOn("lora-2", "solo_login");
    const solo = await orderOf("lora-1", "@solo_login");
    const other = await erase(elsewhere);
    expect(await read(solo)).toEqual({ ...KEPT, buyer: "@solo_login" });
    expect(other.customOrdersLeftAmbiguous).toBe(1);
    const his = await erase(here);
    expect(await read(solo)).toEqual(TAKEN);
    expect(his.customOrdersLeftAmbiguous).toBe(0);
    // …and does not stand in the way of the page's own fan.
    const own = await fanOn("lora-1", "lone_login");
    await fanOn("lora-2", "lone_login");
    const lone = await orderOf("lora-1", "@lone_login");
    expect((await erase(own)).customOrdersLeftAmbiguous).toBe(0);
    expect(await read(lone)).toEqual(TAKEN);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("takes a bare word for a login only when it is the username letter for letter: «Alex» in another fan's order is a name", async (context) => {
    if (!testDb) return context.skip();
    const alex = await fanOn("lora-1", "alex");
    // Another fan's order, the buyer written by name; and orders that do name the fan `alex`.
    const name = await orderOf("lora-1", "Alex");
    const nameInBrackets = await orderOf("lora-1", "Саша (Alex)");
    const login = await orderOf("lora-1", "alex");
    const loginInBrackets = await orderOf("lora-1", "Саша (alex)");
    const handle = await orderOf("lora-1", "@Alex");
    const link = await orderOf("lora-1", "https://fansly.com/Alex/posts");

    const plan = await erase(alex);
    expect(await read(name)).toEqual({ ...KEPT, buyer: "Alex" });
    expect(await read(nameInBrackets)).toEqual({ ...KEPT, buyer: "Саша (Alex)" });
    for (const id of [login, loginInBrackets, handle, link]) expect(await read(id), `order ${id}`).toEqual(TAKEN);
    expect(ordersIn(plan)).toBe(4);
    expect(plan.customOrdersLeftAmbiguous).toBe(0);
  }, INTEGRATION_TEST_TIMEOUT_MS);
});
