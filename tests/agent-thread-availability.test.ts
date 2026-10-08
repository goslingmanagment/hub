import { describe, expect, it } from "vitest";

import {
  AGENT_PLANE_NAMES,
  agentThreadAvailabilityCauseEnum,
  agentThreadAvailabilityResponseSchema,
  agentThreadAvailabilityStateEnum,
  routeSchemas,
  type AgentThreadAvailabilityResponse,
} from "@agency_hub_core/contracts";
import { CHAT_UNAVAILABILITY_OWNER_NOTE_MAX, CHAT_UNAVAILABILITY_STATES } from "@agency_hub_core/db";
import { KernelApiError, type KernelClient } from "@kernel/sdk";

import {
  HUB_THREAD_AVAILABILITY_NONE,
  HUB_THREAD_AVAILABILITY_UNKNOWN,
  findHubCommand,
  hubRouteMissing,
  hubThreadAvailabilityNote,
} from "../packages/hub-agent-cli/src/commands.ts";
import { HUB_EXIT_ERROR, HUB_EXIT_OK, HUB_EXIT_PARTIAL, runHubCli } from "../packages/hub-agent-cli/src/main.ts";

// `agentThreadAvailability` (arena "vanished chat", plan §5): the strict wire
// of a chat's open unavailability episode, and `hub thread-availability` —
// its one-line note, and its answer on a hub that has no such route.

const EPISODE = {
  state: "established",
  openedAt: "2026-10-06T08:00:00.000Z",
  establishedAt: "2026-10-06T15:11:00.000Z",
  lastRefusalAt: "2026-10-08T15:20:00.000Z",
  refusals: 8,
  retryNotBefore: "2026-10-09T15:20:00.000Z",
  ownerNote: { text: "06.10: the profile does not open from lora-1", at: "2026-10-06T22:14:00.000Z" },
  cause: "unchecked",
} as const;

function answer(episode: unknown, returned = episode === null ? 0 : 1) {
  return {
    scope: { pageLabel: "lora-1", platform: "fansly", conversationRef: "810272281019305984" },
    episode,
    delivery: {
      returned,
      matchedInScope: { value: returned, exact: true, countBasis: "post_dedup" },
      cappedBy: null,
      nextCursor: null,
      snapshotExhausted: true,
      caveats: [],
    },
    capture: {
      planes: AGENT_PLANE_NAMES.map((plane) => ({ plane, state: "not_applicable", reason: "not_a_source_for_this_claim" })),
      observedRowFloor: null,
      gaps: [],
      sourceErrors: [],
      scopeNarrowing: { keyGrantExcludedPages: 0, totalPagesForQuery: 1 },
      scopeFieldStates: {},
    },
    conclusion: { blockers: ["claim_not_declared", "capture_floor_unknown"] },
  };
}

