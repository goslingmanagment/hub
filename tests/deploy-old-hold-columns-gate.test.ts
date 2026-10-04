import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The deploy gate of the last of the three releases that took the old hold
// columns of `sync_pages` away (step 4, S4-33).
//
// The drop is applied while the running image's `sync` still works, and it is
// rollback compatible, so a failed deploy returns to that image. Both are
// safe under the release before the drop (S4-32) alone. An older image names
// the columns of the old hold slot in a statement — the one just before it
// rewrites them at the end of every hold write, so on the migrated table it
// takes no hold and lifts none while its pages keep sending — and
// ROLLBACK_COMPATIBLE_MIGRATIONS cannot tell the two apart (S4-32 has no
// migration of its own). So, while the drop is still to be applied, the deploy
// searches the built code of every running app container's image for the
// slot's columns and stops before any migration if one names them.
//
// The gate function of deploy-production.sh runs here for real. Its remote
// command runs as it would on the host, in a local bash, against a `docker`
// that answers from the fixture and searches the fixture images with the real
// grep. This file names old hold columns for that reason alone: they are what
// the images it searches are made of (tests/sync-old-hold-columns.test.ts).

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const deployPath = path.join(repoRoot, "scripts/deploy-production.sh");
const deploy = readFileSync(deployPath, "utf8");
const GATE = "verify_running_images_run_without_old_hold_columns";
// Found by its name, not its number: the number is the next free one at merge.
const DROP = readdirSync(path.join(repoRoot, "packages/db/migrations")).find((file) => file.endsWith("_sync_pages_drop_old_hold_columns.sql")) ?? "";
const SERVICES = ["api", "worker", "scheduler", "sync"] as const;
type Service = (typeof SERVICES)[number];

/** What the release two before the drop (S4-31) ended every hold write with:
 *  the page's old hold columns rewritten from its rows. */
const REWRITE_OF_THE_IMAGE_TWO_BEFORE = `
  await tx.execute(sql\`
    update sync_pages
       set hold_kind = \${columns.holdKind}::text,
           hold_until = \${untilParam(columns.holdUntil)},
           hold_since = \${timestampParam(columns.holdSince)},
           hold_detail = \${jsonParam(columns.holdDetail)},
           resource_holds = \${jsonParam(columns.resourceHolds)},
           updated_at = clock_timestamp()
     where page_id = \${pageId}
  \`);`;

/** What the release before the drop (S4-32) names of the old hold store: the
 *  marker its acquisition leaves in the resource-hold map, as its built code
 *  has it (the bundles of e8fb51b6, the head of that release). Nothing of the
 *  slot. */
const MARKER_OF_THE_IMAGE_BEFORE = `
  var STALE_HOLD_COLUMNS_MARKER = sql\`
    resource_holds = case when jsonb_typeof(resource_holds) = 'object' then resource_holds else '{}'::jsonb end
                     || '{"route:state": {"version": 2, "routes": {}}}'::jsonb\`;`;

/** In every image: another table's column of the name the slot's end had. */
const NAMESAKE = 'holdUntil: timestamp("hold_until", { withTimezone: true }).notNull(),';

const stubs = String.raw`
set -euo pipefail
log() { printf '%s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
run_remote() {
  printf '%s\n' "$1" >> "$TEST_COMMAND_LOG"
  PATH="$TEST_BIN:$PATH" bash -c "$1"
}
`;

// `docker` on the host: Compose lists the release's services and the running
// container of each; a container has an image, an image a revision label; and
// `docker run --rm <image> <command>` runs the command in the image's files.
const fakeDocker = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TEST_DOCKER_LOG"
image_of() { printenv "TEST_IMAGE_OF_$1" || true; }
name_of() { printf '%s' "$1" | sed -e 's/^sha256://' -e 's/^container-//'; }
refuse() { [[ "$TEST_FAILING_CALL" != "$1" ]] || { printf 'docker: %s failed\n' "$1" >&2; exit "$2"; }; }
case "$1" in
  compose)
    case "$3" in
      config) refuse config 14; printf '%s\n' $TEST_COMPOSE_SERVICES ;;
      ps) refuse "ps $5" 15; [[ -z "$(image_of "$5")" ]] || printf 'container-%s\n' "$5" ;;
    esac ;;
  inspect) refuse inspect 1; printf 'sha256:%s\n' "$(image_of "$(name_of "$4")")" ;;
  image) cat "$TEST_IMAGES/$(name_of "$5")/revision" ;;
  run) refuse run 125; image="$(name_of "$3")"; shift 3; cd "$TEST_IMAGES/$image" && exec "$@" ;;
