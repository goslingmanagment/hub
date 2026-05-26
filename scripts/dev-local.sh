#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

generate_key() {
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
}

create_env() {
  local key
  key="$(generate_key)"

  node -e "const fs = require('fs'); const key = process.argv[1]; const template = fs.readFileSync('.env.example', 'utf8'); fs.writeFileSync('.env', template.replace(/^APP_ENCRYPTION_KEY=.*/m, 'APP_ENCRYPTION_KEY=' + key));" "$key"
}

replace_placeholder_key() {
  local key
  key="$(generate_key)"

  node -e "const fs = require('fs'); const key = process.argv[1]; const env = fs.readFileSync('.env', 'utf8'); fs.writeFileSync('.env', env.replace(/^APP_ENCRYPTION_KEY=replace-with-32-byte-base64-key$/m, 'APP_ENCRYPTION_KEY=' + key));" "$key"
}

if [[ ! -f .env ]]; then
  echo "Creating .env from .env.example..."
  create_env
elif grep -qx "APP_ENCRYPTION_KEY=replace-with-32-byte-base64-key" .env; then
  echo "Replacing placeholder APP_ENCRYPTION_KEY in .env..."
  replace_placeholder_key
fi

echo "Starting Docker Postgres..."
pnpm dev:db

echo "Waiting for Postgres..."
until docker compose exec -T postgres pg_isready -U postgres -d agency_hub_core >/dev/null 2>&1; do
  sleep 1
done

echo "Running migrations..."
pnpm db:migrate

pids=()

cleanup() {
  trap - INT TERM EXIT

  if ((${#pids[@]} > 0)); then
    echo
    echo "Stopping local processes..."
    kill "${pids[@]}" >/dev/null 2>&1 || true
    wait "${pids[@]}" >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM EXIT

echo "Starting API, worker, and dashboard..."
pnpm api &
pids+=("$!")

pnpm worker &
pids+=("$!")

pnpm dev:dashboard &
pids+=("$!")

while true; do
  running_count="$(jobs -pr | wc -l | tr -d ' ')"

  if [[ "$running_count" -lt "${#pids[@]}" ]]; then
    break
  fi

  sleep 1
done

status=0
for pid in "${pids[@]}"; do
  if ! jobs -pr | grep -qx "$pid"; then
    wait "$pid" || status=$?
    break
  fi
done

exit "$status"
