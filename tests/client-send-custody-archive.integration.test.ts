import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CLIENT_GREETING_SEND_RATE,
  applyClientClaimAction,
  closeHeldSendOnArchiveProof,
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  createUser,
  listHeldSendsForArchiveProof,
  readClientFanClaimStatus,
  resolveClientSendCustody,
  type ClientClaimGroup,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { runClientSendArchiveSweep } from "../apps/runtime/src/services/client-send-custody-archive.ts";
import { startIntegrationTestDatabase, type StartedTestDatabase } from "./helpers/db.ts";
import { armNoOutboundTrap } from "./helpers/no-outbound.ts";

// A Fansly greeting held only because Fansly's live channel dropped its echo
// (owner, 2026-11-07): Hub closes it as sent, for the install that dispatched
// it, once its own archive of the page has that very message. On a real
// Postgres: the evidence SQL, the close through the claim rules under the fan's
// lock, the journal, the greeting the openers' A/B reads, the races with the
// extension's own report, and nothing leaving the process. The rule itself is
// tests/client-send-custody-archive.test.ts.

let harness: StartedTestDatabase;
let pageId: number;
let ofPageId: number;
let me: number;
let other: number;
let owner: number;
const I1 = randomUUID();
// Fansly fan, chat and message ids are 18 to 19 digits.
let seq = 5_223_456_789_012_345_000n;
const nextId = () => String(++seq);
const GROUP: ClientClaimGroup = { generationRef: "gen-archive", variant: 0, partCount: 1 };

beforeAll(async () => {
  const started = await startIntegrationTestDatabase();
  if (!started) throw new Error("Docker Postgres is required");
  harness = started;
  const model = (await createModel(harness.db, { slug: "custody-archive", name: "Custody archive" }))!;
  pageId = (await createFanslyPage(harness.db, { modelId: model.id, label: "custody-archive-fs" }))!.id;
  ofPageId = (await createOnlyFansPage(harness.db, { modelId: model.id, label: "custody-archive-of" }))!.id;
  me = (await createUser(harness.db, { username: "archive-me", role: "chatter" }))!.id;
  other = (await createUser(harness.db, { username: "archive-other", role: "chatter" }))!.id;
  owner = (await createUser(harness.db, { username: "archive-owner", role: "owner" }))!.id;
}, 120_000);
afterAll(async () => { await harness?.stop(); });

const query = async (text: string, values: unknown[] = []) => (await harness.pool.query(text, values)).rows;

/** A greeting dispatched ten minutes ago whose ticket ran out with no report: held. */
async function held(input: { page?: number; userId?: number; group?: ClientClaimGroup } = {}) {
  const page = input.page ?? pageId;
  const fanRef = nextId();
  const attemptId = randomUUID();
  const result = await applyClientClaimAction(harness.db, {
    action: "dispatch", pageId: page, fanRef, userId: input.userId ?? me, attemptId, instanceId: I1, purpose: "greeting",
    group: input.group ?? GROUP, partIndex: 0, textRevision: 1, leaseToken: null, flagRevision: 0, rate: CLIENT_GREETING_SEND_RATE,
  });
  expect(result.ok).toBe(true);
  await harness.pool.query(
    `update client_send_custody set created_at = created_at - interval '10 minutes',
       ticket_expires_at = created_at - interval '10 minutes' + interval '10 seconds' where attempt_id = $1`,
    [attemptId],
  );
  const dispatchedAt = new Date((await query("select created_at from client_send_custody where attempt_id = $1", [attemptId]))[0].created_at);
  return { page, fanRef, attemptId, dispatchedAt, chat: nextId() };
}
type Held = Awaited<ReturnType<typeof held>>;

/** The extension's report of the send, the receipt's id (client_send_attributions). */
async function attribute(send: Held, messageId: string, input: { offsetMs?: number; userId?: number; chat?: string } = {}) {
  await harness.pool.query(
    `insert into client_send_attributions (platform, page_id, platform_message_id, fan_ref, conversation_ref, user_id, source,
       priced, with_media, observed_at, composed_with)
     values ('fansly', $1, $2, $3, $4, $5, 'fansly-extension', false, false, $6, 'hi')`,
    [send.page, messageId, send.fanRef, input.chat ?? send.chat, input.userId ?? me,
      new Date(send.dispatchedAt.getTime() + (input.offsetMs ?? -800))],
  );
}

