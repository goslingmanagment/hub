#!/usr/bin/env node
// Static finite-path inventory; no app bootstrap, DB access, fetch or vendor probes.
// node --import tsx/esm scripts/audit-ofapi-coverage.mjs SOURCE_REPO ORIGINAL_MATRIX_JSON OUTPUT_DIR
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const [repo, input, output] = process.argv.slice(2);
if (!repo || !input || !output)
  throw new Error(
    "Pass source repo, original endpoint-matrix.json and output directory",
  );
const require = createRequire(path.join(repo, "package.json")),
  ts = require("typescript");
const original = JSON.parse(fs.readFileSync(input, "utf8"));
if (original.length !== 294 || new Set(original.map(row => `${row.method} ${row.path}`)).size !== 294)
  throw new Error("Expected the frozen 294-operation audit");
const trackedFiles = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).split("\0"));
const read = (f) => fs.readFileSync(path.join(repo, f), "utf8");
const has = (f) => trackedFiles.has(f) && fs.existsSync(path.join(repo, f));
const locate = (file, needle) => {
  const source = read(file), offset = source.indexOf(needle);
  if (offset < 0) throw new Error(`Evidence anchor missing: ${file} ${needle}`);
  return `${file}:${source.slice(0, offset).split("\n").length}`;
};
const norm = (p) =>
  p
    .split("?")[0]
    .replace(/^\/api(?=\/|$)/, "")
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/:[a-z]+/g, "{}");
const key = (method, p) => `${method} ${norm(p)}`;
const signatures = [];
function add(
  method,
  p,
  evidence,
  coverage,
  queries = [],
  consumer = null,
  regression = null,
) {
  if (!method || !p?.startsWith("/")) return;
  for (const value of p.includes("{kind}")
    ? ["subscribers", "spenders"].map((k) => p.replace("{kind}", k))
    : [p])
    signatures.push({
      method,
      path: value,
      key: key(method, value),
      evidence,
      coverage,
      queries,
      consumer,
      regression,
    });
}
function literals(n) {
  if (!n) return [];
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    return [n.text];
  if (ts.isConditionalExpression(n))
    return [...literals(n.whenTrue), ...literals(n.whenFalse)];
  if (ts.isTemplateExpression(n))
    return n.templateSpans.reduce(
      (a, s) =>
        a.flatMap((prefix) =>
          (literals(s.expression).length
            ? literals(s.expression)
            : [`{${s.expression.getText().replace(/[{}]/g, "_")}}`]
          ).map((v) => prefix + v + s.literal.text),
        ),
      [n.head.text],
    );
  return [];
}
function props(n) {
  return n && ts.isObjectLiteralExpression(n)
    ? Object.fromEntries(
        n.properties
          .filter(
            (p) =>
              ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p),
          )
          .map((p) => [
            p.name.getText().replace(/^['"]|['"]$/g, ""),
            ts.isPropertyAssignment(p) ? p.initializer : p.name,
          ]),
      )
    : {};
}
function owner(n) {
  for (let p = n.parent; p; p = p.parent)
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name)
      return p.name.getText();
  return "";
}
const staticFiles = [
  "ofapi.ts",
  "ofapi-capture-jobs.ts",
  "ofapi-export-quotes.ts",
  "ofapi-media-uploads.ts",
].map((f) => "apps/runtime/src/services/" + f);
for (const file of staticFiles.filter(has)) {
  const sf = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const evidence = (n) =>
    `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const walk = (n) => {
    if (
      ts.isCallExpression(n) &&
      ["request", "requestCaptured"].includes(n.expression.getText())
    )
      for (const method of literals(n.arguments[1]))
        for (const p of literals(n.arguments[2]))
          add(method, p, evidence(n), "typed_transport");
    if (ts.isPropertyAssignment(n) && n.name.getText() === "pathname") {
      const p = props(n.parent),
        methods = literals(p.method);
      for (const method of methods.length ? methods : ["GET"])
        for (const pathname of literals(n.initializer))
          add(
            method,
            pathname,
            evidence(n),
            file.includes("media-upload")
              ? "upload_job"
              : "capture_or_typed_read",
            Object.keys(props(p.query)),
          );
    }
    if (ts.isVariableDeclaration(n) && n.name.getText() === "pathname") {
      const method = {
        sendMessageRequest: "POST",
        startTypingRequest: "POST",
        unsendMessageRequest: "DELETE",
        markChatReadRequest: "POST",
      }[owner(n)];
      for (const pathname of literals(n.initializer))
        add(method, pathname, evidence(n), "command_outbox");
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
}
const catalogFile = "packages/shared/src/ofapi-read-catalog.ts";
const catalogModule = await import(pathToFileURL(path.join(repo, catalogFile)));
const { OFAPI_READ_CATALOG: catalog } = catalogModule;
function pureFunction(file, name) {
  const sf = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = sf.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  if (!declaration) throw new Error("Missing pure function " + name);
  const ctx = { exports: {}, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(
    ts.transpileModule(declaration.getText(sf), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    ctx,
    { timeout: 1000 },
  );
  return ctx.exports[name];
}
function catalogEvidence(def) {
  const sf = ts.createSourceFile(catalogFile, read(catalogFile), ts.ScriptTarget.Latest, true);
  const pattern = (node) => {
    if (!node) return null;
    const quote = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (ts.isStringLiteral(node)) return new RegExp(`^${quote(node.text)}$`);
    if (ts.isTemplateExpression(node)) return new RegExp("^" + quote(node.head.text) + node.templateSpans.map(span => "[^/]+" + quote(span.literal.text)).join("") + "$");
    return null;
  };
  const matches = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ["read", "smartRead"].includes(node.expression.getText()) && pattern(node.arguments[0])?.test(def.id) && pattern(node.arguments[1])?.test(def.path))
      matches.push({ evidence: `${catalogFile}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`, specificity: ts.isStringLiteral(node.arguments[0]) ? 1000 + node.arguments[0].text.length : node.arguments[0].head.text.length + node.arguments[0].templateSpans.reduce((sum, span) => sum + span.literal.text.length, 0) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const maximum = Math.max(...matches.map(match => match.specificity));
  const selected = matches.filter(match => match.specificity === maximum);
  if (selected.length !== 1) throw new Error(`Catalog evidence must be unique: ${def.id}: ${JSON.stringify(selected)}`);
  return selected[0].evidence;
}
for (const def of catalog) {
  const global = def.scope === "smart_link";
  add(
    "GET",
    `/${global ? "" : "{account}/"}${def.path}`,
    catalogEvidence(def),
    "durable_read_catalog",
    Object.keys(def.query),
    global || def.category === "tracking_links"
      ? "apps/dashboard/src/pages/OfapiMarketing.tsx"
      : "apps/dashboard/src/pages/settings/OfapiStoredReads.tsx",
    global || def.category === "tracking_links"
      ? "tests/ofapi-smart-links.integration.test.ts"
      : "tests/ofapi-read-collections.integration.test.ts",
  );
  Object.assign(signatures.at(-1), {
    selection: def.id + (def.detail ? ":<id>" : ""),
    category: def.category,
  });
}
const commandFile = "apps/runtime/src/services/ofapi-command-composer.ts";
if (has(commandFile)) {
  const ofapiExtendedAction = pureFunction(commandFile, "ofapiExtendedAction");
  for (const kind of [
    "set_fan_custom_name_v1",
    "like_message_v1",
    "unlike_message_v1",
    "pin_message_v1",
    "unpin_message_v1",
    "mark_chat_unread_v1",
    "mute_chat_v1",
    "unmute_chat_v1",
    "hide_chat_v1",
  ]) {
    const action = ofapiExtendedAction(kind, "AUDIT_ACCOUNT", "AUDIT_CHAT", {
      messageId: "AUDIT_MESSAGE",
      customName: "audit",
    });
    add(
      action.method,
      action.path
        .replace("AUDIT_ACCOUNT", "{account}")
        .replace("AUDIT_CHAT", "{chat}")
        .replace("AUDIT_MESSAGE", "{message}"),
      locate(commandFile, "export function ofapiExtendedAction"),
      "closed_command",
      [],
      "Desktop PR27 persisted composer/actions",
      "tests/ofapi-command-composer.integration.test.ts",
    );
  }
}
const marketingFile = "apps/runtime/src/services/ofapi-smart-links.ts";
if (has(marketingFile)) {
  const ofapiMarketingRequest = pureFunction(
    marketingFile,
    "ofapiMarketingRequest",
  );
  for (const action of [
    "smart_link_create",
    "smart_link_delete",
    "tags_add",
    "tags_remove",
    "pixel_create",
    "pixel_update",
    "pixel_disconnect",
    "pixel_test",
    "postback_create",
    "postback_update",
    "postback_delete",
  ]) {
    const req = ofapiMarketingRequest(
      {
        action,
        pageId: 1,
        linkId: "AUDIT_LINK",
        pixelId: "AUDIT_PIXEL",
        postbackId: "AUDIT_POSTBACK",
      },
      "AUDIT_ACCOUNT",
    );
    add(
      req.method,
      req.path
        .replace("AUDIT_LINK", "{link}")
        .replace("AUDIT_PIXEL", "{pixel}")
        .replace("AUDIT_POSTBACK", "{postback}"),
      locate(marketingFile, "export function ofapiMarketingRequest"),
      "closed_marketing_command",
      [],
      "apps/dashboard/src/pages/OfapiMarketing.tsx",
      "tests/ofapi-smart-links.integration.test.ts",
    );
  }
  for (const p of ["/smart-link-postbacks", "/smart-link-postbacks/{id}"])
    add(
      "GET",
      p,
      locate(marketingFile, "pathname: `/smart-link-postbacks"),
      "encrypted_admin_read",
      [],
      "apps/dashboard/src/pages/OfapiMarketing.tsx",
      "tests/ofapi-smart-links.integration.test.ts",
    );
}
// Preserve legacy gateway-only exact routes by exercising its pure allowlist.
const gatewayFile = "apps/runtime/src/services/ofapi-read-gateway.ts";
const gatewaySource = read(gatewayFile),
  gatewayCtx = {
    exports: {},
    resolveOfapiCatalogPath: catalogModule.resolveOfapiCatalogPath,
  };
