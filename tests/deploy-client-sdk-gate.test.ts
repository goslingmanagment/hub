import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeCompatibleClientSdks } from "../apps/runtime/src/services/compatible-client-sdks.ts";

// H-1c: the deploy refuses a candidate that drops a client SDK the running hub
// registers, unless the owner names each dropped value with
// --drop-client-sdk. The gate function from deploy-production.sh runs for
// real against a stubbed run_remote (no SSH, no Docker), and calls the real
// verifier script, as a deploy does.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const deployPath = path.join(repoRoot, "scripts/deploy-production.sh");
const verifierPath = path.join(repoRoot, "scripts/verify-client-sdk-retention.mjs");
const candidateTag = "example/hub:production-candidate-fixture";
const runningTag = "example/hub:production-rollback-fixture";
const printMode = "node apps/runtime/dist/startup.js print-compatible-client-sdks";
const candidateCall = `set -euo pipefail; docker run --rm ${candidateTag} ${printMode}`;
const runningCall = `set -euo pipefail; docker run --rm ${runningTag} ${printMode}`;
const sha = (digit: string) => digit.repeat(64);
const [ownHash, keptHash, retiredHash, keptBuild, retiredBuild, sharedHashBuild, newBuild] =
  ["0", "1", "2", "a", "b", "c", "d"].map(sha) as [string, string, string, string, string, string, string];
const line = (registered: string[], bundles: string[]) => JSON.stringify({ own: ownHash, registered, bundles });
// The old-image failure: startup.js before H-1b takes the mode for a role name.
const unsupportedMode = 'Error: Unsupported Agency Hub runtime role "print-compatible-client-sdks"\n    at resolveRole (file:///app/apps/runtime/dist/startup.js:51:11)';

const stubs = String.raw`
set -euo pipefail
log() { printf '%s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
run_remote() {
  printf '%s\n' "$1" >> "$TEST_COMMAND_LOG"
  case "$1" in
    *" $IMAGE_CANDIDATE_TAG node apps/runtime/dist/startup.js print-compatible-client-sdks")
      [[ -n "$TEST_CANDIDATE_LINE" ]] || { printf 'docker: candidate image missing\n' >&2; return 125; }
      printf '%s\n' "$TEST_CANDIDATE_LINE" ;;
    *" $ROLLBACK_IMAGE_TAG node apps/runtime/dist/startup.js print-compatible-client-sdks")
      if [[ -n "$TEST_RUNNING_ERROR" ]]; then printf '%s\n' "$TEST_RUNNING_ERROR" >&2; return 1; fi
      printf '%s\n' "$TEST_RUNNING_LINE" ;;
    *) printf 'Unexpected remote command\n' >&2; return 97 ;;
  esac
}
DROP_CLIENT_SDKS=($TEST_DROPS)
`;

function gateFunction() {
  const match = readFileSync(deployPath, "utf8").match(/^verify_candidate_client_sdks\(\) \{\n[\s\S]*?^\}\n/m);
  if (!match) throw new Error("Missing deploy function: verify_candidate_client_sdks");
  return match[0];
}

function verifier(...args: string[]) {
  return spawnSync(process.execPath, [verifierPath, ...args], { encoding: "utf8", timeout: 10_000 });
}

