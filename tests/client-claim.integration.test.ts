import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyClientClaimAction,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  createUser,
  readClientFanClaimStatus,
  readDesktopFollowerOutreach,
  resolveClientSendCustody,
  type ClientClaimActionInput,
  type ClientClaimGroup,
} from "@agency_hub_core/db";

import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// hub-pr-plan H-7a: the chat-extension lease and custody repository on a real
// Postgres — races under the advisory locks, keys reused across fans, repeats,
// parts, the manual resolve, the desktop outbox's greeting predicate (critic
// 1), the per-user rate lock and the instance-bound reports (critic 12), and
// erasure.

let harness: StartedTestDatabase;
let pageId: number;
let me: number;
let other: number;
let owner: number;
let fanSeq = 600_000_000;
const nextFan = () => String(++fanSeq);
const I1 = randomUUID();
const I2 = randomUUID();
const GROUP: ClientClaimGroup = { generationRef: "gen-a", variant: 0, partCount: 3 };

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres is required");
  harness = started;
  const model = (await createModel(harness.db, { slug: "client-claim", name: "Client claim" }))!;
  pageId = (await createOnlyFansPage(harness.db, { modelId: model.id, label: "client-claim-of" }))!.id;
  await createFanslyPage(harness.db, { modelId: model.id, label: "client-claim-fs" });
  me = (await createUser(harness.db, { username: "claim-me", role: "chatter" }))!.id;
  other = (await createUser(harness.db, { username: "claim-other", role: "chatter" }))!.id;
  owner = (await createUser(harness.db, { username: "claim-owner", role: "owner" }))!.id;
}, 120_000);
afterAll(async () => { await harness?.stop(); });
// Each test starts outside the previous tests' 60 s preview-send rate window.
beforeEach(async () => {
  await harness.pool.query("update client_send_custody set created_at = created_at - interval '2 minutes'");
});

const act = (input: ClientClaimActionInput, options?: Parameters<typeof applyClientClaimAction>[2]) =>
  applyClientClaimAction(harness.db, input, options);
const claim = (fanRef: string, userId = me, instanceId = I1, leaseToken: string = randomUUID()) =>
  act({ action: "claim", pageId, fanRef, userId, instanceId, leaseToken });
const dispatch = (fanRef: string, over: Partial<Extract<ClientClaimActionInput, { action: "dispatch" }>> = {}) =>
  act({
    action: "dispatch", pageId, fanRef, userId: me, attemptId: randomUUID(), instanceId: I1, purpose: "greeting",
    group: GROUP, partIndex: 0, textRevision: 1, leaseToken: null, flagRevision: 3, ...over,
  } as ClientClaimActionInput);
const sent = (fanRef: string, attemptId: string, platformMessageId: string, userId = me, instanceId = I1) =>
  act({ action: "sent", pageId, fanRef, userId, attemptId, instanceId, platformMessageId });
const custodyRow = async (attemptId: string) => (await harness.pool.query(
  "select state, encode(ticket_hash, 'hex') as ticket_hash, lease_id::text, platform_message_id from client_send_custody where attempt_id = $1",
  [attemptId],
)).rows[0];

describe("lease", () => {
  it("grants exactly one of simultaneous claims from two people, two instances and two tabs", async () => {
    const fanRef = nextFan();
    const results = await Promise.all([
      claim(fanRef, me, I1), claim(fanRef, me, I1), claim(fanRef, me, I2), claim(fanRef, other, I2),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => !result.ok && result.code)).toEqual(["claim_busy", "claim_busy", "claim_busy"]);
    const { rows } = await harness.pool.query("select count(*)::int as n from client_fan_leases where fan_ref = $1", [fanRef]);
    expect(rows[0].n).toBe(1);
  });

  it("expires a lease lazily: the late renew is claim_expired and the next claim wins", async () => {
    const fanRef = nextFan();
    const token = randomUUID();
    expect((await claim(fanRef, me, I1, token)).view.lease).toMatchObject({ state: "owned", leaseToken: token });
    await harness.pool.query("update client_fan_leases set expires_at = now() - interval '1 second' where lease_id = $1", [token]);
    expect(await act({ action: "renew", pageId, fanRef, userId: me, instanceId: I1, leaseToken: token }))
      .toMatchObject({ ok: false, code: "claim_expired", view: { lease: { state: "expired" } } });
    expect((await claim(fanRef, other, I2)).ok).toBe(true);
    const { rows } = await harness.pool.query("select state from client_fan_leases where fan_ref = $1 order by created_at", [fanRef]);
    expect(rows.map((row) => row.state)).toEqual(["expired", "active"]);
    expect((await readClientFanClaimStatus(harness.db, { pageId, fanRef, userId: me, instanceId: I1, leaseToken: null })).lease)
      .toMatchObject({ state: "held", heldBy: "someone-else", leaseToken: null });
  });
});

