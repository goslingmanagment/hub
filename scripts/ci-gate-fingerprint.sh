#!/usr/bin/env bash
# Hash gate inputs, including code and data inside evidence directories.
# Only regular, non-executable Markdown in reviewed prose locations is ignored.
# The integration scope additionally excludes dashboard source/public assets;
# ALL tests, manifests, configuration, scripts and unknown paths remain inputs.
# Usage: scripts/ci-gate-fingerprint.sh [revision] [gate|integration]
set -euo pipefail

revision="${1:-HEAD}"
scope="${2:-gate}"
case "$scope" in gate|integration) ;; *) echo "Unknown gate scope: $scope" >&2; exit 1 ;; esac

# NOTE: `git ls-tree -r` lists mode, type, blob sha and path — the hash covers
# executable bits and symlinks as well as content, and nothing else (no commit
# message, author, date, or history), which is exactly what the gate observes.
git -c core.quotePath=true ls-tree -r --full-tree "$revision" | awk -F '\t' -v scope="$scope" '
  {
    path = $2
    if ($1 ~ /^100644 / && path ~ /\.md$/) {
      if (path ~ /^(investigations|\.claude|\.agentic)\//) next
      if (path ~ /^docs\/(plans|audits|reports|migration-history)\//) next
      if (path == "docs/decisions.md") next
      if (path == "AGENTS.md" || path == "CLAUDE.md" || path == "README.md" || path == "SESSIONS.md" || path == "backlog.md") next
    }
    if (scope == "integration" && $1 ~ /^100644 / && path ~ /^apps\/dashboard\/(src|public)\//) next
    print
  }
' | shasum -a 256 | cut -c1-64
