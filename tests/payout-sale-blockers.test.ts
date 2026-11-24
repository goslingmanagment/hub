import { describe, expect, it } from "vitest";

import type { TeamLedgerPayoutPrepareResponse } from "@agency_hub_core/contracts";
import { listSaleClaims, type Database, type HandinSaleRow, type SaleBlockerPersonRow, type SaleClaimRow } from "@agency_hub_core/db";

import {
  payoutSaleBlockers,
  resolveBlockerPersonFromRoster,
  selectPayoutSaleBlockers,
  type BlockerPerson,
} from "../apps/runtime/src/services/payout-sale-blockers.ts";
import { listSaleQuestionsSaid, questionsMarkdown } from "../apps/runtime/src/services/sale-decisions-door.ts";
import {
  buildPayoutBriefModel,
  saleQuestionMatchHint,
  workboardPath,
} from "../apps/workboard/src/screens/payouts/briefModel.ts";
import { runHubCli } from "../packages/hub-agent-cli/src/main.ts";

/**
 * Canonical payout sale blockers selector (`payoutSaleBlockers`), Workboard's `PayoutBrief` zero-balance visibility,
 * `agentSaleQuestions --person`, and the `hub sale questions --person` CLI. Synthetic people, pages, and sales only.
 */

const ROSTER: readonly SaleBlockerPersonRow[] = [
  {
    personId: 101,
    code: "anna",
    displayName: "Аня",
    reportTag: "#anna",
    // Two logins: old disabled login 11 and active login 21.
    userIds: [11, 21],
    usernames: ["anna-old", "anna.k"],
    workingPageIds: [1, 2],
  },
  {
    personId: 102,
    code: "boris",
    displayName: "Боря",
    reportTag: "#boris",
    userIds: [12],
    usernames: ["boris.m"],
    workingPageIds: [1, 3],
  },
  {
    personId: 103,
    code: "vera",
    displayName: "Вера",
    reportTag: null,
    userIds: [13],
    usernames: ["vera.s"],
    workingPageIds: [3],
  },
];

function personOf(code: string): { person: BlockerPerson; others: BlockerPerson[] } {
  const resolved = resolveBlockerPersonFromRoster(code, ROSTER);
  if (resolved === null) throw new Error(`missing synthetic person ${code}`);
  return resolved;
}

function makeClaim(over: Partial<SaleClaimRow> & { id: number }): SaleClaimRow {
  return {
    transactionId: null,
    pageId: 1,
    kind: "question",
    claimantUserId: null,
    claimantHandinId: null,
    claimantVersion: null,
    statement: null,
    shareWithUserId: null,
    claimantNote: null,
    claimedAt: new Date("2026-11-12T10:00:00.000Z"),
    sideUserId: null,
    sideShiftId: null,
    state: "owner",
    answer: null,
    answerNote: null,
    answeredAt: null,
    answeredByUserId: null,
    answeredByAgentKeyId: null,
    answerDoor: null,
    answerRef: null,
    escalatedAt: new Date("2026-11-12T10:00:00.000Z"),
    escalatedWhy: "question",
    decisionId: null,
    closedAt: null,
    ledgerQuestionId: null,
    question: "Чья продажа?",
    whoText: null,
    ledgerRef: null,
    needsLink: true,
    createdAt: new Date("2026-11-12T10:00:00.000Z"),
    askedOf: "owner",
    sourceLink: null,
    askedByAgentKeyId: null,
    answerText: null,
    closeNote: null,
    origin: "version",
    silenceAt: null,
    ...over,
  };
}

function makeSale(over: Partial<HandinSaleRow> & { transactionId: number }): HandinSaleRow {
  return {
    pageId: 1,
    pageLabel: "mia-1",
    platform: "fansly",
    kind: "tip",
    occurredAt: new Date("2026-11-12T09:00:00.000Z"),
    netMills: 25_000,
    fan: { fanRef: "7700001001", name: "Fan One", username: "fan_one" },
    home: null,
    ...over,
  };
}

