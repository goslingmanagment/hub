import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createFanslyPage,
  createModel,
  createOnlyFansPage,
  DM_ARCHIVE_ERASURE_FENCE_LOCK_NS,
  getVoiceNoteByClientRequestId,
  getVoiceNoteById,
  insertErasureLog,
  insertAiGenerationContent,
  releaseStaleIndeterminateVoiceBudgets,
  sweepVoiceNotes,
  upsertVoiceProfile,
  type VoiceNoteRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../apps/runtime/src/bootstrap.ts";
import { createUserAccount } from "../apps/runtime/src/services/auth.ts";
import type { HumanAuthPrincipal } from "../apps/runtime/src/services/auth.ts";
import { type VoiceTtsProvider } from "../apps/runtime/src/services/voice-elevenlabs-provider.ts";
import {
  createVoiceNote,
  dispatchVoiceNote,
  getVoiceNoteAudio,
  getVoiceNoteStatus,
  type CreateVoiceNoteBody,
} from "../apps/runtime/src/services/voice-notes.ts";
import { sha256Hex } from "../apps/runtime/src/services/voice-script-validation.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";
import { createTestAppContext } from "./helpers/runtime.ts";

// Task 5 — the voice-notes service: admission, idempotent replay, single-CAS
// dispatch, fenced settle. The provider here is a CONTROLLED FAKE (never a mock
// of the service under test); the DB is the real Docker Postgres.

const CONVERSATION_REF = "conv-777";
const SCRIPT = "hello [warmly] world"; // 20 chars, one allowlisted tag
const SCRIPT_CHARS = SCRIPT.length;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 4000);
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(opts.intervalMs ?? 15);
  }
  throw new Error("waitFor: condition not met before timeout");
}

interface FakeProvider {
  provider: VoiceTtsProvider;
  state: { calls: number };
}

type SynthResult = Awaited<ReturnType<VoiceTtsProvider["synthesize"]>>;

function fakeProvider(handler: () => Promise<SynthResult> | SynthResult): FakeProvider {
  const state = { calls: 0 };
  return {
    state,
    provider: {
      async synthesize() {
        state.calls += 1;
        return handler();
      },
    },
  };
}

function okAudio(characterCost: number | null): Extract<SynthResult, { ok: true }> {
  return {
    ok: true,
    audio: Buffer.from("fake-mp3-bytes-payload"),
    characterCost,
    requestId: "prov-req-1",
    traceId: "prov-trace-1",
    region: "us-east-1",
  };
}

let testDb: StartedTestDatabase | null = null;
let appContext: AppContext;

beforeAll(async () => {
  testDb = await startIntegrationTestDatabase();
}, 120_000);

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async (context) => {
  if (!testDb) {
    context.skip();
    return;
  }
  await resetIntegrationDatabase(testDb.pool);
  appContext = createTestAppContext(testDb);
});

interface Provisioned {
  page: { id: number; label: string };
  principal: HumanAuthPrincipal;
  sourceRef: string;
  body: (overrides?: Partial<CreateVoiceNoteBody>) => CreateVoiceNoteBody;
}

