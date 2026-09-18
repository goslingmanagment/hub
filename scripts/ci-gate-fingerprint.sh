#!/usr/bin/env bash
# Prints the CI gate fingerprint of a revision: a sha256 over every blob the
# Quality Gate can observe. Two revisions with the same fingerprint would run
# byte-identical checks, so a gate that passed for one has passed for the other.
#
# The fingerprint is the full tree MINUS paths no check reads: prose that is
# never imported, parsed, or grepped by a test, a lint rule, a build, or the
# Docker context (`docs` and `investigations` are also in .dockerignore).
# The list is deliberately narrow — anything not named here stays in the hash.
# tests/ci-gate-fingerprint.test.ts pins both the semantics and the rule that
# no test may read an excluded path.
#
# Usage: scripts/ci-gate-fingerprint.sh [revision]   (default HEAD)
set -euo pipefail

revision="${1:-HEAD}"

# NOTE: `git ls-tree -r` lists mode, type, blob sha and path — the hash covers
# executable bits and symlinks as well as content, and nothing else (no commit
# message, author, date, or history), which is exactly what the gate observes.
git ls-tree -r --full-tree "$revision" | awk -F '\t' '
  {
    path = $2
    if (path ~ /^investigations\//) next
    if (path ~ /^docs\/plans\//) next
    if (path ~ /^docs\/audits\//) next
    if (path ~ /^docs\/reports\//) next
    if (path ~ /^docs\/migration-history\//) next
    if (path == "docs/decisions.md") next
    if (path ~ /^\.claude\//) next
    if (path ~ /^\.agentic\//) next
    if (path == "AGENTS.md" || path == "CLAUDE.md" || path == "README.md" || path == "SESSIONS.md" || path == "backlog.md") next
    print
  }
' | shasum -a 256 | cut -c1-64
