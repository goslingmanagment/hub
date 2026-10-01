#!/usr/bin/env bash
set -euo pipefail

# Sync Engine design §9.3, assumption A3: proves on a throwaway Compose
# project the order the production deploy relies on when it recreates the
# `sync` container. Stand-in services mirror production's dependency graph
# (postgres <- api <- worker, sync; postgres <- scheduler); the stand-in api
# turns healthy only after MIGRATE_MS, like an api running its startup
# migrations, and the stand-in sync needs DRAIN_MS after SIGTERM, like an
# engine finishing its in-flight request. Every container appends its
# lifecycle events to one log on a shared volume.
#
#   1. The app-scope recreate (`up ... api worker scheduler`, the deploy's own
#      command) leaves the running sync container untouched while the new api
#      migrates.
#   2. The separate `up -d --no-deps --force-recreate --no-build sync`, run
#      once the api is healthy, stops the old sync with SIGTERM, waits for its
#      graceful exit and only then starts the new one: no overlap.
#   3. Control (the assumption itself): with sync listed in the same `up` as
#      the api, Compose stops the old sync before the new api is healthy.
#   4. Rollback to release files without a sync service (`up -d
#      --remove-orphans --force-recreate --no-build`, no service list) removes
#      the sync container after a graceful stop.
#
# Exit 0 when 1, 2 and 4 hold; 3 is reported either way (if it does not hold,
# the separate step is merely unnecessary, never unsafe). Needs a local Docker
# daemon and the image locally; it touches nothing but its own project.
#
#   scripts/check-compose-recreate-order.sh [image]   (default node:22-bookworm-slim)

IMAGE="${1:-node:22-bookworm-slim}"
MIGRATE_MS=8000
DRAIN_MS=3000
PROJECT="hub-a3-check-$$"
VOLUME="${PROJECT}-events"
WORKDIR="$(mktemp -d)"
COMPOSE_FILE="${WORKDIR}/compose.yml"
OLD_COMPOSE_FILE="${WORKDIR}/compose-without-sync.yml"
FAILURES=0

# The deploy's commands, verbatim (scripts/deploy-production.sh).
APP_RECREATE=(up -d --remove-orphans --force-recreate --no-build api worker scheduler)
SYNC_RECREATE=(up -d --no-deps --force-recreate --no-build sync)
ROLLBACK_RECREATE=(up -d --remove-orphans --force-recreate --no-build)

