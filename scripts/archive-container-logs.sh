#!/usr/bin/env bash
# Archives the whole Docker log of every container of the named Compose
# services before a deploy replaces them (М1). The production `local` log
# driver keeps a container's log in the container's own directory, so
# `up --force-recreate` deletes it together with the container, and nothing
# ships it anywhere else.
#
# ONLY READS DOCKER: `docker ps`, `docker inspect` and `docker logs`. It never
# stops, kills or removes a container and never runs Compose, so it is safe to
# run by hand at any time. A running container is read as it is: the header
# says "snapshot":true, and the lines it writes after the read are not kept.
#
#   archive-container-logs.sh --dir D --project-dir P --reason R
#     [--max-age-days 30] [--max-bytes 536870912] [--max-disk-percent 90]
#     [--logs-timeout 60] SERVICE...
#
# Containers are those with the Compose labels working_dir=P (normalized
# through `cd P && pwd`), service=S and oneoff=False, whatever the Compose
# file says now. Each one becomes D/S/<created>_<archived>_<id12>_<rev12>.log.gz
# (0600, directories 0700): a `# hub-container-log {json}` header, then
# `docker logs --timestamps`. A read that failed or timed out, or a gzip that
# failed, is kept as ….truncated.log.gz. Archives older than --max-age-days
# and *.partial files older than an hour are removed, then the oldest archives
# until D holds at most --max-bytes; this run's files are never removed, and
# when they alone exceed the cap the output says over_cap. At --max-disk-percent
# or above (df -P D) nothing is written.
#
# stdout carries metadata only, never a log line. Exit status:
#   0  every named service had a container, every log was read and written
#   3  partial: a service without a container, a truncated read, a failed write
#   4  nothing written: the disk is at the threshold or D is unusable
#   2  bad arguments
#
# Portable to bash 3.2 and BSD tools (macOS runs its tests); `timeout` is
# optional, without it a log is read without a time limit.

usage() {
  printf 'usage: %s --dir D --project-dir P --reason R [--max-age-days N] [--max-bytes N] [--max-disk-percent N] [--logs-timeout N] SERVICE...\n' "${0##*/}" >&2
  exit 2
}

bad() {
  printf 'archive-container-logs: %s\n' "$*" >&2
  exit 2
}

is_count() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  return 0
}

file_size() {
  local size
  size="$(wc -c <"$1" 2>/dev/null)" || size=0
  size="${size//[!0-9]/}"
  printf '%s' "${size:-0}"
}

is_run_file() {
  case "$RUN_FILES" in
    *"|$1|"*) return 0 ;;
  esac
  return 1
}

remove_file() {
  local size
  size="$(file_size "$1")"
  if rm -f -- "$1" 2>/dev/null; then
    PRUNED_FILES=$((PRUNED_FILES + 1))
    PRUNED_BYTES=$((PRUNED_BYTES + size))
    TOTAL_BYTES=$((TOTAL_BYTES - size))
  fi
}

