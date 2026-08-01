import { describe, expect, it } from "vitest";

import { AGENT_CAPABILITIES } from "@agency_hub_core/contracts";
import type { KernelClient } from "@kernel/sdk";
import { KernelApiError } from "@kernel/sdk";

import {
  HUB_COMMANDS,
  findHubCommand,
} from "../packages/hub-agent-cli/src/commands.ts";
import {
  HUB_DEFAULT_BASE_URL,
  parseHubCredentialsFile,
  resolveHubCredentials,
} from "../packages/hub-agent-cli/src/credentials.ts";
import {
  HUB_EXIT_ERROR,
  HUB_EXIT_OK,
  HUB_EXIT_PARTIAL,
  runHubCli,
} from "../packages/hub-agent-cli/src/main.ts";

/**
 * The `hub` CLI, slice B.
 *
 * Every assertion here is one of the two promises the CLI makes and one of the
 * ways it has to keep them: one JSON document per call whatever happens, and an
 * exit code that reports the EPISTEMIC verdict rather than only the transport.
 * The client is a stub throughout — this file tests the CLI, not the hub.
 */

const ENV = { HUB_AGENT_KEY: "agency_hub_agent_test-token" };
const NO_FILE = () => null;
/** No credentials file on disk: keeps every case below independent of the machine. */
const NO_MODE = () => null;

/**
 * A client whose calls are recorded. Typed through `KernelClient` on the way in
 * so a command that renamed an operation stops compiling here first.
 */
function stubClient(response: unknown, calls: Array<{ method: string; input: unknown }> = []) {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, property: string) {
      return (input: unknown) => {
        calls.push({ method: property, input });
        if (response instanceof Error) {
          return Promise.reject(response);
        }
        return Promise.resolve(response);
      };
    },
  };
  return new Proxy({}, handler) as unknown as KernelClient;
}

function run(argv: string[], options: { response?: unknown; calls?: Array<{ method: string; input: unknown }> } = {}) {
  return runHubCli({
    argv,
    env: ENV,
    readFile: NO_FILE,
    fileMode: NO_MODE,
    createHubClient: () => stubClient(options.response ?? { conclusion: { blockers: [] } }, options.calls),
  });
}