describe("resolveBlockerPersonFromRoster", () => {
  it("resolves a person by code, person id, any of their logins (old or new), or username", () => {
    for (const ref of ["anna", "ANNA", "101", "11", "21", "anna-old", "anna.k"]) {
      const resolved = resolveBlockerPersonFromRoster(ref, ROSTER);
      expect(resolved?.person.code, ref).toBe("anna");
      expect(resolved?.person.userIds, ref).toEqual([11, 21]);
      expect(resolved?.person.workingPageIds, ref).toEqual([1, 2]);
    }
    expect(resolveBlockerPersonFromRoster("ghost", ROSTER)).toBeNull();
  });
});

describe("selectPayoutSaleBlockers", () => {
  it("matches a person across multiple logins, multiple working pages, sale home shares, and Russian name inflections", () => {
    const { person, others } = personOf("anna");
    const claims: SaleClaimRow[] = [
      // 1. Linked via old disabled login 11 (party).
      makeClaim({ id: 1, kind: "claim", transactionId: 5001, pageId: 1, claimantUserId: 11, sideUserId: 12, statement: "mine", question: null }),
      // 2. Linked via active login 21 as share target (party).
      makeClaim({ id: 2, kind: "claim", transactionId: 5002, pageId: 2, claimantUserId: 12, sideUserId: null, shareWithUserId: 21, statement: "share", question: null }),
      // 3. Linked via sale_homes share on old login 11 (party) even when claim has different claimant.
      makeClaim({ id: 3, kind: "question", transactionId: 5003, pageId: 1, claimantUserId: 12, sideUserId: null, question: "Спор по PPV" }),
      // 4. Named in Russian dative case inside whoText («Ане и Боре») with no user ids.
      makeClaim({ id: 4, kind: "question", pageId: 3, whoText: "Ане и Боре", question: "Кому отдать?" }),
      // 5. Named by code in question body.
      makeClaim({ id: 5, kind: "imported", pageId: 1, question: "Проверить с anna по чату" }),
      // 6. Unattributed open question on her second working page (pageId: 2).
      makeClaim({ id: 6, kind: "question", pageId: 2, whoText: null, question: "Непонятно чей донат" }),
    ];
    const sales = new Map<number, HandinSaleRow>([
      [5001, makeSale({ transactionId: 5001, pageId: 1 })],
      [5002, makeSale({ transactionId: 5002, pageId: 2, pageLabel: "mia-2" })],
      [5003, makeSale({
        transactionId: 5003,
        pageId: 1,
        home: { home: "shift", reason: "last_write", pot: null, shares: [{ userId: 11, workRef: null, shiftId: null, mills: 25_000 }] },
      })],
    ]);

    const result = selectPayoutSaleBlockers({
      claims,
      sales,
      person,
      otherPeople: others,
      pageScope: "owner",
    });

    expect(result.coverage).toEqual({ state: "complete", reasons: [] });
    expect(result.matched.map((item) => [item.claim.id, item.match])).toEqual([
      [1, "party"],
      [2, "party"],
      [3, "party"],
      [4, "named"],
      [5, "named"],
      [6, "page"],
    ]);
  });

  it("excludes another person's disputes and questions (by login, by whoText, or on another page)", () => {
    const { person, others } = personOf("anna");
    const claims: SaleClaimRow[] = [
      // Boris vs Vera shift-report dispute on Anna's working page 1 -> excluded.
      makeClaim({ id: 10, kind: "claim", transactionId: 6001, pageId: 1, claimantUserId: 12, sideUserId: 13, statement: "mine", question: null }),
      // Question explicitly linked to Boris and Vera on Anna's working page 1 -> excluded.
      makeClaim({ id: 11, kind: "question", pageId: 1, claimantUserId: 12, sideUserId: 13, whoText: "Боря и Вера", question: "Чья продажа?" }),
      // Unlinked user ids, but whoText names ONLY Boris and Vera -> excluded for Anna.
      makeClaim({ id: 12, kind: "imported", pageId: 1, claimantUserId: null, sideUserId: null, whoText: "Боря и Вера", question: "Чья продажа?" }),
      // Unattributed question on page 3 (Vera/Boris's page, NOT Anna's working page) -> excluded.
      makeClaim({ id: 13, kind: "question", pageId: 3, claimantUserId: null, sideUserId: null, whoText: null, question: "Чья продажа на nova-1?" }),
      // Substring trap: «Таня» must NOT match «Аня».
      makeClaim({ id: 14, kind: "question", pageId: 3, whoText: "Таня", question: "Таня вела чат" }),
    ];

    const result = selectPayoutSaleBlockers({
      claims,
      sales: new Map(),
      person,
      otherPeople: others,
      pageScope: "owner",
    });

    expect(result.matched).toEqual([]);
    expect(result.coverage).toEqual({ state: "complete", reasons: [] });
  });

  it("surfaces unlinked/unattributed open questions (pageId null) to the owner, while omitting them for agent keys with partial coverage", () => {
    const { person, others } = personOf("anna");
    const unlinkedAll = makeClaim({ id: 20, kind: "imported", pageId: null, claimantUserId: null, sideUserId: null, whoText: null, question: "Без страницы и имени" });
    const unlinkedOther = makeClaim({ id: 21, kind: "imported", pageId: null, claimantUserId: 12, sideUserId: null, whoText: "Боря", question: "Борина продажа без страницы" });

    // Owner sees the unattributed null-page question (match: "unlinked"), NOT Boris's null-page question.
    const forOwner = selectPayoutSaleBlockers({
      claims: [unlinkedAll, unlinkedOther],
      sales: new Map(),
      person,
      otherPeople: others,
      pageScope: "owner",
    });
    expect(forOwner.matched.map((item) => [item.claim.id, item.match])).toEqual([[20, "unlinked"]]);
    expect(forOwner.coverage).toEqual({ state: "complete", reasons: [] });

    // Agent key with grant [1, 2] NEVER receives null-page rows, and gets honest partial coverage.
    const forAgent = selectPayoutSaleBlockers({
      claims: [],
      nullPageCandidates: [unlinkedAll, unlinkedOther],
      sales: new Map(),
      person,
      otherPeople: others,
      pageScope: [1, 2],
    });
    expect(forAgent.matched).toEqual([]);
    expect(forAgent.coverage).toEqual({ state: "partial", reasons: ["unlinked_questions_omitted"] });
  });

  it("reports incomplete coverage (pages_outside_key) when an agent key lacks one of the person's working pages and never leaks ungranted pages", () => {
    const { person, others } = personOf("anna");
    const onGranted = makeClaim({ id: 30, pageId: 1, claimantUserId: 21, question: "На доступной странице" });
    const onUngranted = makeClaim({ id: 31, pageId: 2, claimantUserId: 21, question: "На закрытой для ключа странице" });

    // Agent key only has page 1, while Anna works pages [1, 2].
    const result = selectPayoutSaleBlockers({
      claims: [onGranted, onUngranted],
      sales: new Map(),
      person,
      otherPeople: others,
      pageScope: [1],
    });

    expect(result.matched.map((item) => item.claim.id)).toEqual([30]);
    expect(result.coverage).toEqual({ state: "partial", reasons: ["pages_outside_key"] });

    // Markdown output also carries the partial-coverage warning so empty/partial lists never look complete.
    const md = questionsMarkdown([], result.coverage);
    expect(md).toContain("Покрытие неполное");
    expect(md).toContain("рабочим страницам");
  });

  it("applies access, date window, and person-relevance filtering BEFORE applying row limit", () => {
    const { person, others } = personOf("anna");
    const annaOld = makeClaim({
      id: 1,
      pageId: 1,
      claimantUserId: 11,
      claimedAt: new Date("2026-11-05T10:00:00.000Z"),
      question: "Старый открытый вопрос Ани",
    });
    // 500 newer unrelated questions (other people, other pages, ungranted pages) must NOT crowd out Anna's old row.
    const noise: SaleClaimRow[] = Array.from({ length: 500 }, (_, index) => makeClaim({
      id: 100 + index,
      pageId: index % 2 === 0 ? 1 : 3,
      claimantUserId: 12,
      sideUserId: 13,
      claimedAt: new Date(Date.parse("2026-11-10T00:00:00.000Z") + index * 60_000),
      question: `Чужой вопрос ${index}`,
    }));

    const result = selectPayoutSaleBlockers({
      claims: [...noise.reverse(), annaOld],
      sales: new Map(),
      person,
      otherPeople: others,
      pageScope: [1, 2],
      limit: 5,
    });

    expect(result.matched.map((item) => item.claim.id)).toEqual([1]);
    expect(result.coverage).toEqual({ state: "complete", reasons: [] });
  });

  it("filters inclusively by Moscow day window (from, to) using sale occurredAt, ledgerRef, or claimedAt", () => {
    const { person, others } = personOf("anna");
    const early = makeClaim({ id: 40, pageId: 1, claimantUserId: 21, transactionId: 7001, claimedAt: new Date("2026-11-15T10:00:00.000Z") });
    const inside = makeClaim({ id: 41, pageId: 1, claimantUserId: 21, transactionId: 7002, claimedAt: new Date("2026-11-15T11:00:00.000Z") });
    const late = makeClaim({ id: 42, pageId: 1, claimantUserId: 21, ledgerRef: { occurredAt: "2026-11-20T12:00:00+03:00" }, claimedAt: new Date("2026-11-20T12:00:00.000Z") });

    const sales = new Map<number, HandinSaleRow>([
      // 2026-11-09 22:00 UTC = 2026-11-10 01:00 MSK -> inside [2026-11-10, 2026-11-18]!
      [7001, makeSale({ transactionId: 7001, occurredAt: new Date("2026-11-08T12:00:00.000Z") })],
      [7002, makeSale({ transactionId: 7002, occurredAt: new Date("2026-11-09T22:00:00.000Z") })],
    ]);

    const result = selectPayoutSaleBlockers({
      claims: [early, inside, late],
      sales,
      person,
      otherPeople: others,
      pageScope: "owner",
      from: "2026-11-10",
      to: "2026-11-18",
    });

    expect(result.matched.map((item) => item.claim.id)).toEqual([41]);
  });
});

