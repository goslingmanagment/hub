// Reads what the stand's publish capture collected (capture.sh collect) —
// the operator's `publish` journal, publish-<day>.jsonl[.gz] — for writing
// docs/plans/2026-10-23-wall-posts/fansly-publish-contract.md (runbook:
// stand-session-0.2.md). On the Mac, over the copied directory:
//
//   node --no-warnings apps/page-browser/stand/publish-capture/read.ts <dir>              the timeline, the ids, what was blocked
//   node --no-warnings apps/page-browser/stand/publish-capture/read.ts <dir> --line <id>  one request in full (its CDP id)
//   node --no-warnings apps/page-browser/stand/publish-capture/read.ts <dir> --json       every line, in time order, as one JSON array (for jq)
//
// The journal is already redacted (src/capture/redact.ts): this reads, it
// never fetches anything.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { PublishLine } from "../../src/capture/publish.ts";

const [dir, flag, value] = process.argv.slice(2);
if (!dir) {
  console.error("usage: read.ts <dir> [--line <id> | --json]");
  process.exit(2);
}

function files(at: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(at)) {
    const full = path.join(at, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/^publish-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(name)) out.push(full);
  }
  return out;
}

const lines: PublishLine[] = [];
for (const file of files(dir)) {
  const raw = readFileSync(file);
  const text = (file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
  for (const row of text.split("\n")) {
    if (row.trim() === "") continue;
    const parsed = JSON.parse(row) as PublishLine & { gap?: boolean; dropped?: number };
    if (parsed.gap === true) {
      console.error(`a gap in ${path.basename(file)}: ${parsed.dropped} line(s) dropped`);
      continue;
    }
    lines.push(parsed);
  }
}
lines.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

if (flag === "--json") {
  console.log(JSON.stringify(lines, null, 2));
  process.exit(0);
}
if (flag === "--line") {
  for (const line of lines.filter((entry) => entry.id === value)) console.log(JSON.stringify(line, null, 2));
  process.exit(0);
}

/** Ids a body names (a key `id` or ending in `Id`/`Ids`), a few levels deep. */
function ids(value: unknown, depth = 0, out: string[] = [], prefix = ""): string[] {
  if (depth > 4 || out.length > 12 || value === null || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value)) {
    const name = prefix === "" ? key : `${prefix}.${key}`;
    if (/^(id|.*Id|.*Ids)$/.test(key) && (typeof entry === "string" || typeof entry === "number" || Array.isArray(entry))) {
      out.push(`${name}=${Array.isArray(entry) ? `[${entry.slice(0, 4).join(",")}${entry.length > 4 ? ",…" : ""}]` : String(entry)}`);
    } else {
      ids(entry, depth + 1, out, Array.isArray(value) ? prefix : name);
    }
  }
  return out;
}

const size = (body: { bytes: number | null } | null | undefined) => (body?.bytes === null || body?.bytes === undefined ? "-" : String(body.bytes));
console.log("time          what       method  host/path  status  ms  req/res bytes  ids");
for (const line of lines) {
  if (line.what === "read" && line.status === null && line.error === null) continue;
  const time = line.startedAt.slice(11, 23);
  const named = [...ids(line.request.body?.json, 0, [], "req"), ...ids(line.response?.body?.json, 0, [], "res")].slice(0, 8).join(" ");
  const end = line.blocked ? "BLOCKED" : line.error !== null ? `ERR ${line.error}` : String(line.status);
  console.log(`${time}  ${line.what.padEnd(9)}  ${line.method.padEnd(6)}  ${line.host}${line.path}  ${end}  ${line.durationMs}  ${size(line.request.body)}/${size(line.response?.body)}  ${named}  [${line.id}]`);
}

const count = (what: string) => lines.filter((line) => line.what === what).length;
console.log(`\n${lines.length} lines: publish ${count("publish")}, read ${count("read")}, preflight ${count("preflight")}, write ${count("write")}`);
const blocked = new Map<string, number>();
for (const line of lines.filter((entry) => entry.blocked)) blocked.set(`${line.method} ${line.host}${line.path}`, (blocked.get(`${line.method} ${line.host}${line.path}`) ?? 0) + 1);
if (blocked.size > 0) {
  console.log("blocked by the rules (the site asked; nothing left):");
  for (const [what, n] of [...blocked].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${what}`);
}
const failed = lines.filter((line) => line.status !== null && line.status >= 400);
if (failed.length > 0) {
  console.log("answers of 400 and above:");
  for (const line of failed) console.log(`  ${line.status} ${line.method} ${line.host}${line.path} [${line.id}]`);
}
