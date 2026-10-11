// The pilot's engine against the stand: the runbook's stop and restart before
// the login, with the check Astra's seventh review asked for — after the
// restart the site's requests really complete, not only "the page is ready".
// Run in the stand's runner container next to a live engine started with
// LIVE_REHEARSAL=1:
//   node /pb/stand/live/rehearse.mjs
// Exit 0 = every step held.

import { readdirSync, readFileSync } from "node:fs";

import { Docker } from "../runner/infra.ts";

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

// Chrome dies. The operator would start another one by itself; the pilot's
// engine stops the session at the loss, and only the owner's restart brings
// the page back — with a new Chrome whose requests carry old numbers.
const browsers = () => journal().filter((entry) => entry.event === "browser.new").length;
await new Docker(process.env.STAND_BROWSER_CONTAINER ?? "pb-stand-browser-1").signal("chrome", "KILL");
await until("the session stopped", async () => (await call("/status")).stopped != null, 15_000);
mark = now();
await sleep(6_000);
let status = await call("/status");
step("Chrome died: the session stops and nothing completes", String(status.stopped).startsWith("CDP lost") && status.exit === "closed" && answered(mark) === 0, { stopped: status.stopped, exit: status.exit, answered: answered(mark) });

async function restartAndCount(name) {
  const browsersBefore = browsers();
  const restart = await call("/command", "POST", { name: "restart" });
  await until("the page ready again", async () => (await call("/status")).state === "ready", 120_000);
  await call("/command", "POST", { name: "test.navigate", url: SITE });
  const since = now();
  await sleep(16_000);
  const after = answered(since);
  const entries = journal().filter((entry) => entry.mono >= since);
  step(name, restart.ok === true && after >= 3, { answered: after, newBrowserSeen: browsers() > browsersBefore, refusedAfter: entries.filter((entry) => entry.event === "refused").length });
}

await restartAndCount("requests complete after the restart that follows a dead Chrome");

await call("/stop", "POST");
await until("the page stopped", async () => (await call("/status")).exit === "closed", 15_000);
mark = now();
await sleep(6_000);
status = await call("/status");
step("the owner's stop: nothing completes", answered(mark) === 0 && status.stopped === "owner", { answered: answered(mark), stopped: status.stopped });

await restartAndCount("requests complete after the owner's restart");

const hub = await call("/hub", "POST", { path: "/api/hub" });
step("a Hub request completes after the restart", hub.outcome === "response" && hub.status === 200, { outcome: hub.outcome ?? null, status: hub.status ?? null });

process.exit(steps.every((entry) => entry.ok) ? 0 : 1);
