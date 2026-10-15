import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const secretsOf = (page: string) => ["rpc_token", "api_token", "vnc_password"].map((name) => readFileSync(path.join(pbBase, "pages", page, "secrets", name), "utf8"));

describe("deploy-page-browser.sh add-profile", () => {
  it("makes the container with a new profile and its own secrets, then registers it in Hub with the secrets on its standard input", () => {
    const made = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV]);
    expect(made.status, made.stderr).toBe(0);
    const pageEnv = readFileSync(path.join(pbBase, "pages/ari-2/page.env"), "utf8");
    const profile = /^PB_PROFILE_ID=([0-9a-f-]{36})$/m.exec(pageEnv)?.[1];
    expect(profile).toBeDefined();
    expect(pageEnv).toContain("PB_SOCKS_IP=203.0.113.50\nPB_SOCKS_PORT=1080\n");
    // Chrome's zone and first language come from the environment.
    expect(pageEnv).toContain("PB_TZ=Europe/Berlin\nPB_LANG=de-DE\n");
    expect(volumes()).toEqual([`pb-buffer-${profile}`, `pb-profile-${profile}`]);
    expect(containers()).toEqual(["page-browser-ari-2"]);
    // Its own secrets, root's only, each a fresh random one.
    const secrets = secretsOf("ari-2");
    expect(new Set(secrets).size).toBe(3);
    for (const name of ["rpc_token", "api_token", "vnc_password"]) {
      expect(statSync(path.join(pbBase, "pages/ari-2/secrets", name)).mode & 0o777).toBe(0o600);
    }
    // Hub: one call, its secrets on stdin in the CLI's order, none in a
    // command line or the remote commands.
    const [call, ...more] = hubCalls();
    expect(more).toEqual([]);
    expect(call!.args.slice(call!.args.indexOf("node"))).toEqual([
      "node", "apps/runtime/dist/cli.js", "sync", "browser-profile", "add", "--profile", profile, "--container", "page-browser-ari-2",
      "--socks", "203.0.113.50:1080", "--env", ENV, "--secrets-stdin", "--new-page", "ari-2",
    ]);
    expect(call!.stdin).toBe(secrets.join(""));
    const remote = made.remote.join("\n");
    for (const secret of secrets) {
      const value = secret.trim();
      expect(remote).not.toContain(value);
      expect(call!.args.join(" ")).not.toContain(value);
      expect(made.stdout + made.stderr).not.toContain(value);
    }
    expect(made.stderr).toContain(`profile ${profile} of ari-2: container page-browser-ari-2 up, registered in Hub; connect the page in the dashboard`);
  });

  it("binds the profile to a page that exists (--existing): it moves to its browser", () => {
    const made = run("add-profile", ["--page", "lilly-1", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV, "--existing"]);
    expect(made.status, made.stderr).toBe(0);
    const [call] = hubCalls();
    expect(call!.args.slice(-2)).toEqual(["--page", "lilly-1"]);
    expect(made.stderr).toContain("registered in Hub and bound to lilly-1");
  });

  it("Hub refuses the profile (its own word: nothing written): the container, its files and both volumes go — nothing half-made stays", () => {
    const made = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV], {
      TEST_HUB_EXIT_0: "1",
      TEST_HUB_OUT_0: '{\n  "profileId": "x",\n  "outcome": "refused",\n  "reason": "Container page-browser-ari-2 has a profile already"\n}',
    });
    expect(made.status).toBe(1);
    expect(made.stderr).toMatch(/add-profile failed; nothing of profile [0-9a-f-]{36} is kept/);
    // No call to Hub but the refused add.
    expect(hubCalls()).toHaveLength(1);
    expect(volumes()).toEqual([]);
    expect(containers()).toEqual([]);
    expect(existsSync(path.join(pbBase, "pages/ari-2"))).toBe(false);
  });

  /** The server is untouched after an add whose outcome is unknown, and the
   *  owner is told how to resolve it: Hub's word, then remove-profile by the
   *  profile's UUID. */
  function expectUntouchedWithResolution(made: ReturnType<typeof run>, page: string): string {
    expect(made.status).toBe(1);
    const profile = /^PB_PROFILE_ID=(.+)$/m.exec(readFileSync(path.join(pbBase, `pages/${page}/page.env`), "utf8"))![1]!;
    expect(made.stderr).toContain(`whether Hub registered profile ${profile} is not known — nothing was removed`);
    expect(made.stderr).toContain(`sync browser-profile show --profile ${profile}`);
    expect(made.stderr).toContain(`scripts/deploy-page-browser.sh remove-profile root@agency-de --page ${page} --profile ${profile}`);
    expect(volumes()).toEqual([`pb-buffer-${profile}`, `pb-profile-${profile}`]);
    expect(containers()).toEqual([`page-browser-${page}`]);
    // No clean-up asked of Hub either.
    expect(hubCalls()).toHaveLength(1);
    return profile;
  }

  it("the add's answer lost with --existing (Hub may have bound the profile, or still will): nothing is removed, the way to resolve it said (Astra's review of PR 16, round 2)", () => {
    // Astra's order: the add's answer lost before its commit; a forget asked
    // now would find nothing yet (absent) — and the add commits after.
    const made = run("add-profile", ["--page", "lilly-1", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV, "--existing"], {
      TEST_HUB_EXIT_0: "255",
      TEST_HUB_OUT_1: '{"profileId": "x", "container": null, "outcome": "absent"}',
    });
    expectUntouchedWithResolution(made, "lilly-1");
    expect(made.stderr).toContain("bound to lilly-1");
  });

  it("a new page's add whose answer was lost, or that failed without Hub's refusal: nothing is removed; once Hub says it has none, the printed remove-profile removes it all", () => {
    const lost = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV], { TEST_HUB_EXIT_0: "255" });
    const profile = expectUntouchedWithResolution(lost, "ari-2");
    // The owner asked Hub (absent), then runs the printed command: Hub forgets
    // the profile for good, then the server removes it.
    const removed = run("remove-profile", ["--page", "ari-2", "--profile", profile], { TEST_HUB_OUT_1: '{"profileId": "x", "outcome": "absent"}' });
    expect(removed.status, removed.stderr).toBe(0);
    expect(hubCalls()[1]!.args.slice(-4)).toEqual(["remove", "--profile", profile, "--absent-ok"]);
    expect(volumes()).toEqual([]);
    expect(containers()).toEqual([]);
    // A failure that is not Hub's refusal (no word of it): unknown too.
    rmSync(state, { recursive: true, force: true });
    mkdirSync(state);
    const failed = run("add-profile", ["--page", "eva-1", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV], {
      TEST_HUB_EXIT_0: "1",
      TEST_HUB_OUT_0: "Error: connect ECONNREFUSED 10.0.0.5:5432",
    });
    expectUntouchedWithResolution(failed, "eva-1");
  });

  it("a container that does not come up healthy: its volumes and files go, Hub is never told", () => {
    const made = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV], { TEST_UNHEALTHY: "1" });
    expect(made.status).toBe(1);
    expect(made.stderr).toMatch(/the new profile [0-9a-f-]{36} of ari-2 was not kept/);
    expect(volumes()).toEqual([]);
    expect(existsSync(path.join(pbBase, "pages/ari-2"))).toBe(false);
    expect(hubCalls()).toEqual([]);
  });

  it("a failed start that page.sh left as it is — a container that would not stop, a Docker that cannot be read — keeps the new profile's files and volumes, and says what to do (Astra's review of PR 16, round 4)", () => {
    for (const [env, word] of [[{ TEST_STOP_FAILS: "1" }, "is running"], [{ TEST_UNREADABLE_AFTER_STOP: "1" }, "is unreadable"]] as const) {
      rmSync(state, { recursive: true, force: true });
      mkdirSync(state);
      rmSync(path.join(pbBase, "pages/ari-2"), { recursive: true, force: true });
      const made = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV], { TEST_UNHEALTHY: "1", ...env });
      expect(made.status).toBe(1);
      expect(made.stderr).toContain("left as it is");
      const profile = /the new profile ([0-9a-f-]{36}) of ari-2 is kept as it is/.exec(made.stderr)?.[1];
      expect(profile, made.stderr).toBeDefined();
      expect(made.stderr).toContain(`page-browser-ari-2 ${word}`);
      // Its files — the secrets of a container that may run — and its volumes stay.
      expect(existsSync(path.join(pbBase, "pages/ari-2/secrets/rpc_token"))).toBe(true);
      expect(volumes()).toEqual([`pb-buffer-${profile}`, `pb-profile-${profile}`]);
      expect(hubCalls()).toEqual([]);
    }
  });

  it("refuses a page that has a container, and needs the environment", () => {
    expect(run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV]).status).toBe(0);
    const again = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("ari-2 has a container here already");
    expect(hubCalls()).toHaveLength(1);
    const noEnv = run("add-profile", ["--page", "eva-1", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080"]);
    expect(noEnv.status).toBe(1);
    expect(noEnv.stderr).toContain("add-profile needs --env <json> with --socks");
  });
});