describe("greeting send custody", () => {
  it("refuses a greeting without the lease and issues a one-time ticket with it", async () => {
    const fanRef = nextFan();
    expect(await dispatch(fanRef)).toMatchObject({ ok: false, code: "claim_expired" });
    const leaseToken = randomUUID();
    await claim(fanRef, me, I1, leaseToken);
    const attemptId = randomUUID();
    const first = await dispatch(fanRef, { attemptId, leaseToken });
    expect(first).toMatchObject({ ok: true, view: { custody: { attemptId, state: "dispatching" }, group: { heldParts: [0], sentParts: [] } } });
    const ticket = first.view.custody!.ticket!;
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await custodyRow(attemptId);
    expect(row).toMatchObject({ state: "dispatching", lease_id: leaseToken, ticket_hash: createHash("sha256").update(ticket).digest("hex") });
    // A repeat reads without a ticket; another body conflicts.
    expect(await dispatch(fanRef, { attemptId, leaseToken })).toMatchObject({ ok: true, view: { custody: { attemptId, ticket: null } } });
    expect(await dispatch(fanRef, { attemptId, leaseToken, textRevision: 2 })).toMatchObject({ ok: false, code: "attempt_conflict" });
  });

  it("holds the fan after a crash past the ticket, through lease expiry, until a report or resolve", async () => {
    const fanRef = nextFan();
    const leaseToken = randomUUID();
    await claim(fanRef, me, I1, leaseToken);
    const attemptId = randomUUID();
    await dispatch(fanRef, { attemptId, leaseToken });
    await harness.pool.query("update client_send_custody set ticket_expires_at = now() - interval '1 second' where attempt_id = $1", [attemptId]);
    await harness.pool.query("update client_fan_leases set expires_at = now() - interval '1 second' where lease_id = $1", [leaseToken]);
    const otherLease = randomUUID();
    expect((await claim(fanRef, other, I2, otherLease)).ok).toBe(true);
    const blocked = await act({
      action: "dispatch", pageId, fanRef, userId: other, attemptId: randomUUID(), instanceId: I2, purpose: "greeting",
      group: { ...GROUP, generationRef: "gen-b" }, partIndex: 0, textRevision: 1, leaseToken: otherLease, flagRevision: 3,
    });
    expect(blocked).toMatchObject({ ok: false, code: "custody_held", view: { custody: { attemptId, state: "uncertain-held" } } });
    // Neither another instance's failure report nor a 401 releases it.
    expect(await act({ action: "failed", pageId, fanRef, userId: me, attemptId, instanceId: I2, reason: "not_enqueued", httpStatus: null }))
      .toMatchObject({ ok: false, code: "custody_not_owned" });
    expect(await act({ action: "failed", pageId, fanRef, userId: me, attemptId, instanceId: I1, reason: "native_rejected", httpStatus: 401 }))
      .toMatchObject({ ok: false, code: "invalid_request" });
    // The manual resolve frees it, audited.
    const resolved = await resolveClientSendCustody(harness.db, {
      pageId, attemptId, resolverUserId: owner, outcome: "not_sent", platformMessageId: null, note: "not in the chat",
    });
    expect(resolved).toMatchObject({ ok: true, view: { custody: { state: "resolved-not-sent" } } });
    const audit = await harness.pool.query(
      "select actor_user_id, metadata from audit_events where event_type = 'client.send_custody_resolved' and metadata->>'attemptId' = $1",
      [attemptId],
    );
    expect(audit.rows).toEqual([{ actor_user_id: BigInt(owner), metadata: {
      attemptId, outcome: "not_sent", priorState: "uncertain-held", platformMessageIdRecorded: false,
    } }]);
    expect(JSON.stringify(audit.rows[0].metadata)).not.toContain(fanRef);
    expect(await resolveClientSendCustody(harness.db, {
      pageId, attemptId: randomUUID(), resolverUserId: owner, outcome: "sent", platformMessageId: null, note: "x",
    })).toEqual({ ok: false, code: "not_found", view: null });
  });

  it("refuses a not-sent resolve that carries a message id, so the real send's later proof still counts", async () => {
    const fanRef = nextFan();
    const leaseToken = randomUUID();
    await claim(fanRef, me, I1, leaseToken);
    const attemptId = randomUUID();
    await dispatch(fanRef, { attemptId, leaseToken });
    expect(await resolveClientSendCustody(harness.db, {
      pageId, attemptId, resolverUserId: owner, outcome: "not_sent", platformMessageId: "7101", note: "pasted by mistake",
    })).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await custodyRow(attemptId)).toMatchObject({ state: "dispatching", platform_message_id: null });
    // The table refuses the contradiction too.
    await expect(harness.pool.query(
      `update client_send_custody set state = 'resolved_not_sent', platform_message_id = '7101', resolved_at = now(),
         resolved_by_user_id = $2, resolution_note = 'x' where attempt_id = $1`,
      [attemptId, owner],
    )).rejects.toMatchObject({ code: "23514", constraint: "client_send_custody_message_state_check" });
    expect((await resolveClientSendCustody(harness.db, {
      pageId, attemptId, resolverUserId: owner, outcome: "not_sent", platformMessageId: null, note: "not in the chat",
    })).ok).toBe(true);
    // The composer then proves 7101 was this greeting's first part: recorded, and the fan is greeted.
    expect(await act({
      action: "registerNativeSend", pageId, fanRef, userId: me, attemptId: randomUUID(), instanceId: I1, purpose: "greeting",
      group: GROUP, partIndex: 0, platformMessageId: "7101",
    })).toMatchObject({ ok: true, view: { greeting: { state: "confirmed", source: "native-register", messageRef: "7101" } } });
  });

  it("sends three parts of one greeting; the first confirmation fences everyone else", async () => {
    const fanRef = nextFan();
    const leaseToken = randomUUID();
    await claim(fanRef, me, I1, leaseToken);
    const parts = [randomUUID(), randomUUID(), randomUUID()] as const;
    await dispatch(fanRef, { attemptId: parts[0], leaseToken });
    expect(await sent(fanRef, parts[0], "7001", me, I2)).toMatchObject({ ok: false, code: "custody_not_owned" });
    expect(await sent(fanRef, parts[0], "7001")).toMatchObject({
      ok: true, view: { greeting: { state: "confirmed", messageRef: "7001", source: "preview-send" }, custody: { state: "sent" } },
    });
    await act({ action: "release", pageId, fanRef, userId: me, instanceId: I1, leaseToken });
    // The owner continues the same group without a lease; nobody else greets.
    expect((await dispatch(fanRef, { attemptId: parts[1], partIndex: 1 })).ok).toBe(true);
    expect(await sent(fanRef, parts[1], "7002")).toMatchObject({ ok: true });
    expect(await dispatch(fanRef, { partIndex: 2, group: { ...GROUP, generationRef: "gen-z" } }))
      .toMatchObject({ ok: false, code: "generation_mismatch" });
    expect(await act({
      action: "dispatch", pageId, fanRef, userId: other, attemptId: randomUUID(), instanceId: I2, purpose: "greeting",
      group: GROUP, partIndex: 2, textRevision: 1, leaseToken: null, flagRevision: 3,
    })).toMatchObject({ ok: false, code: "greeting_done" });
    expect(await dispatch(fanRef, { partIndex: 0 })).toMatchObject({ ok: false, code: "part_already_sent" });
    expect((await dispatch(fanRef, { attemptId: parts[2], partIndex: 2 })).ok).toBe(true);
    expect(await sent(fanRef, parts[2], "7003")).toMatchObject({ ok: true, view: { group: { ...GROUP, sentParts: [0, 1, 2], heldParts: [] } } });
    const greeting = await harness.pool.query("select owner_user_id, first_message_ref, first_attempt_id::text, source from client_greetings where fan_ref = $1", [fanRef]);
    expect(greeting.rows).toEqual([{ owner_user_id: BigInt(me), first_message_ref: "7001", first_attempt_id: parts[0], source: "preview-send" }]);
  });

  it("frees the fan on proven non-acceptance only", async () => {
    const fanRef = nextFan();
    const attemptId = randomUUID();
    await dispatch(fanRef, { attemptId, purpose: "preview-reply" });
    expect(await act({ action: "failed", pageId, fanRef, userId: me, attemptId, instanceId: I1, reason: "native_rejected", httpStatus: 403 }))
      .toMatchObject({ ok: true, view: { custody: { state: "failed" } } });
    expect((await dispatch(fanRef, { purpose: "preview-reply" })).ok).toBe(true);
  });
});

