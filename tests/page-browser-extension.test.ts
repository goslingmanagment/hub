import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify as verifySignature, createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ExtensionFiles } from "../apps/page-browser/src/egress/extension-files.ts";
import { Egress } from "../apps/page-browser/src/egress/proxy.ts";
import { classifyFanslyHost } from "../apps/page-browser/src/egress/hosts.ts";
import { extensionId, packCrx3, publicKeyDer, unzip, updateManifest, verifyCrx3, zip } from "../apps/page-browser/src/extension/crx.ts";
import { buildPackage, checkVersion, CRX_PATH, manifestFor, NO_WINDOW_WITHOUT_THE_EXTENSION, PACKAGE_FILES, policyWith, UPDATE_PATH, UPDATE_URL } from "../apps/page-browser/src/extension/package.ts";
import { buildRules } from "../apps/page-browser/src/policy/rules.ts";
import { dropUnrecordedExtensionDirs } from "../apps/page-browser/src/profile/extension-dirs.ts";
import { quiet } from "./helpers/page-browser-fakes.ts";

// The rules extension as a package (Project Browser plan §4.6, spec §8.1;
// stage 3, PR 6): the CRX3 Chrome installs by policy, its update manifest,
// the policy entry, the operator serving both files on the proxy's port, and
// the build of it all into the image. The real Chrome installs it on the
// stand (apps/page-browser/stand/rules-check.mjs).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "apps/page-browser");
const template = JSON.parse(readFileSync(path.join(app, "extension/manifest.json"), "utf8")) as Record<string, unknown>;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const temps: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pb-extension-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the ZIP", () => {
  it("holds the files as they are, and is the same bytes for the same files", () => {
    const entries = [
      { name: "manifest.json", data: Buffer.from('{"a":1}') },
      { name: "rules.json", data: Buffer.from("[]\n") },
      { name: "empty", data: Buffer.alloc(0) },
    ];
    const archive = zip(entries);
    expect(unzip(archive)).toEqual(entries);
    expect(zip(entries).equals(archive)).toBe(true);
    // The end record: three entries, the directory right before it.
    const end = archive.subarray(archive.length - 22);
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt16LE(10)).toBe(3);
    expect(end.readUInt32LE(16) + end.readUInt32LE(12)).toBe(archive.length - 22);
    expect(() => zip([{ name: "../up", data: Buffer.alloc(0) }])).toThrow(/plain/);
    // The system's own unzip reads it.
    const dir = temp();
    writeFileSync(path.join(dir, "a.zip"), archive);
    const listed = spawnSync("unzip", ["-p", path.join(dir, "a.zip"), "manifest.json"], { encoding: "utf8" });
    if (listed.error === undefined) expect(listed.stdout).toBe('{"a":1}');
  });
});

describe("the CRX3", () => {
  const archive = zip([{ name: "manifest.json", data: Buffer.from("{}") }]);

  it("carries the key and its signature over the ZIP; the ID is the key's", () => {
    const crx = packCrx3(archive, privateKey);
    expect(crx.subarray(0, 4).toString("latin1")).toBe("Cr24");
    expect(crx.readUInt32LE(4)).toBe(3);
    const read = verifyCrx3(crx);
    const spki = publicKeyDer(privateKey);
    expect(read.publicKey.equals(spki)).toBe(true);
    expect(read.archive.equals(archive)).toBe(true);
    expect(read.id).toBe(extensionId(spki));
    expect(read.id).toMatch(/^[a-p]{32}$/);
    // The ID by its definition: the key's SHA-256, its first 16 bytes, 0–f as a–p.
    const hex = createHash("sha256").update(spki).digest("hex").slice(0, 32);
    expect(read.id).toBe([...hex].map((digit) => "abcdefghijklmnop"[parseInt(digit, 16)]).join(""));
    // The signature by its definition, checked without this module's reader:
    // "CRX3 SignedData\0", the signed data's length, the signed data, the ZIP.
    const headerLength = crx.readUInt32LE(8);
    const header = crx.subarray(12, 12 + headerLength);
    const signedData = Buffer.concat([Buffer.from([0x0a, 16]), createHash("sha256").update(spki).digest().subarray(0, 16)]);
    expect(header.subarray(header.length - signedData.length).equals(signedData)).toBe(true);
    // CrxFileHeader.signed_header_data is field 10000: tag 0x82 0xf1 0x04.
    expect([...header.subarray(header.length - signedData.length - 4, header.length - signedData.length)]).toEqual([0x82, 0xf1, 0x04, signedData.length]);
    const signature = header.subarray(header.indexOf(spki) + spki.length + 3, header.length - signedData.length - 4);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(signedData.length);
    expect(verifySignature("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\0", "latin1"), length, signedData, archive]), createPublicKey(privateKey), signature)).toBe(true);
  });

  it("does not verify once a byte of the ZIP, of the signature or of the ID changed, nor with another key's ID", () => {
    const crx = packCrx3(archive, privateKey);
    const flip = (at: number) => {
      const copy = Buffer.from(crx);
      copy[at] = copy[at]! ^ 0x01;
      return copy;
    };
    expect(() => verifyCrx3(flip(crx.length - 1))).toThrow(/signature/);
    expect(() => verifyCrx3(flip(12 + 300))).toThrow();
    expect(() => verifyCrx3(flip(12 + crx.readUInt32LE(8) - 1))).toThrow(/no signature by the key of the ID/);
    expect(() => verifyCrx3(flip(0))).toThrow(/not a CRX3/);
    expect(() => verifyCrx3(crx.subarray(0, 40))).toThrow();
    // Another key gives another ID, and its package verifies as its own.
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    expect(verifyCrx3(packCrx3(archive, other)).id).not.toBe(verifyCrx3(crx).id);
    expect(() => packCrx3(archive, generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey)).toThrow(/RSA/);
  });
});

