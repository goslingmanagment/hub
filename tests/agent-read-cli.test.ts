import { describe, expect, it } from "vitest";

import { resolveHubCredentials } from "../packages/hub-agent-cli/src/credentials.ts";

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