async function provision(opts?: {
  script?: string;
  scriptMaxChars?: number;
  pageBudget?: number;
  globalBudget?: number;
  enabled?: boolean;
  allowlisted?: boolean;
  retrievalEnabled?: boolean;
  withProfile?: boolean;
  sourceOutcome?: string;
  sourceFeature?: string;
  sourceStopReason?: string;
  sourceConversationRef?: string;
  sourceFanRef?: string | null;
  provider?: VoiceTtsProvider;
  maxConcurrentSyntheses?: number;
  /** The page's platform; Fansly unless an OnlyFans page is asked for. */
  platform?: "fansly" | "onlyfans";
}): Promise<Provisioned> {
  const model = await createModel(appContext.db, { slug: "voice", name: "Voice" });
  if (!model) {
    throw new Error("createModel returned no row");
  }
  const page = opts?.platform === "onlyfans"
    ? await createOnlyFansPage(appContext.db, { modelId: model.id, label: "voice-page-of" })
    : await createFanslyPage(appContext.db, { modelId: model.id, label: "voice-page" });
  if (!page) {
    throw new Error("createPlatformPage returned no row");
  }
  if (opts?.withProfile !== false) {
    await upsertVoiceProfile(appContext.db, {
      platformAccountId: page.id,
      voiceId: "voice-abc",
      model: "eleven_v3",
      settings: { stability: 0.5 },
      outputFormat: "mp3_44100_128",
    });
  }
  const user = await createUserAccount(
    appContext,
    { username: "voice-chatter", role: "chatter" },
    { source: "cli" },
  );
  if (!user) {
    throw new Error("createUserAccount returned no user");
  }
  const sourceRef = `gen-${randomUUID()}`;
  await insertAiGenerationContent(appContext.db, {
    usageEventId: null,
    generationRef: sourceRef,
    feature: opts?.sourceFeature ?? "voice-script",
    model: "anthropic:claude-sonnet-4-6",
    provider: "anthropic",
    userId: user.id,
    pageId: page.id,
    conversationRef: opts?.sourceConversationRef ?? CONVERSATION_REF,
    fanRef: opts?.sourceFanRef === undefined
      ? (opts?.sourceConversationRef ?? CONVERSATION_REF)
      : opts.sourceFanRef,
    promptBlocks: [],
    completion: opts?.script ?? SCRIPT,
    params: {
      outcome: opts?.sourceOutcome ?? "completed",
      ...(opts?.sourceStopReason !== undefined ? { stopReason: opts.sourceStopReason } : {}),
    },
  });

  const principal: HumanAuthPrincipal = {
    authMethod: "device_token",
    user: {
      id: user.id,
      username: user.username,
      role: "chatter",
      assignedPages: [],
      mustChangePassword: false,
    },
    assignedPageIds: [page.id],
    deviceTokenId: 1,
  };

  appContext.config.voiceNotesEnabled = opts?.enabled ?? true;
  appContext.config.voiceNotesRetrievalEnabled = opts?.retrievalEnabled ?? true;
  appContext.config.voiceNotesPageAllowlist = (opts?.allowlisted ?? true) ? page.label : "";
  appContext.config.voiceNotesScriptMaxChars = opts?.scriptMaxChars ?? 600;
  appContext.config.voiceNotesDailyCharBudget = opts?.pageBudget ?? 100_000;
  appContext.config.voiceNotesGlobalDailyCharBudget = opts?.globalBudget ?? 100_000;
  appContext.config.voiceNotesMaxConcurrentSyntheses = opts?.maxConcurrentSyntheses ?? 2;
  appContext.voiceTtsProvider = opts?.provider;

  return {
    page: { id: page.id, label: page.label },
    principal,
    sourceRef,
    body: (overrides) => ({
      clientRequestId: randomUUID(),
      conversationRef: CONVERSATION_REF,
      sourceGenerationRef: sourceRef,
      script: opts?.script ?? SCRIPT,
      ...overrides,
    }),
  };
}

async function spentForScope(scope: string): Promise<number> {
  const res = await testDb!.pool.query<{ total: string }>(
    "select coalesce(sum(spent_chars), 0)::text as total from voice_char_budget where scope = $1",
    [scope],
  );
  return Number(res.rows[0]?.total ?? 0);
}