describe("the package", () => {
  const built = buildPackage({ template, rules: buildRules(), key: privateKey });

  it("is the manifest and the rules built from the map, signed, with the update manifest that names its bytes", () => {
    const read = verifyCrx3(built.crx);
    expect(read.id).toBe(built.id);
    const files = unzip(read.archive);
    expect(files.map((file) => file.name)).toEqual(["manifest.json", "rules.json"]);
    expect(files[0]!.data.toString()).toBe(built.manifest);
    expect(JSON.parse(files[1]!.data.toString())).toEqual(buildRules());
    expect(built.updateXml).toContain(`<app appid='${built.id}'>`);
    expect(built.updateXml).toContain(`codebase='http://127.0.0.1:3128${CRX_PATH}'`);
    expect(built.updateXml).toContain(`version='${built.version}'`);
    expect(built.updateXml).toContain(`hash_sha256='${createHash("sha256").update(built.crx).digest("hex")}'`);
    expect(() => updateManifest({ id: built.id, version: "1.0", codebase: "http://x/'><evil", sha256: "00" })).toThrow();
  });

  it("is a Manifest V3 extension of static rules only: one permission, one ruleset, no scripts, no hosts", () => {
    const manifest = JSON.parse(built.manifest) as Record<string, unknown>;
    expect(manifest).toEqual({
      manifest_version: 3,
      name: "Hub page rules",
      description: expect.any(String),
      version: "1.0.0",
      permissions: ["declarativeNetRequest"],
      declarative_net_request: { rule_resources: [{ id: "hub", enabled: true, path: "rules.json" }] },
      update_url: UPDATE_URL,
    });
    expect(UPDATE_URL).toBe(`http://127.0.0.1:3128${UPDATE_PATH}`);
    for (const more of [{ background: { service_worker: "sw.js" } }, { content_scripts: [] }, { host_permissions: ["<all_urls>"] }, { permissions: ["declarativeNetRequest", "tabs"] }, { manifest_version: 2 }, { version: "1.0.x" }, { version: "70000" }, { declarative_net_request: { rule_resources: [{ id: "hub", enabled: false, path: "rules.json" }] } }]) {
      expect(() => manifestFor({ ...template, ...more }), JSON.stringify(more)).toThrow();
    }
    expect(checkVersion("1.285.27914.0")).toBe("1.285.27914.0");
    for (const bad of ["", "1.2.3.4.5", "01.2", "1..2", "-1"]) expect(() => checkVersion(bad), bad).toThrow();
  });

  it("gives the policy the entry that force-installs it from the operator, every other extension blocked", () => {
    const policy = JSON.parse(readFileSync(path.join(app, "policies/hub.json"), "utf8")) as Record<string, unknown>;
    const withIt = policyWith(policy, built.id);
    expect(withIt.ExtensionSettings).toEqual({
      "*": { installation_mode: "blocked" },
      [built.id]: { installation_mode: "force_installed", update_url: "http://127.0.0.1:3128/pb-extension/update.xml" },
    });
    expect({ ...withIt, ExtensionSettings: policy.ExtensionSettings }).toEqual(policy);
    expect(() => policyWith(policy, "not-an-id")).toThrow();
  });

  it("refuses a policy under which a window could run without the extension: Incognito, a guest, a new person", () => {
    const policy = JSON.parse(readFileSync(path.join(app, "policies/hub.json"), "utf8")) as Record<string, unknown>;
    expect(NO_WINDOW_WITHOUT_THE_EXTENSION).toEqual({ IncognitoModeAvailability: 1, BrowserGuestModeEnabled: false, BrowserAddPersonEnabled: false });
    expect(policy).toMatchObject(NO_WINDOW_WITHOUT_THE_EXTENSION);
    for (const [name, wrong] of [["IncognitoModeAvailability", 0], ["IncognitoModeAvailability", 2], ["IncognitoModeAvailability", undefined], ["BrowserGuestModeEnabled", true], ["BrowserGuestModeEnabled", undefined], ["BrowserAddPersonEnabled", true], ["BrowserAddPersonEnabled", undefined]] as const) {
      const changed: Record<string, unknown> = { ...policy, [name]: wrong };
      if (wrong === undefined) delete changed[name];
      expect(() => policyWith(changed, "a".repeat(32)), `${name}: ${String(wrong)}`).toThrow(new RegExp(name));
    }
  });
});