describe("hub CLI: the command surface", () => {
  it("offers exactly one command per agentKey operation, and none for the owner-session ones", () => {
    // 9b (observation payloads) and #13 (hydration decisions) are owner-session.
    // A command for them could only ever produce a confident 401.
    expect(HUB_COMMANDS.map((command) => command.operation).sort()).toEqual([
      "agentCapabilities",
      "agentCoverage",
      "agentDatasetQuery",
      "agentObservations",
      "agentPerson",
      "agentPersonTimeline",
      "agentResolve",
      "agentSearchMessages",
      "agentThreadMessages",
      "agentThreads",
    ]);
    expect(HUB_COMMANDS.map((command) => command.operation)).not.toContain(
      "agentObservationPayload",
    );
  });

  it("names every command uniquely and describes every flag", () => {
    const names = HUB_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of HUB_COMMANDS) {
      for (const [flag, option] of Object.entries(command.options)) {
        expect(option.describe.length, `${command.name} --${flag}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("hub CLI: exit codes", () => {
  it("exits 0 when the answer carries no blockers", async () => {
    const result = await run(["threads"], { response: { conclusion: { blockers: [] } } });
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(result.document.ok).toBe(true);
    expect(result.document.blockers).toEqual([]);
  });

  it("still exits 0 on a blocked answer WITHOUT --fail-on-partial", async () => {
    // The default is deliberate: a narrowed answer is usually the wanted answer.
    // What must never happen is a narrowed answer that LOOKS complete, which is
    // why the blockers are lifted to the top of the document either way.
    const result = await run(["threads"], {
      response: { conclusion: { blockers: ["window_before_capture_floor"] } },
    });
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(result.document.blockers).toEqual(["window_before_capture_floor"]);
  });

  it("exits 3 on a blocked answer WITH --fail-on-partial", async () => {
    const result = await run(["threads", "--fail-on-partial"], {
      response: { conclusion: { blockers: ["read_only_mode"] } },
    });
    expect(result.exitCode).toBe(HUB_EXIT_PARTIAL);
    expect(result.document.exitCode).toBe(HUB_EXIT_PARTIAL);
    expect(result.document.ok).toBe(true);
  });

  it("exits 4 on a hub error and still prints a document", async () => {
    const result = await run(["threads"], {
      response: new KernelApiError("nope", "not_found", 404, "not_found", { error: "not_found" }),
    });
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(result.document.ok).toBe(false);
    expect(result.document.error).toMatchObject({ status: 404, code: "not_found" });
  });

  it("prints bounded error METADATA and never the rejected payload", async () => {
    // `KernelApiError.body` on a 2xx that failed contract validation is the
    // COMPLETE UNVALIDATED payload; on a non-2xx it is whatever arrived. Printing
    // it would hand the agent exactly what the schema refused, which is how a
    // signed CDN URL reaches a model. SDK validation is the boundary of what this
    // plane shows, and a diagnostic channel around the boundary is not a
    // diagnostic channel, it is a second unvalidated read path.
    const leaked = "https://cdn.example/secret.mp4?Policy=LEAKED-SIGNED-URL";
    const result = await run(["threads"], {
      response: new KernelApiError(
        "GET /api/v1/agent/threads response failed contract validation",
        "contract",
        200,
        "response_validation_failed",
        { items: [{ mediaUrl: leaked }] },
      ),
    });
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(JSON.stringify(result.document)).not.toContain(leaked);
    expect(JSON.stringify(result.document)).not.toContain("mediaUrl");
    const error = result.document.error as Record<string, unknown>;
    expect(error).not.toHaveProperty("body");
    // Still enough to act on.
    expect(error).toMatchObject({
      category: "contract",
      status: 200,
      code: "response_validation_failed",
    });
  });

  it("bounds the error message so a payload cannot ride out inside it", async () => {
    const enormous = `x${"LEAK".repeat(5_000)}`;
    const result = await run(["threads"], {
      response: new KernelApiError(enormous, "server", 500, "boom", null),
    });
    const message = String((result.document.error as { message: string }).message);
    expect(message.length).toBeLessThan(600);
    expect(message.endsWith("... (truncated)")).toBe(true);
  });

  it("refuses a stray positional instead of silently widening the query", async () => {
    // `hub threads lora-2` used to run over EVERY granted page and exit 0: a
    // scope typo turning into a broader answer, which is the false-completeness
    // family this plane exists to prevent, reproduced in the CLI.
    const calls: Array<{ method: string; input: unknown }> = [];
    const result = await run(["threads", "lora-2"], { calls });
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(calls).toEqual([]);
    expect(String((result.document.error as { message: string }).message))
      .toContain('unexpected argument "lora-2"');
  });

  it("exits 4 on an unknown command, an unknown flag, and a missing required flag", async () => {
    for (const argv of [
      ["nonsense"],
      ["threads", "--not-a-flag", "x"],
      ["transcript", "--page-label", "lora-2"],
    ]) {
      const result = await run(argv);
      expect(result.exitCode, argv.join(" ")).toBe(HUB_EXIT_ERROR);
      expect(result.document.ok).toBe(false);
    }
  });

  it("never returns 0 without a document", async () => {
    const result = await run(["capabilities"], { response: { deployment: {} } });
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    // #1 has no conclusion at all; an unreadable conclusion is no blockers, never
    // a fabricated one.
    expect(result.document.blockers).toEqual([]);
    expect(result.document.data).toEqual({ deployment: {} });
  });
});

describe("hub CLI: request building", () => {
  it("sends the thread transcript request the contract describes", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    await run([
      "transcript",
      "--page-label", "lora-2",
      "--conversation", "810272281019305984",
      "--from", "2026-01-01T00:00:00Z",
      "--include-deleted", "false",
      "--limit", "25",
    ], { calls });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "agentThreadMessages",
      input: {
        params: { pageLabel: "lora-2", conversationRef: "810272281019305984" },
        query: { from: "2026-01-01T00:00:00Z", includeDeleted: false, limit: 25 },
      },
    });
  });

  it("keeps a tristate filter's three states distinct", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    await run(["threads", "--quarantined", "false"], { calls });
    await run(["threads", "--quarantined", "true"], { calls });
    await run(["threads"], { calls });
    const queries = calls.map((call) => (call.input as { query: Record<string, unknown> }).query);
    expect(queries[0]).toMatchObject({ quarantined: false });
    expect(queries[1]).toMatchObject({ quarantined: true });
    expect(queries[2]).not.toHaveProperty("quarantined");
  });

  it("refuses a value outside the contract's enum instead of round-tripping a 400", async () => {
    const result = await run(["threads", "--platform", "fanslyy"]);
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(String((result.document.error as { message: string }).message))
      .toContain("--platform must be one of");
  });

  it("splits a dataset filter into field, op and a JSON-or-string value", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    await run([
      "dataset",
      "--page-label", "lora-2",
      "--dataset", "transactions",
      "--filter", 'type:in:["tip","message"]',
      "--filter", "amountMills:gte:1000",
      "--filter", "refundedAt:is_null",
      "--sort", "occurredAt:desc",
    ], { calls });
    const body = (calls[0]?.input as { body: Record<string, unknown> }).body;
    expect(body.filters).toEqual([
      { field: "type", op: "in", value: ["tip", "message"] },
      { field: "amountMills", op: "gte", value: 1000 },
      { field: "refundedAt", op: "is_null" },
    ]);
    expect(body.sort).toEqual([{ field: "occurredAt", dir: "desc" }]);
  });

  it("encodes a claim as two flat fields on GET and a nested object on POST", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    await run(["threads", "--claim-field", "lifetimeSpendMills"], { calls });
    await run(["search", "--q", "refund", "--claim-field", "lifetimeSpendMills"], { calls });
    expect((calls[0]?.input as { query: Record<string, unknown> }).query).toMatchObject({
      claimFields: ["lifetimeSpendMills"],
      claimTargets: "all_in_scope",
    });
    expect((calls[1]?.input as { body: Record<string, unknown> }).body).toMatchObject({
      claim: { fields: ["lifetimeSpendMills"], targets: "all_in_scope" },
    });
  });

  it("refuses half of the person pair on search", async () => {
    const result = await run(["search", "--q", "refund", "--person-platform", "fansly"]);
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    expect(String((result.document.error as { message: string }).message))
      .toContain("atomic pair");
  });

  it("defaults the two resolve includes to on, and turns them off by flag", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    await run(["resolve", "--input", "https://fansly.com/rick"], { calls });
    await run(["resolve", "--input", "rick", "--no-threads"], { calls });
    expect((calls[0]?.input as { body: Record<string, unknown> }).body).toMatchObject({
      inputs: [{ raw: "https://fansly.com/rick" }],
      includeAliases: true,
      includeThreads: true,
    });
    expect((calls[1]?.input as { body: Record<string, unknown> }).body).toMatchObject({
      includeThreads: false,
    });
  });
});

describe("hub CLI: credentials", () => {
  it("prefers the environment over the file", () => {
    const resolved = resolveHubCredentials({
      env: { HUB_AGENT_KEY: "from-env" },
      readFile: () => "HUB_AGENT_KEY=from-file\n",
      fileMode: () => 0o600,
    });
    expect(resolved.token).toBe("from-env");
    expect(resolved.tokenSource).toBe("env");
  });

  it("falls back to the credentials file and defaults the base URL to production", () => {
    const resolved = resolveHubCredentials({
      env: {},
      readFile: () => "# a comment\n\nHUB_AGENT_KEY = \"from-file\"\n",
      fileMode: () => 0o600,
    });
    expect(resolved.token).toBe("from-file");
    expect(resolved.tokenSource).toBe("file");
    expect(resolved.baseUrl).toBe(HUB_DEFAULT_BASE_URL);
  });

  it("takes HUB_BASE_URL from either source and strips the trailing slash", () => {
    expect(resolveHubCredentials({
      env: { HUB_AGENT_KEY: "t", HUB_BASE_URL: "http://localhost:3000/" },
      readFile: () => null,
      fileMode: () => null,
    }).baseUrl).toBe("http://localhost:3000");
    expect(resolveHubCredentials({
      env: { HUB_AGENT_KEY: "t" },
      readFile: () => "HUB_BASE_URL=http://hub.local//\n",
      fileMode: () => 0o600,
    }).baseUrl).toBe("http://hub.local");
  });

  it("keeps a token containing '=' intact (only the first separator splits)", () => {
    expect(parseHubCredentialsFile("HUB_AGENT_KEY=abc=def==\n")).toEqual({
      HUB_AGENT_KEY: "abc=def==",
    });
  });

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

  it("refuses to run without a key, naming BOTH places it looks", async () => {
    const result = await runHubCli({
      argv: ["capabilities"],
      env: {},
      readFile: NO_FILE,
      fileMode: NO_MODE,
      createHubClient: () => stubClient({}),
    });
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    const message = String((result.document.error as { message: string }).message);
    expect(message).toContain("HUB_AGENT_KEY");
    expect(message).toContain(".config/hub/credentials");
  });
});

describe("hub CLI: the usage document", () => {
  it("lists every command, the credential sources and the exit codes", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(HUB_EXIT_ERROR);
    const error = result.document.error as { commands: Record<string, string>; exitCodes: unknown };
    expect(Object.keys(error.commands).sort())
      .toEqual(HUB_COMMANDS.map((command) => command.name).sort());
    expect(error.exitCodes).toEqual({
      "0": "answer complete",
      "3": "answer has blockers and --fail-on-partial was passed",
      "4": "no answer",
    });
  });

  it("--help on a command describes that command's flags", async () => {
    const result = await run(["dataset", "--help"]);
    const error = result.document.error as { options: Record<string, string> };
    expect(Object.keys(error.options)).toContain("filter");
    expect(findHubCommand("dataset")?.operation).toBe("agentDatasetQuery");
  });
});

describe("hub CLI: capability vocabulary", () => {
  it("the closed matrix is what the dashboard and the CLI both describe", () => {
    // Not a tautology: it pins that slice B never grew a sixth capability in a
    // help string while the contract kept five.
    expect([...AGENT_CAPABILITIES]).toHaveLength(5);
  });
});
