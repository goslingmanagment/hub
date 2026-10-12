// The operator's in-memory inventory of an answer (src/operator/inventory.ts)
// against fixed answers: vetted names only, every other key a placeholder,
// sensitive names marked by category, values and data-bearing keys never in
// the result, every bound held (Astra reviews 13 and 14).
//   node --no-warnings stand/runner/inventory-check.ts      exit 0 = all hold

import { BOUNDS, inspectBody } from "../../src/operator/inventory.ts";

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(JSON.stringify({ check: name, ok, ...(detail === undefined ? {} : { detail }) }));
  if (!ok) failures.push(name);
}
const buf = (value: unknown) => [Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8")];

// Values and keys that are data: none may appear in an inventory.
const DATA = [
  "owner@example.test",
  "tok-very-secret-value",
  "+491701234567",
  "p@ss!w0rd#2026",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl",
  "723606174951284736",
  "Anikaplayxx",
  "Signature=abc",
];
const answer = {
  success: true,
  response: {
    account: { id: DATA[5], username: DATA[6], email: DATA[0], phoneNumber: DATA[2], settings: { twofaEnabled: false } },
    accounts: [{ id: "1", username: "a", avatar: { locations: [{ location: `https://cdn3.example/x?${DATA[7]}`, metadata: { "Key-Pair-Id": "k" } }] } }],
    aggregationData: { [DATA[5]]: { postCount: 3 }, [DATA[0]]: { x: 1 }, [DATA[1]]: 1, [DATA[2]]: 2, [DATA[3]]: 3, [DATA[4]]: 4, [DATA[6]]: 5 },
    session: { token: DATA[1] },
  },
};
const inv = inspectBody(buf(answer), false, 1_000_000);
const text = JSON.stringify(inv);
check("inspected JSON", inv.inspected === true && inv.json === true && inv.success === true);
check("no value and no data-bearing key in the result", DATA.every((value) => !text.includes(value)), inv.paths);
check("vetted names kept, nested and array paths", ["response.account.username", "response.accounts[].username", "response.accounts[].id"].every((path) => inv.paths!.includes(path)), inv.paths);
check("numeric keys are {id}, other unknown keys {?} or a category", inv.paths!.includes("response.aggregationData.{id}.postCount") && inv.paths!.includes("response.aggregationData.{secret}") && inv.paths!.includes("response.aggregationData.{?}") && (inv.unknownKeys ?? 0) > 0, inv.paths);
const marked = new Map((inv.sensitive ?? []).map((entry) => [entry.path, entry.category]));
check(
  "sensitive names marked by category",
  marked.get("response.account.email") === "email" && marked.get("response.account.{phone}") === "phone" && marked.get("response.account.settings.{twofa}") === "twofa" && marked.get("response.session") === "session" && marked.get("response.session.token") === "token" && !marked.has("response.account.username"),
  inv.sensitive,
);
check("not JSON", JSON.stringify(inspectBody(buf("<html>"), false, 1000)) === JSON.stringify({ inspected: true, json: false }));
check("over the size: not inspected", inspectBody(null, true, 1000).inspected === false);

// Bounds: a wide object, long keys, deep nesting, a large array.
const wide: Record<string, number> = {};
for (let i = 0; i < 10_000; i++) wide[`field${i}x`] = i;
const wideInv = inspectBody(buf({ response: wide }), false, 10_000_000);
check("a wide object stays bounded", (wideInv.paths?.length ?? 0) <= BOUNDS.paths && JSON.stringify(wideInv).length < 200_000, { paths: wideInv.paths?.length, bytes: JSON.stringify(wideInv).length, truncated: wideInv.truncated });
const vetted: Record<string, unknown> = {};
let cursor = vetted;
for (let i = 0; i < 40; i++) cursor = (cursor.response = {}) as Record<string, unknown>;
check("depth and path length are bounded", inspectBody(buf(vetted), false, 1_000_000).truncated === true);
const longKeys: Record<string, number> = {};
for (let i = 0; i < 2000; i++) longKeys[`${"k".repeat(5000)}${i}`] = i;
const longInv = inspectBody(buf(longKeys), false, 20_000_000);
check("long unknown keys do not grow the output", JSON.stringify(longInv).length < 10_000, { bytes: JSON.stringify(longInv).length });
const big = { response: Array.from({ length: 300_000 }, (_, i) => ({ id: String(i), username: "u", createdAt: i })) };
const started = performance.now();
const bigInv = inspectBody(buf(big), false, 64_000_000);
const ms = performance.now() - started;
check("a large array is sampled: its shape, quickly, bounded", (bigInv.sampledArrays ?? 0) === 1 && ["response[].id", "response[].username", "response[].createdAt"].every((path) => bigInv.paths!.includes(path)) && ms < 2000 && JSON.stringify(bigInv).length < 10_000, { ms: Math.round(ms), sampled: bigInv.sampledArrays, paths: bigInv.paths });
const many = { response: Array.from({ length: 150 }, () => Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}x`, { data: { content: i } }]))) };
const manyInv = inspectBody(buf(many), false, 64_000_000);
check("the node bound holds on wide items", manyInv.truncated === true && JSON.stringify(manyInv).length < 10_000, { truncated: manyInv.truncated, bytes: JSON.stringify(manyInv).length });
process.exit(failures.length === 0 ? 0 : 1);
