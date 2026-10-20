import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `scripts/deploy-page-browser.sh add-profile` and `remove-profile` (Project
// Browser PR 16; plan §3.2 «Подключение новой страницы через браузер», step
// 1): a new profile's container, its row in Hub with its secrets on the
// CLI's standard input, and nothing half-made left when either side fails.
// Both scripts run for real — the workstation's and the server's page.sh —
// against an `ssh` that runs the remote command here (the server's paths
// moved into a temporary directory) and a `docker` that keeps the
// containers, volumes and Hub calls it was asked for in files.

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const script = path.join(repoRoot, "scripts/deploy-page-browser.sh");
const pageSh = path.join(repoRoot, "apps/page-browser/host/page.sh");

const ENV = '{"timeZone":"Europe/Berlin","languages":["de-DE","de","en-US","en"],"geolocation":{"latitude":52.52,"longitude":13.4,"accuracyM":5000}}';

const fakeSsh = `#!/usr/bin/env bash
remote="\${@: -1}"
eval "set -- $remote"
command="$3"
printf '%s\\n--\\n' "$command" >> "$TEST_SSH_LOG"
command="\${command//\\/opt\\/agency-hub\\/page-browser\\/page.sh/$TEST_PAGE_SH}"
command="\${command//\\/opt\\/agency-hub\\/page-browser/$TEST_PB_BASE}"
command="\${command//\\/opt\\/agency-hub/$TEST_HUB_DIR}"
PB_BASE="$TEST_PB_BASE" exec bash -c "$command"
`;

// docker: containers, volumes and Hub calls as files under $TEST_STATE; an
// image's Chrome by its label, a new profile's last Chrome none (page.sh's
// start guard, PR 18). The
// n-th Hub call (from 0) runs $TEST_HUB_HOOK_<n> (what happens on the server
// meanwhile), prints $TEST_HUB_OUT_<n> and exits with $TEST_HUB_EXIT_<n>
// (else $TEST_HUB_EXIT, else 0) — 255 is ssh's word for an answer that never
// came back.
const fakeDocker = `#!/usr/bin/env bash
state="$TEST_STATE"
mkdir -p "$state/volumes" "$state/containers" "$state/stopped"
echo "$*" >> "$state/docker.log"
if [[ "$1" == "compose" && " $* " == *" exec -T api "* ]]; then
  n=$(ls "$state" | grep -c '^hub-call-[0-9]*[.]args$' || true)
  printf '%s\\n' "$@" > "$state/hub-call-$n.args"
  cat > "$state/hub-call-$n.stdin"
  out="TEST_HUB_OUT_$n"; code="TEST_HUB_EXIT_$n"; hook="TEST_HUB_HOOK_$n"
  [[ -z "\${!hook:-}" ]] || eval "\${!hook}"
  [[ -z "\${!out:-}" ]] || printf '%s\\n' "\${!out}"
  exit "\${!code:-\${TEST_HUB_EXIT:-0}}"
fi
case "$1" in
  image)
    if [[ "$2" == "inspect" && " $* " == *" --format "* ]]; then echo "155.0.7000.1"; fi
    exit 0 ;;
  run) exit 0 ;;
  stop)
    # A container that would not stop; a Docker that cannot be read from here on.
    [[ "\${TEST_STOP_FAILS:-0}" == "1" ]] || touch "$state/stopped/\${@: -1}"
    [[ "\${TEST_UNREADABLE_AFTER_STOP:-0}" != "1" ]] || touch "$state/unreadable"
    exit 0 ;;
  rm) rm -f "$state/containers/\${@: -1}" "$state/stopped/\${@: -1}"; exit 0 ;;
  volume)
    case "$2" in
      create) touch "$state/volumes/$3"; echo "$3" ;;
      inspect) shift 2; for v in "$@"; do [[ -e "$state/volumes/$v" ]] || exit 1; done ;;
      rm) shift 2; for v in "$@"; do rm -f "$state/volumes/$v"; done ;;
    esac
    exit 0 ;;
  ps) exit 0 ;;
  logs) exit 0 ;;
  inspect)
    if [[ "\${TEST_DOCKER_UNREADABLE:-0}" == "1" || -e "$state/unreadable" ]]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
    if [[ "$2" == "-f" ]]; then
      [[ -e "$state/containers/$4" ]] || { echo "Error: No such object: $4" >&2; exit 1; }
      if [[ "$3" == *".State.Running"* ]]; then [[ -e "$state/stopped/$4" ]] && echo false || echo true; exit 0; fi
      if [[ "\${TEST_UNHEALTHY:-0}" == "1" ]]; then echo unhealthy; else echo healthy; fi
      exit 0
    fi
    [[ -e "$state/containers/$2" ]]; exit $? ;;
  compose)
    project="$3"
    if [[ " $* " == *" up "* ]]; then touch "$state/containers/$project"; rm -f "$state/stopped/$project"; fi
    if [[ " $* " == *" down"* ]]; then rm -f "$state/containers/$project" "$state/stopped/$project"; fi
    exit 0 ;;
esac
exit 0
`;

let root: string;
let pbBase: string;
let state: string;
let sshLog: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "hub-pb-add-profile-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "ssh"), fakeSsh, { mode: 0o755 });
  writeFileSync(path.join(bin, "docker"), fakeDocker, { mode: 0o755 });
  // The server's tools page.sh needs that this machine may not have.
  writeFileSync(path.join(bin, "flock"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(bin, "getent"), "#!/usr/bin/env bash\necho \"203.0.113.50 STREAM $2\"\n", { mode: 0o755 });
  pbBase = path.join(root, "pb");
  mkdirSync(path.join(pbBase, "pages"), { recursive: true });
  writeFileSync(path.join(pbBase, "egress-rules.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(path.join(pbBase, "docker-compose.page-browser.yml"), "");
  mkdirSync(path.join(root, "hub"));
  state = path.join(root, "state");
  mkdirSync(state);
  sshLog = path.join(root, "ssh.log");
  writeFileSync(sshLog, "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(command: "add-profile" | "remove-profile", args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bash", [script, command, "root@agency-de", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
      TEST_SSH_LOG: sshLog,
      TEST_PAGE_SH: pageSh,
      TEST_PB_BASE: pbBase,
      TEST_HUB_DIR: path.join(root, "hub"),
      TEST_STATE: state,
      ...env,
    },
  });
  const remote = readFileSync(sshLog, "utf8").split("\n--\n").filter((line) => line.trim().length > 0);
  return { ...result, remote };
}

const volumes = () => (existsSync(path.join(state, "volumes")) ? readdirSync(path.join(state, "volumes")).sort() : []);
const containers = () => (existsSync(path.join(state, "containers")) ? readdirSync(path.join(state, "containers")).sort() : []);
const hubCalls = () => readdirSync(state).filter((name) => name.endsWith(".args")).sort().map((name) => ({
  args: readFileSync(path.join(state, name), "utf8").trim().split("\n"),
  stdin: readFileSync(path.join(state, name.replace(/\.args$/, ".stdin")), "utf8"),
}));

describe("deploy-page-browser.sh remove-profile", () => {
  it("Hub forgets the profile first, then its container, files and volumes go", () => {
    expect(run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV]).status).toBe(0);
    const profile = /^PB_PROFILE_ID=(.+)$/m.exec(readFileSync(path.join(pbBase, "pages/ari-2/page.env"), "utf8"))![1]!;
    const removed = run("remove-profile", ["--page", "ari-2"]);
    expect(removed.status, removed.stderr).toBe(0);
    const calls = hubCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args.slice(calls[1]!.args.indexOf("node"))).toEqual(["node", "apps/runtime/dist/cli.js", "sync", "browser-profile", "remove", "--profile", profile, "--absent-ok"]);
    // The server is told which profile Hub forgot.
    expect(removed.remote.at(-1)).toContain(`page.sh remove-profile --page ari-2 --profile ${profile}`);
    expect(volumes()).toEqual([]);
    expect(containers()).toEqual([]);
    expect(existsSync(path.join(pbBase, "pages/ari-2"))).toBe(false);
  });

  it("Hub refuses (a profile bound to a page): nothing on the server is removed", () => {
    expect(run("add-profile", ["--page", "lilly-1", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV, "--existing"]).status).toBe(0);
    const refused = run("remove-profile", ["--page", "lilly-1"], { TEST_HUB_EXIT: "1" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Hub did not forget profile");
    expect(volumes()).toHaveLength(2);
    expect(containers()).toEqual(["page-browser-lilly-1"]);
    expect(existsSync(path.join(pbBase, "pages/lilly-1/page.env"))).toBe(true);
  });

  it("removes on the server only the profile Hub forgot: another up --new-profile in between keeps the page's new profile whole (Astra's review of PR 16, item 7)", () => {
    expect(run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV]).status).toBe(0);
    const envFile = path.join(pbBase, "pages/ari-2/page.env");
    const forgotten = /^PB_PROFILE_ID=(.+)$/m.exec(readFileSync(envFile, "utf8"))![1]!;
    // While Hub forgets the first profile, another operation gives the page a new one.
    const removed = run("remove-profile", ["--page", "ari-2"], {
      TEST_HUB_HOOK_1: 'PB_BASE="$TEST_PB_BASE" bash "$TEST_PAGE_SH" up --page ari-2 --image hub-page-browser:155.0.1-abc --new-profile >/dev/null',
    });
    const now = /^PB_PROFILE_ID=(.+)$/m.exec(readFileSync(envFile, "utf8"))![1]!;
    expect(now).not.toBe(forgotten);
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain(`ari-2's files name profile ${now}, not ${forgotten}: nothing removed`);
    // The new profile, its container and its files are whole.
    expect(volumes()).toEqual(expect.arrayContaining([`pb-buffer-${now}`, `pb-profile-${now}`]));
    expect(containers()).toEqual(["page-browser-ari-2"]);
    expect(existsSync(envFile)).toBe(true);
  });

  it("page.sh removes nothing when Docker cannot say the container is gone (PR 18's rule, as forget)", () => {
    expect(run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV]).status).toBe(0);
    const profile = /^PB_PROFILE_ID=(.+)$/m.exec(readFileSync(path.join(pbBase, "pages/ari-2/page.env"), "utf8"))![1]!;
    const refused = spawnSync("bash", [pageSh, "remove-profile", "--page", "ari-2", "--profile", profile], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, PB_BASE: pbBase, TEST_STATE: state, TEST_DOCKER_UNREADABLE: "1" },
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("cannot be read: nothing of ari-2 is removed");
    expect(volumes()).toHaveLength(2);
    expect(existsSync(path.join(pbBase, "pages/ari-2/page.env"))).toBe(true);
  });

  it("page.sh removes a profile only when told which one, and only that one", () => {
    expect(run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV]).status).toBe(0);
    const page = (args: string[]) => spawnSync("bash", [pageSh, "remove-profile", "--page", "ari-2", ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, PB_BASE: pbBase, TEST_STATE: state },
    });
    expect(page([]).stderr).toContain("remove-profile needs --profile <uuid>");
    expect(page(["--profile", "00000000-0000-4000-8000-000000000000"]).stderr).toContain("not 00000000-0000-4000-8000-000000000000: nothing removed");
    expect(volumes()).toHaveLength(2);
    expect(containers()).toEqual(["page-browser-ari-2"]);
  });
});