describe("deploy gate: a candidate keeps every registered client SDK", () => {
  let fixtureRoot: string;
  let commandLog: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "hub client sdk gate "));
    commandLog = path.join(fixtureRoot, "commands.log");
    writeFileSync(commandLog, "");
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function runGate(options: {
    candidate?: string;
    running?: string;
    runningError?: string;
    runningImage?: boolean;
    drops?: string[];
  }) {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEPLOY_")));
    const result = spawnSync("bash", ["-c", [stubs, gateFunction(), "verify_candidate_client_sdks"].join("\n")], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...inherited,
        IMAGE_CANDIDATE_TAG: candidateTag,
        ROLLBACK_IMAGE_TAG: runningTag,
        ROLLBACK_IMAGE_AVAILABLE: options.runningImage === false ? "0" : "1",
        TEMP_DIR: fixtureRoot,
        SCRIPT_DIR: path.join(repoRoot, "scripts"),
        TEST_COMMAND_LOG: commandLog,
        TEST_CANDIDATE_LINE: options.candidate ?? "",
        TEST_RUNNING_LINE: options.running ?? "",
        TEST_RUNNING_ERROR: options.runningError ?? "",
        TEST_DROPS: (options.drops ?? []).join(" "),
      },
    });
    const calls = readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean);
    return { ...result, calls };
  }

  it("reads the candidate, then the running image, and passes when nothing registered is lost", () => {
    const result = runGate({
      running: line([keptHash], [keptBuild]),
      candidate: line([keptHash, retiredHash], [keptBuild, newBuild]),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([candidateCall, runningCall]);
    expect(result.stdout).toContain("Candidate keeps every client SDK the running hub registers (2 contract hash(es), 2 build(s))");
  });

  it("refuses a dropped build even while another build keeps its contract hash listed", () => {
    const result = runGate({
      running: line([keptHash], [keptBuild, sharedHashBuild]),
      candidate: line([keptHash], [keptBuild]),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`  registry build ${sharedHashBuild}`);
    expect(result.stderr).not.toContain(`contract hash ${keptHash}`);
    expect(result.stderr).toContain("--drop-client-sdk <sha256> once per value above");
    expect(result.stderr).toContain("error: Candidate would drop a registered client SDK");
  });

  it("refuses a retired SDK until the owner names its contract hash and each of its builds", () => {
    const running = line([keptHash, retiredHash], [keptBuild, retiredBuild]);
    const candidate = line([keptHash], [keptBuild]);

    const unnamed = runGate({ running, candidate });
    expect(unnamed.status).toBe(1);
    expect(unnamed.stderr).toContain(`  contract hash ${retiredHash}`);
    expect(unnamed.stderr).toContain(`  registry build ${retiredBuild}`);

    const hashOnly = runGate({ running, candidate, drops: [retiredHash] });
    expect(hashOnly.status).toBe(1);
    expect(hashOnly.stdout).toContain(`Owner-approved drop of contract hash ${retiredHash}`);
    expect(hashOnly.stderr).toContain(`  registry build ${retiredBuild}`);
    expect(hashOnly.stderr).not.toContain(`  contract hash ${retiredHash}`);

    const named = runGate({ running, candidate, drops: [retiredBuild, retiredHash, sha("e")] });
    expect(named.status, named.stderr).toBe(0);
    expect(named.stdout).toContain(`Owner-approved drop of contract hash ${retiredHash}`);
    expect(named.stdout).toContain(`Owner-approved drop of registry build ${retiredBuild}`);
    // A drop that matches nothing changes nothing, and the log says so.
    expect(named.stdout).toContain(`--drop-client-sdk ${sha("e")} ignored: the candidate does not drop it`);
    expect(named.stdout).toContain("Candidate keeps every client SDK the running hub registers (1 contract hash(es), 1 build(s))");
  });

  it("skips the comparison, with a message, when the running image predates the print mode", () => {
    const result = runGate({ candidate: line([keptHash], [keptBuild]), runningError: unsupportedMode, drops: [retiredHash] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([candidateCall, runningCall]);
    expect(result.stderr).toContain("Running image predates print-compatible-client-sdks; skipping the registered client SDK comparison");
    expect(result.stdout).toContain(`--drop-client-sdk ${retiredHash} ignored: no running image line to compare`);
    expect(result.stdout).toContain("Candidate registers 1 contract hash(es), 1 build(s); no running image line to compare");
  });

  it("compares nothing when no running image was captured", () => {
    const result = runGate({ candidate: line([keptHash], [keptBuild]), runningImage: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([candidateCall]);
    expect(result.stderr).toContain("No running image to compare registered client SDKs with");
  });

  it("fails closed when the running image cannot be read for any other reason", () => {
    const result = runGate({
      candidate: line([keptHash], [keptBuild]),
      runningError: "docker: Error response from daemon: No such image",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No such image");
    expect(result.stderr).toContain("error: Unable to read the running image's registered client SDKs");
    expect(result.stdout).toBe("");
  });

  it("fails before reading the running image when the candidate cannot print its registry", () => {
    const result = runGate({ running: line([keptHash], [keptBuild]) });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([candidateCall]);
    expect(result.stderr).toContain("error: Unable to read the candidate's registered client SDKs");
  });

  it.each([
    ["not JSON", "Starting hub"],
    ["no bundles (a line without the H-1b build list)", JSON.stringify({ own: ownHash, registered: [keptHash] })],
    ["a short hash", JSON.stringify({ own: ownHash, registered: ["b95b765c"], bundles: [] })],
    ["an uppercase hash", JSON.stringify({ own: ownHash, registered: [sha("f").toUpperCase()], bundles: [] })],
    ["no own hash", JSON.stringify({ registered: [], bundles: [] })],
    ["an array", "[]"],
  ])("refuses a registry line with %s, from either image", (_label, malformed) => {
    const good = line([keptHash], [keptBuild]);
    for (const [candidate, running] of [[malformed, good], [good, malformed]] as const) {
      const result = runGate({ candidate, running });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("verify-client-sdk-retention: the ");
      expect(result.stderr).toContain("error: Candidate would drop a registered client SDK, or its registry line is unreadable");
    }
  });

  it("reads the line startup prints today, and ignores keys it does not know", () => {
    const today = JSON.stringify(describeCompatibleClientSdks());
    const kept = verifier("--candidate", today, "--running", today);
    expect(kept.status, kept.stderr).toBe(0);
    expect(kept.stdout).toContain("Candidate keeps every client SDK the running hub registers");
    const later = JSON.stringify({ ...describeCompatibleClientSdks(), future: { anything: true } });
    expect(verifier("--candidate", later, "--running", today).status).toBe(0);
    expect(verifier("--candidate", today, "--running", later).status).toBe(0);
  });

  it.each([
    [[] as string[], "--candidate is required"],
    [["--candidate"], "missing value for --candidate"],
    [["--candidate", line([], []), "--drop", "B95B"], "--drop takes a lowercase sha256"],
    [["--candidate", line([], []), "--candidate", line([], [])], "unexpected argument"],
    [["--candidate", line([], []), "--keep", sha("1")], "unexpected argument"],
  ])("rejects verifier arguments %j", (args, message) => {
    const result = verifier(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it.each([
    [["--drop-client-sdk", "b95b765c"], "--drop-client-sdk takes a lowercase sha256"],
    [["--drop-client-sdk", sha("B")], "--drop-client-sdk takes a lowercase sha256"],
    [["--drop-client-sdk", `${sha("b")}; echo injected`], "--drop-client-sdk takes a lowercase sha256"],
    [["--drop-client-sdk"], "Missing value for --drop-client-sdk"],
  ])("deploy-production.sh rejects %j before SSH", (flags, message) => {
    const result = spawnSync("bash", ["-c", String.raw`
      ssh() { printf 'unexpected SSH\n' >> "$TEST_COMMAND_LOG"; return 99; }
      export -f ssh
      script="$1"; shift
      bash "$script" "$@"
    `, "fixture", deployPath, "root@localhost", ...flags], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, TEST_COMMAND_LOG: commandLog },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(readFileSync(commandLog, "utf8")).toBe("");
  });
});