/** The page's own archive copy of the message (message_archive). */
async function archive(send: Held, messageId: string, input: { sentByMe?: boolean; deleted?: boolean; chat?: string } = {}) {
  const occurredAt = new Date(send.dispatchedAt.getTime() - 300);
  await harness.pool.query(
    `insert into message_archive (account_id, platform, conversation_ref, message_ref, sender_role, is_sent_by_me, occurred_at,
       text_plain, deleted_at)
     values ($1, 'fansly', $2, $3, 'model', $4, $5, 'hey you', $6)`,
    [send.page, input.chat ?? send.chat, messageId, input.sentByMe ?? true, occurredAt, input.deleted ? new Date() : null],
  );
  return occurredAt;
}

const custody = async (attemptId: string) =>
  (await query("select state, platform_message_id from client_send_custody where attempt_id = $1", [attemptId]))[0];
const greeting = async (send: Held) => (await query(
  "select confirmed_at, first_message_ref, first_attempt_id::text, source, generation_ref, variant, part_count from client_greetings where page_id = $1 and fan_ref = $2",
  [send.page, send.fanRef],
))[0];
const proofs = async (send: Held) => query(
  "select account_id::int, platform, source, producer, payload from observations where kind = 'client.send_custody_archive_proof.v1' and payload->>'attemptId' = $1",
  [send.attemptId],
);
const ref = (send: Held) => ({ attemptId: send.attemptId, pageId: send.page, fanRef: send.fanRef });
const logger = { info() {}, warn() {}, error() {} } as unknown as AppContext["logger"];

