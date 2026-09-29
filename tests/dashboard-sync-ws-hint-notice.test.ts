import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncBlockStatus, SyncBlocksPage } from "@agency_hub_core/contracts";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";

// Root tests cannot resolve @tanstack/react-query, so the api layer is mocked
// at module level (same pattern as dashboard-sync-surfaces.test.ts).
const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });
const queries = vi.hoisted(() => ({
  useSyncOverview: vi.fn(),
  usePageSyncBlocks: vi.fn(),
  useAdminSyncBlockTrigger: vi.fn(),
  useAdminSyncBlockPause: vi.fn(),
  useAdminSyncBlockResume: vi.fn(),
  useAdminSyncBlockReset: vi.fn(),
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => queries);
vi.mock("../apps/dashboard/node_modules/sonner/dist/index.mjs", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  formatBlockSummary,
  getBlockTone,
  getWsHintGenerationNotice,
  needsVisualAttention,
} from "../apps/dashboard/src/pages/settings/sync/syncBlockDisplay.ts";
import { SyncBlockRow } from "../apps/dashboard/src/pages/settings/sync/SyncBlockRow.tsx";
import { SyncPageList } from "../apps/dashboard/src/pages/settings/sync/SyncPageList.tsx";
import { SyncPageDetail } from "../apps/dashboard/src/pages/settings/sync/SyncPageDetail.tsx";

const PAUSED = "Event-driven refresh paused";

function block(key: SyncBlockStatus["block"], metrics: Record<string, unknown> = {}): SyncBlockStatus {
  return {
    block: key,
    state: "up_to_date",
    succeededAt: "2026-09-28T11:00:00.000Z",
    progress: null,
    progressStream: null,
    progressRole: null,
    error: null,
    statusReason: null,
    primaryFresh: true,
    needsAttention: false,
    nextDueAt: null,
    nextRetryAt: null,
    intervals: [],
    metrics,
    connectionStatus: key === "connection" ? "connected" : null,
    substreams: [],
  };
}

const mismatch = { state: "generation_mismatch", configuredGeneration: "a".repeat(64), currentGeneration: "b".repeat(64) };

function page(hints: Record<string, unknown> | null): SyncBlocksPage {
  return {
    pageId: 7,
    pageLabel: "lora-2",
    platform: "fansly",
    modelSlug: "lora",
    modelName: "Lora",
    username: "lora",
    displayName: null,
    diagnosis: null,
    blocks: {
      connection: block("connection"),
      financials: block("financials"),
      audience: block("audience"),
      messages_live: block("messages_live", {
        visibleConversationCount: 4,
        ...(hints ? { fanslyWsHints: hints } : {}),
      }),
      messages_history: block("messages_history"),
    },
  };
}

function renderRouted(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, element));
}

beforeEach(() => {
  for (const hook of ["useAdminSyncBlockTrigger", "useAdminSyncBlockPause", "useAdminSyncBlockResume",
    "useAdminSyncBlockReset"] as const) queries[hook].mockReturnValue(mutation());
});

describe("WS hint generation mismatch on the sync surfaces", () => {
  it("names a mismatch only on Messages Live, only for generation_mismatch", () => {
    expect(getWsHintGenerationNotice(block("messages_live", { fanslyWsHints: mismatch })))
      .toMatchObject({ headline: PAUSED });
    for (const state of ["matching", "inactive", "generation_unavailable"]) {
      expect(getWsHintGenerationNotice(block("messages_live", { fanslyWsHints: { state } }))).toBeNull();
    }
    expect(getWsHintGenerationNotice(block("messages_live"))).toBeNull();
    expect(getWsHintGenerationNotice(block("messages_live", { fanslyWsHints: "generation_mismatch" }))).toBeNull();
    expect(getWsHintGenerationNotice(block("messages_history", { fanslyWsHints: mismatch }))).toBeNull();
  });

  it("stays informational: block state, tone and attention are unchanged", () => {
    const plain = block("messages_live", { visibleConversationCount: 4 });
    const flagged = block("messages_live", { visibleConversationCount: 4, fanslyWsHints: mismatch });
    expect(formatBlockSummary(flagged)).toBe(formatBlockSummary(plain));
    expect(getBlockTone(flagged)).toEqual(getBlockTone(plain));
    expect(needsVisualAttention(flagged)).toBe(false);
  });

  it("shows a status line in the overview row and clears once the policy matches", () => {
    const flagged = renderToStaticMarkup(createElement(SyncBlockRow, { block: page(mismatch).blocks.messages_live }));
    expect(flagged).toContain(PAUSED);
    expect(flagged).toContain("fansly:ws-policy");
    const repinned = renderToStaticMarkup(createElement(SyncBlockRow, {
      block: page({ ...mismatch, state: "matching" }).blocks.messages_live,
    }));
    expect(repinned).not.toContain(PAUSED);
  });

  it("renders on the overview page card without inventing a page error", () => {
    queries.useSyncOverview.mockReturnValue({
      data: { generatedAt: "2026-09-28T12:00:00.000Z", diagnosis: null, pages: [page(mismatch)] },
      isLoading: false, isError: false, error: null,
    });
    const html = renderRouted(createElement(SyncPageList, { onSelectPage: vi.fn() }));
    expect(html.split(PAUSED)).toHaveLength(2);
    expect(html).not.toContain("needs attention");

    queries.useSyncOverview.mockReturnValue({
      data: { generatedAt: "2026-09-28T12:00:00.000Z", diagnosis: null, pages: [page({ state: "matching" })] },
      isLoading: false, isError: false, error: null,
    });
    expect(renderRouted(createElement(SyncPageList, { onSelectPage: vi.fn() }))).not.toContain(PAUSED);
  });

  it("explains the re-pin on the page detail with the exact read-only preview command", () => {
    queries.usePageSyncBlocks.mockReturnValue({
      data: { generatedAt: "2026-09-28T12:00:00.000Z", page: page(mismatch) },
      isLoading: false, isError: false, error: null,
    });
    const html = renderRouted(createElement(SyncPageDetail, { pageLabel: "lora-2", onBack: vi.fn() }));
    expect(html.split(PAUSED)).toHaveLength(2);
    expect(html).toContain("still arrive through scheduled polling");
    expect(html).toContain("pnpm --silent cli fansly:ws-policy --page lora-2 --preview");

    queries.usePageSyncBlocks.mockReturnValue({
      data: { generatedAt: "2026-09-28T12:00:00.000Z", page: page(null) },
      isLoading: false, isError: false, error: null,
    });
    expect(renderRouted(createElement(SyncPageDetail, { pageLabel: "lora-2", onBack: vi.fn() })))
      .not.toContain(PAUSED);
  });
});
