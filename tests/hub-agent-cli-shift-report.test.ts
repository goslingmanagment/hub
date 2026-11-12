import { describe, expect, it } from "vitest";

import { KernelApiError } from "@kernel/sdk";

import { runHubCli } from "../packages/hub-agent-cli/src/main.ts";

/**
 * `hub shift-report …`: Gengar's /smena writes a person's shift report «со слов».
 *
 * The client is a stub: who may write what is the routes' own test
 * (tests/shift-handins.integration.test.ts). Here, what the CLI itself promises:
 * a hand-in never leaves without the person's message and its sender, «мимо
 * площадки» goes through the money codec, «делим с <name>» names exactly one
 * colleague of the report, and a refusal comes back with its reason.
 */

const SENDER = "700000111";
const MESSAGE = "https://t.me/c/2600000001/2004";

function report(over: Record<string, unknown> = {}) {
  return {
    shift: {
      id: 41, userId: 5, personName: "Anna", ongoing: false, startedAt: "2026-11-10T15:00:00.000Z",
      endedAt: "2026-11-10T23:00:00.000Z", workedMinutes: 480, reportDate: "2026-11-10", pages: ["mia-1"],
    },
    access: "own",
    enabled: true,
    canEdit: true,
    state: "open",
    latest: null,
    versions: [],
    view: { source: "draft", totalMills: 12_340, lines: [], offPlatform: [], comment: "", pages: [] },
    afterSubmission: null,
    posts: [],
    colleagues: [{ userId: 12, name: "Bella" }, { userId: 13, name: "Cora" }],
    serverNow: "2026-11-11T00:00:00.000Z",
    ...over,
  };
}

function hub(answers: Record<string, (input: unknown) => unknown>) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const client = new Proxy({}, {
    get: (_target, operation) => async (input: unknown) => {
      calls.push({ operation: String(operation), input });
      const answer = answers[String(operation)];
      if (answer === undefined) throw new Error(`unexpected call ${String(operation)}`);
      return answer(input);
    },
  });
  const run = (argv: string[]) => runHubCli({ argv, env: { HUB_AGENT_KEY: "t" }, readFile: () => null, createHubClient: () => client as never });
  return { calls, run };
}

