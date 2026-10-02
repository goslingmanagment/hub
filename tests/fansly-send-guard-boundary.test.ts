import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Plan §2.4/§2.5 «все отправители страницы под охраной»: after the send guard's
// second step no code path reaches apiv3.fansly.com, wsv3.fansly.com or
// cdn*.fansly.com through a page's egress without a capture of the page's send
// guard. The compiler forces each sender's callers to hand it a guard (the
// parameters are mandatory); this pins the senders themselves and the ways to
// a page's egress, so a new one cannot appear unnoticed. Sanctioned call sites
// are listed with their reason; a change here is a review of the boundary.

const ROOT = join(__dirname, "..");
const SCANNED = ["apps/runtime/src", "packages", "scripts"];

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mts|mjs|js)$/.test(entry)) files.push(relative(ROOT, path));
    }
  };
  for (const directory of SCANNED) walk(join(ROOT, directory));
  return files.sort();
}

const files = sourceFiles();
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const matching = (pattern: RegExp) => files.filter((file) => pattern.test(read(file))).sort();

/** Every file that names a Fansly origin, and why that is no unguarded send. */
const SANCTIONED_FANSLY_ORIGIN_FILES: Record<string, string> = {
  "apps/runtime/src/services/egress/fansly-binding-preflight.ts": "the binding preflight: one request under the page's guard",
  "apps/runtime/src/services/egress/fansly-probe-socket.ts": "the W0 probe handshake: under a lease of the page's guard",
  "apps/runtime/src/services/egress/fansly-receiver-socket.ts": "the B0 receiver handshake: under a lease of the page's guard",
  "apps/runtime/src/services/egress/media-download.ts": "the CDN host allowlist; a Fansly hop is captured per hop",
  "apps/runtime/src/services/sync/fansly-cdn-tokens.ts": "comments only: reads signed CDN URLs, sends nothing",
  "packages/contracts/src/generate.ts": "the base URL default of the generated docs, sends nothing",
  "packages/contracts/src/routes.ts": "validates avatar URLs the API returns, sends nothing",
  "packages/shared/src/config-registry.ts": "the base URL setting of the adapter (which sends under the guard)",
  "packages/shared/src/config.ts": "the base URL setting of the adapter (which sends under the guard)",
  "scripts/fansly-ws/diagnostic.ts": "compares a recorded URL, sends nothing",
};

