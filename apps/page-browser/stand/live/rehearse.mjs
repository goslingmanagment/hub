// The pilot's engine against the stand: the runbook's stop and restart before
// the login, with the check Astra's seventh review asked for — after the
// restart the site's requests really complete, not only "the page is ready".
// Run in the stand's runner container next to a live engine started with
// LIVE_REHEARSAL=1:
//   node /pb/stand/live/rehearse.mjs
// Exit 0 = every step held.

import { readdirSync, readFileSync } from "node:fs";

const CONTROL = "http://127.0.0.1:7801";
const SITE = "https://site.stand.test/?auto=1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, method = "GET", body) {
  // A request the engine never answers is a failed step, not a hang.
  try {
    const response = await fetch(`${CONTROL}${path}`, { method, signal: AbortSignal.timeout(60_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return await response.json();
  } catch (error) {
    return { error: String(error) };
  }
}

function journal() {
  const file = readdirSync("/stand/results")
    .filter((name) => name.startsWith("live-") && name.endsWith(".jsonl"))
    .sort()
    .at(-1);
  return readFileSync(`/stand/results/${file}`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Site requests answered by the server since `mono`. */
const answered = (since) => journal().filter((entry) => entry.event === "site.done" && entry.outcome === "response" && entry.mono >= since).length;
const now = () => journal().at(-1)?.mono ?? 0;

async function until(what, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`);
    await sleep(250);
  }
}

const steps = [];
function step(name, ok, detail) {
  steps.push({ name, ok, ...detail });
  console.log(JSON.stringify({ step: name, ok, ...detail }));
}

await until("the page ready", async () => (await call("/status")).state === "ready", 120_000);
await call("/command", "POST", { name: "test.navigate", url: SITE });
let mark = now();
await sleep(14_000);
const before = answered(mark);
step("requests complete before the stop", before >= 3, { answered: before });

await call("/stop", "POST");
await until("the page stopped", async () => (await call("/status")).exit === "closed", 15_000);
mark = now();
await sleep(6_000);
const whileStopped = answered(mark);
step("nothing completes while stopped", whileStopped === 0, { answered: whileStopped, status: await call("/status") });

const restart = await call("/command", "POST", { name: "restart" });
await until("the page ready again", async () => (await call("/status")).state === "ready", 120_000);
await call("/command", "POST", { name: "test.navigate", url: SITE });
mark = now();
await sleep(16_000);
const after = answered(mark);
const entries = journal().filter((entry) => entry.mono >= mark);
step("requests complete after the restart", restart.ok === true && after >= 3, {
  answered: after,
  newBrowserSeen: journal().some((entry) => entry.event === "browser.new"),
  refusedAfter: entries.filter((entry) => entry.event === "refused").length,
});

const hub = await call("/hub", "POST", { path: "/api/hub" });
step("a Hub request completes after the restart", hub.outcome === "response" && hub.status === 200, { outcome: hub.outcome ?? null, status: hub.status ?? null });

process.exit(steps.every((entry) => entry.ok) ? 0 : 1);
