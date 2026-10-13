// Before Chrome starts (s6-rc.d/chrome/run, as pb-chrome): the rules
// extension's version directories the profile does not name go
// (extension-dirs.ts). Prints one line; a failure never stops Chrome's start.

import { dropUnrecordedExtensionDirs } from "./extension-dirs.ts";

const profile = process.argv[2] ?? "/data/profile";
try {
  const result = dropUnrecordedExtensionDirs(profile);
  console.log(`chrome: extension directories kept ${result.kept.length}, dropped ${result.dropped.length}${result.skipped ? ` (${result.skipped})` : ""}`);
} catch (error) {
  console.log(`chrome: extension directories not checked: ${error instanceof Error ? error.message : String(error)}`);
}