describe("agentThreadAvailability: the strict wire", () => {
  it("takes a null episode and an episode, each with the plane's envelope", () => {
    expect(agentThreadAvailabilityResponseSchema.safeParse(answer(null)).success).toBe(true);
    expect(agentThreadAvailabilityResponseSchema.safeParse(answer(EPISODE)).success).toBe(true);
    expect(agentThreadAvailabilityResponseSchema.safeParse(answer({
      ...EPISODE, state: "refusing", establishedAt: null, retryNotBefore: null, refusals: 1, ownerNote: null,
    })).success).toBe(true);
  });

  it("refuses a key it does not declare, anywhere in the answer", () => {
    const extra = [
      { ...answer(null), threadCoverage: null },
      { ...answer(null), scope: { ...answer(null).scope, fanPlatformUserId: null } },
      answer({ ...EPISODE, firstAttemptId: 41 }),
      answer({ ...EPISODE, ownerNote: { ...EPISODE.ownerNote, by: "owner" } }),
    ];
    for (const value of extra) {
      expect(agentThreadAvailabilityResponseSchema.safeParse(value).success, JSON.stringify(value).slice(0, 80)).toBe(false);
    }
  });

  it("counts the episode as the one record it returns", () => {
    expect(agentThreadAvailabilityResponseSchema.safeParse(answer(null, 1)).success).toBe(false);
    expect(agentThreadAvailabilityResponseSchema.safeParse(answer(EPISODE, 0)).success).toBe(false);
  });

  it("has every cause now, so a later hub's probable cause is no answer this one refuses", () => {
    expect(agentThreadAvailabilityCauseEnum.options).toEqual(["unchecked", "probably_blocked", "probably_deleted"]);
    for (const cause of agentThreadAvailabilityCauseEnum.options) {
      expect(agentThreadAvailabilityResponseSchema.safeParse(answer({ ...EPISODE, cause })).success, cause).toBe(true);
    }
    expect(agentThreadAvailabilityResponseSchema.safeParse(answer({ ...EPISODE, cause: "blocked" })).success).toBe(false);
  });

  it("mirrors the episode's states and the owner's note the table keeps", () => {
    expect(agentThreadAvailabilityStateEnum.options).toEqual([...CHAT_UNAVAILABILITY_STATES]);
    const note = "я".repeat(CHAT_UNAVAILABILITY_OWNER_NOTE_MAX);
    expect(agentThreadAvailabilityResponseSchema.safeParse(answer({ ...EPISODE, ownerNote: { text: note, at: EPISODE.ownerNote.at } })).success)
      .toBe(true);
    expect(agentThreadAvailabilityResponseSchema.safeParse(answer({ ...EPISODE, ownerNote: { text: "", at: EPISODE.ownerNote.at } })).success)
      .toBe(false);
  });

  it("is page-scoped, agent-keyed and says what a null episode means", () => {
    const route = routeSchemas.agentThreadAvailability;
    expect(route.auth).toEqual({ kind: "agentKey", scope: "page" });
    expect(route.summary).toContain("A null episode means no open episode is recorded, not proof that Fansly serves the chat");
    expect(Object.keys(route.response)).toContain("404");
  });
});

// --- the CLI ---------------------------------------------------------------

function stubClient(response: unknown, calls: Array<{ method: string; input: unknown }> = []) {
  return new Proxy({}, {
    get(_target, property: string) {
      return (input: unknown) => {
        calls.push({ method: property, input });
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
      };
    },
  }) as unknown as KernelClient;
}

function hub(argv: string[], response: unknown, calls?: Array<{ method: string; input: unknown }>) {
  return runHubCli({
    argv,
    env: { HUB_AGENT_KEY: "agency_hub_agent_availability-test" },
    readFile: () => null,
    fileMode: () => null,
    createHubClient: () => stubClient(response, calls),
  });
}

const ARGV = ["thread-availability", "--page-label", "lora-1", "--conversation", "810272281019305984"];

/** The router's 404 of a hub that has no such route (`server.ts`'s not-found
 *  handler in production, Fastify's own elsewhere). */
const ROUTE_MISSING = new KernelApiError("Route not found", "not_found", 404, "Not Found", {
  error: "Not Found", message: "Route not found", statusCode: 404,
});
/** The plane's one 404: a page out of reach, or a thread the page does not hold. */
const PLANE_NOT_FOUND = new KernelApiError("Not found", "not_found", 404, "not_found", {
  error: "not_found", message: "Not found", statusCode: 404,
});