describe("registerNativeSend", () => {
  it("records a proven composer send once per message and leaves another's custody held", async () => {
    const fanRef = nextFan();
    const held = randomUUID();
    await act({
      action: "dispatch", pageId, fanRef, userId: other, attemptId: held, instanceId: I2, purpose: "preview-reply",
      group: { generationRef: "gen-r", variant: 0, partCount: 1 }, partIndex: 0, textRevision: 1, leaseToken: null, flagRevision: 3,
    });
    const register = (attemptId: string) => act({
      action: "registerNativeSend", pageId, fanRef, userId: me, attemptId, instanceId: I1, purpose: "greeting",
      group: GROUP, partIndex: 0, platformMessageId: "8001",
    });
    expect(await register(randomUUID())).toMatchObject({ ok: true, view: { greeting: { state: "confirmed", source: "native-register" } } });
    expect((await register(randomUUID())).ok).toBe(true);
    // The same message reported as another part contradicts the record.
    expect(await act({
      action: "registerNativeSend", pageId, fanRef, userId: me, attemptId: randomUUID(), instanceId: I1, purpose: "greeting",
      group: GROUP, partIndex: 1, platformMessageId: "8001",
    })).toMatchObject({ ok: false, code: "attempt_conflict" });
    const { rows } = await harness.pool.query("select attempt_id::text, state, origin from client_send_custody where fan_ref = $1 order by created_at", [fanRef]);
    expect(rows).toEqual([
      { attempt_id: held, state: "dispatching", origin: "preview-send" },
      { attempt_id: expect.any(String), state: "sent", origin: "native-register" },
    ]);
  });
});

