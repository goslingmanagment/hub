import { describe, expect, it } from "vitest";

import { KernelApiError } from "@kernel/sdk";

import { runHubCli } from "../packages/hub-agent-cli/src/main.ts";

/**
 * `hub people …`: the people registry for an agent — the feed of who is who,
 * and proposals about a person that wait for the owner.
 *
 * The client is a stub: what the door accepts and refuses is the routes' own
 * test. Here, what the CLI itself promises: the flags of a change become the
 * owner's edit and nothing else, an empty change never leaves, a new person
 * comes whole from the file, a field a proposal does not have (pay terms, an
 * invitation) is refused rather than dropped, and a key without the capability
 * is told who grants it.
 */

const MESSAGE = "https://t.me/c/2600000001/3001";

function proposal(over: Record<string, unknown> = {}) {
  return {
    proposal: {
      id: 7, kind: "update", personCode: "anna", change: {}, reason: "why", requestedBy: null, sourceRef: null,
      state: "open", createdAt: "2026-11-12T10:00:00.000Z", decidedAt: null, decisionNote: null, ...over,
    },
  };
}

function hub(answers: Record<string, (input: unknown) => unknown> = {}, files: Record<string, string> = {}) {
  const calls: Array<{ operation: string; input: unknown }> = [];
  const client = new Proxy({}, {
    get: (_target, operation) => async (input: unknown) => {
      calls.push({ operation: String(operation), input });
      const answer = answers[String(operation)];
      if (answer === undefined) throw new Error(`unexpected call ${String(operation)}`);
      return answer(input);
    },
  });
  const run = (argv: string[]) => runHubCli({
    argv, env: { HUB_AGENT_KEY: "t" }, readFile: (path) => files[path] ?? null, createHubClient: () => client as never,
  });
  return { calls, run };
}

const bodyOf = (call: { input: unknown } | undefined) => (call?.input as { body: Record<string, unknown> }).body;
const messageOf = (result: { document: Record<string, unknown> }) => (result.document.error as { message: string }).message;

