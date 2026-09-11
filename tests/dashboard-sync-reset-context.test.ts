import type * as ReactModule from "react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { SyncBlockStatus } from "@agency_hub_core/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, pending: false, reset: vi.fn(), success: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof ReactModule>(),
  useState(initial: unknown) {
    const values = state.values, index = state.cursor++;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (next: unknown) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
  },
  useRef(initial: unknown) {
    const index = state.cursor++;
    if (!(index in state.values)) state.values[index] = { current: initial };
    return state.values[index];
  },
}));
vi.mock("../apps/dashboard/src/api/queries.ts", () => ({
  useAdminSyncBlockTrigger: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useAdminSyncBlockPause: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useAdminSyncBlockResume: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useAdminSyncBlockReset: () => ({ isPending: state.pending, mutateAsync: state.reset }),
}));
vi.mock("../apps/dashboard/node_modules/sonner", () => ({ toast: { success: state.success } }));

import { SyncBlockActions } from "../apps/dashboard/src/pages/settings/sync/SyncBlockActions.tsx";
import { ConfirmModal } from "../apps/dashboard/src/components/shared/ConfirmModal.tsx";

type Element = ReactElement<Record<string, unknown>>;
const block: SyncBlockStatus = {
  block: "financials", state: "up_to_date", succeededAt: null, progress: null,
  progressStream: null, progressRole: null, error: null, statusReason: null,
  primaryFresh: true, needsAttention: false, nextDueAt: null, nextRetryAt: null,
  intervals: [], metrics: {}, connectionStatus: null, substreams: [],
};
function draw(pageLabel: string) {
  state.cursor = 0;
  return SyncBlockActions({ pageLabel, platform: "fansly", block });
}
function find(node: ReactNode, matches: (element: Element) => boolean): Element {
  const queue: ReactNode[] = [node];
  while (queue.length) {
    const child = queue.shift();
    if (Array.isArray(child)) { queue.push(...child); continue; }
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (matches(child)) return child;
    queue.push(child.props.children as ReactNode);
  }
  throw new Error("Control not found");
}
function openReset(pageLabel: string) {
  const button = find(draw(pageLabel), item => item.type === "button" && item.props.children === "Сбросить состояние");
  (button.props.onClick as () => void)();
}
function review(pageLabel: string) { return find(draw(pageLabel), item => item.type === ConfirmModal); }

beforeEach(() => { state.values = []; state.cursor = 0; state.pending = false; vi.resetAllMocks(); });

describe("Sync reset confirmation context", () => {
  it("keeps the original target when the cached account changes before confirmation and during its request", async () => {
    let resolve!: (result: unknown) => void;
    const result = new Promise(done => { resolve = done; });
    state.reset.mockImplementation(() => { state.pending = true; return result.finally(() => { state.pending = false; }); });

    openReset("original-account");
    const originalTitle = review("original-account").props.title;
    // Back/Forward changes the account without unmounting this block's state.
    const moved = review("other-account");
    expect(moved.props.title).toBe(originalTitle);
    expect(moved.props.message).toContain("Страница original-account.");
    expect(moved.props.message).not.toContain("other-account");
    const pending = (moved.props.onConfirm as () => Promise<void>)();
    await (moved.props.onConfirm as () => Promise<void>)();
    expect(state.reset).toHaveBeenCalledExactlyOnceWith({ pageLabel: "original-account", block: "financials" });

    const sending = review("third-account");
    expect(sending.props.isPending).toBe(true);
    (sending.props.onClose as () => void)();
    expect(review("third-account").props.message).toContain("Страница original-account.");
    resolve({ accepted: true });
    await pending;
    expect(state.success).toHaveBeenCalledExactlyOnceWith("original-account · Financials: состояние сброшено, запуск запрошен");
    expect(() => review("third-account")).toThrow("Control not found");

    openReset("third-account");
    expect(review("third-account").props.message).toContain("Страница third-account.");
  });
});
