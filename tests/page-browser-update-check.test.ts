import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FROM, makeHost, PAGE, REPO_ROOT, TO, UPDATE_SCRIPT, type Host } from "./helpers/page-browser-update.ts";

// Each test runs the script in bash against a fake server that starts a
// process per call: slower than a unit test, more so under a full parallel run.
vi.setConfig({ testTimeout: 180_000 });

// scripts/page-browser-update.sh check — the timer's daily look (Project
// Browser PR 18; plan §4.10): the newest Chrome Stable in Google's
// repository, InRelease verified with the pinned key, Packages and the .deb
// by their SHA-256; a newer Chrome archived, built on the deployed commit,
// and proposed — never a page touched (owner decision №15 is open). Also
// build and prune.

const REPO = "https://dl.example.test/linux/chrome/deb";
const KEY = path.join(REPO_ROOT, "apps/page-browser/host/google-linux-signing-key.asc");
const GOOGLE_FPR = "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796";
const NEW = "155.0.8059.79-1";
const NEW_TAG = `hub-page-browser:${NEW}-aaaaaaaaaaaa`;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

let host: Host | undefined;
afterEach(() => {
  host?.cleanup();
  host = undefined;
});

interface Repo {
  version?: string;
  deb?: string;
  debSha?: string;
  packagesSha?: string;
  filename?: string;
  date?: string;
  signature?: "good" | "bad";
}

/** Google's repository as the fake curl serves it. */
function publish(h: Host, repo: Repo = {}): { deb: string; release: string } {
  const version = repo.version ?? NEW;
  const dir = path.join(h.root, "repo");
  mkdirSync(dir, { recursive: true });
  const deb = repo.deb ?? `the google-chrome-stable ${version} package`;
  const filename = repo.filename ?? `pool/main/g/google-chrome-stable/google-chrome-stable_${version}_amd64.deb`;
  writeFileSync(path.join(dir, "chrome.deb"), deb);
  const packages = [
    "Package: google-chrome-beta",
    "Version: 156.0.8078.12-1",
    "Filename: pool/main/g/google-chrome-beta/google-chrome-beta_156.0.8078.12-1_amd64.deb",
    "Size: 100",
    `SHA256: ${"1".repeat(64)}`,
    "",
    "Package: google-chrome-stable",
    `Version: ${version}`,
    "Architecture: amd64",
    `Filename: ${filename}`,
    `Size: ${Buffer.byteLength(deb)}`,
    `SHA256: ${repo.debSha ?? sha256(deb)}`,
    "",
  ].join("\n");
  writeFileSync(path.join(dir, "Packages"), packages);
  const release = [
    "Origin: Google LLC",
    "Label: Google",
    "Suite: stable",
    "Codename: stable",
    `Date: ${repo.date ?? "Wed, 14 Oct 2026 09:01:24 UTC"}`,
    "Architectures: amd64 arm64",
    "Components: main",
    "SHA256:",
    ` ${repo.packagesSha ?? sha256(packages)} ${Buffer.byteLength(packages)} main/binary-amd64/Packages`,
    ` ${"2".repeat(64)} 100 main/binary-arm64/Packages`,
    "",
  ].join("\n");
  writeFileSync(
    path.join(dir, "InRelease"),
    `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${release}-----BEGIN PGP SIGNATURE-----\n\n${repo.signature === "bad" ? "BAD-SIGNATURE" : "c2lnbmF0dXJl"}\n-----END PGP SIGNATURE-----\n`,
  );
  h.edit((state) => {
    state.urls = {
      [`${REPO}/dists/stable/InRelease`]: path.join(dir, "InRelease"),
      [`${REPO}/dists/stable/main/binary-amd64/Packages`]: path.join(dir, "Packages"),
      [`${REPO}/${filename}`]: path.join(dir, "chrome.deb"),
    };
  });
  return { deb, release };
}

