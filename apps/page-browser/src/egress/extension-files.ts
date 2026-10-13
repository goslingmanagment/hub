// The rules extension's package on the proxy's port (plan §4.6; spec §8.1):
// Chrome's policy force-installs it from http://127.0.0.1:3128 — loopback,
// which Chrome reaches without its proxy, and the one port the kernel lets
// it reach (plan §4.5). Two files, read once at the operator's start from
// the image (extension/build.ts wrote them): the update manifest and the
// CRX. Only a direct request for one of them is answered; a request Chrome
// sends through its proxy names a whole URL and is refused like any other.
// A missing package answers nothing: the extension does not install, and
// the self-test keeps the exit closed.

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { CRX_PATH, PACKAGE_FILES, UPDATE_PATH } from "../extension/package.ts";
import { errorMessage, makeLog, type Logger } from "../shared/util.ts";

interface File {
  body: Buffer;
  type: string;
}

export class ExtensionFiles {
  readonly #files = new Map<string, File>();
  readonly #log: Logger;
  /** The ID the package is built for, or null without a package. */
  readonly id: string | null;

  constructor(dir: string, log: Logger = makeLog("extension")) {
    this.#log = log;
    let id: string | null = null;
    try {
      const update = readFileSync(path.join(dir, PACKAGE_FILES.update));
      const crx = readFileSync(path.join(dir, PACKAGE_FILES.crx));
      id = readFileSync(path.join(dir, PACKAGE_FILES.id), "utf8").trim();
      this.#files.set(UPDATE_PATH, { body: update, type: "application/xml" });
      this.#files.set(CRX_PATH, { body: crx, type: "application/x-chrome-extension" });
      log("extension.loaded", { id, crxBytes: crx.length });
    } catch (error) {
      log("extension.missing", { dir, error: errorMessage(error) });
    }
    this.id = id;
  }

  /** Answers a request for the package; false for anything else. */
  serve(req: IncomingMessage, res: ServerResponse): boolean {
    const target = req.url ?? "";
    if (!target.startsWith("/")) return false;
    const file = this.#files.get(target.split(/[?#]/, 1)[0]!);
    if (!file || (req.method !== "GET" && req.method !== "HEAD")) return false;
    this.#log("extension.served", { path: target.split(/[?#]/, 1)[0]!, method: req.method });
    res.writeHead(200, { "content-type": file.type, "content-length": String(file.body.length), "cache-control": "no-store", connection: "close" });
    res.end(req.method === "HEAD" ? undefined : file.body);
    return true;
  }
}
