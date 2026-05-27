#!/usr/bin/env bash
set -euo pipefail
set -m

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

read_env_value() {
  local name="$1"

  [[ -f .env ]] || return 0

  node -e "
const fs = require('fs');
const name = process.argv[1];
const env = fs.readFileSync('.env', 'utf8');

for (const line of env.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    continue;
  }

  const separatorIndex = trimmed.indexOf('=');
  if (separatorIndex <= 0) {
    continue;
  }

  if (trimmed.slice(0, separatorIndex).trim() !== name) {
    continue;
  }

  let value = trimmed.slice(separatorIndex + 1).trim();
  if (
    (value.startsWith('\"') && value.endsWith('\"')) ||
    (value.startsWith(\"'\") && value.endsWith(\"'\"))
  ) {
    value = value.slice(1, -1);
  }

  console.log(value);
  process.exit(0);
}
" "$name"
}

port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

find_available_port() {
  local start_port="$1"
  local port="$start_port"
  local max_port=$((start_port + 99))

  while ((port <= max_port)); do
    if ! port_in_use "$port"; then
      echo "$port"
      return 0
    fi

    port=$((port + 1))
  done

  echo "No available API port found between ${start_port} and ${max_port}." >&2
  return 1
}

if [[ ! -f .env ]]; then
  echo "Creating .env from .env.example..."
  create_env
elif grep -qx "APP_ENCRYPTION_KEY=replace-with-32-byte-base64-key" .env; then
  echo "Replacing placeholder APP_ENCRYPTION_KEY in .env..."
  replace_placeholder_key
fi

configured_api_port="${API_PORT:-}"
if [[ -z "$configured_api_port" ]]; then
  configured_api_port="$(read_env_value API_PORT)"
fi
configured_api_port="${configured_api_port:-3000}"

api_port="$(find_available_port "$configured_api_port")"
api_proxy_target="http://127.0.0.1:${api_port}"

if [[ "$api_port" != "$configured_api_port" ]]; then
  echo "API port ${configured_api_port} is in use; using ${api_port} for this dev session."
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
    for pid in "${pids[@]}"; do
      kill -- "-$pid" >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
    done
    wait "${pids[@]}" >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM EXIT

echo "Starting API, worker, and dashboard..."
echo "API will listen on port ${api_port}; dashboard proxy target is ${api_proxy_target}."

API_PORT="$api_port" pnpm api &
pids+=("$!")

API_PORT="$api_port" pnpm worker &
pids+=("$!")

VITE_API_PROXY_TARGET="$api_proxy_target" pnpm dev:dashboard &
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