describe("the Fansly send-guard boundary (plan §2.5)", () => {
  it("names a Fansly origin only in the sanctioned files", () => {
    const origins = /(apiv3|wsv3)\.fansly\.com|cdn[0-9a-z<>N-]*\.fansly\.com|fansly\\\.com/;
    expect(matching(origins)).toEqual(Object.keys(SANCTIONED_FANSLY_ORIGIN_FILES).sort());
  });

  it("opens a WebSocket only in the two socket helpers, each on a lease of the page's guard", () => {
    const sockets = matching(/new WebSocket\(/);
    expect(sockets).toEqual([
      "apps/runtime/src/services/egress/fansly-probe-socket.ts",
      "apps/runtime/src/services/egress/fansly-receiver-socket.ts",
    ]);
    for (const file of sockets) {
      const text = read(file);
      expect(text, file).toMatch(/lease: FanslySendLease/);
      expect(text, file).toContain("bindFanslyUpgradeLease(lease, ");
    }
  });

  it("dispatches every Fansly HTTP request through the lease of its capture", () => {
    // The adapter: every attempt, every sender of senders.md #1–#5, #8–#15.
    const adapter = read("packages/fansly/src/adapter.ts");
    expect(adapter.match(/\bfetch\(/g)).toHaveLength(1);
    expect(adapter).toContain("dispatcher: lease.bind(this.getDispatcher(context.proxy)),");
    expect(adapter.match(/this\.getDispatcher\(/g)).toHaveLength(1);
    // The binding preflight (#16).
    const preflight = read("apps/runtime/src/services/egress/fansly-binding-preflight.ts");
    expect(preflight.match(/\bfetch\(/g)).toHaveLength(1);
    expect(preflight).toContain("dispatcher: lease.bind(dispatcher)");
    expect(preflight).toMatch(/sendGuard: FanslySendGuard;/);
    // The CDN download (#6): a capture per Fansly hop, never direct.
    const media = read("apps/runtime/src/services/egress/media-download.ts");
    expect(media).toContain("const guarded = isFanslyHost(current.hostname);");
    expect(media).toContain("if (guarded && (!input.fanslySendGuard || !input.dispatcher))");
    expect(media).toContain("lease.bind(input.dispatcher)");
    expect(media).toContain("fanslySendGuard: FanslySendGuard | null;");
  });

  it("hands a page's egress only to the sanctioned senders", () => {
    // resolveEgress({ kind: "page" }) is the only way to a page's proxy.
    expect(matching(/resolveEgress\([^)]*kind: "page"/)).toEqual([
      "apps/runtime/src/services/ai-media-describe/worker.ts",
      "apps/runtime/src/services/egress/fansly-probe-context.ts",
      // The Sync Engine's live page transport: built only by the engine's live
      // loop, which no build runs before the switch (LIVE_LOOP_ENABLED = false,
      // I17); its admissions need the guard row handed to the engine, and its
      // send check is the engine pacer's (tests/sync-live-gate.integration.test.ts).
      "apps/runtime/src/sync/fansly/transport.ts",
    ]);
    // The probe context (session + page egress) and who opens it.
    expect(matching(/\b(readProbeSnapshot|resolveFanslyProbeContext)\(/)).toEqual([
      "apps/runtime/src/services/egress/fansly-probe-context.ts",
      "apps/runtime/src/services/fansly-ws-policy-repair.ts",
      "apps/runtime/src/services/fansly-ws/worker.ts",
      "scripts/fansly-ws/binding-preflight.ts",
      "scripts/fansly-ws/continuity-runtime.ts",
      "scripts/fansly-ws/probe.ts",
      // The Sync Engine's socket of a live page (step-3 design §3.3): built
      // only by the host's live loop (LIVE_LOOP_ENABLED = false until S3-05),
      // its Upgrade admitted by the engine's pacer on an engine lease.
      "apps/runtime/src/sync/fansly/ws/source.ts",
    ].sort());
  });

  it("admits the engine socket's Upgrade on a lease over the pacer's check, through the receiver socket helper", () => {
    const source = read("apps/runtime/src/sync/fansly/ws/source.ts");
    expect(source).toContain("const lease = createEngineUpgradeLease(hooks, { pageId });");
    expect(source).toContain("bind: (dispatcher) => composeFanslySendCheck(dispatcher, gate.check),");
    expect(source).toContain("const gate = createOneShotSendCheck(hooks.check);");
    expect(source).toContain("const opener = this.#d.openSocket ?? openFanslyReceiverSocket;");
    expect(source).toContain("open: () => opener(egress, lease),");
    // The opener is replaced only through the host's test-only option, which
    // the runtime never passes (tests/sync-live-gate.integration.test.ts).
    expect(read("apps/runtime/src/sync/main.ts")).not.toContain("wsSourceOverrides");
  });

  it("gives each sender outside the adapter the guard of its page with its own source", () => {
    const expectations: Array<[string, string]> = [
      ["apps/runtime/src/services/ai-media-describe/worker.ts", 'fanslyPageSendGuard(app, input.pageId, "media_download")'],
      ["apps/runtime/src/services/fansly-ws/worker.ts", 'fanslyPageSendGuard(app, pageId, "ws_connect")'],
      ["apps/runtime/src/services/fansly-ws-policy-repair.ts", 'fanslyPageSendGuard(app, context.pageId, "binding_preflight")'],
      ["scripts/fansly-ws/binding-preflight.ts", 'source: "binding_preflight"'],
      ["scripts/fansly-ws/probe.ts", 'source: "ws_probe"'],
      ["scripts/fansly-ws/continuity-runtime.ts", 'source: "ws_probe"'],
    ];
    for (const [file, guard] of expectations) {
      expect(read(file), file).toContain(guard);
    }
    // The W0 scripts read through a READ ONLY pool; the guard writes through a
    // connection of its own.
    expect(read("scripts/fansly-ws/send-guard.ts")).not.toContain("default_transaction_read_only");
  });
});
