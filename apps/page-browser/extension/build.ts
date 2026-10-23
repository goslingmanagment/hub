// Builds the rules extension into the image (plan §4.6; Dockerfile):
//
//   node --no-warnings extension/build.ts --out <dir> --policy <hub.json> [--capture publish]
//
// - rules.json from the map of operations (src/policy/) and
//   extension/manifest.json, in a CRX3 signed by the extension's key; the
//   update manifest; the ID. Into <dir>, where the operator serves them from
//   (egress/extension-files.ts).
// - The policy file gets the ExtensionSettings entry that force-installs
//   this ID from the operator, every other extension blocked (spec §8.1).
// - The key is made here, in this process's memory, signs the package once
//   and is gone with the process: it is never written anywhere — not into
//   the repository, the image or a secret store. So every image has an
//   extension ID of its own, the one its own policy names. That is on
//   purpose: Chrome updates an installed extension only to a higher version
//   and never back, so with one kept key a page rolled back to an older
//   image would keep the newer image's rules (seen on Chrome 155). With an
//   ID per image, the rules in the browser are always the image's: Chrome
//   removes the previous image's extension, which its policy now blocks, and
//   installs this one at its first start, while the exit is still closed
//   (the self-test waits for it).
// - `--capture publish`: the stand's publish capture (docs/plans/
//   2026-10-23-wall-posts, PR 0.1) — the capture's rules on top of the
//   production rules, and its marker next to the package, which turns the
//   operator's side on (src/capture/mode.ts). Only the stand's image is
//   built with it (stand/publish-capture/Dockerfile, over a production
//   image); the production Dockerfile never passes it, and a build without
//   it removes a marker left in <dir>.

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PUBLISH_CAPTURE_MARK, PUBLISH_CAPTURE_MARKER } from "../src/capture/mode.ts";
import { buildPackage, PACKAGE_FILES, policyWith } from "../src/extension/package.ts";
import { buildRules } from "../src/policy/rules.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, policy: { type: "string" }, capture: { type: "string" } }, strict: true });
if (!values.out || !values.policy || (values.capture !== undefined && values.capture !== "publish")) {
  console.error("usage: build.ts --out <dir> --policy <hub.json> [--capture publish]");
  process.exit(2);
}
const out = values.out;
const publishCapture = values.capture === "publish";

const here = path.dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(readFileSync(path.join(here, "manifest.json"), "utf8")) as Record<string, unknown>;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const built = buildPackage({ template, rules: buildRules({ publishCapture }), key: privateKey });

mkdirSync(out, { recursive: true });
const write = (name: string, data: string | Buffer) => writeFileSync(path.join(out, name), data, { mode: 0o644 });
write(PACKAGE_FILES.crx, built.crx);
write(PACKAGE_FILES.update, built.updateXml);
write(PACKAGE_FILES.id, `${built.id}\n`);
write(PACKAGE_FILES.rules, built.rules);
write(PACKAGE_FILES.manifest, built.manifest);
if (publishCapture) write(PUBLISH_CAPTURE_MARKER, `${JSON.stringify(PUBLISH_CAPTURE_MARK)}\n`);
else rmSync(path.join(out, PUBLISH_CAPTURE_MARKER), { force: true });

const policy = JSON.parse(readFileSync(values.policy, "utf8")) as Record<string, unknown>;
writeFileSync(values.policy, `${JSON.stringify(policyWith(policy, built.id), null, 2)}\n`);

console.log(JSON.stringify({ id: built.id, version: built.version, rules: (JSON.parse(built.rules) as unknown[]).length, crxBytes: built.crx.length, publishCapture }));