describe("closing a held Fansly greeting on the archive's copy", () => {
  it("closes it once, for the install that dispatched it, journaled first, and nothing leaves the process", async () => {
    const send = await held();
    const messageId = nextId();
    await attribute(send, messageId);
    const sentAt = await archive(send, messageId);
    expect((await listHeldSendsForArchiveProof(harness.db, { limit: 100 })).map((row) => row.attemptId)).toContain(send.attemptId);

    const trap = await armNoOutboundTrap(harness);
    try {
      const tally = await runClientSendArchiveSweep({ db: harness.db, logger });
      expect(tally.closed).toBeGreaterThanOrEqual(1);
      await trap.assertNoOutbound();
    } finally {
      await trap.restore();
    }

    expect(await custody(send.attemptId)).toEqual({ state: "sent", platform_message_id: messageId });
    // The greeting the openers' A/B reads: its group, its message, dated by the archive's copy.
    expect(await greeting(send)).toEqual({
      confirmed_at: sentAt, first_message_ref: messageId, first_attempt_id: send.attemptId, source: "preview-send",
      generation_ref: GROUP.generationRef, variant: 0, part_count: 1,
    });
    const journal = await proofs(send);
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      account_id: pageId, platform: "fansly", source: "operator", producer: "hub:send-custody-archive",
      payload: { attemptId: send.attemptId, fanRef: send.fanRef, platformMessageId: messageId, userId: me, instanceId: I1 },
    });
    // Everyone reads the fan as greeted; the held list no longer has it.
    expect(await readClientFanClaimStatus(harness.db, { pageId, fanRef: send.fanRef, userId: other, instanceId: null, leaseToken: null }))
      .toMatchObject({ greeting: { state: "confirmed", messageRef: messageId }, custody: null });
    expect((await listHeldSendsForArchiveProof(harness.db, { limit: 100 })).map((row) => row.attemptId)).not.toContain(send.attemptId);

    // Again: nothing to do, nothing written.
    expect(await closeHeldSendOnArchiveProof(harness.db, ref(send))).toEqual({ outcome: "skipped", reason: "not_held" });
    expect(await proofs(send)).toHaveLength(1);
    // The extension's late report of the same message changes nothing; another message conflicts.
    const late = { action: "sent", pageId, fanRef: send.fanRef, userId: me, attemptId: send.attemptId, instanceId: I1 } as const;
    expect(await applyClientClaimAction(harness.db, { ...late, platformMessageId: messageId })).toMatchObject({ ok: true });
    expect(await applyClientClaimAction(harness.db, { ...late, platformMessageId: nextId() }))
      .toMatchObject({ ok: false, code: "attempt_conflict" });
    expect(await greeting(send)).toMatchObject({ confirmed_at: sentAt, first_message_ref: messageId });
  });

  it("leaves a send untouched when any part of the proof is missing", async () => {
    const cases: Array<[string, (send: Held, messageId: string) => Promise<void>]> = [
      ["no_attribution", async (send, messageId) => { await archive(send, messageId); }],
      ["no_attribution", async (send, messageId) => { await attribute(send, messageId, { userId: other }); await archive(send, messageId); }],
      ["no_attribution", async (send, messageId) => { await attribute(send, messageId, { offsetMs: 31_000 }); await archive(send, messageId); }],
      ["not_in_archive", async (send, messageId) => { await attribute(send, messageId); }],
      ["not_in_archive", async (send, messageId) => { await attribute(send, messageId); await archive(send, messageId, { deleted: true }); }],
      ["not_in_archive", async (send, messageId) => { await attribute(send, messageId); await archive(send, messageId, { sentByMe: false }); }],
      ["not_in_archive", async (send, messageId) => { await attribute(send, messageId); await archive(send, messageId, { chat: nextId() }); }],
      ["ambiguous", async (send, messageId) => {
        const hand = nextId();
        await attribute(send, messageId); await archive(send, messageId);
        await attribute(send, hand, { offsetMs: 9_000 }); await archive(send, hand);
      }],
    ];
    for (const [reason, prepare] of cases) {
      const send = await held();
      await prepare(send, nextId());
      expect(await closeHeldSendOnArchiveProof(harness.db, ref(send)), reason).toEqual({ outcome: "skipped", reason });
      expect(await custody(send.attemptId)).toEqual({ state: "dispatching", platform_message_id: null });
      expect(await greeting(send)).toBeUndefined();
      expect(await proofs(send)).toEqual([]);
    }
  });

  it("does not take a message id another send already carries", async () => {
    // Another fan's send carries the id (a native send registered for it): the proof is not this send's.
    const send = await held();
    const messageId = nextId();
    await attribute(send, messageId);
    await archive(send, messageId);
    const otherFan = nextId();
    expect(await applyClientClaimAction(harness.db, {
      action: "registerNativeSend", pageId, fanRef: otherFan, userId: other, attemptId: randomUUID(), instanceId: randomUUID(),
      purpose: "greeting", group: { generationRef: "gen-other", variant: 0, partCount: 1 }, partIndex: 0, platformMessageId: messageId,
    })).toMatchObject({ ok: true });
    expect(await closeHeldSendOnArchiveProof(harness.db, ref(send))).toEqual({ outcome: "skipped", reason: "taken" });
    expect(await custody(send.attemptId)).toEqual({ state: "dispatching", platform_message_id: null });
  });

  it("loses cleanly to the extension's own report and to a manual resolve", async () => {
    // The extension's report and the sweep at once: one of them closes it, with one greeting, and the
    // journal has the proof exactly when the sweep was the one (its greeting is dated by the copy).
    const send = await held();
    const messageId = nextId();
    await attribute(send, messageId);
    const sentAt = await archive(send, messageId);
    const [extension, sweep] = await Promise.all([
      applyClientClaimAction(harness.db, {
        action: "sent", pageId, fanRef: send.fanRef, userId: me, attemptId: send.attemptId, instanceId: I1, platformMessageId: messageId,
      }),
      closeHeldSendOnArchiveProof(harness.db, ref(send)),
    ]);
    expect(extension.ok).toBe(true);
    expect(["closed", "skipped", "unproven", "unchanged"]).toContain(sweep.outcome);
    expect(await custody(send.attemptId)).toEqual({ state: "sent", platform_message_id: messageId });
    const row = await greeting(send);
    expect(row.first_message_ref).toBe(messageId);
    expect((await proofs(send)).length).toBe(sweep.outcome === "closed" ? 1 : 0);
    expect(row.confirmed_at.getTime() === sentAt.getTime()).toBe(sweep.outcome === "closed");

    // A person resolved it by hand first: Hub leaves it be.
    const resolved = await held();
    const resolvedId = nextId();
    await attribute(resolved, resolvedId);
    await archive(resolved, resolvedId);
    expect(await resolveClientSendCustody(harness.db, {
      pageId, attemptId: resolved.attemptId, resolverUserId: owner, outcome: "not_sent", platformMessageId: null, note: "checked",
    })).toMatchObject({ ok: true });
    expect(await closeHeldSendOnArchiveProof(harness.db, ref(resolved))).toEqual({ outcome: "skipped", reason: "not_held" });
    expect(await custody(resolved.attemptId)).toEqual({ state: "resolved_not_sent", platform_message_id: null });
  });

  it("lists only Fansly one-part greetings past their ticket and the grace", async () => {
    const fresh = await held();
    await harness.pool.query(
      "update client_send_custody set ticket_expires_at = now() - interval '30 seconds' where attempt_id = $1",
      [fresh.attemptId],
    );
    const twoParts = await held({ group: { generationRef: "gen-two", variant: 0, partCount: 2 } });
    const onlyfans = await held({ page: ofPageId });
    const listed = (await listHeldSendsForArchiveProof(harness.db, { limit: 100 })).map((row) => row.attemptId);
    for (const send of [fresh, twoParts, onlyfans]) expect(listed).not.toContain(send.attemptId);
  });
});
