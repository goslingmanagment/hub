#!/usr/bin/env bash
# Run one command in the background of a CI job and join it in a later step.
#
#   ci-background.sh start NAME COMMAND [ARG...]
#       Launch COMMAND in its own process group; its output goes to a log file.
#   ci-background.sh join NAME
#       Wait for it, print its whole log, and exit with its exit status. A
#       command that vanished without recording a status fails the step.
#   ci-background.sh stop NAME
#       Cleanup for an `if: always()` step: print the log if no join printed it
#       (a cancelled or timed-out job) and kill whatever of the process group
#       is still alive. Never fails.
#
# State lives in $RUNNER_TEMP/ci-background/NAME.*; the runner empties
# RUNNER_TEMP between jobs, and its orphan-process cleanup is the last resort.
set -euo pipefail

usage() { echo "usage: ci-background.sh start NAME COMMAND [ARG...] | join NAME | stop NAME" >&2; exit 2; }

[ "$#" -ge 2 ] || usage
action="$1"
name="$2"
shift 2
[[ "$name" =~ ^[a-z][a-z0-9-]*$ ]] || usage
dir="${RUNNER_TEMP:?RUNNER_TEMP is not set}/ci-background"
base="$dir/$name"

# A process group with any member left, and one process that has not exited.
alive() { kill -0 -- "-$1" 2>/dev/null; }
running() {
  local state
  if [ -d /proc/self ]; then state="$(sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null)" || return 1
  else state="$(ps -o stat= -p "$1" 2>/dev/null)" || return 1
  fi
  [[ -n "$state" && "$state" != Z* ]]
}

case "$action" in
  start)
    [ "$#" -ge 1 ] || usage
    mkdir -p "$dir"
    rm -f "$base".{pid,started,ended,log,status,status.tmp,printed}
    # Job control makes the background job lead a process group of its own,
    # so `stop` reaches every process it spawned. stdin/stdout/stderr must not
    # stay attached to this step, or the runner would wait on them.
    date +%s > "$base.started"
    set -m
    bash -c '"${@:2}"; status=$?; date +%s > "$1.ended"; printf "%s\n" "$status" > "$1.status.tmp" && mv "$1.status.tmp" "$1.status"' \
      ci-background "$base" "$@" </dev/null >"$base.log" 2>&1 &
    pid=$!
    set +m
    printf '%s\n' "$pid" > "$base.pid"
    echo "Started $name in the background (process group $pid): $*"
    ;;

  join)
    [ "$#" -eq 0 ] || usage
    [ -f "$base.pid" ] || { echo "::error::$name was never started"; exit 1; }
    pid="$(cat "$base.pid")"
    joined="$(date +%s)"
    while [ ! -f "$base.status" ] && running "$pid"; do sleep 0.2; done
    touch "$base.printed"
    now="$(date +%s)"
    started="$(cat "$base.started")"
    ended="$(cat "$base.ended" 2>/dev/null || echo "$now")"
    echo "$name ran in the background for $(( ended - started ))s; this step waited $(( now - joined ))s for it. Its log:"
    cat "$base.log"
    # Anything the command left behind in its group dies with the join.
    if alive "$pid"; then kill -KILL -- "-$pid" 2>/dev/null || true; fi
    if [ ! -f "$base.status" ]; then
      echo "::error::$name ended without recording an exit status (killed?)"
      exit 1
    fi
    status="$(cat "$base.status")"
    [[ "$status" =~ ^[0-9]+$ ]] || { echo "::error::$name recorded an invalid exit status: $status"; exit 1; }
    exit "$status"
    ;;

  stop)
    [ "$#" -eq 0 ] || usage
    [ -f "$base.pid" ] || exit 0
    pid="$(cat "$base.pid" 2>/dev/null || true)"
    [[ "$pid" =~ ^[0-9]+$ ]] || { echo "::warning::$name left no usable process group id"; exit 0; }
    alive "$pid" || exit 0
    if [ ! -f "$base.printed" ]; then
      echo "$name was still running; its log so far:"
      cat "$base.log" || true
    fi
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do alive "$pid" || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    echo "Stopped $name (process group $pid)."
    ;;

  *) usage ;;
esac
