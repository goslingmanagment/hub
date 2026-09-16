#!/usr/bin/env bash
set -euo pipefail

case "${CI_TYPECHECK_ALREADY_PASSED:-false}" in
  false) exec pnpm build:production ;;
  true) exec pnpm build:artifacts ;;
  *) echo "CI_TYPECHECK_ALREADY_PASSED must be true or false" >&2; exit 1 ;;
esac
