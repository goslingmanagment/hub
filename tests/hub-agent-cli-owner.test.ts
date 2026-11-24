import { describe, expect, it } from "vitest";

import { runHubCli } from "../packages/hub-agent-cli/src/main.ts";

/**
 * `hub owner …`: the owner's agent door from the owner's desk. What the CLI promises: the owner's desk key and never
 * an agent's, the reason with every call (percent-encoded, as a header carries it), nothing sent without one, and each
 * command's flags as one operation of the door. What the door does is the server's (owner-agent-door tests).
 */

function hub(env: Record<string, string | undefined> = { HUB_OWNER_KEY: "owner-desk-token" }) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const clients: Array<{ token: string; headers?: Record<string, string> | undefined }> = [];
  const client = new Proxy({}, {
    get: (_target, operation) => async (input: unknown) => {
      calls.push({ operation: String(operation), input });
      return { op: (input as { body: { op: string } }).body.op, result: {}, serverNow: "2026-11-24T10:00:00.000Z" };
    },
  });
  const run = (argv: string[]) => runHubCli({
    argv, env, readFile: () => null, fileMode: () => null,
    createHubClient: (options) => {
      clients.push({ token: options.token, headers: options.headers });
      return client as never;
    },
  });
  return { calls, clients, run };
}

const WHY = "сверяю спорную продажу";

