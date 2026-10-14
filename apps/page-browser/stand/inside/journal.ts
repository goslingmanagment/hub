// The operator's own journal, read inside the page container for a run's
// evidence (runner/criteria.ts): the lines of one kind (src/logs/journal.ts
// — JSON Lines on the buffer volume, one file per kind and UTC day, an
// ended day gzipped) written at or after a moment, narrowed to what the
// runner asks.
//
//   node --no-warnings /opt/page-browser/stand/inside/journal.ts '<json>'
//   { kind: "requests", sinceWall, decision? }
//
// The journal holds no secret by design (no query, no header, no body:
// src/logs/journal.ts); this prints its lines as they are. Started as root
// by the runner (docker exec): the directory is the operator's own.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

interface Ask {
  kind: "connections" | "requests" | "states" | "sockets";
  sinceWall: number;
  decision?: string;
}

const ask = JSON.parse(process.argv[2] ?? "{}") as Ask;
const dir = process.env.PB_LOG_DIR ?? "/data/buffer/logs";
const sinceDay = new Date(ask.sinceWall).toISOString().slice(0, 10);
const files = readdirSync(dir)
  .filter((name) => name.startsWith(`${ask.kind}-`) && /\.jsonl(\.gz)?$/.test(name) && name.slice(ask.kind.length + 1, ask.kind.length + 11) >= sinceDay)
  .sort();
const out: string[] = [];
for (const name of files) {
  const raw = readFileSync(join(dir, name));
  const text = (name.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let parsed: { at?: unknown; decision?: unknown };
    try {
      parsed = JSON.parse(line) as { at?: unknown; decision?: unknown };
    } catch {
      continue; // a line cut by a crash: not evidence of anything
    }
    if (typeof parsed.at !== "string" || Date.parse(parsed.at) < ask.sinceWall) continue;
    if (ask.decision !== undefined && parsed.decision !== ask.decision) continue;
    out.push(line);
  }
}
console.log(out.join("\n"));
process.exit(0);
