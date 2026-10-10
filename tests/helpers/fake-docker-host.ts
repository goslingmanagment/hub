import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

// A host for scripts/archive-container-logs.sh without Docker: a PATH that
// holds only the tools the helper may use (real ones, linked) and fakes of
// `docker`, `df`, and on request `gzip`, `timeout` and `date`. The fake docker
// answers `ps` by label filters, `inspect` with the line the helper's template
// renders, and `logs` with a canned log; it journals every call.

/** Real tools the helper (and the fakes) may run. Nothing else is on PATH, so
 *  `timeout` is absent unless a fake is asked for, on Linux as on macOS. */
const REAL_TOOLS = ["bash", "cat", "date", "find", "grep", "gzip", "ls", "mkdir", "mv", "nice", "rm", "wc"] as const;

/** macOS's /bin/bash is 3.2: the oldest bash the helper must run on. */
export const HELPER_BASH = existsSync("/bin/bash") ? "/bin/bash" : resolveTool("bash");

function resolveTool(tool: string): string {
  const result = spawnSync("/usr/bin/env", ["bash", "-c", `command -v ${tool}`], { encoding: "utf8" });
  const resolved = result.stdout.trim();
  if (result.status !== 0 || !resolved.startsWith("/")) throw new Error(`Missing host tool for the archive tests: ${tool}`);
  return resolved;
}

export interface FakeContainer {
  id: string;
  service: string;
  workingDir: string;
  oneoff?: boolean;
  created?: string;
  running?: boolean;
  /** The image's agency-hub.source-revision label; null when absent. */
  revision?: string | null;
  state?: string;
  exitCode?: number;
  log?: string;
  logsExit?: number;
}

export interface FakeHostOptions {
  containers: FakeContainer[];
  diskPercent?: number;
  gzipFails?: boolean;
  timeout?: "absent" | "pass" | "expire";
  /** Fixed `date -u` answers: { compact: 20261010T120000Z, iso: 2026-10-10T12:00:00Z }. */
  fixedDate?: { compact: string; iso: string };
  psFails?: boolean;
  /** A path whose existence `docker logs` records (present/absent) when it is called. */
  watch?: string;
}

export interface FakeHost {
  bin: string;
  dockerLog: string;
  timeoutLog: string;
  watchLog: string;
  env: NodeJS.ProcessEnv;
}

// Plain strings: the bash below is full of \${…}, which a template literal would interpolate.
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  'printf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"',
  'state="$FAKE_DOCKER_STATE"',
  'command="$1"',
  "shift",
  'case "$command" in',
  "  ps)",
  '    [[ ! -f "$state/ps_exit" ]] || exit "$(cat "$state/ps_exit")"',
  "    filters=()",
  "    while (( $# > 0 )); do",
  '      if [[ "$1" == --filter ]]; then filters+=("${2#label=}"); shift 2; else shift; fi',
  "    done",
  '    for dir in "$state"/containers/*; do',
  '      [[ -d "$dir" ]] || continue',
  "      keep=1",
  '      for filter in "${filters[@]}"; do grep -qxF -- "$filter" "$dir/labels" || keep=0; done',
  '      [[ "$keep" == 1 ]] && printf \'%s\\n\' "${dir##*/}"',
  "    done",
  "    exit 0",
  "    ;;",
  "  inspect)",
  '    id="${!#}"',
  '    [[ -f "$state/containers/$id/inspect" ]] || { printf \'Error: No such object: %s\\n\' "$id" >&2; exit 1; }',
  '    cat "$state/containers/$id/inspect"',
  "    ;;",
  "  logs)",
  '    id="${!#}"',
  '    if [[ -n "${FAKE_DOCKER_WATCH:-}" ]]; then',
  '      if [[ -e "$FAKE_DOCKER_WATCH" ]]; then echo present; else echo absent; fi >> "$FAKE_DOCKER_WATCH_LOG"',
  "    fi",
  '    cat "$state/containers/$id/logs"',
  '    exit "$(cat "$state/containers/$id/logs_exit")"',
  "    ;;",
  "  *)",
  '    printf \'fake docker: unexpected %s\\n\' "$command" >&2',
  "    exit 99",
  "    ;;",
  "esac",
  "",
].join("\n");

const FAKE_DF = String.raw`#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/fake 100 %s %s %s%% /\n' "$FAKE_DF_PERCENT" "$((100 - FAKE_DF_PERCENT))" "$FAKE_DF_PERCENT"
`;