vm.createContext(gatewayCtx);
vm.runInContext(
  ts.transpileModule(
    "class BadRequestError extends Error {}\n" +
      gatewaySource.slice(
        gatewaySource.indexOf("type RawQuery ="),
        gatewaySource.indexOf("function authenticatedFromStatus"),
      ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText,
  gatewayCtx,
  { timeout: 1000 },
);
const resolveGateway = gatewayCtx.exports.resolveOfapiReadGatewayRequest;
for (const row of original.filter((o) => o.method === "GET")) {
  const sample = row.path
    .replace(/^\/api/, "")
    .replace("{account}", "acct_Audit1")
    .replace(/\{[^}]+\}/g, "123");
  try {
    const required = Object.fromEntries(
      (row.vendorQueryRequired ?? []).map((k) => [
        k,
        k === "ids"
          ? "123"
          : k === "query"
            ? "audit"
            : k.includes("Date")
              ? "2026-09-01"
              : k === "timezone"
                ? "UTC"
                : "audit",
      ]),
    );
    const resolved = resolveGateway(sample, required);
    const incidental =
      (resolved.operation === "ofapi_gateway_user" &&
        !row.path.endsWith("/users/{username}")) ||
      (resolved.operation === "ofapi_gateway_chat_message" &&
        !row.path.endsWith("/messages/{message_id}"));
    if (resolved.kind === "proxy" && !incidental)
      add(
        "GET",
        row.path,
        locate(gatewayFile, resolved.operation.startsWith("ofapi_read_") ? "try { catalog =" : ["ofapi_gateway_fans_all", "ofapi_gateway_fans_active"].includes(resolved.operation) ? "`ofapi_gateway_fans_" : `"${resolved.operation}"`),
        "gateway_read",
        [],
        "Desktop generated SDK read gateway",
        "tests/ofapi-read-gateway.test.ts",
      );
  } catch (error) {
    if (error.message?.startsWith("Evidence anchor missing:")) throw error;
    /* Unsupported or required-query paths remain governed by explicit catalog proof. */
  }
}
function excluded(row) {
  const tags = row.tags.join("|"),
    p = row.path;
  if (p.endsWith("/fans/{fan_id}/notes"))
    return "OF-native notes were historically excluded; local append-only notes remain the selected workflow (S10).";
  if (p.endsWith("/messages/{queue_id}/attach-tags"))
    return "Post-send release-form tag replacement is separate from typed send attachments and requires a dedicated workflow (S6/S11).";
  if (p.endsWith("/chats/mark-as-read"))
    return "Only explicit single-chat read/unread commands selected; account-wide read-state mutation excluded (S6b).";
  if (row.method === "DELETE" && p.endsWith("/chats/{chat_id}"))
    return "Hide-chat selected; destructive chat deletion excluded from the user workflow (S6b).";
  if (p.includes("/media/download/"))
    return "Paid CDN/DRM binary import is a separate controlled optional workflow; owned-file uploads and vault metadata meet mandatory S7 acceptance.";
  if (["/api/{account}/queue", "/api/{account}/queue/counts"].includes(p))
    return "Generic publication-queue workflow belongs to optional S11b; the named S11a mass-message queue/history reads are implemented.";
  if (row.method === "DELETE" && p.startsWith("/api/webhooks/"))
    return "Webhook deletion is outside the named S3 inventory/history/redelivery and scoped registration update operations.";
  if (tags === "Endpoints")
    return "Provider-internal callbacks; not an outbound Hub operation (S12).";
  if (row.deprecated)
    return "Deprecated provider operation; current upload/download path used (S12).";
  if (/AI|Fans AI/.test(tags))
    return "Provider AI/custom categories duplicate Hub AI gateway; explicitly deferred (S12).";
  if (/Banking|Settings/.test(tags))
    return "Banking, tax/legal and platform settings changes are outside this coverage release (S12).";
  if (
    /Analytics|Chargebacks|Statistics|Account|Payouts|Public Profiles/.test(
      tags,
    )
  )
    return "Only the named S12 read snapshots and existing financial pipeline selected; adjacent aggregates/onboarding/withdrawal need a concrete consumer.";
  if (/Tracking|Trial|Promotions|Bundles|Link Tags/.test(tags))
    return "Legacy promotion/link creation or mutation is workflow-conditional and deferred after read/attribution (S9/S12).";
  if (/Saved For Later/.test(tags))
    return "Saved-for-later workflows and autosend explicitly deferred (S12).";
  if (/Connect OnlyFans|Client Sessions/.test(tags))
    return "Interactive credential/face/OTP lifecycle flow is owner-controlled; no autonomous connection workflow (S12).";
  if (/Release Forms/.test(tags))
    return "Only read/attach references selected; create/invite/rename/hide needs a separate participant workflow (S12).";
  if (
    row.method !== "GET" &&
    /Posts|Stories|Highlights|Mass Messaging|Queue|Post Comments|Post Labels/.test(
      tags,
    )
  )
    return "Publishing, campaign writes and moderation are optional S11b, excluded from this read release.";
  if (
    row.method !== "GET" &&
    /User List|Media Vault|Users|Notifications|Fans/.test(tags)
  )
    return "Unselected moderation/list/vault/subscription mutations are excluded; selected S6 commands are separately implemented.";
  return null;
}
function context(row, matched) {
  const p = row.path;
  if (matched.some((s) => s.consumer))
    return {
      consumer: [
        ...new Set(matched.map((s) => s.consumer).filter(Boolean)),
      ].join(" | "),
      regression: [
        ...new Set(matched.map((s) => s.regression).filter(Boolean)),
      ].join(" | "),
    };
  if (
    (/media\/(upload|uploads|vault)/.test(p) && row.method !== "GET") ||
    /uploads.*status/.test(p)
  )
    return {
      consumer: "apps/dashboard/src/pages/OfapiMediaPage.tsx",
      regression: "tests/ofapi-media-uploads.integration.test.ts",
    };
  if (p.includes("webhooks"))
    return {
      consumer: "Owner webhook inventory/history/redelivery controls",
      regression: "tests/ofapi-webhook-recovery.integration.test.ts",
    };
  if (p.includes("data-exports"))
    return {
      consumer: "Owner typed export quote/approve/status/download controls",
      regression: "tests/ofapi-typed-exports.integration.test.ts",
    };
  if (
    p.includes("usage/credits") ||
    p.includes("whoami") ||
    p === "/api/accounts"
  )
    return {
      consumer: "Owner collection credit/key/account diagnostics",
      regression: "tests/ofapi-vendor-usage.integration.test.ts",
    };
  if (p.includes("chargebacks"))
    return {
      consumer: "apps/runtime/src/services/ofapi-chargebacks-sync.ts",
      regression: "tests/ofapi-chargebacks-sync.integration.test.ts",
    };
  if (p.endsWith("/tracking-links") || p.endsWith("/trial-links"))
    return {
      consumer: "apps/runtime/src/services/ofapi-link-stats-sync.ts",
      regression: "tests/ofapi-link-stats-sync.integration.test.ts",
    };
  if (p.includes("banned-words"))
    return {
      consumer: "Desktop v2 composer banned-word preview",
      regression: "tests/ofapi-command-composer.integration.test.ts",
    };
  if (row.method !== "GET")
    return {
      consumer: "Desktop durable one-attempt outbox",
      regression: "tests/ofapi-command-outbox.integration.test.ts",
    };
  return {
    consumer: "Existing Hub sync/capture projections and Desktop SDK",
    regression:
      "tests/ofapi-audience-sync.integration.test.ts | tests/ofapi-capture-repository.integration.test.ts",
  };
}
function materialEvidence(row, matched) {
  if (matched.some((s) => s.coverage === "durable_read_catalog"))
    return {
      captureEvidence:
        "apps/runtime/src/services/ofapi-collection-read-transport.ts",
      projectionEvidence:
        "apps/runtime/src/services/canonicalize/ofapi-read-collections.ts | apps/runtime/src/services/projections/ofapi-read-snapshots.ts",
    };
  if (
    matched.some(
      (s) =>
        s.coverage === "closed_marketing_command" ||
        s.coverage === "encrypted_admin_read",
    )
  )
    return {
      captureEvidence:
        "apps/runtime/src/services/ofapi-smart-links.ts (encrypted administrative response)",
      projectionEvidence:
        "apps/runtime/src/services/projections/ofapi-marketing.ts",
    };
  if (
    row.path.includes("/media/") &&
    (/upload/.test(row.path) || row.method === "POST")
  )
    return {
      captureEvidence:
        "apps/runtime/src/services/ofapi-capture-jobs.ts | apps/runtime/src/services/ofapi-media-uploads.ts",
      projectionEvidence:
        "apps/runtime/src/services/projections/ofapi-media.ts | apps/runtime/src/services/projections/media-plane.ts",
    };
  if (row.path.includes("data-exports"))
    return {
      captureEvidence:
        "apps/runtime/src/services/ofapi-capture-jobs.ts | apps/runtime/src/services/ofapi-credential-policy.ts",
      projectionEvidence:
        "apps/runtime/src/services/ofapi-typed-exports.ts (typed captured rows/artifacts and local job state)",
    };
  if (row.path.includes("webhooks"))
    return {
      captureEvidence: "apps/runtime/src/services/ofapi-credential-policy.ts",
      projectionEvidence: row.path.endsWith("/events")
        ? "apps/runtime/src/services/ofapi-webhook-event-catalog.ts (control-plane projection on read)"
        : "apps/runtime/src/services/ofapi-webhook-recovery.ts | apps/runtime/src/services/ofapi-webhooks.ts (administrative state)",
    };
  if (
    row.path.includes("/usage/") ||
    row.path === "/api/whoami" ||
    row.path === "/api/accounts"
  )
    return {
      captureEvidence: "apps/runtime/src/services/ofapi-credential-policy.ts",
      projectionEvidence:
        "apps/runtime/src/services/ofapi-vendor-usage.ts | apps/runtime/src/services/ofapi-account-health.ts (administrative diagnostics)",
    };
  if (row.path.includes("banned-words"))
    return {
      captureEvidence: "apps/runtime/src/services/ofapi-credential-policy.ts",
      projectionEvidence:
        "apps/runtime/src/services/ofapi-banned-words.ts (local dictionary state)",
    };
  if (row.method !== "GET")
    return {
      captureEvidence:
        "apps/runtime/src/services/ofapi.ts | apps/runtime/src/services/ofapi-command-outbox.ts",
      projectionEvidence:
        "apps/runtime/src/services/ofapi-command-executor.ts (durable result/verification state)",
    };
  if (matched.some((s) => s.coverage === "gateway_read"))
    return {
      captureEvidence:
        "apps/runtime/src/services/ofapi-capture-transport.ts | apps/runtime/src/services/ofapi-read-gateway-capture.ts",
      projectionEvidence:
        "apps/runtime/src/services/canonicalize/index.ts (registered legacy read families); Desktop response consumer",
    };
  return {
    captureEvidence: "apps/runtime/src/services/ofapi-capture-transport.ts",
    projectionEvidence:
      "apps/runtime/src/services/canonicalize/sync-pull.ts | apps/runtime/src/services/projections/registry.ts",
  };
}
const rows = original.map((row) => {
  const matched = signatures.filter((s) => s.key === key(row.method, row.path));
  const exclusion = matched.length ? null : excluded(row);
  return {
    method: row.method,
    path: row.path,
    summary: row.summary,
    tags: row.tags,
    docsUrl: row.docsUrl,
    deprecated: row.deprecated,
    vendorQuery: row.vendorQuery,
    status: matched.length
      ? "implemented_scoped"
      : exclusion
        ? "excluded_by_plan"
        : "unresolved",
    baselineStatus: row.status,
    selection: [...new Set(matched.map((s) => s.selection).filter(Boolean))],
    category: [...new Set(matched.map((s) => s.category).filter(Boolean))],
    coverage: [...new Set(matched.map((s) => s.coverage))],
    evidence: [...new Set(matched.map((s) => s.evidence))],
    implementedQuery: [...new Set(matched.flatMap((s) => s.queries))],
    ...context(row, matched),
    ...materialEvidence(row, matched),
    intentionalExclusion: exclusion,
    liveProbeExecuted: false,
  };
});
for (const row of rows.filter((r) => r.status !== "implemented_scoped")) {
  row.consumer = "";
  row.regression = "";
  row.captureEvidence = "";
  row.projectionEvidence = "";
}
const count = (field) =>
  Object.fromEntries(
    [...new Set(rows.map((r) => r[field]))].map((v) => [
      v,
      rows.filter((r) => r[field] === v).length,
    ]),
  );
const missingEvidence = [];
for (const row of rows.filter((r) => r.status === "implemented_scoped"))
  for (const field of [
    "evidence",
    "captureEvidence",
    "projectionEvidence",
    "consumer",
    "regression",
  ]) {
    for (const file of String(row[field] ?? "").match(
      /(?:apps|tests|packages)\/[A-Za-z0-9_./-]+\.(?:tsx?|mjs)/g,
    ) ?? [])
      if (!has(file))
        missingEvidence.push({
          operation: `${row.method} ${row.path}`,
          field,
          file,
        });
  }
const summary = {
  endToEndEvidenceComplete: missingEvidence.length === 0,
  missingEvidence,
  head: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim(),
  dirty:
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: repo,
      encoding: "utf8",
    }).trim().length > 0,
  originalSha256: createHash("sha256")
    .update(fs.readFileSync(input))
    .digest("hex"),
  operations: rows.length,
  catalogOperations: catalog.length,
  migrations: fs.readdirSync(path.join(repo, "packages/db/migrations")).filter(name => /^\d+_.*\.sql$/.test(name) && Number(name.split("_")[0]) >= 150).sort(),
  byStatus: count("status"),
  supportedByMethod: Object.fromEntries([...new Set(rows.map(row => row.method))].map(method => [method, rows.filter(row => row.method === method && row.status === "implemented_scoped").length])) ,
  unresolved: rows
    .filter((r) => r.status === "unresolved")
    .map((r) => `${r.method} ${r.path} ${r.summary}`),
  unmatchedSignatures: signatures.filter(
    (s) => !original.some((r) => s.key === key(r.method, r.path)),
  ),
  methodology:
    "Finite method/path inventory plus exact gateway allowlist. Catalog paths are exercised by existing exhaustive catalog tests; evidence denotes code and test coverage, not live provider verification or complete parameter parity. Conditional feature selection and default-off rollout are documented separately. No vendor requests or app bootstrap.",
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(output, "endpoint-matrix.json"),
  JSON.stringify(rows, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(output, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
const fields = [
  "method",
  "path",
  "summary",
  "tags",
  "status",
  "baselineStatus",
  "selection",
  "category",
  "coverage",
  "evidence",
  "captureEvidence",
  "projectionEvidence",
  "consumer",
  "regression",
  "vendorQuery",
  "implementedQuery",
  "intentionalExclusion",
  "docsUrl",
];
const csv = (v) =>
  '"' +
  String(Array.isArray(v) ? v.join(" | ") : (v ?? "")).replaceAll('"', '""') +
  '"';
fs.writeFileSync(
  path.join(output, "endpoint-matrix.csv"),
  fields.map(csv).join(",") +
    "\n" +
    rows.map((r) => fields.map((f) => csv(r[f])).join(",")).join("\n") +
    "\n",
);
function constant(file, name, context = {}) {
  const sf = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = sf.statements.find(
    (s) =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some((d) => d.name.getText() === name),
  );
  if (!statement) throw new Error(`Missing declared constant ${file} ${name}`);
  const ctx = { exports: {}, ...context };
  vm.createContext(ctx);
  vm.runInContext(
    ts.transpileModule(statement.getText(sf), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText,
    ctx,
    { timeout: 1000 },
  );
  return ctx.exports[name];
}
const eventInput = path.join(
  path.dirname(path.dirname(input)),
  "evidence/webhook-catalog.json",
);
const eventsOriginal = JSON.parse(
  fs.readFileSync(eventInput, "utf8"),
).documented;
if (eventsOriginal.length !== 32 || new Set(eventsOriginal).size !== 32)
  throw new Error("Expected the frozen 32-event catalog");
const webhookFile = "apps/runtime/src/services/ofapi-webhooks.ts",
  lifecycleFile = "apps/runtime/src/services/ofapi-lifecycle-contract.ts",
  canonicalFile = "apps/runtime/src/services/canonicalize/ofapi-webhook.ts",
  contentFile =
    "apps/runtime/src/services/canonicalize/ofapi-content-events.ts";
const baseline = constant(webhookFile, "OFAPI_WEBHOOK_EVENTS");
const lifecycle = constant(lifecycleFile, "OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES");
const groups = constant(lifecycleFile, "OFAPI_OPTIONAL_WEBHOOK_GROUPS", {
  OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES: lifecycle,
});
const canonical = constant(canonicalFile, "OFAPI_WEBHOOK_CANONICALIZED_KINDS", {
  OFAPI_ASYNC_LIFECYCLE_EVENT_TYPES: lifecycle,
  OFAPI_CONTENT_KINDS: has(contentFile)
    ? constant(contentFile, "OFAPI_CONTENT_KINDS")
    : [],
});
const eventRows = eventsOriginal.map((event) => {
  const group =
    Object.entries(groups).find(([, members]) =>
      members.includes(event),
    )?.[0] ?? null;
  let consumer = "Desktop journal/CRM/activity feed",
    regression = "tests/ofapi-webhook.integration.test.ts";
  if (event.startsWith("accounts.")) {
    consumer = "Owner account health + paused page jobs";
    regression = "tests/ofapi-account-health.integration.test.ts";
  }
  if (event.startsWith("subscriptions.")) {
    consumer = "CRM subscription history and audience relationships";
    regression = "tests/ofapi-webhook-lifecycle.integration.test.ts";
  }
  if (event.startsWith("data_exports.")) {
    consumer = "Owner typed-export status + bounded recovery";
    regression = "tests/ofapi-typed-exports.integration.test.ts";
  }
  if (event.startsWith("media_uploads.")) {
    consumer = "Owner media upload status, readiness and handoff";
    regression = "tests/ofapi-media-uploads.integration.test.ts";
  }
  if (event === "posts.liked" || event.startsWith("chat_queue.")) {
    consumer = "Owner collection content evidence report";
    regression = "tests/ofapi-content-events.integration.test.ts";
  }
  if (event === "users.typing")
    consumer = "Transient hint captured without durable business projection";
  if (event === "fan_summary.completed") {
    consumer =
      "Deferred provider AI; no requested subscription or semantic projection";
    regression = "";
  }
  return {
    event,
    subscription: baseline.includes(event)
      ? "existing_baseline"
      : group
        ? "optional_default_off"
        : "excluded_provider_ai",
    optionalGroup: group,
    lifecycleConsumerGate: event.startsWith("accounts.") ? "OFAPI_ACCOUNT_HEALTH_ENABLED" : event.startsWith("subscriptions.") ? "OFAPI_AUDIENCE_SYNC_ENABLED" : ["users.online", "users.offline"].includes(event) ? "OFAPI_PRESENCE_PROJECTION_ENABLED" : null,
    canonical: canonical.has(event),
    status: canonical.has(event)
      ? "canonical_and_consumed"
      : event === "users.typing"
        ? "intentional_ephemeral"
        : "excluded_provider_ai",
    consumer,
    regression,
    code: event === "posts.liked" || event.startsWith("chat_queue.")
      ? locate(contentFile, "export const OFAPI_CONTENT_KINDS")
      : event.startsWith("media_uploads.") || event.startsWith("data_exports.")
        ? locate(canonicalFile, 'type: lifecycle.resourceKind === "data_export"')
        : canonical.has(event) ? locate(canonicalFile, `case "${event}"`)
          : locate(canonicalFile, "OFAPI_WEBHOOK_CANONICALIZED_KINDS"),
    captureEvidence: "apps/runtime/src/services/ofapi-webhook-capture.ts",
    projectionEvidence: event.startsWith("accounts.") ? "apps/runtime/src/services/ofapi-account-health.ts (replayable operational state)"
      : event.startsWith("subscriptions.") ? "apps/runtime/src/services/ofapi-subscription-projection.ts"
        : event.startsWith("data_exports.") || event.startsWith("media_uploads.") ? "apps/runtime/src/services/ofapi-async-lifecycle.ts (journal-backed local lifecycle view; not imported artifact/readiness proof)"
          : event === "posts.liked" ? "apps/runtime/src/services/projections/fansly-engagement.ts"
            : event.startsWith("chat_queue.") ? "apps/runtime/src/services/projections/ofapi-content-events.ts"
              : event.startsWith("users.") ? (event === "users.typing" ? "Intentional ephemeral capture only" : "apps/runtime/src/services/ofapi-presence-projection.ts")
                : event === "transactions.new" ? "apps/runtime/src/services/projections/fan-earnings.ts"
                  : event === "fan_summary.completed" ? "No semantic projection: provider AI excluded"
                    : "apps/runtime/src/services/ofapi-dm-projection.ts | apps/runtime/src/services/projections/message-archive.ts",
    consumerEvidence: event.startsWith("data_exports.") ? "apps/dashboard/src/pages/OfapiExportsPage.tsx"
      : event.startsWith("media_uploads.") ? "apps/dashboard/src/pages/OfapiMediaPage.tsx"
        : event === "posts.liked" || event.startsWith("chat_queue.") ? "apps/dashboard/src/pages/settings/OfapiContentEvidence.tsx"
          : event.startsWith("accounts.") ? "apps/runtime/src/modules/ingest/index.ts"
            : event === "users.typing" || event === "fan_summary.completed" ? "No durable business UI claimed"
              : "apps/runtime/src/modules/agent-read/handlers-journal.ts | Desktop journal/CRM SDK",
    rollout: group
      ? `Owner Settings → Collection → webhook group ${group}; preview and apply one group only.`
      : event === "fan_summary.completed"
        ? "Leave provider-AI subscription disabled."
        : "Existing baseline; this release adds no subscription flip.",
  };
});
const eventFields = [
  "event",
  "subscription",
  "optionalGroup",
  "lifecycleConsumerGate",
  "canonical",
  "status",
  "consumer",
  "regression",
  "code",
  "captureEvidence",
  "projectionEvidence",
  "consumerEvidence",
  "rollout",
];
fs.writeFileSync(
  path.join(output, "event-matrix.csv"),
  eventFields.map(csv).join(",") +
    "\n" +
    eventRows
      .map((r) => eventFields.map((f) => csv(r[f])).join(","))
      .join("\n") +
    "\n",
);
for (const row of eventRows) for (const field of ["code", "captureEvidence", "projectionEvidence", "consumerEvidence", "regression"]) {
  for (const file of String(row[field] ?? "").match(/(?:apps|tests|packages)\/[A-Za-z0-9_./-]+\.(?:tsx?|mjs)/g) ?? [])
    if (!has(file)) missingEvidence.push({ event: row.event, field, file });
}
summary.endToEndEvidenceComplete = missingEvidence.length === 0 && summary.unresolved.length === 0 && !summary.dirty;
summary.events = {
  total: eventRows.length,
  canonical: eventRows.filter((r) => r.canonical).length,
  baselineSubscriptions: baseline.length,
  optionalSubscriptions: eventRows.filter(
    (r) => r.subscription === "optional_default_off",
  ).length,
  ephemeral: eventRows.filter((r) => r.status === "intentional_ephemeral")
    .length,
  excludedProviderAi: eventRows.filter(
    (r) => r.status === "excluded_provider_ai",
  ).length,
};
fs.writeFileSync(
  path.join(output, "event-matrix.json"),
  JSON.stringify(eventRows, null, 2) + "\n",
);
fs.writeFileSync(
  path.join(output, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
