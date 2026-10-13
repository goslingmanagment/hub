// Builds the rules extension into the image (plan §4.6; Dockerfile):
//
//   node --no-warnings extension/build.ts --out <dir> --policy <hub.json>
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

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildPackage, PACKAGE_FILES, policyWith } from "../src/extension/package.ts";
import { buildRules } from "../src/policy/rules.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, policy: { type: "string" } }, strict: true });
if (!values.out || !values.policy) {
  console.error("usage: build.ts --out <dir> --policy <hub.json>");
  process.exit(2);
}
const out = values.out;

const here = path.dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(readFileSync(path.join(here, "manifest.json"), "utf8")) as Record<string, unknown>;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const built = buildPackage({ template, rules: buildRules(), key: privateKey });

mkdirSync(out, { recursive: true });
const write = (name: string, data: string | Buffer) => writeFileSync(path.join(out, name), data, { mode: 0o644 });
write(PACKAGE_FILES.crx, built.crx);
write(PACKAGE_FILES.update, built.updateXml);
write(PACKAGE_FILES.id, `${built.id}\n`);
write(PACKAGE_FILES.rules, built.rules);
write(PACKAGE_FILES.manifest, built.manifest);

const policy = JSON.parse(readFileSync(values.policy, "utf8")) as Record<string, unknown>;
writeFileSync(values.policy, `${JSON.stringify(policyWith(policy, built.id), null, 2)}\n`);

console.log(JSON.stringify({ id: built.id, version: built.version, rules: (JSON.parse(built.rules) as unknown[]).length, crxBytes: built.crx.length }));
