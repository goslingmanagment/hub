// WP-F0(c)(ii) / §9.3 — the permanent erasure column-shape ratchet.
//
// THE GAP IT CLOSES. The Stage 28.4 erasure module's only AUTOMATIC guard
// enumerates non-cascade foreign keys to `fans` and fails on an unmapped one
// (`erasure/index.ts`, FAN_FK_CURATED). Every fan reference this initiative
// adds — order buyers, message-offer fans, and later likers, comment authors,
// notification correlation refs — is a TEXT platform ref with NO foreign key.
// The FK guard is structurally blind to all of them.
//
// The precedent proves it is not hypothetical: `tip_sender_platform_user_id`
// on `creator_post_tips` had to be hand-added to the erasure inventory,
// because nothing would have noticed its absence. An unlisted table
// UNDER-ERASES SILENTLY — a fan asks to be forgotten, the run reports success,
// and their purchases stay.
//
// So: discover the fan-ref-shaped columns from `information_schema` at run
// time and require each one to be either a declared fan-scope erasure target
// (`FAN_REF_ERASURE_COLUMNS`, in the erasure module itself) or an explicitly
// justified allowlist entry. A new fan-ref column lands untargeted ⇒ this fails
// at the PR that introduces it.
//
// COLUMN-scoped, not table-scoped, and that is the whole point of the second
// revision: erasure targets carry only a table name, so collapsing a column to
// its table would let a NEW fan-ref column on an ALREADY-targeted table pass
// while no predicate touches it. That is the same silent under-erasure in a
// place the first version of this ratchet declared safe.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFanslyPage, createModel } from "@agency_hub_core/db";

import {
  FAN_REF_ERASURE_COLUMNS,
  planErasure,
} from "../apps/runtime/src/services/erasure/index.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

let testDb: StartedTestDatabase | null = null;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

/**
 * The shapes a fan reference takes in this schema. `%…%` is deliberate: a
 * column called `original_buyer_platform_user_id` is the same fact under a
 * different name and must not slip past a `=` match.
 */
const FAN_REF_COLUMN_PATTERNS = [
  "%buyer_platform_user_id%",
  "%liker_platform_user_id%",
  "%fan_platform_user_id%",
  "%sender_platform_user_id%",
  "author_ref",
  "correlation_ref",
  "correlation_group_ref",
];

/**
 * Columns that NO fan-scope erasure target reaches, each with the one line that
 * says why that is lawful — or, where it is not, that says so out loud. An
 * entry here is a claim a reviewer can check, not a way to make the test green.
 */
const JUSTIFIED_NON_TARGETS = new Map<string, string>([
  [
    "media_offer_locations.correlation_ref",
    "NOT A FAN REF, and it only reaches this list because `correlation_ref` is one of the "
    + "shapes the pattern list hunts for. On `creatorMediaOfferLocations[]` (WP-F1, A17-5) the "
    + "column carries the CARRIER object a media offer was placed on — a post id or a message "
    + "id — while the account on the row is the CREATOR (`owner_account_ref`). Verified against "
    + "the live shape: all eleven keys are id-relations between the creator's own media, offers, "
    + "bundles and walls, and no fan appears anywhere in the row. Erasing a fan must not delete "
    + "the creator's own placement record, which is what a predicate here would do.",
  ],
  [
    "ofapi_spend_projection_events.fan_platform_user_id",
    "PRE-EXISTING GAP, surfaced by this ratchet at its introduction and recorded "
    + "rather than silently fixed: migration 0036's shadow/audit projection carries a fan "
    + "ref and is in no erasure plan. Backlog item — it is out of WP-F0's scope to change "
    + "the erasure surface of an unrelated OFAPI table, and listing it here is what stops "
    + "it from being invisible.",
  ],
]);

/**
 * The declaration under test, indexed. It is COLUMN-scoped on purpose: erasure
 * targets carry only a table name, so collapsing a column to its table asks the
 * wrong question — a NEW fan-ref column on an already-targeted table would pass
 * a table-scoped check while no predicate touches it, which is the exact shape
 * of a silent under-erasure.
 */
const DECLARED = new Map(FAN_REF_ERASURE_COLUMNS.map((entry) => [entry.column, entry]));