describe("PayoutBrief zero-balance visibility", () => {
  it("keeps ledger flags and open sale questions visible even when balance is zero (nothing)", () => {
    const zeroBrief: TeamLedgerPayoutPrepareResponse = {
      slug: "anna",
      name: "Аня",
      generatedAt: "2026-11-20T10:00:00.000Z",
      amountMills: 0,
      nothing: "долга нет: платить нечего",
      toPayMills: 0,
      period: null,
      lines: [],
      flags: [
        { kind: "hub_decision", blocker: true, text: "решение Hub №12: ожидаемая доля не засчитана" },
        { kind: "board_post", blocker: false, text: "пост за 18.11 расходится с отчётом Hub" },
      ],
      blockers: 1,
      saleQuestions: [{
        id: 88,
        kind: "question",
        transactionId: 90_001,
        pageLabel: "mia-1",
        netMills: 44_000,
        occurredAt: "2026-11-18T12:00:00.000Z",
        askedAt: "2026-11-19T09:00:00.000Z",
        askedOf: "owner",
        who: "Аня и Боря",
        text: "Чья продажа по кастому?",
        match: "party",
        link: "/workboard/waiting?dispute=90001#questions",
        sourceLink: null,
      }],
      saleQuestionsCoverage: { state: "complete", reasons: [] },
      suggestion: null,
      message: null,
      placeholder: null,
    };

    const model = buildPayoutBriefModel(zeroBrief);
    expect(model.isZero).toBe(true);
    expect(model.nothingText).toBe("долга нет: платить нечего");
    expect(model.blockers).toEqual([{ kind: "hub_decision", blocker: true, text: "решение Hub №12: ожидаемая доля не засчитана" }]);
    expect(model.notes).toEqual([{ kind: "board_post", blocker: false, text: "пост за 18.11 расходится с отчётом Hub" }]);
    expect(model.showSaleQuestionsBlock).toBe(true);
    expect(model.saleQuestions).toHaveLength(1);
    expect(model.hasBlockers).toBe(true);
    expect(workboardPath(model.saleQuestions[0]!.link)).toBe("/waiting?dispute=90001#questions");
    expect(saleQuestionMatchHint("unlinked")).toBe("не привязан — проверьте");
    expect(saleQuestionMatchHint("page")).toBe("на его странице — проверьте");
    expect(saleQuestionMatchHint("party")).toBeUndefined();
  });

  it("shows partial coverage note when a ledger person is absent from Hub registry even with zero open questions", () => {
    const partialBrief: TeamLedgerPayoutPrepareResponse = {
      slug: "vika",
      name: "Вика",
      generatedAt: "2026-11-20T10:00:00.000Z",
      amountMills: 0,
      nothing: "долга нет: платить нечего",
      toPayMills: 0,
      period: null,
      lines: [],
      flags: [],
      blockers: 0,
      saleQuestions: [],
      saleQuestionsCoverage: { state: "partial", reasons: ["person_not_in_hub"] },
      suggestion: null,
      message: null,
      placeholder: null,
    };

    const model = buildPayoutBriefModel(partialBrief);
    expect(model.showSaleQuestionsBlock).toBe(true);
    expect(model.coverageNote).toContain("реестре Hub");
  });
});

