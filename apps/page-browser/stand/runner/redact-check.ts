// What capture mode "redacted" writes (src/operator/redact.ts), against fixed
// answers shaped like the fields the fifth pilot session found: the login
// e-mail of account/me and of timeline/home's accounts, a token field, a
// session-like field — none of their values may reach the text to be
// written; ordinary values stay as they are.
//   node --no-warnings stand/runner/redact-check.ts      exit 0 = all hold

import { redactBody } from "../../src/operator/redact.ts";

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(JSON.stringify({ check: name, ok, ...(detail === undefined ? {} : { detail }) }));
  if (!ok) failures.push(name);
}
const buf = (value: unknown) => [Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8")];

const SECRETS = ["owner@example.test", "tok-very-secret-value", "+491701234567", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXg", "sess-abcdef123456", "other.person@mail.example"];
const answer = {
  success: true,
  response: {
    account: { id: "723606174951284736", username: "Anikaplayxx", email: SECRETS[0], phoneNumber: SECRETS[2] },
    token: SECRETS[1],
    accounts: [
      { id: "1", username: "someone", email: null, about: `write me: ${SECRETS[5]}` },
      { id: "2", username: "other", settings: { sessionId: SECRETS[4] } },
    ],
    aggregationData: { [SECRETS[0]]: { postCount: 3 }, "723606174951284736": { postCount: 7 } },
    wsAuth: SECRETS[3],
    posts: [{ id: "9", content: "hello", likeCount: 4 }],
  },
};
const result = redactBody(buf(answer), false, 1_000_000);
check("written", result.ok === true);
if (result.ok) {
  check("no secret in the text to be written", SECRETS.every((secret) => !result.text.includes(secret)), result.redactions);
  const back = JSON.parse(result.text);
  check("ordinary values kept", back.response.account.id === "723606174951284736" && back.response.account.username === "Anikaplayxx" && back.response.posts[0].content === "hello" && back.response.posts[0].likeCount === 4 && back.response.aggregationData["723606174951284736"].postCount === 7);
  check("sensitive fields marked", back.response.account.email === "[redacted:email]" && back.response.account.phoneNumber === "[redacted:phone]" && back.response.token === "[redacted:token]" && back.response.accounts[1].settings.sessionId === "[redacted:session]" && back.response.wsAuth === "[redacted:token]");
  check("an e-mail in free text and as a key", back.response.accounts[0].about === "[redacted:email]" && Object.keys(back.response.aggregationData).some((key) => key.startsWith("[redacted:email#")));
}
check("not JSON: not written", redactBody(buf("<html>"), false, 1000).ok === false);
check("over the size: not written", redactBody(null, true, 1000).ok === false);
let deep = "1";
for (let i = 0; i < 20_000; i++) deep = `[${deep}]`;
check("nesting deeper than the stack: not written", redactBody(buf(deep), false, 10_000_000).ok === false);
// Long values: linear time (a quadratic search stalled the operator).
const long = { response: { pad: "x".repeat(8_000_000), ats: "@".repeat(2_000_000), dots: `${"a".repeat(3_000_000)}.${"b".repeat(3_000_000)}` } };
const started = performance.now();
const longResult = redactBody(buf(long), false, 64_000_000);
const ms = performance.now() - started;
check("long values in linear time", longResult.ok === true && ms < 1500, { ms: Math.round(ms) });
process.exit(failures.length === 0 ? 0 : 1);