describe("erasure column-shape ratchet (§9.3)", () => {
  it("targets every fan-ref-shaped column in the schema, or justifies the exception", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);

    const discovered = (await testDb.pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'subject_refresh_state' and column_name = 'subject_ref')
            or (table_name = 'follower_outreach_attempts' and column_name = 'fan_ref')
            -- chat-extension tables (0241 on): every client_* fan_ref is a fan id.
            or (left(table_name, 7) = 'client_' and column_name = 'fan_ref') or ${
        FAN_REF_COLUMN_PATTERNS.map((_, index) => `column_name like $${index + 1}`).join(" or ")
      })
        order by table_name, column_name`,
      FAN_REF_COLUMN_PATTERNS,
    )).rows.map((row) => `${row.table_name}.${row.column_name}`);

    // Non-vacuous: the discovery must actually see the columns this package
    // added, or a broken query would make the ratchet pass by finding nothing.
    expect(discovered).toContain("media_orders.buyer_platform_user_id");
    expect(discovered).toContain("message_media_offers.fan_platform_user_id");
    expect(discovered).toContain("follower_outreach_attempts.fan_ref");
    expect(discovered).toContain("client_send_custody.fan_ref");
    expect(discovered).toContain("client_greetings.fan_ref");
    expect(discovered).toContain("client_fan_leases.fan_ref");
    expect(discovered.length).toBeGreaterThan(4);

    // A plan for a fan nobody has ever seen still enumerates every target the
    // module would touch — which is exactly the inventory under test.
    const model = await createModel(testDb.db, { slug: "ratchet", name: "Ratchet" });
    if (!model) {
      throw new Error("Expected the ratchet test model to be created");
    }
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "ratchet-page" });
    if (!page) {
      throw new Error("Expected the ratchet test page to be created");
    }
    const plan = await planErasure(
      { db: testDb.db, pool: testDb.pool, config: {}, logger: {} } as never,
      { scopeType: "fan", platform: "fansly", fanRef: "fan-ratchet-probe" },
    );
    const hotTargets = plan.targets.filter((target) => target.plane === "hot");
    const targetNames = new Set(hotTargets.map((target) => target.target));

    // (1) Every discovered column is DECLARED (a named target reaches it) or
    // JUSTIFIED (a written reason why nothing does). No third option.
    const undeclared = discovered.filter((column) =>
      !DECLARED.has(column) && !JUSTIFIED_NON_TARGETS.has(column)
    );
    expect(
      undeclared,
      "fan-ref columns that are neither a declared erasure target nor justified — an "
        + "untargeted fan ref UNDER-ERASES SILENTLY (the run reports success and the rows "
        + "stay). Add it to FAN_REF_ERASURE_COLUMNS with the predicate that reaches it, or "
        + "to JUSTIFIED_NON_TARGETS with the reason nothing does",
    ).toEqual([]);

    // (2) Every declaration is honest about the plan it points at: the column
    // exists, the target is one the fan-scope plan actually emits, and the
    // stated REACH matches the target's action. A declaration naming a target
    // that no longer exists would be a promise the plan stopped keeping.
    expect(new Set(FAN_REF_ERASURE_COLUMNS.map((entry) => entry.column)).size)
      .toBe(FAN_REF_ERASURE_COLUMNS.length);
    for (const entry of FAN_REF_ERASURE_COLUMNS) {
      expect(discovered, `${entry.column}: declared but not present in the schema`)
        .toContain(entry.column);
      expect(
        targetNames.has(entry.target),
        `${entry.column}: declared target "${entry.target}" is not in the fan-scope plan`,
      ).toBe(true);
      const actions = hotTargets.filter((target) => target.target === entry.target)
        .map((target) => target.action);
      if (entry.reach === "cascade") {
        expect(actions, `${entry.column}: declared as cascade-reached`).toContain("cascade");
      } else {
        expect(
          actions.some((action) => action !== "cascade"),
          `${entry.column}: declared as predicate-reached, but "${entry.target}" is only a `
            + "counted cascade target — no predicate names this column",
        ).toBe(true);
      }
      expect(
        JUSTIFIED_NON_TARGETS.has(entry.column),
        `${entry.column}: declared AND justified — pick one`,
      ).toBe(false);
    }

    // (3) Orphan check: a justification for a column that no longer exists, or
    // for one that IS now declared, is stale and must be deleted rather than
    // left to make the list look more considered than it is.
    for (const [column, justification] of JUSTIFIED_NON_TARGETS) {
      expect(discovered, `${column}: justified but not present in the schema`).toContain(column);
      expect(justification.length, `${column}: justification too thin`).toBeGreaterThan(60);
    }
  });

  it("names the WP-F0 media-plane tables as fan-scope targets", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
    const model = await createModel(testDb.db, { slug: "ratchet2", name: "Ratchet2" });
    if (!model) {
      throw new Error("Expected the ratchet test model to be created");
    }
    const page = await createFanslyPage(testDb.db, { modelId: model.id, label: "ratchet-page-2" });
    if (!page) {
      throw new Error("Expected the ratchet test page to be created");
    }

    const plan = await planErasure(
      { db: testDb.db, pool: testDb.pool, config: {}, logger: {} } as never,
      { scopeType: "fan", platform: "fansly", fanRef: "fan-ratchet-probe" },
    );
    const targeted = plan.targets.filter((target) => target.plane === "hot")
      .map((target) => target.target);
    // media_orders says WHO bought WHAT for HOW MUCH; message_media_offers says
    // what was offered in the fan's conversation. Both carry a TEXT fan ref
    // with no FK, so only this list keeps them reachable.
    expect(targeted).toContain("media_orders");
    expect(targeted).toContain("message_media_offers");
    // The precedent that proves the FK guard cannot find these on its own.
    expect(targeted).toContain("creator_post_tips");
  });
});
