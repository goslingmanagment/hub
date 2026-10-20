import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeHost, REPO_ROOT, TO, type Host } from "./helpers/page-browser-update.ts";

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

/** A server whose pages all run FROM (Chrome .39); TO is not built yet. */
function server(change?: Parameters<typeof makeHost>[0], options?: Parameters<typeof makeHost>[1]): Host {
  return makeHost((state) => {
    delete state.images[TO];
    change?.(state);
  }, options);
}

const check = (h: Host, args: string[] = [], env: Record<string, string> = {}) =>
  h.run(["check", ...args], { env: { PB_CHROME_REPO: REPO, PB_CHROME_SIGNING_KEY: KEY, ...env } });
const events = (h: Host) => h.journal().map((line) => line.event);
const curled = (run: { calls: Array<{ tool: string; args: string[] }> }) => run.calls.filter((call) => call.tool === "curl").map((call) => call.args[call.args.length - 1]!.slice(REPO.length));

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
});

describe("the trust anchor: Google's key, pinned", () => {
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
