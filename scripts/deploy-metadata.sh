#!/usr/bin/env bash

# Shared by the local deploy and CI image build. Preserve this order and hashing
# format: existing clean full images are keyed by this exact checksum protocol.
DEPENDENCY_MANIFEST_FILES=(
  Dockerfile
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  apps/dashboard/package.json
  apps/runtime/package.json
  packages/contracts/package.json
  packages/db/package.json
  packages/fansly/package.json
  packages/platform-core/package.json
  packages/shared/package.json
)

calculate_dependency_checksum() (
  set -euo pipefail
  local root="${1:-${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"
  cd "$root" || return 1
  # Validate before producing any checksum, including when the caller sources
  # this helper without enabling pipefail or tests its result in a conditional.
  local file
  for file in "${DEPENDENCY_MANIFEST_FILES[@]}"; do
    if [[ ! -f "$file" ]]; then
      printf '[deploy-metadata] Dependency checksum file is missing: %s\n' "$file" >&2
      return 1
    fi
  done
  local checksum
  checksum="$(
    for file in "${DEPENDENCY_MANIFEST_FILES[@]}"; do
      printf 'file:%s\n' "$file"
      shasum -a 256 "$file" || exit 1
    done
  )" || return 1
  # Capture the complete manifest before hashing it. A failed file read must
  # not expose a valid-looking checksum of a partial manifest to the caller.
  printf '%s\n' "$checksum" | shasum -a 256 | awk '{print $1}'
)

calculate_source_revision() {
  local root="${1:-${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}"
  local revision
  if revision="$(git -C "$root" rev-parse --short=12 HEAD 2>/dev/null)"; then
    if [[ -n "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
      revision="${revision}-dirty"
    fi
    printf '%s' "$revision"
  else
    printf 'unknown'
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  source_revision="$(calculate_source_revision "${1:-}")"
  dependency_checksum="$(calculate_dependency_checksum "${1:-}")"
  printf 'source_revision=%s\ndependency_checksum=%s\n' "$source_revision" "$dependency_checksum"
fi
