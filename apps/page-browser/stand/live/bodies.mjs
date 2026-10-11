// What the page's buffer holds after a session that captured bodies — never
// their content: per file its size, whether it parses as JSON, Fansly's
// `success` flag and the shape of `response` (its type, its keys or length).
// Run in the browser container, then join with the journal by file name:
//   docker exec -i pb-live-browser-1 node - < stand/live/bodies.mjs
// Afterwards the bodies are deleted (RUNBOOK, the session with bodies).

import { readdirSync, readFileSync, statSync } from "node:fs";

const DIR = process.env.PB_BODIES_DIR ?? "/data/buffer/bodies";
let names = [];
try {
  names = readdirSync(DIR).sort();
} catch {
  console.log(JSON.stringify({ dir: DIR, files: 0 }));
  process.exit(0);
}
for (const name of names) {
  const path = `${DIR}/${name}`;
  const bytes = statSync(path).size;
  let json = false;
  let success = null;
  let shape = null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    json = true;
    success = typeof value?.success === "boolean" ? value.success : null;
    const r = value?.response;
    shape = Array.isArray(r) ? { type: "array", length: r.length } : r !== null && typeof r === "object" ? { type: "object", keys: Object.keys(r).sort() } : { type: typeof r };
  } catch {
    // Not JSON: a cut body, or not an API answer.
  }
  console.log(JSON.stringify({ file: name, bytes, json, success, shape }));
}
