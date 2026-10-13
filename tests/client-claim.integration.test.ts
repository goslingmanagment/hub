import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CLIENT_GREETING_SEND_RATE,
  applyClientClaimAction,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  createUser,
  explainClientLastOwnDispatchQuery,
  readClientFanClaimStatus,
  readClientPreviewSendRetryAfterMs,
  readDesktopFollowerOutreach,
  resolveClientSendCustody,
  type ClientClaimActionInput,
  type ClientClaimGroup,
} from "@agency_hub_core/db";

import { clientClaimActionInput } from "../apps/runtime/src/services/client-claim.ts";
import { executeErasure, planErasure } from "../apps/runtime/src/services/erasure/index.ts";
import * as sdk from "../packages/sdk/src/index.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";

// hub-pr-plan H-7a: the chat-extension lease and custody repository on a real
// Postgres — races under the advisory locks, keys reused across fans, repeats,
// parts, the manual resolve, the desktop outbox's greeting predicate (critic
// 1), the per-user rate lock and the instance-bound reports (critic 12), and
// erasure.

let harness: StartedTestDatabase;
let pageId: number;
let fsPageId: number;
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
  fsPageId = (await createFanslyPage(harness.db, { modelId: model.id, label: "client-claim-fs" }))!.id;
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
    // In flight, not held: `custody` says the part is on its way; heldParts is what nobody can vouch for.
    expect(first).toMatchObject({ ok: true, view: { custody: { attemptId, state: "dispatching" }, group: { heldParts: [], sentParts: [] } } });
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
    // Nor does the dispatcher's own failure report, once the ticket is over: uncertain-held never becomes failed.
    for (const [reason, httpStatus] of [["not_enqueued", null], ["native_rejected", 403]] as const) {
      expect(await act({ action: "failed", pageId, fanRef, userId: me, attemptId, instanceId: I1, reason, httpStatus }))
        .toMatchObject({ ok: false, code: "custody_held", view: { custody: { attemptId, state: "uncertain-held" } } });
    }
    expect(await custodyRow(attemptId)).toMatchObject({ state: "dispatching" });
    // The status read shows the held send to everyone, and nobody's finished one to anybody else.
    for (const userId of [me, other]) {
      expect((await readClientFanClaimStatus(harness.db, { pageId, fanRef, userId, instanceId: null, leaseToken: null })).custody)
        .toMatchObject({ attemptId, state: "uncertain-held", ticket: null });
    }
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
    // The dispatcher's client names no attempt when it reads: it finds its own last send, resolved. Nobody else does.
    expect(await readClientFanClaimStatus(harness.db, { pageId, fanRef, userId: me, instanceId: null, leaseToken: null }))
      .toMatchObject({
        greeting: { state: "none" },
        group: { ...GROUP, sentParts: [], heldParts: [] },
        custody: { attemptId, state: "resolved-not-sent", ticket: null },
      });
    expect(await readClientFanClaimStatus(harness.db, { pageId, fanRef, userId: other, instanceId: null, leaseToken: null }))
      .toMatchObject({ group: null, custody: null });
    // A send to the fan that is open comes first, for its dispatcher too.
    const next = randomUUID();
    expect((await act({
      action: "dispatch", pageId, fanRef, userId: other, attemptId: next, instanceId: I2, purpose: "preview-reply",
      group: { ...GROUP, generationRef: "gen-reply", partCount: 1 }, partIndex: 0, textRevision: 1, leaseToken: null, flagRevision: 3,
    })).ok).toBe(true);
    expect((await readClientFanClaimStatus(harness.db, { pageId, fanRef, userId: me, instanceId: null, leaseToken: null })).custody)
      .toMatchObject({ attemptId: next, state: "dispatching" });
    expect((await act({ action: "failed", pageId, fanRef, userId: other, attemptId: next, instanceId: I2, reason: "not_enqueued", httpStatus: null })).ok)
      .toBe(true);
    // Each reader then finds their own last send.
    expect((await readClientFanClaimStatus(harness.db, { pageId, fanRef, userId: other, instanceId: null, leaseToken: null })).custody)
      .toMatchObject({ attemptId: next, state: "failed" });
    expect((await readClientFanClaimStatus(harness.db, { pageId, fanRef, userId: me, instanceId: null, leaseToken: null })).custody)
      .toMatchObject({ attemptId, state: "resolved-not-sent" });
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
    // Inside the ticket the page may still send the part: "not sent" waits for the ticket to run out.
    expect(await resolveClientSendCustody(harness.db, {
      pageId, attemptId, resolverUserId: owner, outcome: "not_sent", platformMessageId: null, note: "not in the chat",
    })).toMatchObject({ ok: false, code: "ticket_live", view: { custody: { attemptId, state: "dispatching" } } });
    expect(await custodyRow(attemptId)).toMatchObject({ state: "dispatching" });
    await harness.pool.query("update client_send_custody set ticket_expires_at = now() - interval '1 second' where attempt_id = $1", [attemptId]);
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
    // A greeted fan gives no lease to anyone else: nothing to work out but a second greeting.
    expect(await claim(fanRef, other, I2)).toMatchObject({
      ok: false, code: "greeting_done", view: { greeting: { state: "confirmed" }, lease: { state: "none" } },
    });
    expect(await harness.pool.query("select state from client_fan_leases where fan_ref = $1", [fanRef]))
      .toMatchObject({ rows: [{ state: "released" }] });
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
      const commandId = await insertCommand(fanRef, state, attempts, verifier);
      const leaseToken = randomUUID();
      // The command may have greeted: its outcome is unknown, and it reads as a send nobody can vouch for.
      const mayHaveGreeted = holds && state !== "confirmed";
      const uncertain = { attemptId: commandId, state: "uncertain-held", ticket: null, ticketExpiresAt: null };
      // A fan the desktop greeted, or may have, has no greeting left to work out: nobody takes a lease on it.
      expect.soft(await claim(fanRef, me, I1, leaseToken), label).toMatchObject(state === "confirmed"
        ? { ok: false, code: "greeting_done", view: { lease: { state: "none" } } }
        : mayHaveGreeted
          ? { ok: false, code: "custody_held", view: { lease: { state: "none" }, custody: uncertain } }
          : { ok: true, view: { lease: { state: "owned" } } });
      const view = await readClientFanClaimStatus(harness.db, { pageId, fanRef, userId: me, instanceId: I1, leaseToken });
      expect.soft(view, label).toMatchObject(state === "confirmed"
        ? { greeting: { state: "confirmed", source: "desktop-outbox" }, desktopOutreachHeld: false, lease: { state: "none" }, custody: null }
        : mayHaveGreeted
          ? { greeting: { state: "none" }, desktopOutreachHeld: true, lease: { state: "none" }, custody: uncertain }
          // Cancelled before any attempt, or refused before it left the hub: the fan is free.
          : { greeting: { state: "none" }, desktopOutreachHeld: false, lease: { state: "owned" }, custody: null });
      expect.soft((await harness.pool.query("select 1 from client_fan_leases where fan_ref = $1", [fanRef])).rowCount, label)
        .toBe(mayHaveGreeted || state === "confirmed" ? 0 : 1);
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

  it("finds the reader's own last dispatch through the fan's index, not by walking the reader's sends", async () => {
    // One chatter with 20,000 past sends from the preview to 4,000 fans, in every final state.
    const busy = (await createUser(harness.db, { username: "claim-busy", role: "chatter" }))!.id;
    await harness.pool.query(
      `insert into client_send_custody (attempt_id, page_id, fan_ref, user_id, instance_id, purpose, origin, generation_ref,
         variant, part_count, part_index, text_revision, request_hash, state, ticket_hash, ticket_expires_at,
         platform_message_id, failure_reason, resolved_by_user_id, resolved_at, resolution_note, created_at, updated_at)
       select gen_random_uuid(), $1, (800000000 + g % 4000)::text, $2, $3, 'preview-reply', 'preview-send', 'gen-plan-' || g,
         0, 1, 0, 1, sha256(g::text::bytea), state, sha256(g::text::bytea), at + interval '10 seconds',
         case state when 'sent' then (810000000 + g)::text end,
         case state when 'failed' then 'not_enqueued' end,
         case state when 'resolved_not_sent' then $4::bigint end,
         case state when 'resolved_not_sent' then at end,
         case state when 'resolved_not_sent' then 'not in the chat' end,
         at, at
       from (select g, (array['sent', 'failed', 'resolved_not_sent'])[1 + g % 3] as state,
               now() - interval '1 day' - (g || ' seconds')::interval as at
             from generate_series(1, 20000) g) rows`,
      [pageId, busy, I1, owner],
    );
    await harness.pool.query("analyze client_send_custody");

    // A fan the chatter sent to, and one they never did (the walk that would read all 20,000).
    for (const fanRef of ["800000007", "899999999"]) {
      const plan = await explainClientLastOwnDispatchQuery(harness.db, { pageId, fanRef, userId: busy });
      expect(plan, plan).toContain("client_send_custody_fan");
      expect(plan, plan).not.toContain("client_send_custody_rate");
      expect(plan, plan).not.toMatch(/Seq Scan/);
    }
    // And it is the newest of the fan's five that the read reports, in the state it ended.
    const newest = (await harness.pool.query<{ attempt_id: string; state: string }>(
      `select attempt_id::text, state from client_send_custody where page_id = $1 and fan_ref = '800000007' and user_id = $2
       order by created_at desc limit 1`,
      [pageId, busy],
    )).rows[0]!;
    expect((await readClientFanClaimStatus(harness.db, { pageId, fanRef: "800000007", userId: busy, instanceId: null, leaseToken: null })).custody)
      .toMatchObject({ attemptId: newest.attempt_id, state: newest.state.replaceAll("_", "-"), ticket: null });
    expect((await readClientFanClaimStatus(harness.db, { pageId, fanRef: "899999999", userId: busy, instanceId: null, leaseToken: null })).custody)
      .toBeNull();
  });
});