esac
`;

function gateFunction() {
  const match = deploy.match(new RegExp(`^${GATE}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, "m"));
  if (!match) throw new Error(`Missing deploy function: ${GATE}`);
  return match[0];
}

/** The slot's columns the gate searches for, as the script has them. */
function witness(): string[] {
  const line = gateFunction().match(/^ {2}local slot_columns='([a-z_|]+)'$/m);
  if (!line) throw new Error("Missing the gate's witness");
  return line[1]!.split("|");
}

describe("deploy gate: the old hold columns of sync_pages are dropped only under an image that runs without them", () => {
  let fixtureRoot: string;
  let commandLog: string;
  let dockerLog: string;
  let images: string;

  /** An image: its built code and its source revision label. */
  function image(name: string, revision: string, files: Record<string, string>) {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(images, name, file)), { recursive: true });
      writeFileSync(path.join(images, name, file), text);
    }
    mkdirSync(path.join(images, name), { recursive: true });
    writeFileSync(path.join(images, name, "revision"), `${revision}\n`);
  }

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "hub old hold columns gate "));
    commandLog = path.join(fixtureRoot, "commands.log");
    dockerLog = path.join(fixtureRoot, "docker.log");
    images = path.join(fixtureRoot, "images");
    writeFileSync(commandLog, "");
    writeFileSync(dockerLog, "");
    mkdirSync(path.join(fixtureRoot, "bin"));
    mkdirSync(path.join(fixtureRoot, "app"));
    writeFileSync(path.join(fixtureRoot, "bin/docker"), fakeDocker, { mode: 0o755 });

    // The release before the drop: the marker and the namesake, nothing of the slot.
    image("before", "4eb9301abc65", {
      "apps/runtime/dist/startup.js": `${MARKER_OF_THE_IMAGE_BEFORE}\n${NAMESAKE}\n`,
      "apps/runtime/dist/api.js": `${MARKER_OF_THE_IMAGE_BEFORE}\n${NAMESAKE}\n`,
      "packages/db/dist/index.js": `${MARKER_OF_THE_IMAGE_BEFORE}\n${NAMESAKE}\n`,
      // The migrations ship in every image and name the columns: not built code.
      "packages/db/migrations/0228_sync_engine_core.sql": "  hold_kind text,\n  hold_detail jsonb not null default '{}'::jsonb,\n",
    });
    // The release before that: the rewrite of the columns in every bundle.
    image("older", "25a07294dd10", {
      "apps/runtime/dist/startup.js": `${REWRITE_OF_THE_IMAGE_TWO_BEFORE}\n${NAMESAKE}\n`,
      "packages/db/dist/index.js": `${REWRITE_OF_THE_IMAGE_TWO_BEFORE}\n${NAMESAKE}\n`,
    });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function runGate(options: {
    /** `schema_migrations` before the deploy. */
    applied?: string[];
    /** The image of each service's running container; none = not running. */
    running?: Partial<Record<Service, string>>;
    /** The services the release files on the host define. */
    defined?: string;
    /** A docker call that fails: `config`, `ps <service>`, `inspect`, `run`. */
    failing?: string;
  }) {
    const baseline = path.join(fixtureRoot, "schema-before.txt");
    writeFileSync(baseline, [...(options.applied ?? ["0239_retire_fansly_legacy_sync_states.sql", "0240_sync_holds.sql"]), ""].join("\n"));
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEPLOY_") && !key.startsWith("TEST_IMAGE_OF_")));
    const result = spawnSync("bash", ["-c", [stubs, gateFunction(), GATE, 'log "gate passed"'].join("\n")], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...inherited,
        SCHEMA_BEFORE_FILE: baseline,
        REMOTE_APP_DIR_ESCAPED: `'${path.join(fixtureRoot, "app")}'`,
        REMOTE_COMPOSE: "docker compose --current",
        TEST_COMMAND_LOG: commandLog,
        TEST_DOCKER_LOG: dockerLog,
        TEST_BIN: path.join(fixtureRoot, "bin"),
        TEST_IMAGES: images,
        TEST_COMPOSE_SERVICES: options.defined ?? "postgres api scheduler worker sync",
        TEST_FAILING_CALL: options.failing ?? "",
        ...Object.fromEntries(Object.entries(options.running ?? {}).map(([service, name]) => [`TEST_IMAGE_OF_${service}`, name])),
      },
    });
    const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    return { ...result, remote: lines(commandLog), docker: lines(dockerLog) };
  }

  const everyService = (name: string) => Object.fromEntries(SERVICES.map((service) => [service, name])) as Record<Service, string>;
  const search = (name: string) => `run --rm sha256:${name} grep -rqE ${witness().join("|")} apps/runtime/dist packages/db/dist`;

  it("searches for the three columns of the slot that have no namesake", () => {
    expect(witness()).toEqual(["hold_kind", "hold_since", "hold_detail"]);
  });

  it.each([
    ["applied", [DROP]],
    ["applied under another number", ["0244_sync_pages_drop_old_hold_columns.sql"]],
  ])("asks nothing once the drop is %s: any image may be running", (_label, applied) => {
    const result = runGate({ applied: ["0240_sync_holds.sql", ...applied], running: everyService("older") });
    expect(result.status, result.stderr).toBe(0);
    expect(result.remote).toEqual([]);
    expect(result.docker).toEqual([]);
    expect(result.stderr).toBe("gate passed\n");
  });

  it("passes under the release before the drop: its marker names the resource-hold map, nothing names the slot", () => {
    // What that image carries, and what the search must not take for the slot.
    const bundle = readFileSync(path.join(images, "before/apps/runtime/dist/startup.js"), "utf8");
    expect(bundle).toContain("resource_holds = case when jsonb_typeof(resource_holds) = 'object'");
    expect(bundle).toContain('"route:state": {"version": 2, "routes": {}}');
    expect(bundle).toContain('timestamp("hold_until"');

    const result = runGate({ running: everyService("before") });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("No running image names the old hold slot of sync_pages (4 running app container(s)); its drop may run under them");
    expect(result.stderr).toMatch(/gate passed\n$/);
    // One remote command; the four containers share one image, searched once,
    // in its built code alone (the migrations it ships name the columns).
    expect(result.remote.filter((line) => line.startsWith("set -euo pipefail; cd "))).toHaveLength(1);
    expect(result.docker.filter((call) => call.startsWith("run "))).toEqual([search("before")]);
    expect(result.docker.filter((call) => call.startsWith("compose --current ps "))).toEqual(SERVICES.map((service) => `compose --current ps -q ${service}`));
  });

  it("refuses under the release before that, which rewrites the slot at every hold write: nothing was migrated", () => {
    const result = runGate({ running: everyService("older") });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The drop of the old hold columns of sync_pages is still to be applied, and these running");
    for (const service of SERVICES) expect(result.stderr).toContain(`[deploy]   ${service} (source revision 25a07294dd10)\n`);
    expect(result.stderr).toContain("the dropped columns at every hold write: there it takes no hold and lifts none while its");
    expect(result.stderr).toContain("pages keep sending, and the automatic rollback would return to it. Deploy the release");
    expect(result.stderr).toContain("before the drop first (S4-32, from a checkout of its commit), let it run its hour, then");
    expect(result.stderr).toMatch(/error: A running image is older than the release the drop of the old hold columns of sync_pages needs\n$/);
    expect(result.stderr).not.toContain("gate passed");
    expect(result.docker.filter((call) => call.startsWith("run "))).toEqual([search("older")]);
    // It only reads: the release's services, their containers, the images'
    // labels and files. Nothing is stopped, started, tagged or migrated.
    for (const call of result.docker) {
      expect(call).toMatch(/^(compose --current (config --services|ps -q [a-z]+)|inspect -f \S+ container-[a-z]+|image inspect -f .+ sha256:[a-z]+|run --rm sha256:[a-z]+ grep -rqE \S+ apps\/runtime\/dist packages\/db\/dist)$/);
    }
  });

  it("refuses when only the `sync` still runs the older image: it is the one that works while the migration is applied", () => {
    const result = runGate({ running: { api: "before", worker: "before", scheduler: "before", sync: "older" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[deploy]   sync (source revision 25a07294dd10)\n");
    for (const service of ["api", "worker", "scheduler"]) expect(result.stderr).not.toContain(`[deploy]   ${service} (`);
    expect(result.docker.filter((call) => call.startsWith("run "))).toEqual([search("before"), search("older")]);
  });

  it.each(["hold_kind", "hold_since", "hold_detail"])("refuses an image whose built code names %s alone, in either bundle directory", (column) => {
    expect(witness()).toContain(column);
    image("runtime", "aaaaaaaaaaaa", {
      "apps/runtime/dist/worker.js": `select ${column} from sync_pages where page_id = $1\n`,
      "packages/db/dist/index.js": `${NAMESAKE}\n`,
    });
    image("db", "<no value>", {
      "apps/runtime/dist/worker.js": `${NAMESAKE}\n`,
      "packages/db/dist/migrate.js": `update sync_pages set ${column} = null\n`,
    });
    const result = runGate({ running: { api: "runtime", sync: "db" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[deploy]   api (source revision aaaaaaaaaaaa)\n");
    // An image without the label is named as such.
    expect(result.stderr).toContain("[deploy]   sync (source revision unlabelled)\n");
  });

  it("passes when no app container runs: nothing works on the table, and there is no image to roll back to", () => {
    const result = runGate({ running: {} });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("No app container is running: nothing works on sync_pages while its old hold columns are dropped");
    expect(result.docker.filter((call) => call.startsWith("run "))).toEqual([]);
  });

  it("asks only about the services the release files on the host define", () => {
    const result = runGate({ defined: "postgres api scheduler worker", running: { api: "before", worker: "before", scheduler: "before" } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.docker.join("\n")).not.toContain("ps -q sync");
    expect(result.stderr).toContain("(3 running app container(s))");
  });

  it.each([
    ["the release's services cannot be listed", { failing: "config" }],
    ["a service's containers cannot be listed", { failing: "ps sync" }],
    ["a container's image cannot be read", { failing: "inspect" }],
    ["the image cannot be run", { failing: "run" }],
  ])("fails closed when %s", (_label, options) => {
    const result = runGate({ running: everyService("before"), ...options });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/error: Unable to search the running images for the old hold slot of sync_pages; its drop is still to be applied and is safe only under the release before it\n$/);
    expect(result.stderr).not.toContain("gate passed");
  });

  it("fails closed on an answer it cannot read", () => {
    image("odd", "a|b", { "apps/runtime/dist/startup.js": `${NAMESAKE}\n`, "packages/db/dist/index.js": `${NAMESAKE}\n` });
    const result = runGate({ running: { worker: "odd" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/error: Unreadable answer about the running worker image; refusing to drop the old hold columns of sync_pages under it\n$/);
  });

  it("fails closed on an image without the built code to search", () => {
    image("bare", "bbbbbbbbbbbb", { "apps/runtime/dist/startup.js": `${NAMESAKE}\n` });
    const result = runGate({ running: { api: "bare" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/db/dist");
    expect(result.stderr).toMatch(/error: Unable to search the running images for the old hold slot of sync_pages/);
  });
});

describe("deploy-production.sh asks the running images before anything is quiesced or migrated", () => {
  it("calls the gate once, between the schema baseline and the first change of the deploy", () => {
    const main = deploy.slice(deploy.indexOf('ROLLBACK_RELEASE_ARCHIVE="${TEMP_DIR}/rollback-release-files.tar"'));
    const calls = [...main.matchAll(new RegExp(`^${GATE}$`, "gm"))];
    expect(calls).toHaveLength(1);
    const gate = calls[0]?.index ?? -1;
    const baseline = main.indexOf('capture_remote_schema_migrations "$SCHEMA_BEFORE_FILE"');
    const quiesce = main.indexOf("quiesce_remote_legacy_sync_services \\");
    const migrate = main.indexOf("\nrun_pre_recreate_safe_migrations\n");
    const recreate = main.indexOf("up -d --remove-orphans --force-recreate --no-build ${RECREATE_SERVICES}");
    expect(baseline).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(baseline);
    expect(quiesce).toBeGreaterThan(gate);
    expect(migrate).toBeGreaterThan(quiesce);
    expect(recreate).toBeGreaterThan(migrate);
    // The baseline it reads is the one the rollback decision reads.
    expect(gateFunction()).toContain(`grep -Eq '^[0-9]{4}_sync_pages_drop_old_hold_columns\\.sql$' "$SCHEMA_BEFORE_FILE"`);
  });

  it("the drop it guards is the rollback-compatible entry of the list", () => {
    expect(DROP).toMatch(/^[0-9]{4}_sync_pages_drop_old_hold_columns\.sql$/);
    const compatible = deploy.match(/ROLLBACK_COMPATIBLE_MIGRATIONS=\([\s\S]*?\n\)/)?.[0] ?? "";
    expect(compatible).toContain(`"${DROP}"`);
    expect(compatible.replaceAll("\n  #", "").replace(/\s+/g, " ")).toContain(`so the deploy asks the running images before it migrates anything: ${GATE}.`);
  });
});