describe("voice-notes service: admission + idempotent replay", () => {
  it("replays a completed job WITHOUT re-admission (allowlist flipped off between calls)", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider, state } = fakeProvider(() => okAudio(12));
    const p = await provision({ provider });
    const body = p.body();

    const first = await createVoiceNote(appContext, p.principal, p.page.label, body);
    expect(first.state).toBe("dispatched");
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, first.voiceNoteId))?.state === "completed");
    expect(state.calls).toBe(1);

    // Break a gate that admission WOULD run: an empty allowlist fails closed.
    appContext.config.voiceNotesPageAllowlist = "";

    const replay = await createVoiceNote(appContext, p.principal, p.page.label, body);
    expect(replay.state).toBe("completed");
    expect(replay.voiceNoteId).toBe(first.voiceNoteId);
    // No re-admission, no second synthesis.
    expect(state.calls).toBe(1);
  });

  it("returns status for a still-running job without a second provider call", async (ctx) => {
    if (!testDb) return ctx.skip();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { provider, state } = fakeProvider(async () => {
      await gate;
      return okAudio(10);
    });
    const p = await provision({ provider });
    const body = p.body();

    const first = await createVoiceNote(appContext, p.principal, p.page.label, body);
    expect(first.state).toBe("dispatched");
    // The detached task has entered synthesize (and is blocked on the gate).
    await waitFor(() => state.calls === 1);
    expect((await getVoiceNoteById(testDb!.db, first.voiceNoteId))?.state).toBe("dispatched");

    const replay = await createVoiceNote(appContext, p.principal, p.page.label, body);
    expect(replay.state).toBe("dispatched");
    expect(replay.voiceNoteId).toBe(first.voiceNoteId);
    expect(state.calls).toBe(1); // still exactly one attempt

    release();
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, first.voiceNoteId))?.state === "completed");
    expect(state.calls).toBe(1);
  });

  it("rejects a reused clientRequestId with a different request hash (409)", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider } = fakeProvider(() => okAudio(12));
    const p = await provision({ provider });
    const body = p.body();

    const first = await createVoiceNote(appContext, p.principal, p.page.label, body);
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, first.voiceNoteId))?.state === "completed");

    // Same clientRequestId, different script → different hash → 409, and the
    // mismatch outranks any script re-validation (proving no re-admission).
    await expect(
      createVoiceNote(appContext, p.principal, p.page.label, { ...body, script: "totally different <bad>" }),
    ).rejects.toMatchObject({ code: "idempotency_mismatch", statusCode: 409 });
  });

  it("collapses a concurrent same-clientRequestId race to one row, one synthesis, one reservation", async (ctx) => {
    if (!testDb) return ctx.skip();
    // Gate-blocked provider: the winner's detached synthesis parks in synthesize
    // so its reservation stays UNRECONCILED while we inspect the ledger.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { provider, state } = fakeProvider(async () => {
      await gate;
      return okAudio(12);
    });
    const p = await provision({ provider });
    const body = p.body(); // ONE clientRequestId shared by both racers

    const [a, b] = await Promise.all([
      createVoiceNote(appContext, p.principal, p.page.label, body),
      createVoiceNote(appContext, p.principal, p.page.label, body),
    ]);

    // Winner + replayed loser resolve to the SAME admitted row.
    expect(a.voiceNoteId).toBe(b.voiceNoteId);

    // Exactly one voice_notes row for this (user, clientRequestId).
    const rows = await testDb.pool.query(
      "select id from voice_notes where user_id = $1 and client_request_id = $2",
      [p.principal.user.id, body.clientRequestId],
    );
    expect(rows.rows.length).toBe(1);

    // The loser's reserve+insert ran in ONE transaction; losing the unique race
    // rolled that whole tx back (the rollback IS the reservation release), so
    // exactly ONE reservation's worth remains charged while the winner's
    // synthesis is still gated (not yet reconciled to actuals) — no residue.
    expect(await spentForScope(`page:${p.page.id}`)).toBe(SCRIPT_CHARS);
    expect(await spentForScope("global")).toBe(SCRIPT_CHARS);

    // Exactly one synthesis fires, once released, and the single row completes.
    release();
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, a.voiceNoteId))?.state === "completed");
    expect(state.calls).toBe(1);
  });

  it("replays the same-id winner when it consumed the last available budget", async (ctx) => {
    if (!testDb) return ctx.skip();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { provider, state } = fakeProvider(async () => {
      await gate;
      return okAudio(null);
    });
    const p = await provision({
      provider,
      pageBudget: SCRIPT_CHARS,
      globalBudget: SCRIPT_CHARS,
      maxConcurrentSyntheses: 2,
    });
    const body = p.body();

    const [left, right] = await Promise.all([
      createVoiceNote(appContext, p.principal, p.page.label, body),
      createVoiceNote(appContext, p.principal, p.page.label, body),
    ]);
    expect(left.voiceNoteId).toBe(right.voiceNoteId);
    expect(["queued", "dispatched"]).toContain(left.state);
    expect(["queued", "dispatched"]).toContain(right.state);
    expect(await spentForScope(`page:${p.page.id}`)).toBe(SCRIPT_CHARS);
    expect(await spentForScope("global")).toBe(SCRIPT_CHARS);
    expect(state.calls).toBe(1);

    release();
    await waitFor(async () =>
      (await getVoiceNoteById(testDb!.db, left.voiceNoteId))?.state === "completed");
  });
});