describe("hub shift-report", () => {
  it("hands a shift in only with the person's message and its sender: without either nothing is sent", async () => {
    const submitted = report({
      state: "submitted",
      latest: { version: 1, submittedAt: "2026-11-11T00:01:00.000Z", door: "telegram", by: "gengar", totalMills: 12_340 },
    });
    const { calls, run } = hub({ agentShiftReportSubmit: () => submitted });
    for (const argv of [
      ["--sender", SENDER],
      ["--message", MESSAGE],
      ["--sender", SENDER, "--message", "   "],
      ["--sender", "0", "--message", MESSAGE],
    ]) {
      const refused = await run(["shift-report", "submit", "--shift", "41", ...argv]);
      expect(refused.exitCode, argv.join(" ")).toBe(4);
    }
    expect(calls).toEqual([]);

    const done = await run(["shift-report", "submit", "--shift", "41", "--sender", SENDER, "--message", MESSAGE]);
    expect(done.exitCode).toBe(0);
    expect(calls).toEqual([{
      operation: "agentShiftReportSubmit",
      input: { body: { shiftId: 41, telegramUserId: 700_000_111, sourceRef: MESSAGE } },
    }]);
    expect(done.document).toMatchObject({ ok: true, data: { latest: { version: 1, door: "telegram" } } });
  });

  it("takes «мимо площадки» in dollars and sends mills through the codec", async () => {
    const { calls, run } = hub({ agentShiftReportOffPlatformAdd: () => ({ line: {}, savedAt: "2026-11-11T00:00:00.000Z" }) });
    const add = (amount: string) => run([
      "shift-report", "off-platform", "--shift", "41", "--amount", amount, "--from-whom", "фан", "--what-for", "кастом",
      "--sender", SENDER,
    ]);
    expect((await add("49.99")).exitCode).toBe(0);
    expect((await add("50")).exitCode).toBe(0);
    expect(calls.map((call) => (call.input as { body: { amountMills: number } }).body.amountMills)).toEqual([49_990, 50_000]);
    expect(calls[0]!.input).toEqual({
      body: { shiftId: 41, amountMills: 49_990, fromWhom: "фан", whatFor: "кастом", telegramUserId: 700_000_111 },
    });
    // Nothing, a negative, words, and more than the route's ceiling ($100,000) never leave.
    for (const bad of ["0", "-5", "fifty", "100000.01"]) {
      expect((await add(bad)).exitCode, bad).toBe(4);
    }
    expect(calls).toHaveLength(2);
  });

  it("names the colleague of «делим с…» by user id, or by one name of the report's colleagues", async () => {
    const { calls, run } = hub({ agentShiftReport: () => report(), agentShiftReportLineSet: () => ({ savedAt: "2026-11-11T00:00:00.000Z" }) });
    const line = (...argv: string[]) => run(["shift-report", "line", "--shift", "41", "--sale", "9001", "--sender", SENDER, ...argv]);

    expect((await line("--statement", "share", "--share-with", "bella")).exitCode).toBe(0);
    expect(calls).toEqual([
      { operation: "agentShiftReport", input: { query: { shiftId: 41 } } },
      {
        operation: "agentShiftReportLineSet",
        input: { body: { shiftId: 41, transactionId: 9001, statement: "share", shareWithUserId: 12, telegramUserId: 700_000_111 } },
      },
    ]);

    // A name of nobody on the report: refused with the colleagues to choose from, no word written.
    calls.length = 0;
    const unknown = await line("--statement", "share", "--share-with", "Dora");
    expect(unknown.exitCode).toBe(4);
    expect(unknown.document).toMatchObject({ error: { details: { colleagues: [{ userId: 12 }, { userId: 13 }] } } });
    expect(calls.map((call) => call.operation)).toEqual(["agentShiftReport"]);

    // A user id goes as it is; «share» without a colleague, or a colleague without «share», never leaves.
    calls.length = 0;
    expect((await line("--statement", "share", "--share-with", "13")).exitCode).toBe(0);
    expect((await line("--statement", "share")).exitCode).toBe(4);
    expect((await line("--statement", "not_mine", "--share-with", "13")).exitCode).toBe(4);
    // «rule» takes the person's word back: statement null.
    expect((await line("--statement", "rule", "--message", MESSAGE)).exitCode).toBe(0);
    expect(calls.map((call) => call.input)).toEqual([
      { body: { shiftId: 41, transactionId: 9001, statement: "share", shareWithUserId: 13, telegramUserId: 700_000_111 } },
      { body: { shiftId: 41, transactionId: 9001, statement: null, telegramUserId: 700_000_111, sourceRef: MESSAGE } },
    ]);
  });

  it("tells a switch that is off from a key without the capability, and keeps the reason of a refusal", async () => {
    const refusal = (status: number, code: string, reason: string | null) => () => {
      throw new KernelApiError("refused", status === 409 ? "conflict" : "auth", status, code, reason === null ? { code } : { code, reason });
    };
    const comment = (answer: () => unknown) => hub({ agentShiftReportCommentSet: answer })
      .run(["shift-report", "comment", "--shift", "41", "--text", "до пятницы", "--sender", SENDER]);

    const off = await comment(refusal(403, "forbidden", null));
    const missing = await comment(refusal(403, "agent_capability_missing", null));
    const sender = await comment(refusal(409, "conflict", "sender_not_person"));
    for (const one of [off, missing, sender]) expect(one.exitCode).toBe(4);
    const hint = (one: typeof off) => (one.document.error as { hint?: string }).hint;
    expect(hint(off)).toBeTruthy();
    expect(hint(missing)).toBeTruthy();
    expect(hint(off)).not.toBe(hint(missing));
    expect(sender.document.error).toMatchObject({ status: 409, reason: "sender_not_person" });
  });
});