describe("hub sale questions --person CLI", () => {
  it("forwards --person, --from, --to, --open and --md to agentSaleQuestions", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new Proxy({}, {
      get: (_target, operation) => async (input: unknown) => {
        calls.push({ operation: String(operation), input });
        return {
          questions: [],
          markdown: "",
          coverage: { state: "complete", reasons: [] },
          serverNow: "2026-11-20T10:00:00.000Z",
        };
      },
    });

    const result = await runHubCli({
      argv: ["sale", "questions", "--open", "--person", "anna", "--from", "2026-11-10", "--to", "2026-11-20", "--md"],
      env: { HUB_AGENT_KEY: "test-key" },
      readFile: () => null,
      createHubClient: () => client as never,
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{
      operation: "agentSaleQuestions",
      input: { query: { open: "true", format: "md", person: "anna", from: "2026-11-10", to: "2026-11-20" } },
    }]);
  });
});

describe("SQL pre-limit filtering and agentSaleQuestions delegation to payoutSaleBlockers", () => {
  function flattenSql(node: unknown, params: unknown[] = []): { sql: string; params: unknown[] } {
    if (node !== null && typeof node === "object") {
      if ("queryChunks" in node && Array.isArray((node as { queryChunks: unknown[] }).queryChunks)) {
        const parts = (node as { queryChunks: unknown[] }).queryChunks.map((chunk) => flattenSql(chunk, params).sql);
        return { sql: parts.join(""), params };
      }
      if ("value" in node && Array.isArray((node as { value: unknown[] }).value) && (node as { value: unknown[] }).value.every((v) => typeof v === "string")) {
        return { sql: (node as { value: string[] }).value.join(""), params };
      }
      if ("value" in node) {
        params.push((node as { value: unknown }).value);
        return { sql: `$${params.length}`, params };
      }
    }
    params.push(node);
    return { sql: `$${params.length}`, params };
  }

  function makeStubDb(responder: (sqlText: string, params: unknown[]) => Record<string, unknown>[]) {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      execute: async (query: unknown) => {
        const compiled = flattenSql(query);
        executed.push({ sql: compiled.sql, params: compiled.params });
        return { rows: responder(compiled.sql, compiled.params), rowCount: 0 };
      },
    } as unknown as Database;
    return { db, executed };
  }

  it("listSaleClaims pushes pageIds and realm filters into SQL BEFORE limit and omits LIMIT when limit is null", async () => {
    const { db, executed } = makeStubDb(() => []);
    await listSaleClaims(db, {
      kinds: ["question", "imported"],
      states: ["owner", "asked"],
      pageIds: [1, 2],
      realm: "live",
      limit: 200,
    });
    expect(executed).toHaveLength(1);
    const first = executed[0]!.sql.toLowerCase();
    expect(first).toContain("c.page_id = any(");
    expect(first).toContain("is_test");
    expect(first.indexOf("c.page_id = any(")).toBeLessThan(first.indexOf("limit"));

    // Empty page grant without includeNullPage returns immediately without touching SQL.
    expect(await listSaleClaims(db, { pageIds: [], realm: "live" })).toEqual([]);
    expect(executed).toHaveLength(1);

    // limit: null runs without a SQL LIMIT so person-relevance runs before any cap.
    await listSaleClaims(db, { states: ["owner", "asked"], realm: "live", limit: null });
    expect(executed[1]!.sql.toLowerCase()).not.toContain("limit");
  });

  it("listSaleQuestionsSaid with person delegates to payoutSaleBlockers, respects realm, and throws 404 for unknown person", async () => {
    const { db, executed } = makeStubDb((sqlText) => {
      if (sqlText.includes("from people p")) {
        return [{
          person_id: 101,
          code: "anna",
          display_name: "Аня",
          report_tag: "#anna",
          user_ids: [11, 21],
          usernames: ["anna-old", "anna.k"],
          working_page_ids: [1, 2],
        }];
      }
      if (sqlText.includes("from sale_claims c")) {
        if (sqlText.includes("c.page_id is null")) return [];
        return [{
          id: 77,
          transaction_id: 5001,
          page_id: 1,
          kind: "claim",
          claimant_user_id: 11,
          claimant_handin_id: 9,
          claimant_version: 1,
          statement: "mine",
          share_with_user_id: null,
          claimant_note: "фан мой",
          claimed_at: new Date("2026-11-12T10:00:00.000Z"),
          side_user_id: 12,
          side_shift_id: null,
          state: "owner",
          answer: "disagree",
          answer_note: "писал позже",
          answered_at: new Date("2026-11-12T11:00:00.000Z"),
          answered_by_user_id: 12,
          answered_by_agent_key_id: null,
          answer_door: "workboard",
          answer_ref: null,
          escalated_at: new Date("2026-11-12T11:00:00.000Z"),
          escalated_why: "disagree",
          decision_id: null,
          closed_at: null,
          ledger_question_id: null,
          question: null,
          who_text: null,
          ledger_ref: null,
          needs_link: false,
          created_at: new Date("2026-11-12T10:00:00.000Z"),
          asked_of: null,
          source_link: null,
          asked_by_agent_key_id: null,
          answer_text: null,
          close_note: null,
          origin: "version",
          silence_at: null,
        }];
      }
      if (sqlText.includes("from transactions t") && sqlText.includes("sale_homes")) {
        return [{
          id: 5001,
          page_id: 1,
          label: "mia-1",
          platform: "fansly",
          kind: "tip",
          occurred_at: new Date("2026-11-12T09:00:00.000Z"),
          net: 25_000,
          fan_ref: "7700001001",
          fan_name: "Fan One",
          fan_username: "fan_one",
          home: null,
          reason: null,
          pot: null,
          shares: null,
        }];
      }
      if (sqlText.includes("from transactions t left join fans")) {
        return [{ id: 5001, fan_ref: "7700001001", name: "Fan One", username: "fan_one" }];
      }
      if (sqlText.includes("from users u left join person_logins")) {
        return [{ id: 11, name: "Аня" }, { id: 12, name: "Боря" }];
      }
      if (sqlText.includes("select id, label from pages")) {
        return [{ id: 1, label: "mia-1" }];
      }
      return [];
    });

    const app = { db, config: {}, logger: { warn: () => undefined } } as never;
    const answer = await listSaleQuestionsSaid(app, {
      pageIds: [1],
      realm: "live",
      open: true,
      format: "md",
      person: "anna",
    }, new Date("2026-11-20T12:00:00.000Z"));

    // Returned Anna's open dispute matched via her disabled old login 11, and flagged partial coverage (page 2 outside key).
    expect(answer.questions).toHaveLength(1);
    expect(answer.questions[0]).toMatchObject({
      id: 77,
      transactionId: 5001,
      pageLabel: "mia-1",
      netMills: 25_000,
      kind: "claim",
      match: "party",
      askedOf: "owner",
      who: "Аня и Боря",
      status: "open",
    });
    expect(answer.coverage).toEqual({ state: "partial", reasons: ["pages_outside_key"] });
    expect(answer.markdown).toContain("Покрытие неполное");
    expect(executed.some((entry) => entry.sql.includes("from sale_claims c") && !entry.sql.toLowerCase().includes("limit"))).toBe(true);

    // Unknown (or cross-realm) person throws 404 through agentSaleQuestions.
    await expect(listSaleQuestionsSaid(app, {
      pageIds: [1],
      realm: "live",
      open: true,
      format: "json",
      person: "missing-person",
    })).rejects.toMatchObject({ statusCode: 404 });

    // Owner read (requirePerson=false) does not 404 for a ledger-only person; reports partial coverage.
    const ownerMissing = await payoutSaleBlockers(app, {
      person: "ledger-only",
      fallbackName: "Вика",
      pageScope: "owner",
      realm: "live",
    });
    expect(ownerMissing.person).toBeNull();
    expect(ownerMissing.coverage).toEqual({ state: "partial", reasons: ["person_not_in_hub"] });
  });
});