describe("hub people", () => {
  it("reads the feed, all of it or what changed since an instant; a --since without an offset never leaves", async () => {
    const feed = { people: [], payTermsIncluded: false, keyGrantExcludedPages: 0, serverNow: "2026-11-12T10:00:00.000Z" };
    const { calls, run } = hub({ agentPeople: () => feed });
    expect((await run(["people"])).exitCode).toBe(0);
    const since = await run(["people", "--since", "2026-11-12T00:00:00+03:00"]);
    expect(since.document).toMatchObject({ ok: true, operation: "agentPeople", data: feed });
    expect(calls).toEqual([
      { operation: "agentPeople", input: { query: {} } },
      { operation: "agentPeople", input: { query: { since: "2026-11-12T00:00:00+03:00" } } },
    ]);
    // A bare day, an instant without its offset, and a bare word (a person's code is not a filter of this door).
    for (const argv of [["--since", "2026-11-12"], ["--since", "2026-11-12T00:00:00"], ["anna"]]) {
      expect((await run(["people", ...argv])).exitCode, argv.join(" ")).toBe(4);
    }
    expect(calls).toHaveLength(2);
  });

  it("turns the flags of a change into the owner's edit, with the proposal's words", async () => {
    const { calls, run } = hub({ agentPersonProposalCreate: () => proposal() });
    const propose = (...argv: string[]) => run(["people", "propose", "--person", "anna", ...argv]);

    const done = await propose(
      "--working-page", "mia-1,mia-2", "--slot", "15:00-23:00", "--slot-from", "2026-11-17", "--slot-days", "mon,tue", "--slot-days", "fri",
      "--state", "working", "--telegram-handle", "@anna_k",
      "--reason", "С 17.11 берёт mia-2", "--requested-by", "owner", "--message", MESSAGE,
    );
    expect(done.exitCode).toBe(0);
    expect(calls).toEqual([{
      operation: "agentPersonProposalCreate",
      input: {
        body: {
          kind: "update",
          personCode: "anna",
          change: {
            workingPageLabels: ["mia-1", "mia-2"],
            schedule: { from: "2026-11-17", slot: { start: "15:00", end: "23:00", weekdays: ["mon", "tue", "fri"] } },
            state: "working",
            telegram: { handle: "@anna_k" },
          },
          reason: "С 17.11 берёт mia-2",
          requestedBy: "owner",
          sourceRef: MESSAGE,
        },
      },
    }]);
    // The answer says in so many words that nothing changed yet.
    expect(done.document).toMatchObject({ ok: true, operation: "agentPersonProposalCreate", data: { proposal: { id: 7, state: "open" } } });
    expect(String(done.document.note)).toContain("waits for the owner");

    // One flag is one field: a slot of a page's own line that ends, a person who left, no working page at all.
    calls.length = 0;
    expect((await propose("--slot", "none", "--slot-from", "2026-11-20", "--slot-page", "mia-2", "--reason", "уходит с mia-2")).exitCode).toBe(0);
    expect((await propose("--state", "left", "--left-on", "2026-11-30", "--reason", "ушла")).exitCode).toBe(0);
    expect((await propose("--no-working-pages", "--reason", "страниц пока нет")).exitCode).toBe(0);
    // A first slot, the day not known: `from` goes as null (the registry takes it only while the line has no slot).
    expect((await propose("--slot", "23:00-07:00", "--reason", "ночная")).exitCode).toBe(0);
    expect(calls.map((call) => bodyOf(call).change)).toEqual([
      { schedule: { pageLabel: "mia-2", from: "2026-11-20", slot: null } },
      { state: "left", leftOn: "2026-11-30" },
      { workingPageLabels: [] },
      { schedule: { from: null, slot: { start: "23:00", end: "07:00" } } },
    ]);
    expect(bodyOf(calls[0])).toEqual({
      kind: "update", personCode: "anna", change: { schedule: { pageLabel: "mia-2", from: "2026-11-20", slot: null } }, reason: "уходит с mia-2",
    });
  });

  it("lays the flags over --file: the file carries the rest of the edit, and Telegram keeps what the file says beside the handle", async () => {
    const { calls, run } = hub({ agentPersonProposalCreate: () => proposal() }, {
      "change.json": JSON.stringify({ rights: ["submits_shift"], telegram: { userId: 700_000_111 }, workingPageLabels: ["mia-3"] }),
    });
    const done = await run([
      "people", "propose", "--person", "anna", "--file", "change.json", "--telegram-handle", "anna_k", "--working-page", "mia-1", "--reason", "сдаёт смену в системе",
    ]);
    expect(done.exitCode).toBe(0);
    expect(bodyOf(calls[0]).change).toEqual({
      rights: ["submits_shift"], telegram: { userId: 700_000_111, handle: "anna_k" }, workingPageLabels: ["mia-1"],
    });
  });

  it("refuses an empty change, and a change it cannot spell, before any call", async () => {
    const { calls, run } = hub({ agentPersonProposalCreate: () => proposal() }, { "empty.json": "{}", "list.json": "[]" });
    const propose = (...argv: string[]) => run(["people", "propose", ...argv]);

    const empty = await propose("--person", "anna", "--reason", "просто так");
    expect(empty.exitCode).toBe(4);
    expect(empty.document).toMatchObject({ ok: false, operation: "agentPersonProposalCreate", error: { category: "usage" } });
    expect(messageOf(empty)).toContain("nothing to change");
    expect((await propose("--person", "anna", "--file", "empty.json", "--reason", "просто так")).exitCode).toBe(4);

    for (const argv of [
      // No words: a proposal always says why.
      ["--person", "anna", "--state", "left"],
      // Neither a person nor a new one.
      ["--reason", "why"],
      // The parts of a slot without the slot; a slot that is no pair of times; a day that is no weekday; an ended slot with days.
      ["--person", "anna", "--slot-from", "2026-11-17", "--reason", "why"],
      ["--person", "anna", "--slot-page", "mia-1", "--reason", "why"],
      ["--person", "anna", "--slot", "15:00", "--reason", "why"],
      ["--person", "anna", "--slot", "9:00-17:00", "--reason", "why"],
      ["--person", "anna", "--slot", "15:00-23:00", "--slot-days", "monday", "--reason", "why"],
      ["--person", "anna", "--slot", "none", "--slot-days", "mon", "--reason", "why"],
      // The whole list and no list at once; a state and a day the contract does not have; a code that is no code.
      ["--person", "anna", "--working-page", "mia-1", "--no-working-pages", "--reason", "why"],
      ["--person", "anna", "--state", "fired", "--reason", "why"],
      ["--person", "anna", "--left-on", "30.11.2026", "--reason", "why"],
      ["--person", "Anna K", "--state", "left", "--reason", "why"],
      // A file that is no JSON object, or is not there.
      ["--person", "anna", "--file", "list.json", "--reason", "why"],
      ["--person", "anna", "--file", "missing.json", "--reason", "why"],
    ]) {
      const refused = await propose(...argv);
      expect(refused.exitCode, argv.join(" ")).toBe(4);
      expect(refused.document, argv.join(" ")).toMatchObject({ error: { category: "usage" } });
    }
    expect(calls).toEqual([]);
  });

  it("takes a new person whole from --file, and never lets pay terms or an invitation leave", async () => {
    const person = { code: "dora", displayName: "Дора", role: "chatter", workingPageLabels: ["mia-1"] };
    const { calls, run } = hub({ agentPersonProposalCreate: () => proposal({ id: 8, kind: "create", personCode: "dora" }) }, {
      "person.json": JSON.stringify(person),
      "paid.json": JSON.stringify({ ...person, payTerms: [{ modelSlug: "mia", validFrom: "2026-11-17", shareBasisPoints: 2500, fixPerShiftMills: 0 }] }),
      "invited.json": JSON.stringify({ ...person, invite: { username: "dora", pageLabels: ["mia-1"] } }),
      "terms.json": JSON.stringify({ note: "новые условия", payTerms: [] }),
      "typo.json": JSON.stringify({ telegram: { id: 700_000_111 } }),
      "partial.json": JSON.stringify({ workingPageLabels: ["mia-1"] }),
      "whole.json": JSON.stringify({ kind: "update", personCode: "anna", change: { note: "новые условия" } }),
    });
    const propose = (...argv: string[]) => run(["people", "propose", ...argv, "--reason", "новый чаттер", "--requested-by", "owner"]);

    const done = await propose("--file", "person.json");
    expect(done.exitCode).toBe(0);
    expect(calls).toEqual([{
      operation: "agentPersonProposalCreate",
      input: { body: { kind: "create", person, reason: "новый чаттер", requestedBy: "owner" } },
    }]);
    // The note does not say «nothing changed» of a person who is not there yet.
    expect(String(done.document.note)).toContain("Proposal 8 about dora");
    expect(String(done.document.note)).toContain("not in the registry until the owner accepts it");

    // Money and an invitation are the owner's own: the contract has no field for them, and the hub would drop them
    // without a word and record the rest. Here the whole proposal is refused, the field named.
    calls.length = 0;
    const paid = await propose("--file", "paid.json");
    expect(paid.exitCode).toBe(4);
    expect(paid.document).toMatchObject({ error: { category: "usage", details: { fields: ["person.payTerms"] } } });
    expect((await propose("--file", "invited.json")).document).toMatchObject({ error: { details: { fields: ["person.invite"] } } });
    expect((await propose("--person", "anna", "--file", "terms.json")).document).toMatchObject({ error: { details: { fields: ["change.payTerms"] } } });
    // A misspelt field inside the edit is no change either; nor is the door's whole body where the change itself goes.
    expect((await propose("--person", "anna", "--file", "typo.json")).document).toMatchObject({ error: { details: { fields: ["change.telegram.id"] } } });
    expect((await propose("--person", "anna", "--file", "whole.json")).document).toMatchObject({
      error: { details: { fields: ["change.kind", "change.personCode", "change.change"] } },
    });
    // The flags are about a person the registry has; a file without the person's own fields is not a new person.
    expect((await propose("--file", "person.json", "--state", "working")).exitCode).toBe(4);
    expect((await propose("--file", "partial.json")).exitCode).toBe(4);
    expect(calls).toEqual([]);
  });

  it("lists the key's own proposals, all or since an instant", async () => {
    const list = { proposals: [proposal({ state: "accepted", decidedAt: "2026-11-12T12:00:00.000Z", decisionNote: "да" }).proposal] };
    const { calls, run } = hub({ agentPersonProposals: () => list });
    const all = await run(["people", "proposals"]);
    expect(all.document).toMatchObject({ ok: true, operation: "agentPersonProposals", data: list });
    expect((await run(["people", "proposals", "--since", "2026-11-10T00:00:00Z"])).exitCode).toBe(0);
    expect((await run(["people", "proposals", "--since", "вчера"])).exitCode).toBe(4);
    expect(calls).toEqual([
      { operation: "agentPersonProposals", input: { query: {} } },
      { operation: "agentPersonProposals", input: { query: { since: "2026-11-10T00:00:00Z" } } },
    ]);
  });

  it("tells a key without the capability who grants it, and keeps the reason of a refusal", async () => {
    const refusal = (status: number, code: string, reason: string | null) => () => {
      throw new KernelApiError("refused", status === 409 ? "conflict" : "auth", status, code, reason === null ? { code } : { code, reason });
    };
    const hint = (result: { document: Record<string, unknown> }) => (result.document.error as { hint?: string }).hint;
    const argv = ["people", "propose", "--person", "anna", "--state", "left", "--reason", "ушла"];

    const noPropose = await hub({ agentPersonProposalCreate: refusal(403, "agent_capability_missing", null) }).run(argv);
    expect(noPropose.exitCode).toBe(4);
    expect(hint(noPropose)).toContain("propose:people");
    expect(hint(noPropose)).toContain("the owner grants it");
    expect(hint(await hub({ agentPersonProposals: refusal(403, "agent_capability_missing", null) }).run(["people", "proposals"]))).toContain("propose:people");
    expect(hint(await hub({ agentPeople: refusal(403, "agent_capability_missing", null) }).run(["people"]))).toContain("read:team");

    const taken = await hub({ agentPersonProposalCreate: refusal(409, "conflict", "code_taken") }).run(argv);
    expect(taken.document.error).toMatchObject({ status: 409, reason: "code_taken" });
    expect(hint(taken)).toContain("code_taken");
    const unknown = await hub({ agentPersonProposalCreate: refusal(404, "not_found", null) }).run(argv);
    expect(unknown.exitCode).toBe(4);
    expect(hint(unknown)).toContain("hub people");
  });
});
