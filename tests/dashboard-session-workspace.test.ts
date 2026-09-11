import type * as ReactQuery from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { QueryClient } from "../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../apps/dashboard/node_modules/@tanstack/react-query/build/modern/index.js", async importOriginal => {
  const actual = await importOriginal<typeof ReactQuery>();
  return { ...actual, useQueryClient: () => state.client,
    useQuery: ({ queryKey, initialData }: { queryKey: string[]; initialData: () => unknown }) => {
      const client = state.client as QueryClient;
      if (!client.getQueryState(queryKey)) client.setQueryData(queryKey, initialData());
      return { data: client.getQueryData(queryKey) };
    },
  };
});
import { useSessionWorkspace } from "../apps/dashboard/src/lib/useSessionWorkspace.ts";

beforeEach(() => { state.client = new QueryClient(); });
describe("session workspace request lifetime", () => {
  it("keeps a frozen request and a synchronous lock across route remounts", () => {
    const open = () => useSessionWorkspace("actions", () => ({ pending: false, body: "", id: "" }));
    const [, update, read] = open();
    update({ pending: true, body: "original command", id: "same-id" });
    expect(read().pending).toBe(true);
    expect(open()[0]).toEqual({ pending: true, body: "original command", id: "same-id" });
    update(previous => ({ ...previous, pending: false }));
    expect(open()[0].id).toBe("same-id");
  });
  it("does not let a late reply recreate logged-out data or overwrite the next login", () => {
    const [, previousSessionUpdate] = useSessionWorkspace("actions", () => "original-user");
    (state.client as QueryClient).clear();
    previousSessionUpdate("late-original-reply");
    expect((state.client as QueryClient).getQueryData(["dashboard-workspace", "actions"])).toBeUndefined();
    const [, nextSessionUpdate, read] = useSessionWorkspace("actions", () => "next-user");
    nextSessionUpdate("next-user-draft");
    previousSessionUpdate("late-original-reply");
    expect(read()).toBe("next-user-draft");
  });
  it("preserves an explicitly reset null draft on later updates", () => {
    const [, update, read] = useSessionWorkspace<string | null>("settings", () => "initial-draft");
    update(null);
    update(previous => previous === null ? "new-draft" : "incorrect-old-draft");
    expect(read()).toBe("new-draft");
  });
});