function inspectLine(container: FakeContainer): string {
  const created = container.created ?? "2026-10-09T18:22:31.123456789Z";
  const running = container.running ?? true;
  const revision = container.revision === undefined ? "0123456789ab" : container.revision;
  const plain = `${created}|${running}|${revision ?? "<no value>"}`;
  const fields = [
    `"service":${JSON.stringify(container.service)}`,
    `"name":${JSON.stringify(`/agency-hub-${container.service}-1`)}`,
    `"id":${JSON.stringify(container.id)}`,
    `"revision":${revision === null ? "null" : JSON.stringify(revision)}`,
    `"created":${JSON.stringify(created)}`,
    `"started":${JSON.stringify("2026-10-09T18:22:32.000000000Z")}`,
    `"finished":${JSON.stringify(running ? "0001-01-01T00:00:00Z" : "2026-10-10T11:59:00.000000000Z")}`,
    `"state":${JSON.stringify(container.state ?? (running ? "running" : "exited"))}`,
    `"exit_code":${container.exitCode ?? 0}`,
    `"oom_killed":false`,
    `"restart_count":0`,
  ].join(",");
  return `${plain}\t${fields}\n`;
}

export function createFakeDockerHost(root: string, options: FakeHostOptions): FakeHost {
  const bin = path.join(root, "bin");
  const state = path.join(root, "docker-state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(state, "containers"), { recursive: true });

  for (const tool of REAL_TOOLS) {
    if (tool === "gzip" && options.gzipFails) continue;
    if (tool === "date" && options.fixedDate) continue;
    symlinkSync(tool === "bash" ? HELPER_BASH : resolveTool(tool), path.join(bin, tool));
  }
  writeFileSync(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(path.join(bin, "df"), FAKE_DF, { mode: 0o755 });
  if (options.gzipFails) {
    writeFileSync(path.join(bin, "gzip"), "#!/usr/bin/env bash\ncat >/dev/null\nprintf 'broken'\nexit 1\n", { mode: 0o755 });
  }
  if (options.fixedDate) {
    writeFileSync(path.join(bin, "date"), [
      "#!/usr/bin/env bash",
      'case "$*" in',
      `  "-u +%Y%m%dT%H%M%SZ") printf '%s\\n' ${JSON.stringify(options.fixedDate.compact)} ;;`,
      `  "-u +%Y-%m-%dT%H:%M:%SZ") printf '%s\\n' ${JSON.stringify(options.fixedDate.iso)} ;;`,
      `  *) exec ${JSON.stringify(resolveTool("date"))} "$@" ;;`,
      "esac",
      "",
    ].join("\n"), { mode: 0o755 });
  }
  const timeoutLog = path.join(root, "timeout.log");
  writeFileSync(timeoutLog, "");
  if (options.timeout === "pass" || options.timeout === "expire") {
    writeFileSync(path.join(bin, "timeout"), [
      "#!/usr/bin/env bash",
      'printf \'%s\\n\' "$*" >> "$FAKE_TIMEOUT_LOG"',
      "shift",
      options.timeout === "pass" ? 'exec "$@"' : '"$@"\nexit 124',
      "",
    ].join("\n"), { mode: 0o755 });
  }

  if (options.psFails) writeFileSync(path.join(state, "ps_exit"), "1\n");
  for (const container of options.containers) {
    const dir = path.join(state, "containers", container.id);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "labels"), [
      `com.docker.compose.project.working_dir=${container.workingDir}`,
      `com.docker.compose.service=${container.service}`,
      `com.docker.compose.oneoff=${container.oneoff ? "True" : "False"}`,
      "",
    ].join("\n"));
    writeFileSync(path.join(dir, "inspect"), inspectLine(container));
    writeFileSync(path.join(dir, "logs"), container.log ?? `2026-10-09T18:22:32.000000000Z ${container.service} started\n`);
    writeFileSync(path.join(dir, "logs_exit"), `${container.logsExit ?? 0}\n`);
  }

  const dockerLog = path.join(root, "docker.log");
  const watchLog = path.join(root, "watch.log");
  writeFileSync(dockerLog, "");
  writeFileSync(watchLog, "");
  return {
    bin, dockerLog, timeoutLog, watchLog,
    env: {
      PATH: bin,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DOCKER_STATE: state,
      FAKE_DF_PERCENT: String(options.diskPercent ?? 50),
      FAKE_TIMEOUT_LOG: timeoutLog,
      ...(options.watch ? { FAKE_DOCKER_WATCH: options.watch, FAKE_DOCKER_WATCH_LOG: watchLog } : {}),
    },
  };
}

/** A 64-hex container id whose first 12 characters repeat `seed`. */
export function containerId(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}