describe("hub owner", () => {
  it("sends one operation of the door with the owner's key and the reason", async () => {
    const { calls, clients, run } = hub();
    const shown = await run(["owner", "sale", "show", "--sale", "1234567", "--why", WHY]);
    expect(shown.exitCode, JSON.stringify(shown.document)).toBe(0);
    expect(clients).toEqual([{ token: "owner-desk-token", headers: { "x-hub-owner-reason": encodeURIComponent(WHY) } }]);
    expect(calls).toEqual([{ operation: "ownerAgentCall", input: { body: { op: "sale.show", args: { transactionId: 1234567 } } } }]);

    const decided = await run([
      "owner", "sale", "decide", "--sale", "1234567", "--kind", "split", "--share", "anna:50", "--share", "bella:50",
      "--note", "вели вдвоём", "--why", WHY,
    ]);
    expect(decided.exitCode, JSON.stringify(decided.document)).toBe(0);
    expect(calls[1]).toEqual({ operation: "ownerAgentCall", input: { body: { op: "sale.decide", args: {
      transactionId: 1234567, kind: "split", shares: [{ person: "anna", percent: 50 }, { person: "bella", percent: 50 }], note: "вели вдвоём",
    } } } });

    const raw = await run(["owner", "call", "people.show", "--json", "{\"code\":\"anna\"}", "--why", WHY]);
    expect(raw.exitCode).toBe(0);
    expect(calls[2]).toEqual({ operation: "ownerAgentCall", input: { body: { op: "people.show", args: { code: "anna" } } } });

    const edited = await run(["owner", "people", "edit", "anna", "--working-page", "mia-1,mia-2", "--note", "", "--why", WHY]);
    expect(edited.exitCode, JSON.stringify(edited.document)).toBe(0);
    expect(calls[3]).toEqual({ operation: "ownerAgentCall", input: { body: { op: "people.edit", args: {
      code: "anna", workingPageLabels: ["mia-1", "mia-2"], note: null,
    } } } });

    const listed = await run(["owner", "shift-report", "list", "--person", "anna", "--from", "2026-11-01", "--to", "2026-11-07", "--why", WHY]);
    expect(listed.exitCode).toBe(0);
    expect(calls[4]).toEqual({ operation: "ownerAgentCall", input: { body: { op: "shiftReport.list", args: { person: "anna", from: "2026-11-01", to: "2026-11-07" } } } });
  });

  it("sends part 2's commands as their operations: people set, a custom's step, a finding, a matter, a page, a swap, a link", async () => {
    const { calls, run } = hub();
    const sent: Array<[string[], string, Record<string, unknown>]> = [
      [["owner", "people", "set", "anna", "--state", "left", "--left-on", "2026-11-30", "--working-page", "mia-1"], "people.edit",
        { code: "anna", state: "left", leftOn: "2026-11-30", workingPageLabels: ["mia-1"] }],
      [["owner", "people", "set", "anna", "--schedule", "{\"from\":\"2026-12-01\",\"slot\":null}"], "people.edit",
        { code: "anna", schedule: { from: "2026-12-01", slot: null } }],
      [["owner", "custom", "step", "K-12", "--step", "hold", "--json", "{\"reason\":\"ждём\"}"], "custom.step", { code: "K-12", step: { action: "hold", reason: "ждём" } }],
      [["owner", "custom-finding", "answer", "42", "--step", "dismiss", "--reason", "not_custom"], "customFinding.answer",
        { findingId: 42, step: { action: "dismiss", reason: "not_custom" } }],
      [["owner", "matter", "close", "agent.ask:17", "--how", "resolved"], "matter.close", { key: "agent.ask:17", how: "resolved" }],
      [["owner", "learn", "approve", "chatter-job", "--take-back"], "learn.approve", { slug: "chatter-job", approved: false }],
      [["owner", "swap", "approve", "7", "--text", "ок"], "swap.approve", { questionId: 7, text: "ок" }],
      [["owner", "decision", "link", "9", "--sale", "1234567"], "decision.link", { decisionId: 9, transactionId: 1234567 }],
    ];
    for (const [argv, op, args] of sent) {
      const answer = await run([...argv, "--why", WHY]);
      expect(answer.exitCode, `${argv.join(" ")}: ${JSON.stringify(answer.document)}`).toBe(0);
      expect(calls.at(-1), argv.join(" ")).toEqual({ operation: "ownerAgentCall", input: { body: { op, args } } });
    }
    // Nothing to set is nothing sent.
    const before = calls.length;
    expect((await run(["owner", "people", "set", "anna", "--why", WHY])).exitCode).toBe(4);
    expect(calls).toHaveLength(before);
  });

  it("sends nothing without the reason, or without the owner's desk key (an agent's key is never used)", async () => {
    const noWhy = hub();
    const refused = await noWhy.run(["owner", "sale", "show", "--sale", "5"]);
    expect(refused.exitCode).toBe(4);
    expect(noWhy.calls).toHaveLength(0);
    expect(noWhy.clients).toHaveLength(0);

    const tooLong = await noWhy.run(["owner", "sale", "show", "--sale", "5", "--why", "я".repeat(501)]);
    expect(tooLong.exitCode).toBe(4);
    expect(noWhy.calls).toHaveLength(0);

    const agentOnly = hub({ HUB_AGENT_KEY: "agent-token" });
    const noKey = await agentOnly.run(["owner", "sale", "show", "--sale", "5", "--why", WHY]);
    expect(noKey.exitCode).toBe(4);
    expect(JSON.stringify(noKey.document)).toContain("HUB_OWNER_KEY");
    expect(agentOnly.clients).toHaveLength(0);

    // …and an agent's command never takes the owner's desk key.
    const ownerOnly = hub({ HUB_OWNER_KEY: "owner-desk-token" });
    expect((await ownerOnly.run(["capabilities"])).exitCode).toBe(4);
    expect(ownerOnly.clients).toHaveLength(0);
  });

  it("lists the door's operations without a key or a call", async () => {
    const { calls, clients, run } = hub({});
    const ops = await run(["owner", "ops"]);
    expect(ops.exitCode).toBe(0);
    const operations = (ops.document.data as { operations: Array<{ op: string; writes: boolean; args: string[] }> }).operations;
    expect(operations.map((one) => one.op)).toContain("sale.decide");
    expect(operations.find((one) => one.op === "people.edit")).toMatchObject({ writes: true, args: expect.arrayContaining(["code", "workingPageLabels"]) });
    expect(calls).toHaveLength(0);
    expect(clients).toHaveLength(0);
  });
});
