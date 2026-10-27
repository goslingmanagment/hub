import { describe, expect, it } from "vitest";

import { resolveHubCredentials } from "../packages/hub-agent-cli/src/credentials.ts";
import { runHubCli } from "../packages/hub-agent-cli/src/main.ts";

/**
 * The `hub` CLI, slice B.
 *
 * Every assertion here is one of the two promises the CLI makes and one of the
 * ways it has to keep them: one JSON document per call whatever happens, and an
 * exit code that reports the EPISTEMIC verdict rather than only the transport.
 * The client is a stub throughout — this file tests the CLI, not the hub.
 */

describe("hub CLI: credentials", () => {
  it("refuses an over-permissive credentials file, and names the remedy", () => {
    // The file holds a live bearer token to transcripts and money. The CLI never
    // creates it, so it cannot fix the mode; staying quiet about a world-readable
    // secret is how it stays world-readable (the ssh private-key precedent).
    for (const mode of [0o644, 0o640, 0o604, 0o666]) {
      expect(() => resolveHubCredentials({
        env: {},
        readFile: () => "HUB_AGENT_KEY=t\n",
        fileMode: () => mode,
      }), mode.toString(8)).toThrowError(/readable by others.*chmod 600/s);
    }
    // 0600 and 0400 are fine, and a missing file is not a mode problem at all.
    expect(resolveHubCredentials({
      env: {},
      readFile: () => "HUB_AGENT_KEY=t\n",
      fileMode: () => 0o600,
    }).token).toBe("t");
    expect(resolveHubCredentials({
      env: {},
      readFile: () => "HUB_AGENT_KEY=t\n",
      fileMode: () => 0o400,
    }).token).toBe("t");
  });

  it("refuses an over-permissive file even when the token comes from the environment", () => {
    // The env var wins for the TOKEN, but the file was still read (it can carry
    // HUB_BASE_URL) and it is still leaking whatever key it holds.
    expect(() => resolveHubCredentials({
      env: { HUB_AGENT_KEY: "from-env" },
      readFile: () => "HUB_AGENT_KEY=leaked\n",
      fileMode: () => 0o644,
    })).toThrowError(/readable by others/);
  });
});

describe("hub CLI: cross-spenders", () => {
  type Call = { params: { pageLabel: string }; query: Record<string, unknown> };
  const answer = (items: string[], nextCursor: string | null, blockers: string[]) => ({
    scope: { pageLabel: "lora-1" },
    summary: { qualifying: 3 },
    items: items.map((platformUserId) => ({ platformUserId })),
    delivery: { nextCursor },
    capture: {},
    conclusion: { blockers },
  });

  async function run(argv: string[], pages: Array<ReturnType<typeof answer>>) {
    const calls: Call[] = [];
    const result = await runHubCli({
      argv,
      env: { HUB_AGENT_KEY: "t" },
      readFile: () => null,
      createHubClient: () => ({
        agentCrossSpenders: async (input: Call) => {
          calls.push(input);
          return pages[calls.length - 1];
        },
      }) as never,
    });
    return { result, calls };
  }

  it("turns dollars into mills through the codec, and `any` into no cap", async () => {
    const { result, calls } = await run([
      "cross-spenders", "--page-label", "lora-1", "--source", "lora-2,lora-3",
      "--min-source-spend", "20.5", "--max-target-spend", "any",
    ], [answer(["1"], null, [])]);
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([{
      params: { pageLabel: "lora-1" },
      query: { sources: ["lora-2", "lora-3"], minSourceSpendMills: 20_500, maxTargetSpendMills: "any" },
    }]);
    const zero = await run(["cross-spenders", "--page-label", "lora-1", "--max-target-spend", "0"], [answer([], null, [])]);
    expect(zero.calls[0]!.query).toEqual({ maxTargetSpendMills: 0 });
    for (const bad of [["--min-source-spend", "0"], ["--min-source-spend", "-5"], ["--max-target-spend", "ten"]]) {
      const refused = await run(["cross-spenders", "--page-label", "lora-1", ...bad], []);
      expect(refused.result.exitCode, bad.join(" ")).toBe(4);
      expect(refused.calls).toEqual([]);
    }
  });

  it("--all follows every cursor and prints each fan once", async () => {
    const { result, calls } = await run(["cross-spenders", "--page-label", "lora-1", "--all"], [
      answer(["1", "2"], "c1", ["claim_not_declared", "delivery_not_exhausted"]),
      answer(["2", "3"], null, ["claim_not_declared", "mutable_sort_key_traversal"]),
    ]);
    expect(calls.map((call) => call.query)).toEqual([{ limit: 200 }, { cursor: "c1" }]);
    expect(result.exitCode).toBe(0);
    expect(result.document).toMatchObject({
      ok: true,
      composite: { calls: 2, items: 3, duplicatesDropped: 1 },
      blockers: ["claim_not_declared", "delivery_not_exhausted", "mutable_sort_key_traversal"],
      data: { items: [{ platformUserId: "1" }, { platformUserId: "2" }, { platformUserId: "3" }] },
    });
  });
});