# Removes archives older than the age limit and stale partials, then the
# oldest archives (by mtime) while D holds more than the byte cap. Partials
# count toward the cap but only archives are removed for it, and never one of
# this run's files.
prune() {
  local file
  local found=()
  local archives=()
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    is_run_file "$file" && continue
    remove_file "$file"
  done < <(find "$DIR" -type f \( \( -name '*.log.gz' -mmin "+$((MAX_AGE_DAYS * 1440))" \) -o \( -name '*.partial' -mmin +60 \) \) -print 2>/dev/null)

  shopt -s nullglob
  found=("$DIR"/*/*.log.gz "$DIR"/*/*.partial)
  archives=("$DIR"/*/*.log.gz)
  shopt -u nullglob

  TOTAL_BYTES=0
  for file in ${found[@]+"${found[@]}"}; do
    TOTAL_BYTES=$((TOTAL_BYTES + $(file_size "$file")))
  done
  (( TOTAL_BYTES > MAX_BYTES && ${#archives[@]} > 0 )) || return 0

  while IFS= read -r file; do
    (( TOTAL_BYTES > MAX_BYTES )) || break
    [[ -n "$file" ]] || continue
    is_run_file "$file" && continue
    remove_file "$file"
  done < <(ls -1tr -- "${archives[@]}" 2>/dev/null)
}

finish() {
  local status="$1"
  if [[ "$DIR_USABLE" == "1" ]]; then
    prune
    printf 'pruned files=%s bytes=%s total=%s\n' "$PRUNED_FILES" "$PRUNED_BYTES" "$TOTAL_BYTES"
    if (( TOTAL_BYTES > MAX_BYTES )); then
      printf 'over_cap bytes=%s max_bytes=%s\n' "$TOTAL_BYTES" "$MAX_BYTES"
    fi
  fi
  exit "$status"
}

# YYYY-MM-DDTHH:MM:SS(.fraction)Z -> YYYYMMDDTHHMMSSZ, or "unknown".
compact_time() {
  local value="${1:0:19}"
  case "$value" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]) ;;
    *) printf 'unknown'; return ;;
  esac
  value="${value//-/}"
  printf '%sZ' "${value//:/}"
}

archive_container() {
  local service="$1"
  local id="$2"
  local id12="${id:0:12}"
  local template inspected plain fields created running revision rev12
  local archived_compact archived_iso snapshot header name candidate suffix partial target
  local service_dir="${DIR}/${service}"
  local read_limit="none"
  local statuses logs_status gzip_status bytes

  template='{{.Created}}|{{.State.Running}}|{{index .Config.Labels "agency-hub.source-revision"}}'
  template+=$'\t'
  template+='"service":{{json (index .Config.Labels "com.docker.compose.service")}},"name":{{json .Name}},"id":{{json .Id}}'
  template+=',"revision":{{json (index .Config.Labels "agency-hub.source-revision")}},"created":{{json .Created}}'
  template+=',"started":{{json .State.StartedAt}},"finished":{{json .State.FinishedAt}},"state":{{json .State.Status}}'
  template+=',"exit_code":{{json .State.ExitCode}},"oom_killed":{{json .State.OOMKilled}},"restart_count":{{json .RestartCount}}'
  if ! inspected="$(docker inspect --format "$template" "$id" 2>/dev/null)" \
    || [[ "$inspected" != *$'\t'* ]]; then
    printf 'not_written service=%s id=%s error=inspect_failed\n' "$service" "$id12"
    INCOMPLETE=1
    return
  fi
  plain="${inspected%%$'\t'*}"
  fields="${inspected#*$'\t'}"
  created="${plain%%|*}"
  plain="${plain#*|}"
  running="${plain%%|*}"
  revision="${plain#*|}"
  [[ "$revision" != "<no value>" ]] || revision=""
  rev12="${revision//[!A-Za-z0-9._-]/}"
  rev12="${rev12:0:12}"
  [[ -n "$rev12" ]] || rev12="none"
  snapshot="false"
  [[ "$running" != "true" ]] || snapshot="true"

  archived_compact="$(date -u +%Y%m%dT%H%M%SZ)"
  archived_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  header="{${fields},\"archived_at\":\"${archived_iso}\",\"reason\":\"${REASON}\",\"snapshot\":${snapshot}}"

  if ! mkdir -p -- "$service_dir" 2>/dev/null; then
    printf 'not_written service=%s id=%s error=directory_unavailable\n' "$service" "$id12"
    INCOMPLETE=1
    return
  fi
  name="$(compact_time "$created")_${archived_compact}_${id12}_${rev12}"
  candidate="$name"
  suffix=0
  while [[ -e "${service_dir}/${candidate}.log.gz" || -e "${service_dir}/${candidate}.truncated.log.gz" \
    || -e "${service_dir}/${candidate}.partial" ]]; do
    suffix=$((suffix + 1))
    candidate="${name}-${suffix}"
  done
  partial="${service_dir}/${candidate}.partial"

  [[ -z "$TIMEOUT_AVAILABLE" ]] || read_limit="${LOGS_TIMEOUT}s"
  {
    printf '# hub-container-log %s\n' "$header"
    if [[ -n "$TIMEOUT_AVAILABLE" ]]; then
      timeout "$LOGS_TIMEOUT" docker logs --timestamps "$id" 2>&1
    else
      docker logs --timestamps "$id" 2>&1
    fi
  } | nice -n 10 gzip -6 >"$partial"
  statuses="${PIPESTATUS[*]}"
  logs_status="${statuses%% *}"
  gzip_status="${statuses##* }"

  if [[ ! -f "$partial" ]]; then
    printf 'not_written service=%s id=%s error=write_failed logs_exit=%s gzip_exit=%s\n' \
      "$service" "$id12" "$logs_status" "$gzip_status"
    INCOMPLETE=1
    return
  fi
  if [[ "$logs_status" == "0" && "$gzip_status" == "0" ]]; then
    target="${service_dir}/${candidate}.log.gz"
  else
    target="${service_dir}/${candidate}.truncated.log.gz"
    INCOMPLETE=1
  fi
  if ! mv -f -- "$partial" "$target" 2>/dev/null; then
    rm -f -- "$partial" 2>/dev/null
    printf 'not_written service=%s id=%s error=write_failed\n' "$service" "$id12"
    INCOMPLETE=1
    return
  fi
  RUN_FILES+="${target}|"
  bytes="$(file_size "$target")"
  if [[ "$target" == *.truncated.log.gz ]]; then
    printf 'truncated service=%s id=%s file=%s bytes=%s snapshot=%s read_limit=%s logs_exit=%s gzip_exit=%s\n' \
      "$service" "$id12" "${service}/${target##*/}" "$bytes" "$snapshot" "$read_limit" "$logs_status" "$gzip_status"
  else
    printf 'archived service=%s id=%s file=%s bytes=%s snapshot=%s read_limit=%s\n' \
      "$service" "$id12" "${service}/${target##*/}" "$bytes" "$snapshot" "$read_limit"
  fi
}