describe("keys unique beyond one fan: a lease token, an attempt id, a page's message id", () => {
  // The fan lock orders nothing across fans. Hold the other fan's row
  // uncommitted so the request's insert waits on it and meets it at commit:
  // the request must refuse as designed, never surface the unique violation.
  const raceAgainst = async <T>(table: string, insert: [text: string, values: unknown[]], run: () => Promise<T>) => {
    const client = await harness.pool.connect();
    try {
      await client.query("begin");
      await client.query(...insert);
      const pending = run();
      pending.catch(() => undefined);
      for (let tries = 0; ; tries += 1) {
        const { rows } = await harness.pool.query(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock' and query like $1`,
          [`insert into ${table}%`],
        );
        if (rows[0].n > 0) break;
        if (tries > 400) throw new Error(`the request's insert into ${table} never waited on the held row`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await client.query("commit");
      return await pending;
    } finally {
      client.release();
    }
  };
  const hash = () => createHash("sha256").update(randomUUID()).digest();

  it("a lease token taken on another fan in the meantime is claim_expired", async () => {
    const [fanA, fanB, token] = [nextFan(), nextFan(), randomUUID()];
    const result = await raceAgainst("client_fan_leases", [
      `insert into client_fan_leases (lease_id, page_id, fan_ref, user_id, instance_id, state, expires_at)
       values ($1, $2, $3, $4, $5, 'active', now() + interval '2 minutes')`,
      [token, pageId, fanA, other, I2],
    ], () => claim(fanB, me, I1, token));
    expect(result).toMatchObject({ ok: false, code: "claim_expired", view: { lease: { state: "none" } } });
    const { rows } = await harness.pool.query("select fan_ref from client_fan_leases where lease_id = $1", [token]);
    expect(rows).toEqual([{ fan_ref: fanA }]);
  });

  it("an attempt id taken on another fan in the meantime is an attempt conflict", async () => {
    const [fanA, fanB, attemptId] = [nextFan(), nextFan(), randomUUID()];
    const result = await raceAgainst("client_send_custody", [
      `insert into client_send_custody (attempt_id, page_id, fan_ref, user_id, instance_id, purpose, origin, generation_ref,
         variant, part_count, part_index, text_revision, request_hash, state, ticket_hash, ticket_expires_at)
       values ($1, $2, $3, $4, $5, 'preview-reply', 'preview-send', 'gen-x', 0, 1, 0, 1, $6, 'dispatching', $7,
         now() + interval '10 seconds')`,
      [attemptId, pageId, fanA, other, I2, hash(), hash()],
    ], () => dispatch(fanB, { attemptId, purpose: "preview-reply" }));
    expect(result).toMatchObject({ ok: false, code: "attempt_conflict", view: { custody: null } });
    expect((await harness.pool.query("select fan_ref from client_send_custody where attempt_id = $1", [attemptId])).rows)
      .toEqual([{ fan_ref: fanA }]);
  });

  it("a message id recorded on another fan in the meantime is an attempt conflict", async () => {
    const [fanA, fanB] = [nextFan(), nextFan()];
    const result = await raceAgainst("client_send_custody", [
      `insert into client_send_custody (attempt_id, page_id, fan_ref, user_id, instance_id, purpose, origin, generation_ref,
         variant, part_count, part_index, request_hash, state, platform_message_id)
       values ($1, $2, $3, $4, $5, 'greeting', 'native-register', 'gen-x', 0, 1, 0, $6, 'sent', '7301')`,
      [randomUUID(), pageId, fanA, other, I2, hash()],
    ], () => act({
      action: "registerNativeSend", pageId, fanRef: fanB, userId: me, attemptId: randomUUID(), instanceId: I1,
      purpose: "greeting", group: GROUP, partIndex: 0, platformMessageId: "7301",
    }));
    expect(result).toMatchObject({ ok: false, code: "attempt_conflict", view: { greeting: { state: "none" } } });
    expect((await harness.pool.query("select fan_ref from client_send_custody where platform_message_id = '7301'")).rows)
      .toEqual([{ fan_ref: fanA }]);
  });
});

describe("rate and the switch gate", () => {
  it("serializes a user's dispatches: seven at once to seven fans admit exactly six", async () => {
    const user = (await createUser(harness.db, { username: "claim-rate", role: "chatter" }))!.id;
    const results = await Promise.all(Array.from({ length: 7 }, () => act({
      action: "dispatch", pageId, fanRef: nextFan(), userId: user, attemptId: randomUUID(), instanceId: I1,
      purpose: "preview-reply", group: GROUP, partIndex: 0, textRevision: 1, leaseToken: null, flagRevision: null,
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(6);
    expect(results.filter((result) => !result.ok).map((result) => !result.ok && result.code)).toEqual(["preview_send_rate_limited"]);
  });

  it("runs the gate inside the transaction, after the replay check", async () => {
    const fanRef = nextFan();
    let calls = 0;
    const refuse = { beforeDispatch: async () => { calls += 1; throw new Error("switch off"); } };
    await expect(dispatch(fanRef, { purpose: "preview-reply" })).resolves.toMatchObject({ ok: true });
    const attemptId = randomUUID();
    await expect(act({
      action: "dispatch", pageId, fanRef: nextFan(), userId: me, attemptId, instanceId: I1, purpose: "preview-reply",
      group: GROUP, partIndex: 0, textRevision: 1, leaseToken: null, flagRevision: 3,
    }, refuse)).rejects.toThrow("switch off");
    expect(await custodyRow(attemptId)).toBeUndefined();
    const open = (await harness.pool.query("select attempt_id::text from client_send_custody where fan_ref = $1", [fanRef])).rows[0].attempt_id;
    expect(await act({
      action: "dispatch", pageId, fanRef, userId: me, attemptId: open, instanceId: I1, purpose: "preview-reply",
      group: GROUP, partIndex: 0, textRevision: 1, leaseToken: null, flagRevision: 3,
    }, refuse)).toMatchObject({ ok: true });
    expect(calls).toBe(1);
  });
});

describe("desktop new-follower greetings (critic 1)", () => {
  const cases: Array<[state: string, attempts: number, verifier: unknown, holds: boolean]> = [
    ["queued", 0, null, true], ["in_flight", 1, null, true], ["confirmed", 1, { source: "ofapi_response" }, true],
    ["indeterminate", 1, { source: "stale_recovery" }, true],
    ["failed_retryable", 1, { source: "ofapi_response", httpStatus: 429 }, true],
    ["failed_terminal", 1, { source: "ofapi_response", httpStatus: 400 }, true],
    ["failed_terminal", 1, null, true], ["failed_retryable", 1, {}, true], ["cancelled", 1, null, true],
    ["cancelled", 0, null, false],
    ["failed_retryable", 1, { source: "local_precondition", reason: "key_scope_unavailable" }, false],
    ["failed_terminal", 1, { source: "local_precondition", reason: "binding_replaced" }, false],
    ["failed_terminal", 1, { source: "auth_gate" }, false],
  ];
  const insertCommand = async (fanRef: string, state: string, attempts: number, verifier: unknown, purpose: string | null = "new-follower") => {
    const id = randomUUID();
    await harness.pool.query(
      `insert into ofapi_commands (id, client_command_id, page_id, chatter_user_id, ofapi_account_id, conversation_id,
         outreach_purpose, kind, payload, payload_hash, state, attempt_count, verifier_result, platform_message_id,
         attempt_finished_at, dedupe_expires_at)
       values ($1, $2, $3, $4, 'acct_claim', $5, $6, 'send_text_message_v1', '{}'::jsonb, $7, $8, $9, $10, $11, $12,
         now() + interval '1 day')`,
      [id, randomUUID(), pageId, other, fanRef, purpose, "a".repeat(64), state, attempts, verifier,
        state === "confirmed" ? "9001" : null, state === "confirmed" ? new Date("2026-09-21T10:00:00Z") : null],
    );
    return id;
  };

  it("uses the outbox index's own predicate, row for row", async () => {
    const fans = new Map<string, boolean>();
    for (const [state, attempts, verifier, holds] of cases) {
      const fanRef = nextFan();
      await insertCommand(fanRef, state, attempts, verifier);
      fans.set(fanRef, holds);
    }
    const plainFan = nextFan();
    await insertCommand(plainFan, "queued", 0, null, null);
    fans.set(plainFan, false);
    const predicate = (await harness.pool.query<{ predicate: string }>(
      "select pg_get_expr(i.indpred, i.indrelid) as predicate from pg_index i where i.indexrelid = 'ofapi_commands_follower_outreach_uniq'::regclass",
    )).rows[0]!.predicate;
    const byIndex = new Set((await harness.pool.query<{ conversation_id: string }>(
      `select conversation_id from ofapi_commands where page_id = $1 and conversation_id = any($2::text[]) and (${predicate})`,
      [pageId, [...fans.keys()]],
    )).rows.map((row) => row.conversation_id));
    const desktop = await readDesktopFollowerOutreach(harness.db, pageId, [...fans.keys()]);
    expect(new Set(desktop.keys())).toEqual(byIndex);
    expect(byIndex).toEqual(new Set([...fans].filter(([, holds]) => holds).map(([fanRef]) => fanRef)));
    for (const [fanRef, entry] of desktop) {
      const confirmed = cases[[...fans.keys()].indexOf(fanRef)]![0] === "confirmed";
      expect(entry).toMatchObject(confirmed
        ? { state: "confirmed", messageRef: "9001", at: new Date("2026-09-21T10:00:00Z") }
        : { state: "held", messageRef: null });
    }
  });

  it("blocks a greeting the desktop sent or may have sent, in the fan view and on dispatch", async () => {
    for (const [state, attempts, verifier, holds] of cases) {
      const label = `${state}/${attempts}/${JSON.stringify(verifier)}`;
      const fanRef = nextFan();
      await insertCommand(fanRef, state, attempts, verifier);
      const leaseToken = randomUUID();
      await claim(fanRef, me, I1, leaseToken);
      const view = await readClientFanClaimStatus(harness.db, { pageId, fanRef, userId: me, instanceId: I1, leaseToken });
      expect.soft(view, label).toMatchObject(state === "confirmed"
        ? { greeting: { state: "confirmed", source: "desktop-outbox" }, desktopOutreachHeld: false, lease: { state: "owned" } }
        : { greeting: { state: "none" }, desktopOutreachHeld: holds, lease: { state: "owned" } });
      const expected = !holds ? { ok: true } : state === "confirmed"
        ? { ok: false, code: "greeting_done", view: { greeting: { state: "confirmed", source: "desktop-outbox", messageRef: "9001" } } }
        : { ok: false, code: "custody_held" };
      expect.soft(await dispatch(fanRef, { leaseToken }), label).toMatchObject(expected);
    }
  });
});

describe("the claim GET", () => {
  it("reads every table from one read-only snapshot", async () => {
    const seen: unknown[] = [];
    const spy = new Proxy(harness.db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (run: Parameters<typeof target.transaction>[0], config?: Parameters<typeof target.transaction>[1]) => {
          seen.push(config);
          return target.transaction(run, config);
        };
      },
    });
    const fanRef = nextFan();
    await claim(fanRef);
    expect((await readClientFanClaimStatus(spy, { pageId, fanRef, userId: me, instanceId: I1, leaseToken: null })).lease)
      .toMatchObject({ state: "owned" });
    expect(seen).toEqual([{ isolationLevel: "repeatable read", accessMode: "read only" }]);
  });
});

describe("erasure", () => {
  it("erases a fan's lease, greeting and custody, and a page's, keeping the rest", async () => {
    const fanA = nextFan();
    const fanB = nextFan();
    for (const fanRef of [fanA, fanB]) {
      const leaseToken = randomUUID();
      await claim(fanRef, me, I1, leaseToken);
      const attemptId = randomUUID();
      await dispatch(fanRef, { attemptId, leaseToken });
      await sent(fanRef, attemptId, fanRef === fanA ? "9101" : "9102");
      await dispatch(fanRef, { partIndex: 1 });
    }
    const app = {
      db: harness.db, pool: harness.pool, config: { lakeDir: "/nonexistent-client-claim-lake" },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never;
    const count = async (fanRef: string) => (await harness.pool.query(`
      select (select count(*) from client_fan_leases where fan_ref = $1)::int as leases,
             (select count(*) from client_greetings where fan_ref = $1)::int as greetings,
             (select count(*) from client_send_custody where fan_ref = $1)::int as custody`, [fanRef])).rows[0];
    const scope = { scopeType: "fan", platform: "onlyfans", fanRef: fanA } as const;
    const plan = await planErasure(app, scope);
    for (const [target, rows] of [["client_send_custody", 2], ["client_greetings", 1], ["client_fan_leases", 1]] as const) {
      expect(plan.targets.find((entry) => entry.target === target)).toMatchObject({ rows, action: "delete" });
    }
    await executeErasure(app, scope, { initiatedBy: owner });
    expect(await count(fanA)).toEqual({ leases: 0, greetings: 0, custody: 0 });
    expect(await count(fanB)).toEqual({ leases: 1, greetings: 1, custody: 2 });
    // Another page's erasure leaves them; their own page's takes them.
    await executeErasure(app, { scopeType: "page", pageLabel: "client-claim-fs" }, { initiatedBy: owner });
    expect(await count(fanB)).toEqual({ leases: 1, greetings: 1, custody: 2 });
    await executeErasure(app, { scopeType: "page", pageLabel: "client-claim-of" }, { initiatedBy: owner });
    expect(await count(fanB)).toEqual({ leases: 0, greetings: 0, custody: 0 });
  });
});