describe("voice-notes service: admission gates", () => {
  it("fails closed on an empty allowlist and on a missing profile", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider } = fakeProvider(() => okAudio(12));

    const notAllowed = await provision({ provider, allowlisted: false });
    await expect(
      createVoiceNote(appContext, notAllowed.principal, notAllowed.page.label, notAllowed.body()),
    ).rejects.toMatchObject({ code: "voice_not_allowlisted", statusCode: 403 });

    await resetIntegrationDatabase(testDb.pool);
    appContext = createTestAppContext(testDb);
    const noProfile = await provision({ provider, withProfile: false });
    await expect(
      createVoiceNote(appContext, noProfile.principal, noProfile.page.label, noProfile.body()),
    ).rejects.toMatchObject({ code: "voice_no_profile" });
  });

  it("rejects pre-erasure Fansly source material before row, budget, or provider side effects", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider, state } = fakeProvider(() => okAudio(12));
    const p = await provision({ provider });
    const body = p.body();
    await insertErasureLog(testDb.db, {
      scopeType: "fan",
      scopeRef: `fan:fansly:${CONVERSATION_REF}`,
      initiatedBy: p.principal.user.id,
      dryRun: false,
      plan: { resolvedPageIds: [p.page.id] },
    });

    await expect(
      createVoiceNote(appContext, p.principal, p.page.label, body),
    ).rejects.toMatchObject({ code: "voice_source_invalid", statusCode: 400 });
    expect(
      await getVoiceNoteByClientRequestId(testDb.db, p.principal.user.id, body.clientRequestId),
    ).toBeNull();
    expect(await spentForScope(`page:${p.page.id}`)).toBe(0);
    expect(await spentForScope("global")).toBe(0);
    expect(state.calls).toBe(0);
  });

  it("returns retryable availability without side effects while erasure owns the page fence", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider, state } = fakeProvider(() => okAudio(12));
    const p = await provision({ provider });
    const body = p.body();
    const erasureClient = await testDb.pool.connect();
    try {
      await erasureClient.query("begin");
      await erasureClient.query(
        "select pg_advisory_xact_lock($1, $2)",
        [DM_ARCHIVE_ERASURE_FENCE_LOCK_NS, p.page.id],
      );

      await expect(
        createVoiceNote(appContext, p.principal, p.page.label, body),
      ).rejects.toMatchObject({ code: "voice_provider_unavailable", statusCode: 503 });
      expect(
        await getVoiceNoteByClientRequestId(testDb.db, p.principal.user.id, body.clientRequestId),
      ).toBeNull();
      expect(await spentForScope(`page:${p.page.id}`)).toBe(0);
      expect(state.calls).toBe(0);
    } finally {
      await erasureClient.query("rollback").catch(() => {});
      erasureClient.release();
    }
  });

  it("returns stateless quota denial without durable row cardinality or budget charge", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider, state } = fakeProvider(() => okAudio(12));
    const p = await provision({ provider, pageBudget: 1 }); // script (20) > budget
    const body = p.body();

    await expect(
      createVoiceNote(appContext, p.principal, p.page.label, body),
    ).rejects.toMatchObject({ code: "voice_quota_denied", statusCode: 429 });

    // A denied UUID is not durable state.
    expect(
      await getVoiceNoteByClientRequestId(testDb.db, p.principal.user.id, body.clientRequestId),
    ).toBeNull();
    // Budget released: the atomic reserve rolled back, nothing consumed.
    expect(await spentForScope(`page:${p.page.id}`)).toBe(0);
    expect(await spentForScope("global")).toBe(0);
    // Never dispatched.
    expect(state.calls).toBe(0);

    // The same request remains a 429 while the same budget condition holds.
    await expect(
      createVoiceNote(appContext, p.principal, p.page.label, body),
    ).rejects.toMatchObject({ code: "voice_quota_denied", statusCode: 429 });
    // Fresh UUIDs cannot grow voice_notes either.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(
        createVoiceNote(appContext, p.principal, p.page.label, p.body()),
      ).rejects.toMatchObject({ code: "voice_quota_denied", statusCode: 429 });
    }
    const rows = await testDb.pool.query<{ count: string }>(
      "select count(*)::text as count from voice_notes where user_id = $1",
      [p.principal.user.id],
    );
    expect(Number(rows.rows[0]?.count ?? -1)).toBe(0);
    expect(state.calls).toBe(0);

    // Quota failure released the pre-admission permit. Once the budget is
    // repaired, the same stateless request can be admitted and dispatched.
    appContext.config.voiceNotesDailyCharBudget = 100_000;
    const admitted = await createVoiceNote(appContext, p.principal, p.page.label, body);
    expect(admitted.state).toBe("dispatched");
    await waitFor(async () =>
      (await getVoiceNoteById(testDb!.db, admitted.voiceNoteId))?.state === "completed");
    expect(state.calls).toBe(1);
  });

  it("savepoint rollback: a CUMULATIVE global breach denies the second render AND undoes its page increment", async (ctx) => {
    if (!testDb) return ctx.skip();
    // Gate-park the first render so its reservation stays HELD (dispatched, not
    // yet reconciled/refunded) while the second render is admitted against it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { provider, state } = fakeProvider(async () => {
      await gate;
      return okAudio(null); // no character cost → estimate kept, no reconcile
    });
    // Page budget has room for BOTH (100k), but the GLOBAL budget (30) binds.
    // The first reservation takes 20; the second (20) then passes the per-request
    // early guard (chars ≤ both budgets) yet breaches global CUMULATIVELY. That
    // refusal fires INSIDE reserveVoiceCharBudget's transaction, AFTER its page
    // upsert already incremented the page counter within the SAVEPOINT — the
    // exact path the pageBudget:1 test can never reach (it short-circuits on the
    // early guard, never entering the transaction).
    const p = await provision({ provider, pageBudget: 100_000, globalBudget: 30 });

    const first = await createVoiceNote(appContext, p.principal, p.page.label, p.body());
    expect(first.state).toBe("dispatched");
    await waitFor(() => state.calls === 1); // inside synthesize, blocked on the gate
    // First reservation committed: both scopes at 20, nothing else in flight.
    expect(await spentForScope(`page:${p.page.id}`)).toBe(SCRIPT_CHARS);
    expect(await spentForScope("global")).toBe(SCRIPT_CHARS);

    // Second render: 20 ≤ 100k page and 20 ≤ 30 global (early guard passes), but
    // 20 + 20 = 40 > 30 global → BudgetRefused AFTER the page upsert → the nested
    // SAVEPOINT rolls back (page increment undone) and no denial row is written.
    const secondBody = p.body();
    await expect(
      createVoiceNote(appContext, p.principal, p.page.label, secondBody),
    ).rejects.toMatchObject({ code: "voice_quota_denied", statusCode: 429 });

    expect(
      await getVoiceNoteByClientRequestId(testDb.db, p.principal.user.id, secondBody.clientRequestId),
    ).toBeNull();

    // The crux: BOTH counters are unchanged beyond the first reservation. If the
    // savepoint rollback misbehaved, the page counter would sit at 40 — the
    // second render's page increment stranded, permanently over-charging the day
    // while the request was denied.
    expect(await spentForScope(`page:${p.page.id}`)).toBe(SCRIPT_CHARS);
    expect(await spentForScope("global")).toBe(SCRIPT_CHARS);
    expect(state.calls).toBe(1); // the denied render never dispatched

    // Release the parked first render so the suite shuts down cleanly.
    release();
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, first.voiceNoteId))?.state === "completed");
  });
});