compose() {
  docker compose --progress quiet --project-name "$PROJECT" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  docker compose --project-name "$PROJECT" -f "$COMPOSE_FILE" down --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  docker compose --project-name "$PROJECT" -f "$OLD_COMPOSE_FILE" down --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

note() {
  printf '%s\n' "$*"
}

verdict() {
  local status="$1"
  shift
  printf '[%s] %s\n' "$status" "$*"
  if [[ "$status" == "FAIL" ]]; then
    FAILURES=$((FAILURES + 1))
  fi
}

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || { note "Image ${IMAGE} is not available locally; pull it or pass another Node image"; exit 2; }

cat >"${WORKDIR}/standin.mjs" <<'JS'
import { appendFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

const role = process.argv[2];
const log = (event) => appendFileSync("/events/log", `${Date.now()} ${role} ${event} ${hostname()}\n`);
log("start");
setInterval(() => {}, 1 << 30);
if (role === "api") {
  setTimeout(() => {
    writeFileSync("/tmp/ready", "");
    log("ready");
  }, Number(process.env.MIGRATE_MS));
}
process.on("SIGTERM", () => {
  log("term");
  setTimeout(() => {
    log("exit");
    process.exit(0);
  }, role === "sync" ? Number(process.env.DRAIN_MS) : 0);
});
JS

write_compose() {
  local file="$1"
  local with_sync="$2"
  cat >"$file" <<YAML
x-standin: &standin
  image: ${IMAGE}
  # No network: the order under test does not depend on it, and a shared
  # Docker daemon may have no address pool left for one more project network.
  network_mode: none
  volumes:
    - events:/events
  environment:
    MIGRATE_MS: "${MIGRATE_MS}"
    DRAIN_MS: "${DRAIN_MS}"

services:
  postgres:
    <<: *standin
    command: ["node", "/events/standin.mjs", "postgres"]
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      timeout: 2s
      retries: 30

  api:
    <<: *standin
    command: ["node", "/events/standin.mjs", "api"]
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "test", "-f", "/tmp/ready"]
      interval: 1s
      timeout: 2s
      retries: 120

  scheduler:
    <<: *standin
    command: ["node", "/events/standin.mjs", "scheduler"]
    depends_on:
      postgres:
        condition: service_healthy

  worker:
    <<: *standin
    stop_grace_period: 60s
    command: ["node", "/events/standin.mjs", "worker"]
    depends_on:
      postgres:
        condition: service_healthy
      api:
        condition: service_healthy
YAML
  if [[ "$with_sync" == "1" ]]; then
    cat >>"$file" <<'YAML'

  sync:
    <<: *standin
    stop_grace_period: 45s
    command: ["node", "/events/standin.mjs", "sync"]
    depends_on:
      postgres:
        condition: service_healthy
      api:
        condition: service_healthy
YAML
  fi
  cat >>"$file" <<YAML

volumes:
  events:
    name: ${VOLUME}
    external: true
YAML
}

EVENTS=""
# Reads the shared event log once per phase.
refresh_events() {
  EVENTS="$(docker run --rm -v "${VOLUME}:/events" "$IMAGE" cat /events/log)"
}

# event_ms <role> <event> <hostname> -> epoch ms of the first matching event, or empty.
event_ms() {
  printf '%s\n' "$EVENTS" | awk -v role="$1" -v event="$2" -v host="$3" '$2 == role && $3 == event && $4 == host { print $1; exit }'
}

service_container() {
  compose ps -a -q "$1"
}

container_hostname() {
  docker inspect -f '{{.Config.Hostname}}' "$1"
}

write_compose "$COMPOSE_FILE" 1
write_compose "$OLD_COMPOSE_FILE" 0
docker volume create "$VOLUME" >/dev/null
docker run --rm -i -v "${VOLUME}:/events" "$IMAGE" sh -c 'cat > /events/standin.mjs; : > /events/log' <"${WORKDIR}/standin.mjs"

note "Compose: $(docker compose version --short) / Docker Engine $(docker version --format '{{.Server.Version}}') / image ${IMAGE}"
note "Stand-in api migrates for ${MIGRATE_MS} ms; stand-in sync drains for ${DRAIN_MS} ms after SIGTERM"

compose up -d --pull never
sync_1="$(service_container sync)"
sync_1_host="$(container_hostname "$sync_1")"
sync_1_started="$(docker inspect -f '{{.State.StartedAt}}' "$sync_1")"

# 1. The app-scope recreate leaves sync alone.
compose "${APP_RECREATE[@]}"
refresh_events
api_2_host="$(container_hostname "$(service_container api)")"
api_2_ready="$(event_ms api ready "$api_2_host")"
sync_after="$(service_container sync)"
if [[ "$sync_after" == "$sync_1" \
  && "$(docker inspect -f '{{.State.Running}} {{.State.StartedAt}}' "$sync_1")" == "true ${sync_1_started}" \
  && -z "$(event_ms sync term "$sync_1_host")" && -n "$api_2_ready" ]]; then
  verdict PASS "1. '${APP_RECREATE[*]}' left the sync container ${sync_1_host} running untouched while the new api ${api_2_host} migrated"
else
  verdict FAIL "1. '${APP_RECREATE[*]}' touched the sync container (before ${sync_1_host}, after ${sync_after:-none}) or the new api never became ready"
fi

# 2. The separate sync recreate after API health: graceful stop, then start.
compose "${SYNC_RECREATE[@]}"
refresh_events
sync_2_host="$(container_hostname "$(service_container sync)")"
term_1="$(event_ms sync term "$sync_1_host")"
exit_1="$(event_ms sync exit "$sync_1_host")"
start_2="$(event_ms sync start "$sync_2_host")"
if [[ -n "$term_1" && -n "$exit_1" && -n "$start_2" && -n "$api_2_ready" \
  && "$sync_2_host" != "$sync_1_host" \
  && "$term_1" -gt "$api_2_ready" \
  && $((exit_1 - term_1)) -ge $((DRAIN_MS - 100)) \
  && "$start_2" -ge "$exit_1" ]]; then
  verdict PASS "2. '${SYNC_RECREATE[*]}': old sync got SIGTERM $((term_1 - api_2_ready)) ms after the new api was ready, drained $((exit_1 - term_1)) ms and exited; the new sync ${sync_2_host} started $((start_2 - exit_1)) ms after that exit"
else
  verdict FAIL "2. '${SYNC_RECREATE[*]}' did not stop the old sync gracefully before starting the new one (term=${term_1:-none} exit=${exit_1:-none} new start=${start_2:-none} api ready=${api_2_ready:-none})"
fi

# 3. Control: sync listed with the api in one `up`.
compose up -d --remove-orphans --force-recreate --no-build api worker scheduler sync
refresh_events
api_3_host="$(container_hostname "$(service_container api)")"
api_3_ready="$(event_ms api ready "$api_3_host")"
term_2="$(event_ms sync term "$sync_2_host")"
if [[ -n "$term_2" && -n "$api_3_ready" && "$term_2" -lt "$api_3_ready" ]]; then
  verdict INFO "3. A3 confirmed: with sync in the same 'up' as the api, the old sync got SIGTERM $((api_3_ready - term_2)) ms BEFORE the new api finished migrating"
else
  verdict INFO "3. A3 not observed: with sync in the same 'up', the old sync got SIGTERM at ${term_2:-never}, the new api was ready at ${api_3_ready:-never}"
fi

# 4. Rollback to release files that have no sync service.
sync_3_host="$(container_hostname "$(service_container sync)")"
docker compose --progress quiet --project-name "$PROJECT" -f "$OLD_COMPOSE_FILE" "${ROLLBACK_RECREATE[@]}"
refresh_events
remaining="$(docker ps -a -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=sync")"
term_3="$(event_ms sync term "$sync_3_host")"
exit_3="$(event_ms sync exit "$sync_3_host")"
if [[ -z "$remaining" && -n "$term_3" && -n "$exit_3" ]]; then
  verdict PASS "4. '${ROLLBACK_RECREATE[*]}' with release files without sync removed the sync container ${sync_3_host} after SIGTERM and a $((exit_3 - term_3)) ms drain"
else
  verdict FAIL "4. rollback left a sync container (${remaining:-none}) or stopped it without SIGTERM (term=${term_3:-none} exit=${exit_3:-none})"
fi

note "Timeline (ms from the first event):"
printf '%s\n' "$EVENTS" | sort -n -k1,1 | awk 'NR == 1 { t0 = $1 } { printf "  %+7d  %-9s %-6s %s\n", $1 - t0, $2, $3, $4 }'

if (( FAILURES > 0 )); then
  note "The deploy's sync recreate order does NOT hold (${FAILURES} failed check(s))"
  exit 1
fi
note "The deploy's sync recreate order holds"
