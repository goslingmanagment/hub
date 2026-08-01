import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { AGENT_PLANE_NAMES, agentThreadsResponseSchema } from "@agency_hub_core/contracts";

const run = promisify(execFile);

/**
 * The REAL bin, spawned as a process, from a directory OUTSIDE the repository.
 *
 * This file exists because of a review finding that the internal-module tests
 * structurally could not catch: `bin/hub.mjs` registered tsx without naming a
 * tsconfig, so module resolution depended on the CWD. From the repo root the
 * workspace path aliases were picked up and everything worked; from anywhere else
 * the process died with ERR_MODULE_NOT_FOUND, which means a stack trace on
 * stderr, EMPTY stdout and exit 1. That breaks both CLI invariants at once, in
 * exactly the invocation `docs/agent-read-skill.md` teaches an agent to use.
 *
 * So every case here asserts the same two things about the ACTUAL process:
 * stdout parses as exactly ONE JSON document, and the exit code is one of
 * {0, 3, 4}. Never a stack trace, never an empty stdout, never exit 1.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, "..", "packages", "hub-agent-cli", "bin", "hub.mjs");
/** Anywhere but the repo: the whole point is that the CWD must not matter. */
const OUTSIDE = mkdtempSync(join(tmpdir(), "hub-cli-bin-"));

const CONTRACT_EXIT_CODES = [0, 3, 4];
const SPAWN_TIMEOUT_MS = 60_000;

async function hub(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      cwd: OUTSIDE,
      // A clean-ish environment: PATH and HOME only, so nothing about this
      // machine's shell can accidentally make the case pass.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: OUTSIDE,
        ...env,
      },
      timeout: SPAWN_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** Exactly one document: not zero, not two, not a document with a banner glued on. */
function soleDocument(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  expect(lines, `stdout was not exactly one line:\n${stdout}`).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe("hub bin: spawned from outside the repository", () => {
  it("prints one document and exits 4 when the hub is unreachable", async () => {
    const result = await hub(["threads"], {
      HUB_AGENT_KEY: "agency_hub_agent_spawn-test",
      // Port 9 (discard) refuses fast and needs no fixture server.
      HUB_BASE_URL: "http://127.0.0.1:9",
    });
    expect(CONTRACT_EXIT_CODES).toContain(result.code);
    expect(result.code).toBe(4);
    const document = soleDocument(result.stdout);
    expect(document.ok).toBe(false);
    expect(document.operation).toBe("agentThreads");
    expect(document.exitCode).toBe(4);
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  }, SPAWN_TIMEOUT_MS);

  it("prints one usage document and exits 4 with no command", async () => {
    const result = await hub([], { HUB_AGENT_KEY: "agency_hub_agent_spawn-test" });
    expect(result.code).toBe(4);
    const document = soleDocument(result.stdout);
    const error = document.error as { commands: Record<string, string> };
    expect(Object.keys(error.commands)).toContain("capabilities");
  }, SPAWN_TIMEOUT_MS);

  it("prints one document and exits 4 with no key configured", async () => {
    // HOME points at an empty temp dir, so there is no credentials file either.
    const result = await hub(["capabilities"]);
    expect(result.code).toBe(4);
    const document = soleDocument(result.stdout);
    expect(String((document.error as { message: string }).message)).toContain("HUB_AGENT_KEY");
  }, SPAWN_TIMEOUT_MS);

  it("prints one document and exits 4 on an unknown flag", async () => {
    const result = await hub(["threads", "--not-a-flag"], {
      HUB_AGENT_KEY: "agency_hub_agent_spawn-test",
    });
    expect(result.code).toBe(4);
    expect(soleDocument(result.stdout).ok).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it("exits 0 on a clean answer and 3 on a blocked one, through the real bin", async () => {
    // A one-shot fixture hub, so the SUCCESS path is exercised end to end: tsx
    // bootstrap, contract loading, SDK response VALIDATION against the real
    // schema, envelope, exit code. The body is built from the contract's own
    // vocabulary and asserted valid here first, so a fixture that drifted lands
    // as a failed assertion rather than silently as a "contract error" that would
    // make this case pass for the wrong reason.
    const emptyThreads = (blockers: string[]) => ({
      items: [],
      predicates: [],
      delivery: {
        returned: 0,
        matchedInScope: { value: 0, exact: true, countBasis: "post_dedup" },
        cappedBy: null,
        nextCursor: null,
        snapshotExhausted: true,
        caveats: [],
      },
      capture: {
        planes: AGENT_PLANE_NAMES.map((plane) => ({
          plane,
          state: "not_read",
          reason: "not_queried_by_this_operation",
        })),
        observedRowFloor: null,
        gaps: [],
        sourceErrors: [],
        scopeNarrowing: { keyGrantExcludedPages: 0, totalPagesForQuery: 0 },
        scopeFieldStates: {},
      },
      conclusion: { blockers },
    });
    expect(agentThreadsResponseSchema.safeParse(emptyThreads([])).success).toBe(true);

    const { createServer } = await import("node:http");
    let blockers: string[] = [];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(emptyThreads(blockers)));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const env = {
      HUB_AGENT_KEY: "agency_hub_agent_spawn-test",
      HUB_BASE_URL: `http://127.0.0.1:${port}`,
    };

    try {
      const clean = await hub(["threads"], env);
      expect(clean.code).toBe(0);
      const cleanDocument = soleDocument(clean.stdout);
      expect(cleanDocument.ok).toBe(true);
      expect(cleanDocument.operation).toBe("agentThreads");
      expect(cleanDocument.blockers).toEqual([]);
      expect(cleanDocument.exitCode).toBe(0);

      // Same answer, now narrowed. WITHOUT the flag it is still a 0; with it, a 3.
      blockers = ["window_before_capture_floor"];
      const tolerated = await hub(["threads"], env);
      expect(tolerated.code).toBe(0);
      expect(soleDocument(tolerated.stdout).blockers).toEqual(["window_before_capture_floor"]);

      const strict = await hub(["threads", "--fail-on-partial"], env);
      expect(strict.code).toBe(3);
      const strictDocument = soleDocument(strict.stdout);
      expect(strictDocument.ok).toBe(true);
      expect(strictDocument.exitCode).toBe(3);
      expect(strictDocument.blockers).toEqual(["window_before_capture_floor"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, SPAWN_TIMEOUT_MS);
});
