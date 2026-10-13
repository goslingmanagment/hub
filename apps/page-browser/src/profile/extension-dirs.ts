// The rules extension's version directories in Chrome's profile (stage 1,
// amendment 24). Chrome unpacks a force-installed extension into a new
// version directory at every start that follows an exit it had no time to
// record (it writes its preferences about 10 s after the install), and
// collects the unused directories only 30 s after a start. A Chrome that
// keeps dying sooner — a page whose start keeps failing — leaves a hundred
// of them, and then cannot install the extension at all ("Could not find a
// home for extension"): the self-test fails and the page never comes back
// by itself. So before every start of Chrome the version directories the
// preferences do not name are removed, as Chrome's own collection does: an
// installed version and one waiting to be installed are both kept.
// Preferences that exist and cannot be read name nothing reliably — then
// nothing is removed.
//
// Run as Chrome's user by Chrome's run script (s6-rc.d/chrome/run, through
// main.ts): the profile is that user's alone.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

export interface DirsResult {
  kept: string[];
  dropped: string[];
  /** Why nothing was removed, if so. */
  skipped: string | null;
}

type ExtensionSettings = Record<string, { path?: unknown; idle_install_info?: { path?: unknown } }>;

export function dropUnrecordedExtensionDirs(profileDir: string): DirsResult {
  const result: DirsResult = { kept: [], dropped: [], skipped: null };
  const recorded = new Set<string>();
  for (const file of ["Preferences", "Secure Preferences"]) {
    const prefsPath = path.join(profileDir, "Default", file);
    if (!existsSync(prefsPath)) continue;
    try {
      const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as { extensions?: { settings?: ExtensionSettings } };
      for (const setting of Object.values(prefs.extensions?.settings ?? {})) {
        for (const named of [setting.path, setting.idle_install_info?.path]) if (typeof named === "string") recorded.add(named);
      }
    } catch (error) {
      result.skipped = `${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
      return result;
    }
  }
  const root = path.join(profileDir, "Default", "Extensions");
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    result.skipped = "no extensions directory yet";
    return result;
  }
  for (const id of ids) {
    let versions: string[];
    try {
      versions = readdirSync(path.join(root, id));
    } catch {
      continue;
    }
    for (const version of versions) {
      const named = `${id}/${version}`;
      // "Temp" holds what an interrupted install was unpacking.
      if (id !== "Temp" && recorded.has(named)) {
        result.kept.push(named);
        continue;
      }
      rmSync(path.join(root, id, version), { recursive: true, force: true });
      result.dropped.push(named);
    }
  }
  return result;
}