describe("a manual greeting on a Fansly page (R20 HF-3)", () => {
  // The route refuses every Fansly action that starts something until HF-2 lists Fansly for
  // `newcomers` (tests/client-claim-routes.integration.test.ts). Under it the rules are these: each
  // body is what the extension's SDK lets out (its own schema), handed to the repository exactly as
  // the route hands it (clientClaimActionInput), with the rate the platform's admission names.
  // Fansly fan and message ids are 18 to 19 digits: past a double's exact integers.
  let fsFanSeq = 5_123_456_789_012_345_000n;
  const nextFsFan = () => String(++fsFanSeq);
  let fsMessageSeq = 8_123_456_789_012_345_000n;
  const nextFsMessage = () => String(++fsMessageSeq);
  const fingerprintOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const manual = (text: string) => ({ kind: "manual", textFingerprint: fingerprintOf(text) });
  const sdkBody = sdk.routeSchemas.clientFanClaim.body;
  const fsAct = (fanRef: string, userId: number, body: Record<string, unknown>) =>
    act(clientClaimActionInput(sdkBody.parse(body), { pageId: fsPageId, fanRef, userId }, CLIENT_GREETING_SEND_RATE));
  const fsClaim = (fanRef: string, userId: number, instanceId: string, leaseToken: string) =>
    fsAct(fanRef, userId, { action: "claim", leaseToken, instanceId });
  const fsDispatch = (fanRef: string, userId: number, body: { instanceId: string; leaseToken: string; text: string; attemptId?: string }) =>
    fsAct(fanRef, userId, {
      action: "dispatch", attemptId: body.attemptId ?? randomUUID(), instanceId: body.instanceId, purpose: "greeting",
      group: manual(body.text), partIndex: 0, textRevision: 2, leaseToken: body.leaseToken, flagRevision: 0,
    });
  const fsSent = (fanRef: string, userId: number, attemptId: string, platformMessageId: string, instanceId = I1) =>
    fsAct(fanRef, userId, { action: "sent", attemptId, instanceId, platformMessageId, evidence: "receipt+echo" });
  const fsStatus = (fanRef: string, userId = me) =>
    readClientFanClaimStatus(harness.db, { pageId: fsPageId, fanRef, userId, instanceId: null, leaseToken: null });
  /** Whatever an AI request would leave behind: a generation's record and its spend. */
  const aiRows = async () => (await harness.pool.query(`
    select (select count(*) from ai_generation_content)::int as generations,
           (select count(*) from ai_usage_events)::int as usage`)).rows[0];
  const fsCustodyRows = async (fanRef: string) => (await harness.pool.query(
    `select attempt_id::text, page_id::int, fan_ref, purpose, origin, generation_ref, variant, part_count, part_index,
       state, platform_message_id, ticket_hash is not null as ticketed
     from client_send_custody where fan_ref = $1 order by created_at, attempt_id`,
    [fanRef],
  )).rows;

  it("goes from claim to sent with no AI request at all, through the SDK's own schema", async () => {
    const before = await aiRows();
    const fanRef = nextFsFan();
    const text = "Привет! Рада, что ты здесь 💛";
    const groupRef = `manual:${fingerprintOf(text)}`;
    const leaseToken = randomUUID();
    expect(await fsClaim(fanRef, me, I1, leaseToken)).toMatchObject({ ok: true, view: { lease: { state: "owned", leaseToken } } });
    const attemptId = randomUUID();
    const dispatched = await fsDispatch(fanRef, me, { attemptId, instanceId: I1, leaseToken, text });
    expect(dispatched).toMatchObject({
      ok: true,
      view: {
        custody: { attemptId, state: "dispatching" },
        group: { generationRef: groupRef, variant: 0, partCount: 1, sentParts: [], heldParts: [] },
      },
    });
    expect(dispatched.view.custody!.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const messageId = nextFsMessage();
    expect(await fsSent(fanRef, me, attemptId, messageId)).toMatchObject({
      ok: true,
      view: {
        greeting: { state: "confirmed", source: "preview-send", messageRef: messageId },
        custody: { attemptId, state: "sent" },
        group: { generationRef: groupRef, sentParts: [0], heldParts: [] },
      },
    });
    // Kept as one more group, ids as exact text: no table changed for it.
    expect(await fsCustodyRows(fanRef)).toEqual([{
      attempt_id: attemptId, page_id: fsPageId, fan_ref: fanRef, purpose: "greeting", origin: "preview-send",
      generation_ref: groupRef, variant: 0, part_count: 1, part_index: 0, state: "sent", platform_message_id: messageId,
      ticketed: true,
    }]);
    expect((await harness.pool.query(
      "select generation_ref, variant, part_count, first_message_ref, source from client_greetings where page_id = $1 and fan_ref = $2",
      [fsPageId, fanRef],
    )).rows).toEqual([{ generation_ref: groupRef, variant: 0, part_count: 1, first_message_ref: messageId, source: "preview-send" }]);
    // Nothing an AI request leaves behind.
    expect(await aiRows()).toEqual(before);
    // Everyone reads the fan as greeted, and nobody greets again: not another text, not another person.
    expect(await fsStatus(fanRef, other)).toMatchObject({ greeting: { state: "confirmed", messageRef: messageId }, custody: null });
    expect(await fsDispatch(fanRef, me, { instanceId: I1, leaseToken, text: `${text} ` }))
      .toMatchObject({ ok: false, code: "generation_mismatch" });
    expect(await fsDispatch(fanRef, me, { instanceId: I1, leaseToken, text })).toMatchObject({ ok: false, code: "part_already_sent" });
    expect(await fsClaim(fanRef, other, I2, randomUUID())).toMatchObject({ ok: false, code: "greeting_done" });
  });

  it("two clients press «Отправить» at once: one ticket, so one POST", async () => {
    const fanRef = nextFsFan();
    const text = "Hey, thanks for following!";
    const clients = [
      { userId: me, instanceId: I1, leaseToken: randomUUID() },
      { userId: me, instanceId: I2, leaseToken: randomUUID() },
      { userId: other, instanceId: I2, leaseToken: randomUUID() },
    ];
    // Two people and a second install of one of them take the fan at once: one lease.
    const claims = await Promise.all(clients.map((client) => fsClaim(fanRef, client.userId, client.instanceId, client.leaseToken)));
    expect(claims.filter((result) => result.ok)).toHaveLength(1);
    // Each sends its own attempt at once, the same text: one ticket.
    const sends = await Promise.all(clients.map((client) => fsDispatch(fanRef, client.userId, { ...client, text })));
    const admitted = sends.filter((result) => result.ok && result.view.custody?.ticket);
    expect(admitted).toHaveLength(1);
    // The others meet the lease, or the winner's send once it is in.
    const refused = sends.flatMap((result) => (result.ok ? [] : [result.code]));
    expect(refused).toHaveLength(2);
    for (const code of refused) expect(["claim_busy", "custody_held"]).toContain(code);
    const winner = clients[claims.findIndex((result) => result.ok)]!;
    const attemptId = admitted[0]!.view.custody!.attemptId;
    // A second tab of the winning install, its own attempt under the same lease: held, no ticket.
    expect(await fsDispatch(fanRef, winner.userId, { ...winner, text })).toMatchObject({
      ok: false, code: "custody_held", view: { custody: { attemptId, state: "dispatching", ticket: null } },
    });
    // The winner lost the answer and asks again: it reads, never a second ticket.
    expect(await fsDispatch(fanRef, winner.userId, { ...winner, text, attemptId })).toMatchObject({
      ok: true, view: { custody: { attemptId, state: "dispatching", ticket: null } },
    });
    expect((await fsCustodyRows(fanRef)).map((row) => [row.attempt_id, row.state, row.ticketed])).toEqual([[attemptId, "dispatching", true]]);
  });

  it("an attempt the client cannot vouch for after a restart holds the fan until proof: no retry, no failure", async () => {
    const fanRef = nextFsFan();
    const text = "Hi! Welcome 🌸";
    const leaseToken = randomUUID();
    await fsClaim(fanRef, me, I1, leaseToken);
    const attemptId = randomUUID();
    expect(await fsDispatch(fanRef, me, { attemptId, instanceId: I1, leaseToken, text })).toMatchObject({ ok: true });
    // The intent was written; the browser died before the answer was known; the ticket ran out.
    await harness.pool.query("update client_send_custody set ticket_expires_at = now() - interval '1 second' where attempt_id = $1", [attemptId]);
    await harness.pool.query("update client_fan_leases set expires_at = now() - interval '1 second' where lease_id = $1", [leaseToken]);
    // After the restart the background reads the fan: its own attempt, held.
    expect(await fsStatus(fanRef)).toMatchObject({
      custody: { attemptId, state: "uncertain-held", ticket: null },
      group: { generationRef: `manual:${fingerprintOf(text)}`, sentParts: [], heldParts: [0] },
    });
    expect(await fsStatus(fanRef, other)).toMatchObject({ custody: { attemptId, state: "uncertain-held" } });
    // Its own repeat only reads.
    expect(await fsDispatch(fanRef, me, { attemptId, instanceId: I1, leaseToken, text }))
      .toMatchObject({ ok: true, view: { custody: { attemptId, state: "uncertain-held", ticket: null } } });
    // A new attempt, its own after a fresh lease or a colleague's, gets no ticket.
    const again = randomUUID();
    expect((await fsClaim(fanRef, me, I1, again)).ok).toBe(true);
    expect(await fsDispatch(fanRef, me, { instanceId: I1, leaseToken: again, text })).toMatchObject({ ok: false, code: "custody_held" });
    await harness.pool.query("update client_fan_leases set expires_at = now() - interval '1 second' where lease_id = $1", [again]);
    const theirs = randomUUID();
    expect((await fsClaim(fanRef, other, I2, theirs)).ok).toBe(true);
    expect(await fsDispatch(fanRef, other, { instanceId: I2, leaseToken: theirs, text: "Привет!" }))
      .toMatchObject({ ok: false, code: "custody_held" });
    // Past the ticket nothing it could report frees the fan: not a proof of failure, not a 2xx that says it failed.
    for (const body of [
      { action: "failed", attemptId, instanceId: I1, reason: "not_enqueued" },
      { action: "failed", attemptId, instanceId: I1, reason: "native_rejected", httpStatus: 403 },
    ]) {
      expect(await fsAct(fanRef, me, body), JSON.stringify(body)).toMatchObject({ ok: false, code: "custody_held" });
    }
    expect(sdkBody.safeParse({ action: "failed", attemptId, instanceId: I1, reason: "native_rejected", httpStatus: 200 }).success)
      .toBe(false);
    expect((await fsCustodyRows(fanRef)).map((row) => [row.attempt_id, row.state])).toEqual([[attemptId, "dispatching"]]);
    // The late proof (its receipt and echo found after all) ends it.
    const messageId = nextFsMessage();
    expect(await fsSent(fanRef, me, attemptId, messageId)).toMatchObject({
      ok: true, view: { greeting: { state: "confirmed", messageRef: messageId }, custody: { attemptId, state: "sent" } },
    });
  });

  it("keeps Fansly ids of 18 and 19 digits apart when they are one double apart", async () => {
    const [a, b] = ["1234567890123456789", "1234567890123456790"];
    const [messageA, messageB] = ["9223372036854775806", "9223372036854775807"];
    expect(Number(a)).toBe(Number(b));
    expect(Number(messageA)).toBe(Number(messageB));
    const text = "Hello!";
    const leaseA = randomUUID();
    const leaseB = randomUUID();
    expect((await fsClaim(a, me, I1, leaseA)).ok).toBe(true);
    // Another fan: not busy, not held.
    expect((await fsClaim(b, other, I2, leaseB)).ok).toBe(true);
    const attemptA = randomUUID();
    const attemptB = randomUUID();
    expect((await fsDispatch(a, me, { attemptId: attemptA, instanceId: I1, leaseToken: leaseA, text })).ok).toBe(true);
    expect((await fsDispatch(b, other, { attemptId: attemptB, instanceId: I2, leaseToken: leaseB, text })).ok).toBe(true);
    expect((await fsSent(a, me, attemptA, messageA)).ok).toBe(true);
    // A message id is the proof of one send per page: its neighbour is another message.
    expect((await fsSent(b, other, attemptB, messageB, I2)).ok).toBe(true);
    expect(await fsStatus(a)).toMatchObject({ greeting: { messageRef: messageA } });
    expect(await fsStatus(b)).toMatchObject({ greeting: { messageRef: messageB } });
    expect((await harness.pool.query(
      "select fan_ref, platform_message_id from client_send_custody where page_id = $1 and fan_ref = any($2::text[]) order by fan_ref",
      [fsPageId, [a, b]],
    )).rows).toEqual([{ fan_ref: a, platform_message_id: messageA }, { fan_ref: b, platform_message_id: messageB }]);
    // An 18-digit id is a fan as well.
    expect((await fsClaim("512345678901234567", me, I1, randomUUID())).ok).toBe(true);
    // Erasing one of them takes its rows and leaves its neighbour's.
    const app = {
      db: harness.db, pool: harness.pool, config: { lakeDir: "/nonexistent-client-claim-lake" },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never;
    await executeErasure(app, { scopeType: "fan", platform: "fansly", fanRef: a }, { initiatedBy: owner });
    const left = async (fanRef: string) => (await harness.pool.query(`
      select (select count(*) from client_fan_leases where fan_ref = $1)::int as leases,
             (select count(*) from client_greetings where fan_ref = $1)::int as greetings,
             (select count(*) from client_send_custody where fan_ref = $1)::int as custody`, [fanRef])).rows[0];
    expect(await left(a)).toEqual({ leases: 0, greetings: 0, custody: 0 });
    expect(await left(b)).toEqual({ leases: 1, greetings: 1, custody: 1 });
  });

  it("a Fansly greeting counts toward its own rate, never toward OnlyFans' sends from the preview", async () => {
    const user = (await createUser(harness.db, { username: "claim-fs-rate", role: "chatter" }))!.id;
    const ofReply = () => act({
      action: "dispatch", pageId, fanRef: nextFan(), userId: user, attemptId: randomUUID(), instanceId: I1,
      purpose: "preview-reply", group: GROUP, partIndex: 0, textRevision: 1, leaseToken: null, flagRevision: null,
    });
    // Six sends from the preview on OnlyFans: the whole of that window.
    for (let n = 0; n < 6; n += 1) {
      expect((await ofReply()).ok).toBe(true);
    }
    // Thirty-one Fansly greetings at once, each under its own lease: exactly thirty, the six not counted.
    const fans = Array.from({ length: 31 }, () => ({ fanRef: nextFsFan(), leaseToken: randomUUID() }));
    const leases = await Promise.all(fans.map((fan) => fsClaim(fan.fanRef, user, I1, fan.leaseToken)));
    expect(leases.every((result) => result.ok)).toBe(true);
    const greetings = await Promise.all(fans.map((fan) =>
      fsDispatch(fan.fanRef, user, { instanceId: I1, leaseToken: fan.leaseToken, text: `Hi ${fan.fanRef}` })));
    expect(greetings.filter((result) => result.ok)).toHaveLength(30);
    expect(greetings.filter((result) => !result.ok).map((result) => !result.ok && result.code)).toEqual(["preview_send_rate_limited"]);
    // And the thirty never held back OnlyFans: its own window is what refuses the seventh.
    expect(await ofReply()).toMatchObject({ ok: false, code: "preview_send_rate_limited" });
    // Each window advises on its own wait: OnlyFans' oldest of six came before Fansly's oldest of thirty.
    const fanslyWait = await readClientPreviewSendRetryAfterMs(harness.db, { userId: user, pageId: fsPageId, rate: CLIENT_GREETING_SEND_RATE });
    const onlyFansWait = await readClientPreviewSendRetryAfterMs(harness.db, { userId: user, pageId });
    expect(fanslyWait).toBeLessThanOrEqual(60_000);
    expect(onlyFansWait).toBeGreaterThan(0);
    expect(onlyFansWait).toBeLessThan(fanslyWait);
    expect(await readClientPreviewSendRetryAfterMs(harness.db, { userId: me, pageId: fsPageId, rate: CLIENT_GREETING_SEND_RATE }))
      .toBe(0);
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