/** What the last deploy kept: the build context of aaaaaaaaaaaa, KasmVNC and s6. */
function keepContext(h: Host): void {
  const work = mkdtempSync(path.join(tmpdir(), "pb context "));
  mkdirSync(path.join(work, "context"));
  writeFileSync(path.join(work, "context/Dockerfile"), "FROM scratch\n");
  mkdirSync(path.join(work, "context/src/rpc"), { recursive: true });
  writeFileSync(path.join(work, "context/src/rpc/protocol.ts"), "export const PROTOCOL = { major: 1, minor: 1 } as const;\n");
  writeFileSync(
    path.join(work, "context/vendor.sha256"),
    [
      `${"3".repeat(64)}  google-chrome-stable_155.0.8059.39-1_amd64.deb`,
      `${"4".repeat(64)}  google-chrome-stable_155.0.8059.39-1_arm64.deb`,
      `${"5".repeat(64)}  kasmvncserver_bookworm_1.5.0_amd64.deb`,
      `${"6".repeat(64)}  s6-overlay-noarch.tar.xz`,
      "",
    ].join("\n"),
  );
  const contexts = path.join(h.pbBase, "build/context");
  mkdirSync(contexts, { recursive: true });
  expect(spawnSync("tar", ["-cf", path.join(contexts, "aaaaaaaaaaaa.tar"), "-C", work, "context"]).status).toBe(0);
  writeFileSync(path.join(contexts, "LATEST"), "aaaaaaaaaaaa\n");
  mkdirSync(path.join(h.pbBase, "vendor"), { recursive: true });
  writeFileSync(path.join(h.pbBase, "vendor/kasmvncserver_bookworm_1.5.0_amd64.deb"), "kasm");
  writeFileSync(path.join(h.pbBase, "vendor/s6-overlay-noarch.tar.xz"), "s6");
  rmSync(work, { recursive: true, force: true });
}

/** A server whose pages all run FROM (Chrome .39); TO is not built yet. */
function server(change?: Parameters<typeof makeHost>[0], options?: Parameters<typeof makeHost>[1]): Host {
  return makeHost((state) => {
    delete state.images[TO];
    change?.(state);
  }, options);
}

const check = (h: Host, args: string[] = [], env: Record<string, string> = {}) =>
  h.run(["check", ...args], { env: { PB_CHROME_REPO: REPO, PB_CHROME_SIGNING_KEY: KEY, ...env } });
const fetched = (h: Host) => existsSync(path.join(h.pbBase, "chrome", `google-chrome-stable_${NEW}_amd64.deb`));
const events = (h: Host) => h.journal().map((line) => line.event);
const curled = (run: { calls: Array<{ tool: string; args: string[] }> }) => run.calls.filter((call) => call.tool === "curl").map((call) => call.args[call.args.length - 1]!.slice(REPO.length));

