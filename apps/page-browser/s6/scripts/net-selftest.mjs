// The kernel check of the page container's egress rules (plan §4.1, step 5;
// stage 3, PR 2). Run once by s6 after init-net, as root: it connects as
// pb-chrome and as pb-operator to what each may and may not reach. A
// forbidden destination must be refused by the kernel itself, at once —
// init-net's reject: EHOSTUNREACH for TCP, EPERM for UDP — not time out
// somewhere on the network; a permitted one must not be refused. The result
// goes to /run/pb/net-selftest.json (the image's health check and the
// operator's self-check read it); any miss stops the container.
//
//   node net-selftest.mjs                 the check (root)
//   node net-selftest.mjs --probe <json>  one user's probes (spawned by it)

import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";

const PROBE_TIMEOUT_MS = 2_000;
const KERNEL_REFUSALS = new Set(["EPERM", "EHOSTUNREACH"]);
/** The kernel answers within milliseconds; a refusal later than this came
 *  from the network. */
const KERNEL_REFUSAL_MS = 500;

/** One connection attempt: "connected", an error code, or "timeout", and
 *  how long it took. */
function probe({ proto, host, port }) {
  const started = performance.now();
  return new Promise((resolve) => {
    const finish = (got) => resolve({ got, ms: Math.round(performance.now() - started) });
    if (proto === "udp") {
      const socket = dgram.createSocket("udp4");
      socket.send(Buffer.from("pb"), port, host, (error) => {
        socket.close();
        finish(error ? (error.code ?? error.message) : "sent");
      });
      return;
    }
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      finish(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done("timeout"));
    socket.on("connect", () => done("connected"));
    socket.on("error", (error) => done(error.code ?? error.message));
  });
}

if (process.argv[2] === "--probe") {
  const targets = JSON.parse(process.argv[3]);
  const results = await Promise.all(targets.map(probe));
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
}

const users = { "pb-chrome": 1001, "pb-operator": 1002 };
const socksIp = readFileSync("/run/pb/socks-ip", "utf8").trim();
const socksPort = Number(readFileSync("/run/pb/socks-port", "utf8").trim());

// expect: "refused" — the kernel's refusal; "permitted" — anything else
// (nobody listens yet: connection refused, or a timeout on the network).
const checks = [
  { user: "pb-chrome", proto: "tcp", host: "127.0.0.1", port: 3128, expect: "permitted", what: "the operator's proxy" },
  { user: "pb-chrome", proto: "tcp", host: "1.1.1.1", port: 443, expect: "refused", what: "the internet" },
  { user: "pb-chrome", proto: "tcp", host: socksIp, port: socksPort, expect: "refused", what: "the page's SOCKS5" },
  { user: "pb-chrome", proto: "tcp", host: "127.0.0.1", port: 9222, expect: "refused", what: "CDP" },
  { user: "pb-chrome", proto: "tcp", host: "127.0.0.1", port: 7700, expect: "refused", what: "the operator's RPC" },
  { user: "pb-chrome", proto: "tcp", host: "127.0.0.1", port: 6901, expect: "refused", what: "the screen" },
  { user: "pb-chrome", proto: "udp", host: "1.1.1.1", port: 53, expect: "refused", what: "DNS" },
  { user: "pb-chrome", proto: "udp", host: "127.0.0.11", port: 53, expect: "refused", what: "Docker's DNS" },
  { user: "pb-operator", proto: "tcp", host: socksIp, port: socksPort, expect: "permitted", what: "the page's SOCKS5" },
  { user: "pb-operator", proto: "tcp", host: "127.0.0.1", port: 9222, expect: "permitted", what: "CDP" },
  { user: "pb-operator", proto: "tcp", host: "1.1.1.1", port: 443, expect: "refused", what: "the internet" },
  { user: "pb-operator", proto: "tcp", host: socksIp, port: socksPort === 443 ? 444 : 443, expect: "refused", what: "another port of the SOCKS5 host" },
  { user: "pb-operator", proto: "udp", host: "1.1.1.1", port: 53, expect: "refused", what: "DNS" },
  { user: "pb-operator", proto: "udp", host: "127.0.0.11", port: 53, expect: "refused", what: "Docker's DNS" },
];

function runAs(user, targets) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", process.argv[1], "--probe", JSON.stringify(targets)], {
      uid: users[user],
      gid: users[user],
      env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      try {
        if (code !== 0) throw new Error(`exit ${code}`);
        resolve(JSON.parse(out));
      } catch (error) {
        reject(new Error(`the probes of ${user} failed: ${error.message}`));
      }
    });
  });
}

const results = [];
for (const user of Object.keys(users)) {
  const mine = checks.filter((check) => check.user === user);
  const outcomes = await runAs(user, mine);
  mine.forEach((check, index) => {
    const { got, ms } = outcomes[index];
    const refused = KERNEL_REFUSALS.has(got) && ms <= KERNEL_REFUSAL_MS;
    const pass = check.expect === "refused" ? refused : !KERNEL_REFUSALS.has(got);
    results.push({ ...check, got, ms, pass });
  });
}
const ok = results.every((result) => result.pass);
writeFileSync("/run/pb/net-selftest.json", `${JSON.stringify({ ok, at: new Date().toISOString(), results })}\n`, { mode: 0o644 });
for (const result of results) {
  const line = `net-selftest: ${result.pass ? "ok  " : "FAIL"} ${result.user} ${result.proto} ${result.what} → ${result.got} in ${result.ms} ms (expected ${result.expect})`;
  (result.pass ? console.log : console.error)(line);
}
process.exit(ok ? 0 : 1);