main() {
  local service id ids count disk_percent normalized

  DIR=""
  PROJECT_DIR=""
  REASON=""
  MAX_AGE_DAYS=30
  MAX_BYTES=536870912
  MAX_DISK_PERCENT=90
  LOGS_TIMEOUT=60
  SERVICES=()
  while (( $# > 0 )); do
    case "$1" in
      --dir | --project-dir | --reason | --max-age-days | --max-bytes | --max-disk-percent | --logs-timeout)
        (( $# >= 2 )) || usage
        case "$1" in
          --dir) DIR="$2" ;;
          --project-dir) PROJECT_DIR="$2" ;;
          --reason) REASON="$2" ;;
          --max-age-days) MAX_AGE_DAYS="$2" ;;
          --max-bytes) MAX_BYTES="$2" ;;
          --max-disk-percent) MAX_DISK_PERCENT="$2" ;;
          --logs-timeout) LOGS_TIMEOUT="$2" ;;
        esac
        shift 2
        ;;
      --) shift; break ;;
      -*) usage ;;
      *) SERVICES+=("$1"); shift ;;
    esac
  done
  while (( $# > 0 )); do
    SERVICES+=("$1")
    shift
  done

  [[ -n "$DIR" && -n "$PROJECT_DIR" && -n "$REASON" && ${#SERVICES[@]} -gt 0 ]] || usage
  # The reason goes into the JSON header unescaped.
  case "$REASON" in
    *[!A-Za-z0-9\ ._:-]*) bad "--reason may hold only letters, digits, spaces and . _ : -" ;;
  esac
  for count in "$MAX_AGE_DAYS" "$MAX_BYTES" "$MAX_DISK_PERCENT" "$LOGS_TIMEOUT"; do
    is_count "$count" || bad "limits are whole numbers"
  done
  (( LOGS_TIMEOUT > 0 )) || bad "--logs-timeout must be positive"
  for service in "${SERVICES[@]}"; do
    case "$service" in
      '' | .* | *[!A-Za-z0-9._-]*) bad "not a Compose service name: ${service}" ;;
    esac
  done
  # Compose labels the absolute project directory without a trailing slash.
  normalized="$(cd -- "$PROJECT_DIR" 2>/dev/null && pwd)" || bad "no project directory: ${PROJECT_DIR}"
  PROJECT_DIR="$normalized"

  RUN_FILES="|"
  PRUNED_FILES=0
  PRUNED_BYTES=0
  TOTAL_BYTES=0
  INCOMPLETE=0
  DIR_USABLE=0
  TIMEOUT_AVAILABLE=""
  command -v timeout >/dev/null 2>&1 && TIMEOUT_AVAILABLE=1

  if ! mkdir -p -- "$DIR" 2>/dev/null || [[ ! -d "$DIR" || ! -w "$DIR" ]]; then
    printf 'skipped error=directory_unavailable dir=%s\n' "$DIR"
    exit 4
  fi
  DIR_USABLE=1
  prune

  disk_percent="$(df -P "$DIR" 2>/dev/null | { read -r _ && read -r _ _ _ _ capacity _ && printf '%s' "${capacity%\%}"; })"
  if ! is_count "$disk_percent"; then
    printf 'skipped error=disk_unreadable dir=%s\n' "$DIR"
    finish 4
  fi
  if (( disk_percent >= MAX_DISK_PERCENT )); then
    printf 'skipped disk_percent=%s max_disk_percent=%s\n' "$disk_percent" "$MAX_DISK_PERCENT"
    finish 4
  fi

  for service in "${SERVICES[@]}"; do
    if ! ids="$(docker ps -a -q --no-trunc \
      --filter "label=com.docker.compose.project.working_dir=${PROJECT_DIR}" \
      --filter "label=com.docker.compose.service=${service}" \
      --filter "label=com.docker.compose.oneoff=False" 2>/dev/null)"; then
      printf 'service=%s found=0 error=docker_ps_failed\n' "$service"
      INCOMPLETE=1
      continue
    fi
    count=0
    for id in $ids; do
      count=$((count + 1))
    done
    printf 'service=%s found=%s\n' "$service" "$count"
    (( count > 0 )) || INCOMPLETE=1
    for id in $ids; do
      case "$id" in
        *[!0-9a-f]*)
          printf 'not_written service=%s error=unexpected_id\n' "$service"
          INCOMPLETE=1
          continue
          ;;
      esac
      archive_container "$service" "$id"
    done
  done

  if [[ "$INCOMPLETE" == "1" ]]; then
    finish 3
  fi
  finish 0
}

set -u
umask 077
export LC_ALL=C
unset CDPATH
# The deploy streams this file to `bash -s`: main reads nothing from stdin, so
# no command it runs can swallow the rest of the script.
main "$@" </dev/null
