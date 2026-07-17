import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function getShellFunction(text: string, functionName: string) {
  const match = text.match(
    new RegExp(`^${functionName}\\(\\) \\{\\n([\\s\\S]*?)(?=^}\\n)`, "m"),
  );

  if (!match) {
    throw new Error(`Unable to find ${functionName} in deploy-production.sh`);
  }

  return `${match[0]}}\n`;
}

function runHarness(source: string, mode: string) {
  return spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MODE_UNDER_TEST: mode,
    },
    input: source,
    timeout: 5_000,
  });
}

function candidateRetentionHarness(pruneFunction: string) {
  return [
    "set -euo pipefail",
    pruneFunction,
    'IMAGE_TAG="agency_hub_core/runtime:production"',
    'log() { printf \'LOG:%s\\n\' "$*"; }',
    "docker() {",
    '  local command="${1:-} ${2:-}"',
    '  local reference="${!#}"',
    '  case "$command" in',
    '    "image ls")',
    '      [[ "$MODE_UNDER_TEST" != "list-failure" ]] || return 7',
    "      printf '%s\\n' \\",
    "        '2026-07-17 00:00:00 +0000 UTC|agency_hub_core/runtime:production-candidate-old' \\",
    "        '2026-07-17 05:00:00 +0000 UTC|agency_hub_core/runtime:production-candidate-newest' \\",
    "        '2026-07-17 03:00:00 +0000 UTC|agency_hub_core/runtime:production-candidate-used' \\",
    "        '2026-07-17 01:00:00 +0000 UTC|agency_hub_core/runtime:production-candidate-rm-fails' \\",
    "        '2026-07-17 04:00:00 +0000 UTC|agency_hub_core/runtime:production-candidate-second' \\",
    "        '2026-07-17 02:00:00 +0000 UTC|agency_hub_core/runtime:production-candidate-inspect-fails'",
    "      ;;",
    '    "container ls")',
    '      [[ "$MODE_UNDER_TEST" != "container-failure" ]] || return 8',
    "      printf '%s\\n' container-1",
    "      ;;",
    '    "container inspect")',
    '      [[ "$MODE_UNDER_TEST" != "container-inspect-failure" ]] || return 9',
    "      printf '%s\\n' sha256:used",
    "      ;;",
    '    "image inspect")',
    '      case "$reference" in',
    "        *candidate-newest) printf '%s\\n' sha256:newest ;;",
    "        *candidate-second) printf '%s\\n' sha256:second ;;",
    "        *candidate-used) printf '%s\\n' sha256:used ;;",
    "        *candidate-inspect-fails) return 9 ;;",
    "        *candidate-rm-fails) printf '%s\\n' sha256:rm-fails ;;",
    "        *candidate-old) printf '%s\\n' sha256:old ;;",
    "        *) return 11 ;;",
    "      esac",
    "      ;;",
    '    "image rm")',
    '      printf \'RM_ATTEMPT:%s\\n\' "$reference" >&2',
    '      [[ "$reference" != *candidate-rm-fails ]] || return 10',
    "      ;;",
    "    *)",
    '      printf \'unexpected docker call: %s\\n\' "$*" >&2',
    "      return 12",
    "      ;;",
    "  esac",
    "}",
    "prune_local_candidate_tags",
    "",
  ].join("\n");
}

function cachePromotionHarness(promoteFunction: string) {
  return [
    "set -euo pipefail",
    promoteFunction,
    'IMAGE_CANDIDATE_TAG="agency_hub_core/runtime:production-candidate-current"',
    'LOCAL_BUILD_CACHE_TAG="agency_hub_core/runtime:production-build-cache-linux-amd64"',
    'log() { printf \'LOG:%s\\n\' "$*"; }',
    "docker() {",
    '  if [[ "${1:-} ${2:-}" == "image inspect" ]]; then',
    '    [[ "$MODE_UNDER_TEST" != "missing" ]]',
    "    return",
    "  fi",
    '  if [[ "${1:-}" == "tag" ]]; then',
    '    printf \'TAG_ATTEMPT:%s->%s\\n\' "$2" "$3" >&2',
    '    [[ "$MODE_UNDER_TEST" != "tag-failure" ]]',
    "    return",
    "  fi",
    '  printf \'unexpected docker call: %s\\n\' "$*" >&2',
    "  return 12",
    "}",
    "promote_local_build_cache",
    "",
  ].join("\n");
}

describe("deploy-production Docker retention behavior", () => {
  it("keeps the newest two candidates, protects in-use images, and tolerates per-image failures", async () => {
    const deployScript = await readFile(
      path.join(repoRoot, "scripts/deploy-production.sh"),
      "utf8",
    );
    const pruneFunction = getShellFunction(deployScript, "prune_local_candidate_tags");
    const result = runHarness(candidateRetentionHarness(pruneFunction), "normal");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("candidate-newest");
    expect(result.stderr).not.toContain("candidate-second");
    expect(result.stderr).not.toContain("candidate-used");
    expect(result.stderr).not.toContain("candidate-inspect-fails");
    expect(result.stderr).toContain("RM_ATTEMPT:agency_hub_core/runtime:production-candidate-rm-fails");
    expect(result.stderr).toContain("RM_ATTEMPT:agency_hub_core/runtime:production-candidate-old");
    expect(result.stdout).toContain("Keeping stale candidate agency_hub_core/runtime:production-candidate-used");
    expect(result.stdout).toContain("unable to inspect stale candidate agency_hub_core/runtime:production-candidate-inspect-fails");
    expect(result.stdout).toContain("unable to remove stale candidate tag agency_hub_core/runtime:production-candidate-rm-fails");
    expect(result.stdout).toContain("Removed stale local candidate tag agency_hub_core/runtime:production-candidate-old");
  });

  for (const mode of ["list-failure", "container-failure", "container-inspect-failure"]) {
    it(`fails closed when ${mode.replace("-", " ")} occurs`, async () => {
      const deployScript = await readFile(
        path.join(repoRoot, "scripts/deploy-production.sh"),
        "utf8",
      );
      const pruneFunction = getShellFunction(deployScript, "prune_local_candidate_tags");
      const result = runHarness(candidateRetentionHarness(pruneFunction), mode);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("RM_ATTEMPT:");
      expect(result.stdout).toMatch(
        /unable to (list local candidate images|inventory local containers|resolve local container images)/,
      );
    });
  }

  for (const testCase of [
    { mode: "missing", expectedLog: "is absent (dist-only build)", tags: false },
    { mode: "present", expectedLog: "Advanced local build cache", tags: true },
    { mode: "tag-failure", expectedLog: "unable to advance local build cache", tags: true },
  ]) {
    it(`handles cache promotion mode ${testCase.mode}`, async () => {
      const deployScript = await readFile(
        path.join(repoRoot, "scripts/deploy-production.sh"),
        "utf8",
      );
      const promoteFunction = getShellFunction(deployScript, "promote_local_build_cache");
      const result = runHarness(cachePromotionHarness(promoteFunction), testCase.mode);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(testCase.expectedLog);
      if (testCase.tags) {
        expect(result.stderr).toContain("TAG_ATTEMPT:");
      } else {
        expect(result.stderr).not.toContain("TAG_ATTEMPT:");
      }
    });
  }
});