describe("voice-notes service: detached dispatch settle paths", () => {
  it("does not dispatch queued work after the live kill switch is turned off", async (ctx) => {
    if (!testDb) return ctx.skip();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const provider: VoiceTtsProvider = {
      async synthesize() {
        calls += 1;
        if (calls === 1) {
          await firstGate;
        }
        return okAudio(12);
      },
    };
    const p = await provision({ provider, maxConcurrentSyntheses: 1 });
    const first = await createVoiceNote(appContext, p.principal, p.page.label, p.body());
    await waitFor(() => calls === 1);
    const queued = await createVoiceNote(appContext, p.principal, p.page.label, p.body());
    expect(queued.state).toBe("queued");

    appContext.config.voiceNotesEnabled = false;
    releaseFirst();
    await waitFor(async () =>
      (await getVoiceNoteById(testDb!.db, first.voiceNoteId))?.state === "completed");
    await delay(100);

    expect(calls).toBe(1);
    expect((await getVoiceNoteById(testDb.db, queued.voiceNoteId))?.state).toBe("queued");
    expect((await getVoiceNoteById(testDb.db, queued.voiceNoteId))?.attemptToken).toBeNull();
  });

  it("completed + character cost → reconciles the budget to actuals and stores audio", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider } = fakeProvider(() => okAudio(12));
    const p = await provision({ provider });
    const body = p.body();

    const view = await createVoiceNote(appContext, p.principal, p.page.label, body);
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, view.voiceNoteId))?.state === "completed");

    const row = await getVoiceNoteById(testDb.db, view.voiceNoteId);
    expect(row?.state).toBe("completed");
    expect(row?.billed).toBe(true);
    expect(row?.billedChars).toBe(12);
    expect(row?.providerRequestId).toBe("prov-req-1");
    expect(row?.providerRegion).toBe("us-east-1");
    const audio = Buffer.from("fake-mp3-bytes-payload");
    expect(row?.audioBytesLen).toBe(audio.byteLength);
    expect(row?.audioSha256).toBe(sha256Hex(audio));

    // reserved SCRIPT_CHARS(20), actual 12 → both scopes reconcile to 12. The
    // budget settle is the await after the terminal settle, so wait for it.
    await waitFor(async () => (await spentForScope(`page:${p.page.id}`)) === 12);
    expect(await spentForScope(`page:${p.page.id}`)).toBe(12);
    expect(await spentForScope("global")).toBe(12);

    // Audio read returns verified bytes.
    const got = await getVoiceNoteAudio(appContext, p.principal, p.page.label, view.voiceNoteId);
    expect(got.bytes.equals(audio)).toBe(true);
    expect(got.sha256).toBe(sha256Hex(audio));
  });

  it("keeps the estimate charged for invalid provider character costs", async (ctx) => {
    if (!testDb) return ctx.skip();
    for (const [index, characterCost] of [-1, 1.5, 2_147_483_648].entries()) {
      if (index > 0) {
        await resetIntegrationDatabase(testDb.pool);
        appContext = createTestAppContext(testDb);
      }
      const { provider } = fakeProvider(() => okAudio(characterCost));
      const p = await provision({ provider });

      const view = await createVoiceNote(appContext, p.principal, p.page.label, p.body());
      await waitFor(async () =>
        (await getVoiceNoteById(testDb!.db, view.voiceNoteId))?.state === "completed");

      const row = await getVoiceNoteById(testDb.db, view.voiceNoteId);
      expect(row?.billed).toBe(true);
      expect(row?.billedChars).toBeNull();
      expect(await spentForScope(`page:${p.page.id}`)).toBe(SCRIPT_CHARS);
      expect(await spentForScope("global")).toBe(SCRIPT_CHARS);
    }
  });

  it("completed + NO character cost → billed=true, estimate kept (cost amount unknown)", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider } = fakeProvider(() => okAudio(null));
    const p = await provision({ provider });

    const view = await createVoiceNote(appContext, p.principal, p.page.label, p.body());
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, view.voiceNoteId))?.state === "completed");

    const row = await getVoiceNoteById(testDb.db, view.voiceNoteId);
    expect(row?.state).toBe("completed");
    // The vendor synthesized → billed is TRUE even without a cost header (its
    // absence means we cannot reconcile, not that the take was free).
    expect(row?.billed).toBe(true);
    expect(row?.billedChars).toBeNull();
    // No cost to reconcile against → the estimate stays charged.
    expect(await spentForScope(`page:${p.page.id}`)).toBe(SCRIPT_CHARS);
  });

  it("refusedBeforeBilling → failed_definite and full reservation release", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider } = fakeProvider(() => ({
      ok: false,
      refusedBeforeBilling: true,
      status: 401,
      snippet: "unauthorized",
      failureKind: "http_4xx",
      detail: "unauthorized",
    }));
    const p = await provision({ provider });

    const view = await createVoiceNote(appContext, p.principal, p.page.label, p.body());
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, view.voiceNoteId))?.state === "failed_definite");

    // The full refund is the await after the terminal settle — wait for it.
    await waitFor(async () => (await spentForScope(`page:${p.page.id}`)) === 0);
    expect(await spentForScope(`page:${p.page.id}`)).toBe(0);
    expect(await spentForScope("global")).toBe(0);
  });

  it("definite non-refused HTTP failure → failed_after_dispatch, estimate kept (billed-unknown)", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider } = fakeProvider(() => ({
      ok: false,
      refusedBeforeBilling: false,
      status: 500,
      snippet: "HTTP 500",
      failureKind: "http_5xx",
      detail: "HTTP 500",
    }));
    const p = await provision({ provider });

    const view = await createVoiceNote(appContext, p.principal, p.page.label, p.body());
    await waitFor(async () =>
      (await getVoiceNoteById(testDb!.db, view.voiceNoteId))?.state === "failed_after_dispatch");

    const row = await getVoiceNoteById(testDb.db, view.voiceNoteId);
    // Billing genuinely unknown (the vendor may or may not have charged) → null,
    // NOT false.
    expect(row?.billed).toBeNull();
    expect(await spentForScope(`page:${p.page.id}`)).toBe(SCRIPT_CHARS); // no refund
  });

  it("network/timeout (status 0) → left dispatched for the lease sweep → indeterminate", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider, state } = fakeProvider(() => ({
      ok: false,
      refusedBeforeBilling: false,
      status: 0,
      snippet: "network down",
      failureKind: "connect",
      detail: "network down",
    }));
    const p = await provision({ provider });

    const view = await createVoiceNote(appContext, p.principal, p.page.label, p.body());
    await waitFor(() => state.calls === 1);
    await delay(50); // let the detached task finish its no-op decision

    // No terminal verdict was settled — the row is still dispatched.
    expect((await getVoiceNoteById(testDb.db, view.voiceNoteId))?.state).toBe("dispatched");
    expect(await spentForScope(`page:${p.page.id}`)).toBe(SCRIPT_CHARS); // estimate kept

    // The lease sweep reclaims it as indeterminate (lease is 120s; sweep at +200s).
    const swept = await sweepVoiceNotes(testDb.db, new Date(Date.now() + 200_000));
    expect(swept.leaseExpired).toBe(1);
    expect((await getVoiceNoteById(testDb.db, view.voiceNoteId))?.state).toBe("indeterminate");
    expect(await spentForScope(`page:${p.page.id}`)).toBe(SCRIPT_CHARS);

    // After 24h the conservative reservation is released using billed=false as
    // an INTERNAL idempotency marker. The client-facing billing verdict must
    // remain unknown for this possibly-billed dispatch.
    await releaseStaleIndeterminateVoiceBudgets(
      testDb.db,
      new Date(Date.now() + 24 * 60 * 60 * 1000 + 1),
    );
    expect((await getVoiceNoteById(testDb.db, view.voiceNoteId))?.billed).toBe(false);
    expect(
      (await getVoiceNoteStatus(appContext, p.principal, p.page.label, view.voiceNoteId)).billed,
    ).toBeNull();
  });
});

