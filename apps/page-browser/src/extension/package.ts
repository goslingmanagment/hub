// The rules extension's package (plan §4.6; spec §2.7, §8.1): manifest.json
// with the build's version, rules.json from the map of operations, both in
// a CRX3 signed by the extension's key, the update manifest, and the policy
// entry that force-installs it. Chrome may reach nothing but the operator's
// proxy port (plan §4.5), so the operator serves the package there
// (egress/extension-files.ts): Chrome goes to loopback without its proxy,
// and the request reaches the operator as a plain GET.
//
// The build (extension/build.ts) runs once per image, with a key of that
// build only: the ID is the image's own, and its policy names it. Nothing
// here touches the disk.

import { createHash, type KeyObject } from "node:crypto";

import { extensionId, packCrx3, publicKeyDer, updateManifest, zip } from "./crx.ts";
import { rulesJson, type DnrRule } from "../policy/rules.ts";

/** Where the operator serves the package: the proxy's port on loopback. */
export const EXTENSION_ORIGIN = "http://127.0.0.1:3128";
export const UPDATE_PATH = "/pb-extension/update.xml";
export const CRX_PATH = "/pb-extension/hub.crx";
/** The policy's `update_url` and the manifest's. */
export const UPDATE_URL = `${EXTENSION_ORIGIN}${UPDATE_PATH}`;

/** The files of a built package, by name, in its directory. */
export const PACKAGE_FILES = { crx: "hub.crx", update: "update.xml", id: "id", rules: "rules.json", manifest: "manifest.json" } as const;

export interface ExtensionPackage {
  id: string;
  version: string;
  manifest: string;
  rules: string;
  crx: Buffer;
  updateXml: string;
}

/** A Chrome extension version: one to four numbers, each 0–65535, no
 *  leading zeros. */
export function checkVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !/^(0|[1-9][0-9]{0,4})$/.test(part) || Number(part) > 65535)) {
    throw new Error(`not a Chrome extension version: ${version}`);
  }
  return version;
}

/** The manifest of the image: the template's fields and the update URL. A
 *  rules extension has no scripts and one permission. */
export function manifestFor(template: Record<string, unknown>): string {
  const manifest: Record<string, unknown> = { ...template, version: checkVersion(String(template.version ?? "")), update_url: UPDATE_URL };
  if (manifest.manifest_version !== 3) throw new Error("the rules extension is Manifest V3");
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(["declarativeNetRequest"])) throw new Error("the rules extension has one permission: declarativeNetRequest");
  for (const key of ["background", "content_scripts", "host_permissions", "optional_permissions", "web_accessible_resources", "externally_connectable"]) {
    if (key in manifest) throw new Error(`the rules extension has no ${key}`);
  }
  const resources = (manifest.declarative_net_request as { rule_resources?: Array<{ path?: unknown; enabled?: unknown }> } | undefined)?.rule_resources;
  if (!Array.isArray(resources) || resources.length !== 1 || resources[0]?.path !== PACKAGE_FILES.rules || resources[0]?.enabled !== true) {
    throw new Error("the rules extension has one ruleset, rules.json, enabled");
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function buildPackage(options: { template: Record<string, unknown>; rules: readonly DnrRule[]; key: KeyObject }): ExtensionPackage {
  const manifest = manifestFor(options.template);
  const version = String((JSON.parse(manifest) as { version: string }).version);
  const rules = rulesJson(options.rules);
  const crx = packCrx3(
    zip([
      { name: PACKAGE_FILES.manifest, data: Buffer.from(manifest) },
      { name: PACKAGE_FILES.rules, data: Buffer.from(rules) },
    ]),
    options.key,
  );
  const id = extensionId(publicKeyDer(options.key));
  const sha256 = createHash("sha256").update(crx).digest("hex");
  return { id, version, manifest, rules, crx, updateXml: updateManifest({ id, version, codebase: `${EXTENSION_ORIGIN}${CRX_PATH}`, sha256 }) };
}

/** The policies without which a window or a profile could run where the
 *  rules extension does not (spec §8.1): extensions are off in Incognito
 *  and in guest windows, force-installed ones too. */
export const NO_WINDOW_WITHOUT_THE_EXTENSION = { IncognitoModeAvailability: 1, BrowserGuestModeEnabled: false, BrowserAddPersonEnabled: false } as const;

/** Chrome's policies with the extension force-installed from the operator
 *  and every other blocked (spec §8.1). A policy that leaves a window
 *  without the extension is refused: the image does not build. */
export function policyWith(policy: Record<string, unknown>, id: string): Record<string, unknown> {
  if (!/^[a-p]{32}$/.test(id)) throw new Error(`not an extension ID: ${id}`);
  for (const [name, value] of Object.entries(NO_WINDOW_WITHOUT_THE_EXTENSION)) {
    if (policy[name] !== value) throw new Error(`the policy must set ${name} to ${JSON.stringify(value)}: a window without the rules extension would be possible`);
  }
  return {
    ...policy,
    ExtensionSettings: {
      "*": { installation_mode: "blocked" },
      [id]: { installation_mode: "force_installed", update_url: UPDATE_URL },
    },
  };
}
