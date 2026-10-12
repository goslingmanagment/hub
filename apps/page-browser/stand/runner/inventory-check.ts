// The operator's in-memory inventory of an answer (src/operator/inventory.ts)
// against fixed answers: key names only, ids and data-like keys replaced,
// sensitive names marked, values never in the result.
//   node --no-warnings stand/runner/inventory-check.ts      exit 0 = all hold

import { inspectBody } from "../../src/operator/inventory.ts";

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(JSON.stringify({ check: name, ok, ...(detail === undefined ? {} : { detail }) }));
  if (!ok) failures.push(name);
}
const buf = (value: unknown) => [Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8")];

const SECRET_VALUES = ["owner@example.test", "tok-very-secret-value", "+491701234567"];
const answer = {
  success: true,
  response: {
    account: { id: "723606174951284736", username: "someone", email: SECRET_VALUES[0], phoneNumber: SECRET_VALUES[2], settings: { twofaEnabled: false } },
    accounts: [{ id: "1", username: "a", avatar: { locations: [{ location: "https://cdn3.example/x?Signature=abc", metadata: { "Key-Pair-Id": "k" } }] } }],
    aggregationData: { "723606174951284736": { postCount: 3 }, "owner@example.test": { x: 1 }, abcdefghijklmnopqrstuvwxyz0123: { y: 2 } },
    session: { token: SECRET_VALUES[1] },
  },
};
const inv = inspectBody(buf(answer), false, 1_000_000);
const text = JSON.stringify(inv);
check("inspected JSON", inv.inspected === true && inv.json === true && inv.success === true);
check("no value in the result", SECRET_VALUES.every((value) => !text.includes(value)) && !text.includes("723606174951284736") && !text.includes("Signature"), inv.paths);
check("nested and array paths", ["response.account.username", "response.accounts[].avatar.locations[].location", "response.accounts[].avatar.locations[].metadata.Key-Pair-Id"].every((path) => inv.paths!.includes(path)));
check("id and data-like keys replaced", inv.paths!.includes("response.aggregationData.{id}.postCount") && inv.paths!.includes("response.aggregationData.{key}.x") && inv.paths!.includes("response.aggregationData.{key}.y"));
check(
  "sensitive names marked",
  ["response.account.email", "response.account.phoneNumber", "response.account.settings.twofaEnabled", "response.session", "response.session.token"].every((path) => inv.sensitive!.includes(path)) && !inv.sensitive!.includes("response.account.username"),
  inv.sensitive,
);
check("not JSON", JSON.stringify(inspectBody(buf("<html>"), false, 1000)) === JSON.stringify({ inspected: true, json: false }));
check("over the size: not inspected", inspectBody(null, true, 1000).inspected === false);
const deep: Record<string, unknown> = {};
let node = deep;
for (let i = 0; i < 40; i++) node = (node.n = {}) as Record<string, unknown>;
check("depth is bounded", inspectBody(buf(deep), false, 1_000_000).truncated === true);
process.exit(failures.length === 0 ? 0 : 1);