describe("page-browser-update.sh check: a newer Chrome is fetched, verified, built and proposed — no page touched", () => {
  it("a newer Stable: the .deb archived with its SHA-256, the image built on the deployed commit, the update proposed", () => {
    host = server();
    keepContext(host);
    const { deb } = publish(host);
    const run = check(host);
    expect(run.status, run.stderr).toBe(0);
    expect(curled(run)).toEqual(["/dists/stable/InRelease", "/dists/stable/main/binary-amd64/Packages", `/pool/main/g/google-chrome-stable/google-chrome-stable_${NEW}_amd64.deb`]);
    const archived = path.join(host.pbBase, "chrome", `google-chrome-stable_${NEW}_amd64.deb`);
    expect(readFileSync(archived, "utf8")).toBe(deb);
    expect(readFileSync(`${archived}.meta`, "utf8")).toContain(`version=${NEW}\nsha256=${sha256(deb)}\n`);
    expect(readFileSync(`${archived}.meta`, "utf8")).toContain("signer=0E225917414670F4442C250DFD533C07C264648F\n");
    // Built on the commit the deploy kept, with this Chrome in place of the pinned one.
    const [build] = host.state().builds!;
    expect(build!.tag).toBe(NEW_TAG);
    expect(build!.labels).toEqual({
      "agency-hub.page-browser.revision": "aaaaaaaaaaaa",
      "agency-hub.page-browser.protocol": "1.1",
      "agency-hub.page-browser.chrome-version": NEW,
      "agency-hub.page-browser.chrome-sha256": sha256(deb),
      "agency-hub.page-browser.built-by": "page-browser-update",
    });
    expect(build!.vendorSha256).toBe(
      [`${"5".repeat(64)}  kasmvncserver_bookworm_1.5.0_amd64.deb`, `${"6".repeat(64)}  s6-overlay-noarch.tar.xz`, `${sha256(deb)}  google-chrome-stable_${NEW}_amd64.deb`, ""].join("\n"),
    );
    const buildCall = run.calls.find((call) => call.tool === "docker" && call.args[0] === "build")!;
    expect(buildCall.args).toEqual(expect.arrayContaining(["--build-arg", `CHROME_VERSION=${NEW}`, "--build-arg", "OPERATOR_VERSION=aaaaaaaaaaaa"]));
    expect(buildCall.args.some((arg) => arg.startsWith("vendor="))).toBe(true);
    // Proposed, and nothing else: no page, no lever of the Hub.
    expect(run.ops).toEqual([`docker build ${NEW_TAG}`]);
    expect(run.calls.some((call) => call.tool === "page.sh" || (call.tool === "docker" && call.args.includes("compose")))).toBe(false);
    const proposed = host.journal().find((line) => line.event === "proposed")!;
    expect(proposed.detail).toContain(`its image ${NEW_TAG} is built. No page is updated by itself (owner decision №15 is open)`);
    expect(proposed.detail).toContain(`page-browser-update.sh update --page <first page> --image ${NEW_TAG}`);
    expect(readFileSync(path.join(host.pbBase, "update/status"), "utf8")).toMatch(new RegExp(`^checked .*: Chrome Stable ${NEW}`));
    expect(host.state().containers[`page-browser-${PAGE}`]).toMatchObject({ image: FROM, running: true });
  });

  it("nothing newer than the newest here: nothing fetched or built", () => {
    host = server();
    publish(host, { version: "155.0.8059.39-1" });
    const run = check(host);
    expect(run.status, run.stderr).toBe(0);
    expect(curled(run)).toEqual(["/dists/stable/InRelease", "/dists/stable/main/binary-amd64/Packages"]);
    expect(run.ops).toEqual([]);
    expect(events(host)).toEqual(["checked"]);
  });

  it("--no-build: fetched and proposed for a build", () => {
    host = server();
    publish(host);
    const run = check(host, ["--no-build"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual([]);
    expect(host.journal().find((line) => line.event === "proposed")!.detail).toContain(`page-browser-update.sh build --chrome ${NEW}`);
  });

  it("an update holds the lock: the check only looks", () => {
    host = server((state) => {
      state.behaviour.lockHeld = true;
    });
    publish(host);
    const run = check(host);
    expect(run.status, run.stderr).toBe(0);
    expect(curled(run)).toHaveLength(2);
    expect(host.journal().find((line) => line.event === "checked")!.detail).toContain("the next check takes it");
  });
});

describe("check: nothing unverified is fetched, kept or built", () => {
  const refused = (h: Host, why: string | RegExp, env: Record<string, string> = {}) => {
    const run = check(h, [], env);
    expect(run.status).toBe(1);
    expect(h.journal().filter((line) => line.event === "repository" || line.event === "fetch").map((line) => line.detail).join("\n")).toMatch(why);
    expect(run.ops).toEqual([]);
    expect(readdirSync(path.join(h.pbBase, "chrome")).filter((name) => name.endsWith(".deb") || name.endsWith(".part"))).toEqual([]);
    return run;
  };
  const archive = (h: Host) => mkdirSync(path.join(h.pbBase, "chrome"), { recursive: true });

  it("a bad signature on InRelease", () => {
    host = server();
    archive(host);
    publish(host, { signature: "bad" });
    const run = refused(host, /InRelease is not signed by Google's key/);
    expect(curled(run)).toEqual(["/dists/stable/InRelease"]);
  });

  it("a signature gpgv lets pass, by an expired or revoked key", () => {
    for (const status of ["EXPKEYSIG", "REVKEYSIG"]) {
      host = server((state) => {
        state.behaviour.gpgStatus = status;
      });
      archive(host);
      publish(host);
      refused(host, new RegExp(`InRelease's signature is not one good signature: NEWSIG ${status} VALIDSIG`));
      host.cleanup();
    }
    host = undefined;
  });

  it("a good signature under another primary key", () => {
    host = server((state) => {
      state.behaviour.gpgPrimary = "0".repeat(40);
    });
    archive(host);
    publish(host);
    refused(host, new RegExp(`signed under the key 0{40}, not Google's ${GOOGLE_FPR}`));
  });

  it("Packages that do not match their SHA-256 in InRelease", () => {
    host = server();
    archive(host);
    publish(host, { packagesSha: "7".repeat(64) });
    const run = refused(host, /Packages does not match its SHA-256 in InRelease/);
    expect(curled(run)).toHaveLength(2);
  });

  it("a .deb that does not match its SHA-256 in Packages: the download is dropped", () => {
    host = server();
    archive(host);
    publish(host, { debSha: "8".repeat(64) });
    refused(host, /does not match its size and SHA-256 in Packages/);
  });

  it("a package path that is not the stable package's own", () => {
    host = server();
    archive(host);
    publish(host, { filename: `pool/main/g/google-chrome-stable/../../../../tmp/google-chrome-stable_${NEW}_amd64.deb` });
    refused(host, /Packages names no well-formed google-chrome-stable for amd64/);
  });

  it("an InRelease older than one seen before (a replay that hides releases)", () => {
    host = server();
    archive(host);
    publish(host);
    mkdirSync(path.join(host.pbBase, "update"), { recursive: true });
    writeFileSync(path.join(host.pbBase, "update/repo-date"), `${Date.parse("2026-10-15T00:00:00Z") / 1000}\n`);
    refused(host, /older than one seen before: refused/);
  });

  it("an InRelease whose Date cannot be read: refused, the replay check is never skipped", () => {
    host = server();
    archive(host);
    publish(host, { date: "sometime soon" });
    refused(host, /InRelease's Date \('sometime soon'\) cannot be read/);
  });

  it("no build context kept: fetched, the build alerted, nothing built", () => {
    host = server();
    publish(host);
    const run = check(host);
    expect(run.status).toBe(1);
    expect(run.ops).toEqual([]);
    expect(fetched(host)).toBe(true);
    expect(host.journal().find((line) => line.event === "build")!.detail).toContain("no build context kept for revision ''");
  });
});

describe("check: what waits for the owner", () => {
  it("an update stopped midway with nobody running it, one held for the owner, pages behind for more than 3 days", () => {
    host = server((state) => {
      state.images[TO] = { chrome: NEW, revision: "bbbbbbbbbbbb", created: "2026-10-14T00:00:00Z" };
    });
    publish(host);
    const pages = path.join(host.pbBase, "update/pages");
    mkdirSync(path.join(pages, PAGE), { recursive: true });
    writeFileSync(path.join(pages, PAGE, "state"), `PAGE=${PAGE}\nSTEP=snapshotted\nTO_IMAGE=${TO}\n`);
    mkdirSync(path.join(host.pbBase, "chrome"), { recursive: true });
    writeFileSync(path.join(host.pbBase, "chrome", `google-chrome-stable_${NEW}_amd64.deb`), "x");
    writeFileSync(path.join(host.pbBase, "chrome", `google-chrome-stable_${NEW}_amd64.deb.meta`), `version=${NEW}\nsha256=x\nfetched_s=${Math.floor(Date.now() / 1000) - 4 * 86400}\n`);
    const run = check(host);
    expect(run.status).toBe(1);
    const alerts = host.journal().filter((line) => ["update_stuck", "pages_behind"].includes(line.event));
    expect(alerts.map((line) => line.event)).toEqual(["update_stuck", "pages_behind"]);
    expect(alerts[0]!.detail).toContain(`page-browser-update.sh resume --page ${PAGE}`);
    expect(alerts[1]!.detail).toContain(`1 page(s) still run a Chrome older than ${NEW}, out for more than 3 days`);

    writeFileSync(path.join(pages, PAGE, "state"), `PAGE=${PAGE}\nSTEP=held\nREASON=the owner stopped it\nTO_IMAGE=${TO}\n`);
    check(host);
    expect(host.journal().filter((line) => line.event === "update_waiting").map((line) => line.detail)).toEqual([
      "its update stands at held (the owner stopped it): the owner decides (resume or rollback)",
    ]);
  });
});

describe("build and prune", () => {
  it("build: an archived Chrome on the kept commit; again, nothing", () => {
    host = server();
    keepContext(host);
    publish(host);
    expect(check(host, ["--no-build"]).status).toBe(0);
    const built = host.run(["build", "--chrome", NEW]);
    expect(built.status, built.stderr).toBe(0);
    expect(built.stdout.trim()).toBe(NEW_TAG);
    expect(built.ops).toEqual([`docker build ${NEW_TAG}`]);
    expect(host.run(["build", "--chrome", NEW]).ops).toEqual([]);
  });

  it("build refuses an archived .deb that does not match its SHA-256", () => {
    host = server();
    keepContext(host);
    publish(host);
    check(host, ["--no-build"]);
    writeFileSync(path.join(host.pbBase, "chrome", `google-chrome-stable_${NEW}_amd64.deb`), "tampered");
    const run = host.run(["build", "--chrome", NEW]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("does not match its SHA-256");
    expect(run.ops).toEqual([]);
  });

  it("prune: the newest three images, every image a page runs or keeps, never a tag that is not a release's", () => {
    const tags = ["155.0.8059.20-1", "155.0.8059.25-1", "155.0.8059.30-1", "155.0.8059.39-1", "155.0.8059.79-1"].map((version, i) => ({
      tag: `hub-page-browser:${version}-aaaaaaaaaaaa`,
      version,
      created: `2026-10-0${i + 1}T00:00:00Z`,
    }));
    host = makeHost((state) => {
      state.images = Object.fromEntries(tags.map(({ tag, version, created }) => [tag, { chrome: version, revision: "aaaaaaaaaaaa", created }]));
      state.images["hub-page-browser:stand"] = { chrome: "155.0.8059.39-1", created: "2026-09-01T00:00:00Z" };
      state.containers[`page-browser-${PAGE}`]!.image = tags[0]!.tag;
    });
    writeFileSync(path.join(host.pbBase, "pages", PAGE, "page.env"), host.pageEnv().replace(`PB_IMAGE=${FROM}`, `PB_IMAGE=${tags[0]!.tag}`));
    const chrome = path.join(host.pbBase, "chrome");
    mkdirSync(chrome, { recursive: true });
    for (const { version } of tags) {
      writeFileSync(path.join(chrome, `google-chrome-stable_${version}_amd64.deb`), version);
      writeFileSync(path.join(chrome, `google-chrome-stable_${version}_amd64.deb.meta`), `version=${version}\n`);
    }
    const run = host.run(["prune"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.ops).toEqual([`image rm ${tags[1]!.tag}`]);
    expect(Object.keys(host.state().images).sort()).toEqual([tags[0]!.tag, tags[2]!.tag, tags[3]!.tag, tags[4]!.tag, "hub-page-browser:stand"].sort());
    expect(readdirSync(chrome).filter((name) => name.endsWith(".deb")).sort()).toEqual(
      [tags[0]!, tags[2]!, tags[3]!, tags[4]!].map(({ version }) => `google-chrome-stable_${version}_amd64.deb`).sort(),
    );
  });
});

describe("the trust anchor: Google's key, pinned", () => {
  /** A v4 key's fingerprint: SHA-1 of 0x99, the key packet's length and body. */
  function primaryFingerprint(armored: string): string {
    const body = armored.split("\n\n").slice(1).join("\n\n").split("\n").filter((line) => line && !line.startsWith("=") && !line.startsWith("-----")).join("");
    const bytes = Buffer.from(body, "base64");
    const tag = bytes[0]!;
    expect(tag & 0x80).toBe(0x80);
    let offset: number;
    let length: number;
    if ((tag & 0x40) !== 0) {
      // A new-format packet.
      const first = bytes[1]!;
      if (first < 192) [offset, length] = [2, first];
      else if (first < 224) [offset, length] = [3, ((first - 192) << 8) + bytes[2]! + 192];
      else [offset, length] = [6, bytes.readUInt32BE(2)];
      expect(tag & 0x3f).toBe(6);
    } else {
      expect((tag >> 2) & 0x0f).toBe(6);
      const kind = tag & 0x03;
      [offset, length] = kind === 0 ? [2, bytes[1]!] : kind === 1 ? [3, bytes.readUInt16BE(1)] : [5, bytes.readUInt32BE(1)];
    }
    const packet = bytes.subarray(offset, offset + length);
    const header = Buffer.from([0x99, (length >> 8) & 0xff, length & 0xff]);
    return createHash("sha1").update(Buffer.concat([header, packet])).digest("hex").toUpperCase();
  }

  it("the committed key is Google's Linux package signing key, and the script pins its primary fingerprint", () => {
    expect(primaryFingerprint(readFileSync(KEY, "utf8"))).toBe(GOOGLE_FPR);
    expect(readFileSync(UPDATE_SCRIPT, "utf8")).toContain(`SIGNING_FPR="\${PB_CHROME_SIGNING_FPR:-${GOOGLE_FPR}}"`);
  });

  const gpg = spawnSync("gpg", ["--version"]).status === 0 && spawnSync("gpgv", ["--version"]).status === 0;
  it.skipIf(!gpg)("with the real gpgv: a signed InRelease passes, a changed byte or another key does not", () => {
    host = server(undefined, { without: ["gpgv"] });
    const home = path.join(host.root, "gnupg");
    mkdirSync(home, { mode: 0o700 });
    const g = (...args: string[]) => spawnSync("gpg", ["--homedir", home, "--batch", "--pinentry-mode", "loopback", "--passphrase", "", ...args], { encoding: "utf8" });
    expect(g("--quick-gen-key", "PR 18 test <pr18@example.test>", "ed25519", "sign", "1d").status).toBe(0);
    const fpr = /^fpr:+([0-9A-F]{40}):/m.exec(g("--with-colons", "--fingerprint").stdout)![1]!;
    const key = path.join(host.root, "test-key.asc");
    writeFileSync(key, g("--armor", "--export", fpr).stdout);
    const { release } = publish(host, { version: "155.0.8059.39-1" });
    const inRelease = path.join(host.root, "repo/InRelease");
    writeFileSync(path.join(host.root, "Release"), release);
    expect(g("--yes", "--local-user", fpr, "--clearsign", "-o", inRelease, path.join(host.root, "Release")).status).toBe(0);
    const env = { PB_CHROME_SIGNING_KEY: key, PB_CHROME_SIGNING_FPR: fpr };
    const good = check(host, [], env);
    expect(good.status, good.stderr).toBe(0);
    expect(events(host)).toEqual(["checked"]);

    writeFileSync(inRelease, readFileSync(inRelease, "utf8").replace("Suite: stable", "Suite: stablf"));
    const changed = check(host, [], env);
    expect(changed.status).toBe(1);
    expect(host.journal().at(-1)!.detail).toContain("InRelease is not signed by Google's key");

    expect(g("--yes", "--local-user", fpr, "--clearsign", "-o", inRelease, path.join(host.root, "Release")).status).toBe(0);
    const other = check(host, [], { PB_CHROME_SIGNING_KEY: key, PB_CHROME_SIGNING_FPR: GOOGLE_FPR });
    expect(other.status).toBe(1);
    expect(host.journal().at(-1)!.detail).toContain(`not Google's ${GOOGLE_FPR}`);
  });
});
