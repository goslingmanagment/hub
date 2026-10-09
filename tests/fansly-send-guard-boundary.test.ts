import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Plan §2.4 «все отправители страницы»: no code path reaches apiv3.fansly.com,
// wsv3.fansly.com or cdn*.fansly.com through a page's egress except the Sync
// Engine's, each request under an admission of the page's pacer. The legacy
// senders that rode the page's send guard (§2.5) — the adapter, the probes,
// the alias backfill, the describer's guarded CDN hop — are deleted (step 4,
// S4-20), and no runtime code asks for a page's guard any more. This pins the
// senders that are left and the ways to a page's egress, so a new one cannot
// appear unnoticed. Sanctioned call sites are listed with their reason; a
// change here is a review of the boundary.

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
  "apps/runtime/src/services/egress/fansly-public.ts": "the public egress's one allowed host: every other origin is refused before a connection",
  "apps/runtime/src/services/egress/fansly-receiver-socket.ts": "the page socket's handshake: under the engine's Upgrade lease",
  "apps/runtime/src/services/egress/media-download.ts": "the CDN host allowlist; the describer's download refuses a Fansly host",
  "apps/runtime/src/sync/fansly/lib/cdn-tokens.ts": "comments only: reads signed CDN URLs, sends nothing",
  "packages/contracts/src/generate.ts": "the base URL default of the generated docs, sends nothing",
  "packages/contracts/src/routes.ts": "validates avatar URLs the API returns, sends nothing",
  "packages/shared/src/config-registry.ts": "the base URL setting of the wire layer (sent by the engine's transport)",
  "packages/shared/src/config.ts": "the base URL setting of the wire layer (sent by the engine's transport)",
};

describe("the Fansly send boundary (plan §2.4)", () => {
  it("names a Fansly origin only in the sanctioned files", () => {
    const origins = /(apiv3|wsv3)\.fansly\.com|cdn[0-9a-z<>N-]*\.fansly\.com|fansly\\\.com/;
    expect(matching(origins)).toEqual(Object.keys(SANCTIONED_FANSLY_ORIGIN_FILES).sort());
  });

  it("opens a WebSocket only in the socket helper, its Upgrade on a send lease", () => {
    const sockets = matching(/new WebSocket\(/);
    expect(sockets).toEqual([
      "apps/runtime/src/services/egress/fansly-receiver-socket.ts",
    ]);
    for (const file of sockets) {
      const text = read(file);
      expect(text, file).toMatch(/lease: FanslySendLease/);
      expect(text, file).toContain("bindFanslyUpgradeLease(lease, ");
    }
  });

  it("sends a Fansly HTTP request only through the wire layer's single-request send, under its check", () => {
    // The Fansly package holds one physical send, and it composes the caller's
    // send check onto the dispatcher for that request only.
    expect(files.filter((file) => file.startsWith("packages/fansly/"))).not.toContain("packages/fansly/src/adapter.ts");
    expect(matching(/\bfetch\(/).filter((file) => file.startsWith("packages/fansly/"))).toEqual([]);
    const send = read("packages/fansly/src/wire/send.ts");
    expect(send.match(/\.request\(/g)).toHaveLength(1);
    expect(send).toContain("const response = await composeFanslySendCheck(dispatcher, gate.check).request({");
    // Its callers: the engine's page transport (the pacer's admission) and the
    // identity check of a session without a page (journaled, owner decision №4).
    // The third sanctioned sender, the session-less public account reader
    // (arena R5, `sync/fansly/public-lookup.ts`), lands with the next release;
    // until then nothing sends a session-less request.
    expect(matching(/\b(sendFanslyWireRequest|sendFanslyCdnRequest)\(/)).toEqual([
      "apps/runtime/src/sync/fansly/identity-without-page.ts",
      "apps/runtime/src/sync/fansly/transport.ts",
      "packages/fansly/src/wire/send.ts",
    ]);
    // The describer's CDN download: a Fansly host is refused before any hop.
    const media = read("apps/runtime/src/services/egress/media-download.ts");
    expect(media).toContain("if (isFanslyHost(current.hostname)) {");
    expect(media).not.toMatch(/SendGuard|SendLease|\.acquire\(/);
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

  it("builds a session-less request in the wire layer alone, and hands the public egress to nobody yet", () => {
    // Arena R5 (plan §7): a request without any session is built only by
    // `buildFanslyPublicWireRequest` (wire/public.ts), which refuses a
    // session-bearing spec and an input with a session or cookies; the page's
    // builder refuses a session-less spec. Its one sanctioned caller, the
    // public reader, lands with the next release.
    expect(matching(/\bbuildFanslyPublicWireRequest\(/)).toEqual([]);
    const publicWire = read("packages/fansly/src/wire/public.ts");
    expect(publicWire).toContain('if (candidate.credentials !== "none") {');
    expect(publicWire).toContain("headers: buildFanslyAnonymousRequestHeaders(),");
    expect(publicWire).not.toMatch(/buildFanslyRequestHeaders\(|FanslySessionBundle/);
    expect(read("packages/fansly/src/wire/specs.ts")).toContain('if (spec?.credentials !== "session") {');
    // The `fansly_public` scope: resolved only by the resolver, used by no
    // caller in this release; it lets Fansly's API host through and nothing else.
    expect(matching(/resolveEgress\([^)]*kind: "fansly_public"/)).toEqual([]);
    expect(matching(/\bresolveFanslyPublicEgress\(/)).toEqual([
      "apps/runtime/src/services/egress/fansly-public.ts",
      "apps/runtime/src/services/egress/resolver.ts",
    ]);
    const egress = read("apps/runtime/src/services/egress/fansly-public.ts");
    expect(egress).toContain('export const FANSLY_PUBLIC_API_HOST = "apiv3.fansly.com";');
    expect(egress).toContain("dispatcher: restrictToFanslyPublicHost(base),");
  });

  it("asks for a page's legacy send guard nowhere: no runtime code captures a guard row", () => {
    // `FanslySendGuardRegistry.forPage` and its capture stay only as the
    // legacy sender of the switch and rollback suites (they go with that code).
    expect(matching(/\.forPage\(|fanslyPageSendGuard\b|\.withoutPage\(/)).toEqual([]);
    expect(matching(/\bcaptureFanslyPageSendGuard\(/)).toEqual([
      "apps/runtime/src/services/fansly-send-guard/index.ts",
      "packages/db/src/repositories/fansly-send-guard.ts",
    ]);
  });
});