describe("voice-notes service: status + audio reads", () => {
  it("scopes reads by (id, page, user) and honors the retrieval switch", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider } = fakeProvider(() => okAudio(12));
    const p = await provision({ provider });

    const view = await createVoiceNote(appContext, p.principal, p.page.label, p.body());
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, view.voiceNoteId))?.state === "completed");

    const status = await getVoiceNoteStatus(appContext, p.principal, p.page.label, view.voiceNoteId);
    expect(status.state).toBe("completed");

    // Unknown id → indistinguishable 404.
    await expect(
      getVoiceNoteStatus(appContext, p.principal, p.page.label, view.voiceNoteId + 9999),
    ).rejects.toMatchObject({ statusCode: 404 });

    // Retrieval kill switch off → distinct code.
    appContext.config.voiceNotesRetrievalEnabled = false;
    await expect(
      getVoiceNoteStatus(appContext, p.principal, p.page.label, view.voiceNoteId),
    ).rejects.toMatchObject({ code: "voice_retrieval_disabled", statusCode: 403 });
  });
});

describe("voice-notes service: dispatch log hygiene", () => {
  it("logs status-0 failure detail structurally without any key, proxy credential, or script", async () => {
    const fakeKey = "fake-elevenlabs-key";
    const fakeUser = "fake-service-user";
    const fakePassword = "fake-service-password";
    const fakeScript = "PRIVATE_SCRIPT_TEXT";
    const records: Array<{ level: string; obj: unknown; msg: string }> = [];
    const record = (level: string) => (obj: unknown, msg?: string) => {
      records.push({ level, obj, msg: msg ?? "" });
    };
    const app = {
      config: {
        elevenLabsApiKey: fakeKey,
        serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
        serviceEgressProxyUsername: fakeUser,
        serviceEgressProxyPassword: fakePassword,
      },
      db: {},
      logger: {
        error: record("error"),
        warn: record("warn"),
        info: record("info"),
        debug: record("debug"),
      },
      voiceTtsProvider: fakeProvider(() => ({
        ok: false,
        refusedBeforeBilling: false,
        status: 0,
        snippet: "proxy connect failed",
        failureKind: "connect",
        detail: `${fakeKey} ${fakeUser} ${fakePassword} ${fakeScript} `
          + `socks5://${fakeUser}:${fakePassword}@proxy.example.internal:1080`,
      })).provider,
    } as unknown as AppContext;
    const row = {
      id: 41,
      platformAccountId: 1,
      profileVoiceId: "voice-abc",
      profileModel: "eleven_v3",
      profileSettings: {},
      profileOutputFormat: "mp3_44100_128",
    } as unknown as VoiceNoteRow;

    await dispatchVoiceNote(app, {
      row,
      attemptToken: "fake-attempt-token",
      reservedChars: fakeScript.length,
      canonicalScript: fakeScript,
      now: new Date(),
    });

    const warning = records.find((record) => record.level === "warn");
    expect(warning?.obj).toEqual(expect.objectContaining({
      component: "voice_notes",
      event: "voice_note_synthesis_failed",
      vendor: "elevenlabs",
      voiceNoteId: 41,
      egressKey: "service:socks5://proxy.example.internal:1080",
      providerStatus: 0,
      failureKind: "connect",
      durationMs: expect.any(Number),
      outcome: "indeterminate",
    }));
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(fakeKey);
    expect(serialized).not.toContain(fakeUser);
    expect(serialized).not.toContain(fakePassword);
    expect(serialized).not.toContain(fakeScript);
  });
});

