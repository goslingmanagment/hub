// The stand's publish capture (docs/plans/2026-10-23-wall-posts, plan PR 0.1):
// whether this image was built for it. Only `extension/build.ts --capture
// publish` (stand/publish-capture/Dockerfile) writes the marker, next to the
// rules extension's package it builds with the capture's rules — the
// image's own files, root's, read-only to the operator. A production image
// is built without the flag: no marker, no capture rules, and the operator
// keeps the upload host closed and writes no `publish` journal. The
// operator reads the marker once, at its start.

import { readFileSync } from "node:fs";
import path from "node:path";

/** The marker's file name in the extension's directory. */
export const PUBLISH_CAPTURE_MARKER = "publish-capture.json";

/** The marker's content: what the build writes and the operator expects. */
export const PUBLISH_CAPTURE_MARK = { capture: "publish", plan: "docs/plans/2026-10-23-wall-posts (PR 0.1)", standOnly: true } as const;

/** Whether the image at this extension directory was built for the publish
 *  capture: its marker is there and says so. Anything else — no file, a
 *  file that does not parse, another word — is a production image. */
export function publishCaptureBuilt(extensionDir: string): boolean {
  try {
    const mark = JSON.parse(readFileSync(path.join(extensionDir, PUBLISH_CAPTURE_MARKER), "utf8")) as { capture?: unknown; standOnly?: unknown };
    return mark.capture === PUBLISH_CAPTURE_MARK.capture && mark.standOnly === true;
  } catch {
    return false;
  }
}
