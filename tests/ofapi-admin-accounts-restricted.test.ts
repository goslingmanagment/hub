import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectOfapiAccountsRoster } from "../apps/runtime/src/services/ofapi-credential-policy.ts";
import { toAccountRecords } from "../apps/runtime/src/services/ofapi.ts";
import { RESTRICTED_OBSERVATION_KINDS } from "../apps/runtime/src/services/tiering/index.ts";
import { AGENT_OBSERVATION_PAYLOAD_DENYLIST, agentObservationPayloadAllowed } from "../apps/runtime/src/modules/agent-read/index.ts";

describe("OFAPI roster capture boundary", () => {
  it("retains identity without sessions, arbitrary objects or metadata", () => {
    const body = JSON.stringify({ data: [{ id: "acct_1", onlyfans_id: 123, is_authenticated: true,
      onlyfans_email: "synthetic@invalid", display_name: { sessionToken: "secret" },
      onlyfans_user_data: { id: 123, csrf: "secret", wsAuthToken: "secret", ip: "secret", username: "nested" },
    }], _meta: { sessionToken: "secret" } });
    const result = projectOfapiAccountsRoster({ status: 200, body });
    expect(result.body).not.toMatch(/secret|synthetic@|nested|_meta|display_name/);
    expect(toAccountRecords(JSON.parse(result.body))[0]).toMatchObject({ id: "acct_1", onlyfansUserId: "123", identityStatus: "verified", isAuthenticated: true });
    expect(result.redaction.originalSha256).toBe(createHash("sha256").update(body).digest("hex"));
  });

  const ids: unknown[] = [undefined, null, {}, [], true, 123, "123", "abc", 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1];
  it("preserves identity and authentication across snake/camel precedence and invalid IDs", () => {
    for (const snake of ids) for (const camel of ids) for (const top of ids) {
      const body = JSON.stringify([{ id: "acct_1", onlyfans_id: top, onlyfans_user_data: { id: snake },
        onlyfansUserData: { id: camel }, is_authenticated: false }]);
      const original = toAccountRecords(JSON.parse(body))[0]!;
      const projected = toAccountRecords(JSON.parse(projectOfapiAccountsRoster({ status: 200, body }).body))[0]!;
      expect([projected.id, projected.onlyfansUserId, projected.identityStatus, projected.isAuthenticated])
        .toEqual([original.id, original.onlyfansUserId, original.identityStatus, original.isAuthenticated]);
    }
  });

  it.each(["1e400", "-1e400", "9007199254740992", "12345678901234567890"])("keeps numeric conflict from source JSON %s", number => {
    for (const field of ["onlyfans_id", "onlyfans_user_id", "onlyfansUserId"]) {
      const body = `[{"id":"acct_1","${field}":${number},"onlyfans_user_data":{"id":123}}]`;
      expect(toAccountRecords(JSON.parse(projectOfapiAccountsRoster({ status: 200, body }).body))[0])
        .toMatchObject({ identityStatus: "conflict", onlyfansUserId: null });
    }
    const body = `[{"id":"acct_1","onlyfans_user_data":{"id":${number}},"onlyfansUserData":{"id":123}}]`;
    expect(toAccountRecords(JSON.parse(projectOfapiAccountsRoster({ status: 200, body }).body))[0])
      .toMatchObject({ identityStatus: "conflict", onlyfansUserId: null });
  });

  it.each([
    [403, '{"error":{"code":"unauthorized","message":"secret"}}', "json_object", "unauthorized"],
    [503, "<html>secret</html>", "text", null],
    [401, '{"error":"Bad Code! secret"}', "json_object", null],
  ])("withholds error body at status %s", (status, body, bodyShape, errorCode) => {
    const result = projectOfapiAccountsRoster({ status: Number(status), body: String(body) });
    expect(result.body).toBe("");
    expect(result.redaction).toMatchObject({ withheld: "non_200_status", bodyShape, errorCode });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("withholds malformed bodies and counts UTF-8 bytes", () => {
    expect(projectOfapiAccountsRoster({ status: 200, body: "bad" }).redaction.withheld).toBe("non_json_body");
    expect(projectOfapiAccountsRoster({ status: 200, body: "{}" }).body).toBe("");
    const body = '[{"id":"acct_1","username":"имя"}]';
    expect(projectOfapiAccountsRoster({ status: 200, body }).redaction.originalBytes).toBe(Buffer.byteLength(body));
  });

  it("restricts the roster in the lake and refuses Agent Read", () => {
    expect(RESTRICTED_OBSERVATION_KINDS.has("ofapi_admin_accounts")).toBe(true);
    expect(AGENT_OBSERVATION_PAYLOAD_DENYLIST.has("ofapi_admin_accounts")).toBe(true);
    expect(agentObservationPayloadAllowed("ofapi_admin_accounts")).toBe(false);
    expect(agentObservationPayloadAllowed("ofapi_admin_accounts:failed")).toBe(false);
  });
});