describe("voice-notes service on an OnlyFans page", () => {
  // On OnlyFans the chat id IS the fan id (the extension over ChatSpace): the
  // render names one ref, the fan's, and the fan's erasure is keyed by the
  // OnlyFans platform.
  const FAN_ID = "424242";

  it("renders a voice note whose chat is the fan, with or without the fan named again", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider, state } = fakeProvider(() => okAudio(SCRIPT_CHARS));
    const p = await provision({ provider, platform: "onlyfans", sourceConversationRef: FAN_ID });

    const plain = await createVoiceNote(appContext, p.principal, p.page.label, p.body({ conversationRef: FAN_ID }));
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, plain.voiceNoteId))?.state === "completed");
    const named = await createVoiceNote(
      appContext,
      p.principal,
      p.page.label,
      p.body({ conversationRef: FAN_ID, fanRef: FAN_ID }),
    );
    await waitFor(async () => (await getVoiceNoteById(testDb!.db, named.voiceNoteId))?.state === "completed");
    expect(state.calls).toBe(2);
    expect(await spentForScope(`page:${p.page.id}`)).toBe(2 * SCRIPT_CHARS);
  });

  it("refuses a fanRef that names another fan with 409, before any row, budget or provider call", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider, state } = fakeProvider(() => okAudio(SCRIPT_CHARS));
    const p = await provision({ provider, platform: "onlyfans", sourceConversationRef: FAN_ID });
    const body = p.body({ conversationRef: FAN_ID, fanRef: "777777" });

    await expect(
      createVoiceNote(appContext, p.principal, p.page.label, body),
    ).rejects.toMatchObject({ code: "conversation_fan_mismatch", statusCode: 409 });
    expect(
      await getVoiceNoteByClientRequestId(testDb.db, p.principal.user.id, body.clientRequestId),
    ).toBeNull();
    expect(await spentForScope(`page:${p.page.id}`)).toBe(0);
    expect(state.calls).toBe(0);
  });

  it("is fenced by the OnlyFans fan's erasure", async (ctx) => {
    if (!testDb) return ctx.skip();
    const { provider, state } = fakeProvider(() => okAudio(SCRIPT_CHARS));
    const p = await provision({ provider, platform: "onlyfans", sourceConversationRef: FAN_ID });
    await insertErasureLog(testDb.db, {
      scopeType: "fan",
      scopeRef: `fan:onlyfans:${FAN_ID}`,
      initiatedBy: p.principal.user.id,
      dryRun: false,
      plan: { resolvedPageIds: [p.page.id] },
    });
    const body = p.body({ conversationRef: FAN_ID });

    await expect(
      createVoiceNote(appContext, p.principal, p.page.label, body),
    ).rejects.toMatchObject({ code: "voice_source_invalid", statusCode: 400 });
    expect(
      await getVoiceNoteByClientRequestId(testDb.db, p.principal.user.id, body.clientRequestId),
    ).toBeNull();
    expect(state.calls).toBe(0);
  });
});