describe("the build into the image (extension/build.ts)", () => {
  const build = (out: string, policy: string) => spawnSync(process.execPath, ["--no-warnings", path.join(app, "extension/build.ts"), "--out", out, "--policy", policy], { encoding: "utf8", timeout: 60_000 });

  it("writes the package and the policy entry of its ID, and no key: each build has an ID of its own", () => {
    const dir = temp();
    const policy = path.join(dir, "hub.json");
    const ids: string[] = [];
    for (const name of ["one", "two"]) {
      writeFileSync(policy, readFileSync(path.join(app, "policies/hub.json")));
      const out = path.join(dir, name);
      const result = build(out, policy);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(readdirSync(out).sort()).toEqual(["hub.crx", "id", "manifest.json", "rules.json", "update.xml"]);
      const id = readFileSync(path.join(out, PACKAGE_FILES.id), "utf8").trim();
      const read = verifyCrx3(readFileSync(path.join(out, PACKAGE_FILES.crx)));
      expect(read.id).toBe(id);
      expect(JSON.parse(unzip(read.archive)[1]!.data.toString())).toEqual(buildRules());
      expect(JSON.parse(readFileSync(path.join(out, PACKAGE_FILES.rules), "utf8"))).toEqual(buildRules());
      expect(readFileSync(path.join(out, PACKAGE_FILES.update), "utf8")).toContain(`appid='${id}'`);
      const settings = (JSON.parse(readFileSync(policy, "utf8")) as { ExtensionSettings: Record<string, { installation_mode: string }> }).ExtensionSettings;
      expect(Object.keys(settings)).toEqual(["*", id]);
      expect(settings[id]!.installation_mode).toBe("force_installed");
      // The image's policy keeps every window with the extension.
      expect(JSON.parse(readFileSync(policy, "utf8"))).toMatchObject({ ...NO_WINDOW_WITHOUT_THE_EXTENSION, HttpsOnlyMode: "force_enabled" });
      expect(JSON.parse(result.stdout)).toMatchObject({ id, rules: buildRules().length });
      // Nothing of a private key anywhere it wrote.
      for (const file of readdirSync(out)) expect(readFileSync(path.join(out, file)).includes("PRIVATE KEY"), file).toBe(false);
      ids.push(id);
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("fails without its arguments, and on a policy that is not there", () => {
    expect(spawnSync(process.execPath, ["--no-warnings", path.join(app, "extension/build.ts")], { encoding: "utf8" }).status).toBe(2);
    const dir = temp();
    expect(build(path.join(dir, "out"), path.join(dir, "missing.json")).status).not.toBe(0);
  });

  it("keeps no key in the repository, and the image builds the package from the map with no secret", () => {
    const dockerfile = readFileSync(path.join(app, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY extension/ /opt/page-browser/extension/\nRUN node --no-warnings /opt/page-browser/extension/build.ts \\\n      --out /opt/page-browser/extension/dist \\\n      --policy /etc/opt/chrome/policies/managed/hub.json\n");
    // The map is in the image before the build reads it.
    expect(dockerfile.indexOf("COPY src/ /opt/page-browser/src/")).toBeLessThan(dockerfile.indexOf("extension/build.ts"));
    expect(dockerfile.indexOf("COPY policies/hub.json")).toBeLessThan(dockerfile.indexOf("extension/build.ts"));
    expect(dockerfile).not.toMatch(/--mount=type=secret|\.pem|PRIVATE KEY/);
    expect(readdirSync(path.join(app, "extension")).sort()).toEqual(["build.ts", "manifest.json"]);
    const tracked = spawnSync("git", ["ls-files", "apps/page-browser"], { cwd: root, encoding: "utf8" }).stdout.split("\n");
    expect(tracked.filter((file) => /\.(pem|key|crx)$/.test(file))).toEqual([]);
  });
});

describe("the operator serves the package on the proxy's port", () => {
  function packageDir(): { dir: string; crx: Buffer; update: string; id: string } {
    const dir = temp();
    const built = buildPackage({ template, rules: buildRules(), key: privateKey });
    writeFileSync(path.join(dir, PACKAGE_FILES.crx), built.crx);
    writeFileSync(path.join(dir, PACKAGE_FILES.update), built.updateXml);
    writeFileSync(path.join(dir, PACKAGE_FILES.id), `${built.id}\n`);
    return { dir, crx: built.crx, update: built.updateXml, id: built.id };
  }
  function get(port: number, target: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method, path: target }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  async function proxyWith(dir: string) {
    const files = new ExtensionFiles(dir, quiet);
    const egress = new Egress({ classify: classifyFanslyHost, serve: (req, res) => files.serve(req, res), log: quiet });
    const port = await egress.listen(0);
    cleanups.push(() => egress.close());
    return { files, egress, port };
  }

  it("answers Chrome's two requests — with its query — while the exit is closed, and nothing else", async () => {
    const built = packageDir();
    const { files, egress, port } = await proxyWith(built.dir);
    expect(files.id).toBe(built.id);
    expect(egress.exitOpen).toBe(false);
    const update = await get(port, `${UPDATE_PATH}?os=linux&arch=x64&prodversion=155.0.8059.39&acceptformat=crx3,puff&x=id%3D${built.id}%26v%3D1.0.0%26installedby%3Dpolicy%26uc`);
    expect(update.status).toBe(200);
    expect(update.headers["content-type"]).toBe("application/xml");
    expect(update.body.toString()).toBe(built.update);
    const crx = await get(port, CRX_PATH);
    expect(crx.status).toBe(200);
    expect(crx.headers["content-type"]).toBe("application/x-chrome-extension");
    expect(crx.body.equals(built.crx)).toBe(true);
    expect(verifyCrx3(crx.body).id).toBe(built.id);
    const head = await get(port, CRX_PATH, "HEAD");
    expect([head.status, head.headers["content-length"], head.body.length]).toEqual([200, String(built.crx.length), 0]);
    // Anything else on the port is refused as before.
    for (const [target, method] of [["/", "GET"], ["/pb-extension/", "GET"], ["/pb-extension/id", "GET"], ["/pb-extension/../etc/passwd", "GET"], [CRX_PATH, "POST"], [`${CRX_PATH}/x`, "GET"], [`/x${UPDATE_PATH}`, "GET"]] as const) {
      expect((await get(port, target, method)).status, `${method} ${target}`).toBe(403);
    }
  });

  it("does not answer a request Chrome sends through its proxy, whatever host it names", async () => {
    const built = packageDir();
    const { port } = await proxyWith(built.dir);
    for (const target of [`http://127.0.0.1:3128${CRX_PATH}`, `http://evil.example${UPDATE_PATH}`, `http://fansly.com${CRX_PATH}`]) {
      expect((await get(port, target)).status, target).toBe(403);
    }
  });

  it("answers nothing without a package: the extension does not install, and the self-test keeps the exit closed", async () => {
    const { files, port } = await proxyWith(path.join(temp(), "nothing-here"));
    expect(files.id).toBeNull();
    expect((await get(port, UPDATE_PATH)).status).toBe(403);
    expect((await get(port, CRX_PATH)).status).toBe(403);
    // Half a package is no package.
    const half = temp();
    writeFileSync(path.join(half, PACKAGE_FILES.update), "<gupdate/>");
    const second = await proxyWith(half);
    expect(second.files.id).toBeNull();
    expect((await get(second.port, UPDATE_PATH)).status).toBe(403);
  });
});

describe("the extension's directories in Chrome's profile (stage 1, amendment 24)", () => {
  function profile(prefs: Record<string, unknown> | string | null, dirs: string[]): string {
    const dir = temp();
    mkdirSync(path.join(dir, "Default", "Extensions"), { recursive: true });
    for (const name of dirs) {
      mkdirSync(path.join(dir, "Default", "Extensions", name), { recursive: true });
      writeFileSync(path.join(dir, "Default", "Extensions", name, "manifest.json"), "{}");
    }
    if (prefs !== null) writeFileSync(path.join(dir, "Default", "Secure Preferences"), typeof prefs === "string" ? prefs : JSON.stringify(prefs));
    return dir;
  }
  const left = (dir: string) => readdirSync(path.join(dir, "Default", "Extensions")).flatMap((id) => readdirSync(path.join(dir, "Default", "Extensions", id)).map((version) => `${id}/${version}`)).sort();

  it("drops the version directories the preferences do not name, and keeps the installed one and one waiting to be installed", () => {
    const dir = profile({ extensions: { settings: { aaaa: { path: "aaaa/1.0.0_3" }, bbbb: { path: "bbbb/1.0.0_0", idle_install_info: { path: "bbbb/1.0.1_0" } }, cccc: { path: "/opt/google/chrome/resources/x" } } } }, ["aaaa/1.0.0_0", "aaaa/1.0.0_1", "aaaa/1.0.0_2", "aaaa/1.0.0_3", "bbbb/1.0.0_0", "bbbb/1.0.1_0", "old/1.0.0_0", "Temp/scoped_dir1"]);
    const result = dropUnrecordedExtensionDirs(dir);
    expect(result.skipped).toBeNull();
    expect(result.kept.sort()).toEqual(["aaaa/1.0.0_3", "bbbb/1.0.0_0", "bbbb/1.0.1_0"]);
    expect(result.dropped.sort()).toEqual(["Temp/scoped_dir1", "aaaa/1.0.0_0", "aaaa/1.0.0_1", "aaaa/1.0.0_2", "old/1.0.0_0"]);
    expect(left(dir)).toEqual(["aaaa/1.0.0_3", "bbbb/1.0.0_0", "bbbb/1.0.1_0"]);
  });

  it("with no preferences yet drops them all — Chrome installs again — and with unreadable ones touches nothing", () => {
    const fresh = profile(null, ["aaaa/1.0.0_0", "aaaa/1.0.0_1"]);
    expect(dropUnrecordedExtensionDirs(fresh).dropped).toHaveLength(2);
    expect(left(fresh)).toEqual([]);
    const broken = profile("{ not json", ["aaaa/1.0.0_0", "aaaa/1.0.0_1"]);
    const result = dropUnrecordedExtensionDirs(broken);
    expect(result.skipped).toMatch(/Secure Preferences cannot be read/);
    expect(left(broken)).toEqual(["aaaa/1.0.0_0", "aaaa/1.0.0_1"]);
    // A profile Chrome never ran in.
    const empty = temp();
    expect(dropUnrecordedExtensionDirs(empty)).toEqual({ kept: [], dropped: [], skipped: "no extensions directory yet" });
  });

  it("runs before every start of Chrome, as Chrome's user, and never stops the start", () => {
    const run = readFileSync(path.join(app, "s6/s6-rc.d/chrome/run"), "utf8");
    const cleanup = "/command/s6-setuidgid pb-chrome env -i HOME=/home/pb-chrome PATH=/usr/local/bin:/usr/bin:/bin \\\n  node --no-warnings /opt/page-browser/src/profile/main.ts /data/profile \\\n  || echo \"chrome: extension directories not checked\" >&2\n";
    expect(run).toContain(cleanup);
    expect(run.indexOf(cleanup)).toBeLessThan(run.indexOf("exec env -i HOME=/home/pb-chrome"));
    // The runner itself: one line, exit 0, also on a profile that is not there.
    const result = spawnSync(process.execPath, ["--no-warnings", path.join(app, "src/profile/main.ts"), path.join(temp(), "none")], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("chrome: extension directories kept 0, dropped 0 (no extensions directory yet)");
  });
});
