// The rules of the page's extension by site profile (spec §2.7), PROTOTYPE:
//   node extension/build-rules.mjs fansly > extension/profiles/fansly.json
// (profiles/stand.json is the stand's own, written by hand.)
// Levels, strictly different priorities (at equal priority DNR prefers
// allow): 400 "never" — block; 300 the login operations — allow; 200 every
// write to the site's hosts and the closed socket host — block; 100 local
// and private addresses — block. Never-rules cover the placeholder host of
// Hub requests too; login does not (Hub never logs in).

const ALL_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"];
const WRITES = ["post", "put", "patch", "delete"];
const PLACEHOLDER = ".pb-hold.invalid";

const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const profiles = {
  fansly: {
    api: "apiv3.fansly.com",
    /** Paths under /api/v1, as RE2 alternatives (public bundle 2026-10-11 and
     *  plan §4.6): read marks, typing, status, likes, account, money, 2FA
     *  settings, password, sessions, management, logout. */
    never: [
      "message/ack(/all)?",
      "message/typing",
      "message/like(/remove)?",
      "status",
      "notifications/ack",
      "groups/users/readreceipts",
      "account/disable",
      "account/emailchange/.*",
      "account/wallets/transaction/refund",
      "login/password.*",
      "twofa(/.*)?",
      "session/close",
      "management/.*",
      "webpush/delete",
      "payments/payout.*",
      "payments/wallets.*",
      "payouts/.*",
      "thirdpartyconnect/.*",
      "logout",
    ],
    /** Reads that are not reads, any method (public bundle 2026-10-11, Astra
     *  review 2): an unsubscribe by link, a content-filter verification, and
     *  the support widgets' authorisations (their answers carry tokens). */
    neverAnyMethod: ["emails/unsubscribe", "account/verifynsfw", "intercom/authorize", "zendesk/authorize"],
    /** The owner's login on the page's screen: the password, the 2FA code
     *  and a new device's e-mail check. */
    login: ["login", "login/twofa", "login/email", "login/email/verification", "login/email/verification/token", "login/email/verify", "email-challenge/v1/.*"],
    /** Every write to these hosts and their subdomains is blocked. */
    writeDomains: ["fansly.com"],
    closedSockets: ["chatws.fansly.com"],
  },
};

function build(profile) {
  const rules = [];
  const add = (priority, action, condition) => rules.push({ id: rules.length + 1, priority, action: { type: action }, condition: { ...condition, resourceTypes: condition.resourceTypes ?? ALL_TYPES } });
  const hosts = `${esc(profile.api)}(${esc(PLACEHOLDER)})?`;
  // Several smaller regexes: DNR limits the compiled size of each.
  for (let i = 0; i < profile.never.length; i += 6) {
    add(400, "block", { regexFilter: `^https://${hosts}/api/v1/(${profile.never.slice(i, i + 6).join("|")})([?#].*)?$`, requestMethods: WRITES });
  }
  if (profile.neverAnyMethod?.length) add(400, "block", { regexFilter: `^https://${hosts}/api/v1/(${profile.neverAnyMethod.join("|")})([?#].*)?$` });
  add(300, "allow", { regexFilter: `^https://${esc(profile.api)}/api/v1/(${profile.login.join("|")})([?#].*)?$`, requestMethods: ["post"] });
  add(200, "block", { requestDomains: profile.writeDomains, requestMethods: WRITES });
  if (profile.closedSockets.length > 0) add(200, "block", { requestDomains: profile.closedSockets, resourceTypes: ["websocket"] });
  for (const local of ["||localhost", "||127.0.0.1", "||10.", "||192.168.", "||169.254.", "||[::1]"]) add(100, "block", { urlFilter: local });
  return rules;
}

const name = process.argv[2] ?? "fansly";
const profile = profiles[name];
if (!profile) {
  console.error(`unknown profile ${name}; known: ${Object.keys(profiles).join(", ")}`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(build(profile), null, 2)}\n`);