describe("deploy-page-browser.sh add-profile from the owner's draft (owner decision 2026-10-15)", () => {
  const DRAFT_ENV = { timeZone: "America/New_York", languages: ["en-US", "en"], geolocation: { latitude: 40.7128, longitude: -74.006, accuracyM: 1000 } };
  const DRAFT_ID = "6f0a3c1e-2b4d-4e8f-9a1b-3c5d7e9f1a2b";
  const draft = (overrides: Record<string, unknown> = {}) => JSON.stringify({ name: "ari-2", existingPage: false, page: null, socks: "198.51.100.20:7000", env: DRAFT_ENV, draftId: DRAFT_ID, revision: 3, ...overrides }, null, 2);

  it("takes the SOCKS5's address and the environment from Hub's draft: nothing of the proxy typed, its login and password never on the server", () => {
    const made = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc"], { TEST_HUB_OUT_0: draft() });
    expect(made.status, made.stderr).toBe(0);
    const pageEnv = readFileSync(path.join(pbBase, "pages/ari-2/page.env"), "utf8");
    const profile = /^PB_PROFILE_ID=([0-9a-f-]{36})$/m.exec(pageEnv)?.[1];
    // The fake getent answers every name with one address; an IP goes as it is.
    expect(pageEnv).toContain("PB_SOCKS_PORT=7000\n");
    expect(pageEnv).toContain("PB_TZ=America/New_York\nPB_LANG=en-US\n");
    const [asked, added, ...more] = hubCalls();
    expect(more).toEqual([]);
    expect(asked!.args.slice(asked!.args.indexOf("node"))).toEqual(["node", "apps/runtime/dist/cli.js", "sync", "browser-profile", "draft", "--name", "ari-2"]);
    expect(asked!.stdin).toBe("");
    const socks = /^PB_SOCKS_IP=(.+)$/m.exec(pageEnv)![1];
    expect(added!.args.slice(added!.args.indexOf("node"))).toEqual([
      "node", "apps/runtime/dist/cli.js", "sync", "browser-profile", "add", "--profile", profile, "--container", "page-browser-ari-2",
      "--socks", `${socks}:7000`, "--from-draft", "ari-2", "--draft-id", DRAFT_ID, "--draft-revision", "3", "--secrets-stdin", "--new-page", "ari-2",
    ]);
    expect(added!.stdin).toBe(secretsOf("ari-2").join(""));
    expect(made.stderr).toContain("the draft of ari-2 (revision 3): SOCKS5 198.51.100.20:7000");
    expect(made.stderr).toContain("connect the page in the dashboard");
  });

  it("--env overrides the draft's environment (and goes to Hub as the override)", () => {
    const made = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--env", ENV], { TEST_HUB_OUT_0: draft() });
    expect(made.status, made.stderr).toBe(0);
    expect(readFileSync(path.join(pbBase, "pages/ari-2/page.env"), "utf8")).toContain("PB_TZ=Europe/Berlin\nPB_LANG=de-DE\n");
    const added = hubCalls()[1]!;
    expect(added.args.slice(added.args.indexOf("--from-draft"), added.args.indexOf("--secrets-stdin"))).toEqual(["--from-draft", "ari-2", "--draft-id", DRAFT_ID, "--draft-revision", "3", "--env", ENV]);
  });

  it("an existing page's draft binds the profile with --existing, and refuses without it — before anything is made", () => {
    const refused = run("add-profile", ["--page", "lilly-1", "--image", "hub-page-browser:155.0.1-abc"], { TEST_HUB_OUT_0: draft({ name: "lilly-1", existingPage: true, page: "lilly-1" }) });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("the draft of lilly-1 moves the existing page to its browser: add --existing");
    expect(containers()).toEqual([]);
    expect(volumes()).toEqual([]);
    expect(hubCalls()).toHaveLength(1);
    rmSync(state, { recursive: true, force: true });
    mkdirSync(state);
    const made = run("add-profile", ["--page", "lilly-1", "--image", "hub-page-browser:155.0.1-abc", "--existing"], { TEST_HUB_OUT_0: draft({ name: "lilly-1", existingPage: true, page: "lilly-1" }) });
    expect(made.status, made.stderr).toBe(0);
    const added = hubCalls()[1]!;
    expect(added.args.slice(-2)).toEqual(["--page", "lilly-1"]);
    expect(added.args).toContain("--from-draft");
    expect(made.stderr).toContain("registered in Hub and bound to lilly-1");
    // A new page's draft refuses --existing.
    rmSync(state, { recursive: true, force: true });
    mkdirSync(state);
    const wrong = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--existing"], { TEST_HUB_OUT_0: draft() });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("the draft of ari-2 is a new page's: no --existing");
  });

  it("a draft answer without its own id does not read: nothing is made", () => {
    const made = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc"], { TEST_HUB_OUT_0: draft({ draftId: null }) });
    expect(made.status).toBe(1);
    expect(made.stderr).toContain("Hub's draft of ari-2 has no id");
    expect(containers()).toEqual([]);
    expect(volumes()).toEqual([]);
  });

  it("no draft in Hub: says where the owner starts it, and makes nothing", () => {
    const made = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc"], { TEST_HUB_EXIT_0: "1" });
    expect(made.status).toBe(1);
    expect(made.stderr).toContain("Hub gave no draft of ari-2: start its browser in the dashboard");
    expect(containers()).toEqual([]);
    expect(volumes()).toEqual([]);
    expect(existsSync(path.join(pbBase, "pages/ari-2"))).toBe(false);
  });

  it("Hub refuses the add (the owner changed the draft meanwhile): its own word, so the container and its volumes go", () => {
    const made = run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc"], {
      TEST_HUB_OUT_0: draft(),
      TEST_HUB_EXIT_1: "1",
      TEST_HUB_OUT_1: '{\n  "profileId": "x",\n  "outcome": "refused",\n  "reason": "the owner changed the draft of ari-2 meanwhile (revision 4, not 3): run add-profile again"\n}',
    });
    expect(made.status).toBe(1);
    expect(made.stderr).toMatch(/add-profile failed; nothing of profile [0-9a-f-]{36} is kept/);
    expect(volumes()).toEqual([]);
    expect(containers()).toEqual([]);
    expect(hubCalls()).toHaveLength(2);
  });
});

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

  it("remove-profile --profile refuses a page that names another profile, before Hub is asked", () => {
    expect(run("add-profile", ["--page", "ari-2", "--image", "hub-page-browser:155.0.1-abc", "--socks", "socks.example:1080", "--env", ENV]).status).toBe(0);
    const refused = run("remove-profile", ["--page", "ari-2", "--profile", "00000000-0000-4000-8000-000000000000"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not 00000000-0000-4000-8000-000000000000: nothing removed");
    expect(hubCalls()).toHaveLength(1);
    expect(volumes()).toHaveLength(2);
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