describe("hub thread-availability", () => {
  it("asks for one chat of one page, by the transcript's flags", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const result = await hub(ARGV, answer(null), calls);
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(calls).toEqual([{
      method: "agentThreadAvailability",
      input: { params: { pageLabel: "lora-1", conversationRef: "810272281019305984" } },
    }]);
    expect(Object.keys(findHubCommand("thread-availability")?.options ?? {})).toEqual(["page-label", "conversation"]);
    for (const flag of ["--page-label", "--conversation"]) {
      const missing = await hub(ARGV.filter((_, index) => ARGV[index] !== flag && ARGV[index - 1] !== flag), answer(null));
      expect(missing.exitCode, flag).toBe(HUB_EXIT_ERROR);
      expect(missing.document.error, flag).toMatchObject({ category: "usage", message: `${flag} is required` });
    }
  });

  it("a null episode: the answer as it came, and the note that it proves nothing about the chat being served", async () => {
    const result = await hub(ARGV, answer(null));
    expect(result.document).toMatchObject({
      ok: true,
      operation: "agentThreadAvailability",
      exitCode: HUB_EXIT_OK,
      blockers: ["claim_not_declared", "capture_floor_unknown"],
      note: HUB_THREAD_AVAILABILITY_NONE,
      data: { episode: null },
    });
    expect(HUB_THREAD_AVAILABILITY_NONE).toMatch(/^no open episode recorded: not proof that Fansly serves the chat/);
  });

  it("an episode: its state, dates, refusals, cause and the owner's note in one line", async () => {
    const result = await hub(ARGV, answer(EPISODE));
    expect(result.exitCode).toBe(HUB_EXIT_OK);
    expect(result.document.data).toEqual(answer(EPISODE));
    expect(result.document.note).toBe(
      "established: Fansly does not serve this chat to the page since 2026-10-06T08:00:00.000Z (8 refusals,"
      + " established 2026-10-06T15:11:00.000Z, the last 2026-10-08T15:20:00.000Z); nothing reads it before"
      + " 2026-10-09T15:20:00.000Z, then only a new message in the chat asks for one read;"
      + " cause not checked: the fan deleted the account or blocked the page;"
      + " the owner's note (2026-10-06T22:14:00.000Z): 06.10: the profile does not open from lora-1",
    );
    const refusing = answer({ ...EPISODE, state: "refusing", establishedAt: null, retryNotBefore: null, refusals: 1, ownerNote: null });
    expect(hubThreadAvailabilityNote(refusing as AgentThreadAvailabilityResponse)).toBe(
      "refusing: Fansly has refused this chat to the page since 2026-10-06T08:00:00.000Z (1 refusal, the last"
      + " 2026-10-08T15:20:00.000Z); not established yet; cause not checked: the fan deleted the account or blocked the page",
    );
  });

  it("names every cause as a likelihood", () => {
    const notes = agentThreadAvailabilityCauseEnum.options.map((cause) =>
      hubThreadAvailabilityNote(answer({ ...EPISODE, cause, ownerNote: null }) as AgentThreadAvailabilityResponse));
    expect(notes[1]).toContain("the fan probably blocked the page");
    expect(notes[2]).toContain("probably deleted");
    expect(new Set(notes).size).toBe(3);
  });

  it("a hub without the route: state unknown, data null, exit 0 — with --fail-on-partial too", async () => {
    for (const argv of [ARGV, [...ARGV, "--fail-on-partial"]]) {
      const result = await hub(argv, ROUTE_MISSING);
      expect(result.exitCode).toBe(HUB_EXIT_OK);
      expect(result.document).toEqual({
        ok: true,
        operation: "agentThreadAvailability",
        exitCode: HUB_EXIT_OK,
        blockers: [],
        note: HUB_THREAD_AVAILABILITY_UNKNOWN,
        data: null,
      });
    }
    expect(HUB_THREAD_AVAILABILITY_UNKNOWN).toBe("state unknown: the server has no availability route");
    // A proxy's page in front of it has no code at all: still no route.
    expect(hubRouteMissing(new KernelApiError("GET … failed with 404", "not_found", 404, null, "<html>"))).toBe(true);
  });

  it("a page or a thread out of reach, or any other refusal, stays an error (exit 4)", async () => {
    for (const error of [
      PLANE_NOT_FOUND,
      new KernelApiError("agent key lacks the read:messages capability", "auth", 403, "agent_capability_missing", null),
      new KernelApiError("boom", "server", 503, "agent_plane_disabled", null),
    ]) {
      const result = await hub(ARGV, error);
      expect(result.exitCode, error.code ?? "").toBe(HUB_EXIT_ERROR);
      expect(result.document).toMatchObject({ ok: false, error: { status: error.status, code: error.code } });
      expect(result.document).not.toHaveProperty("note");
    }
    expect(hubRouteMissing(PLANE_NOT_FOUND)).toBe(false);
  });

  it("--fail-on-partial still reads the answer's blockers", async () => {
    const result = await hub([...ARGV, "--fail-on-partial"], answer(EPISODE));
    expect(result.exitCode).toBe(HUB_EXIT_PARTIAL);
    expect(result.document).toMatchObject({ ok: true, exitCode: HUB_EXIT_PARTIAL, note: expect.stringMatching(/^established/) });
  });
});
