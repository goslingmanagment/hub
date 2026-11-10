import { describe, expect, it } from "vitest";

import { readTeamLedgerQuestions } from "../apps/runtime/src/services/ledger-questions.ts";

/**
 * The open questions «whose is this sale» from the agency ledger for the owner's Решения: micro-dollars in, mills out,
 * split by whom they wait for, the oldest first, either spelling of a field; never a wrong row on a changed answer.
 * The questions may still be closed to Hub's key: that is «none yet», not a 503.
 */

function app(logs: { info: unknown[]; warn: unknown[] } = { info: [], warn: [] }) {
  return {
    config: { ledgerUrl: "https://ledger.test", ledgerPayoutsKey: "test-payouts-key" },
    logger: { warn: (details: unknown) => logs.warn.push(details), info: (_details: unknown, message: string) => logs.info.push(message) },
  } as never;
}

function question(overrides: Record<string, unknown> = {}) {
  return {
    id: 11, page_label: "page-a", fan_ref: "fan-1", fan_name: "nick", transaction_ref: "tx-1", net_micros: 42_500_000,
    occurred_at: "2026-11-08T18:10:00+03:00", question: "Кастом делали двое: чья продажа?", asked_of: "owner", who: "anna, boris",
    asked_at: "2026-11-01T12:00:00+03:00", source_link: "https://t.me/c/1000000001/4/77", note: "Договорилась anna, отдал boris.",
    status: "open", decision_id: null, answer: "", closed_at: null, created_at: "2026-11-01T12:00:05+03:00",
    ...overrides,
  };
}

function ledger(answer: { status: number; body: unknown }, seen: string[] = []) {
  return (async (input: URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname}?${url.searchParams.toString()} ${new Headers(init?.headers).get("authorization")}`);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const now = new Date("2026-11-09T10:00:00Z");

describe("readTeamLedgerQuestions", () => {
  it("reads the open questions with Hub's key, in mills, split by whom they wait for, the oldest first", async () => {
    const seen: string[] = [];
    const body = {
      questions: [
        question({ id: 12, asked_at: "2026-11-05T09:00:00Z" }),
        question(),
        // Not paid yet: no sale, no sum, no time; no page and no link either.
        question({ id: 13, page_label: "", transaction_ref: null, net_micros: null, occurred_at: null, source_link: "", note: null, who: null }),
        question({ id: 14, asked_of: "chatters", asked_at: "2026-11-02T08:00:00Z" }),
      ],
    };
    const result = await readTeamLedgerQuestions(app(), { fetchImpl: ledger({ status: 200, body }, seen), now });

    expect(seen).toEqual(["/v1/questions?open=1 Bearer test-payouts-key"]);
    // The oldest asked first; asked at the same time, by id.
    expect(result.owner.map((one) => one.id)).toEqual([11, 13, 12]);
    expect(result.chatters.map((one) => one.id)).toEqual([14]);
    expect(result.owner[0]).toEqual({
      id: 11, pageLabel: "page-a", fanRef: "fan-1", fanName: "nick", transactionRef: "tx-1", netMills: 42_500,
      occurredAt: "2026-11-08T15:10:00.000Z", question: "Кастом делали двое: чья продажа?", who: "anna, boris",
      askedAt: "2026-11-01T09:00:00.000Z", sourceLink: "https://t.me/c/1000000001/4/77", note: "Договорилась anna, отдал boris.",
    });
    expect(result.owner[1]).toMatchObject({ id: 13, pageLabel: "", transactionRef: null, netMills: null, occurredAt: null, sourceLink: null, note: "", who: "" });
    expect(result).toMatchObject({ questionsRead: true, serverNow: now.toISOString() });
  });

  it("takes camelCase too, a number for a reference, no optional fields at all; a closed one or a link that is not the web is left out", async () => {
    const body = {
      questions: [
        { id: "21", pageLabel: "page-b", fanRef: 7001, question: "Подписку оформил один, закрыл другой?", askedOf: "chatters", askedAt: "2026-11-03T10:00:00Z", sourceLink: "javascript:alert(1)", netMicros: 9_990_000 },
        { id: 22, question: "Чья?", createdAt: "2026-11-04T10:00:00Z" },
        question({ id: 23, status: "closed", closed_at: "2026-11-08T10:00:00Z" }),
      ],
    };
    const result = await readTeamLedgerQuestions(app(), { fetchImpl: ledger({ status: 200, body }), now });
    expect(result.chatters).toEqual([{
      id: 21, pageLabel: "page-b", fanRef: "7001", fanName: null, transactionRef: null, netMills: 9_990, occurredAt: null,
      question: "Подписку оформил один, закрыл другой?", who: "", askedAt: "2026-11-03T10:00:00.000Z", sourceLink: null, note: "",
    }]);
    // Asked of nobody known: the owner's — a question never silently disappears.
    expect(result.owner.map((one) => ({ id: one.id, askedAt: one.askedAt, pageLabel: one.pageLabel }))).toEqual([{ id: 22, askedAt: "2026-11-04T10:00:00.000Z", pageLabel: "" }]);
  });

  it("answers «none yet» while the ledger refuses Hub the questions, said once in the log", async () => {
    const logs = { info: [] as unknown[], warn: [] as unknown[] };
    for (const status of [404, 403, 404]) {
      const result = await readTeamLedgerQuestions(app(logs), { fetchImpl: ledger({ status, body: { error: "no" } }), now });
      expect(result).toEqual({ owner: [], chatters: [], questionsRead: false, serverNow: now.toISOString() });
    }
    expect(logs.info).toHaveLength(1);
    // An empty list of Go is none, read.
    expect(await readTeamLedgerQuestions(app(), { fetchImpl: ledger({ status: 200, body: { questions: null } }), now })).toMatchObject({ owner: [], chatters: [], questionsRead: true });
  });

  it("is a 503 on a changed answer and on any other refusal", async () => {
    const fails = async (answer: { status: number; body: unknown }) => {
      const logs = { info: [] as unknown[], warn: [] as unknown[] };
      await expect(readTeamLedgerQuestions(app(logs), { fetchImpl: ledger(answer), now })).rejects.toMatchObject({ statusCode: 503 });
      return logs;
    };
    expect((await fails({ status: 200, body: { questions: [question({ net_micros: "42.50" })] } })).warn).toHaveLength(1);
    expect((await fails({ status: 200, body: { questions: [question({ question: null })] } })).warn).toHaveLength(1);
    expect((await fails({ status: 200, body: { questions: [question({ asked_at: "вчера", created_at: "" })] } })).warn).toHaveLength(1);
    expect((await fails({ status: 200, body: { items: [] } })).warn).toHaveLength(1);
    await fails({ status: 500, body: { error: "no" } });
    await fails({ status: 401, body: { error: "no" } });
  });

  it("is a 503 without asking when the ledger is not connected", async () => {
    const seen: string[] = [];
    const unconnected = { config: { ledgerUrl: "https://ledger.test", ledgerPayoutsKey: null }, logger: { warn() {}, info() {} } } as never;
    await expect(readTeamLedgerQuestions(unconnected, { fetchImpl: ledger({ status: 200, body: { questions: [] } }, seen), now })).rejects.toMatchObject({ statusCode: 503 });
    expect(seen).toEqual([]);
  });
});
