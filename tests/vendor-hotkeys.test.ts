import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { HOTKEY_SCHEME_VERSION } from "../packages/chatgoose-hotkeys/src/index.ts";

const target = mkdtempSync(join(tmpdir(), "vendor-hotkeys-test-"));
afterAll(() => rmSync(target, { recursive: true, force: true }));

describe("scripts/vendor-hotkeys.mjs", () => {
  it("ships a compiled @chatgoose/hotkeys whose manifest pins every file", async () => {
    execFileSync("node", ["scripts/vendor-hotkeys.mjs", target, "--allow-dirty"], { stdio: "pipe" });

    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    expect(pkg.name).toBe("@chatgoose/hotkeys");
    expect(pkg.exports["."].default).toBe("./dist/index.js");

    const manifest = JSON.parse(readFileSync(join(target, "chatgoose-hotkeys.vendor.json"), "utf8"));
    expect(manifest.schemeVersion).toBe(HOTKEY_SCHEME_VERSION);
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining(["dist/index.js", "dist/index.d.ts", "dist/engine.js", "dist/scheme.js", "dist/labels.js"]));
    for (const [file, hash] of Object.entries(manifest.files)) {
      expect(createHash("sha256").update(readFileSync(join(target, file))).digest("hex"), file).toBe(hash);
    }
    expect(manifest.sha256).toBe(createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex"));

    const vendored = await import(pathToFileURL(join(target, "dist/index.js")).href);
    const engine = vendored.createHotkeyEngine({ platform: "mac", client: "desktop" });
    engine.keydown({ code: "MetaLeft", key: "Meta", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false });
    expect(engine.keydown({ code: "KeyE", key: "у", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }))
      .toEqual({ kind: "action", action: "reply", repeat: false });
  }, 60_000);
});
