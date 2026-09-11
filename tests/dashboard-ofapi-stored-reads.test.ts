import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("../apps/dashboard/src/api/adminOfapiStoredReads.ts", () => ({
  useAdminOfapiStoredReads: query,
}));
import { OfapiStoredReads } from "../apps/dashboard/src/pages/settings/OfapiStoredReads.tsx";
function render(operation: string, items: unknown[]) {
  query.mockReturnValue({
    data: {
      catalog: [],
      snapshots: [
        {
          id: "1",
          operation,
          source: "onlyfansapi",
          pathname: "/acct_test/user-lists/friends",
          query: { limit: "20" },
          window: { from: null, to: null },
          observedAt: "2026-09-06T10:00:00Z",
          ageSeconds: 60,
          observationId: "123",
          coverage: {
            state: "unknown",
            reason: "continuation_unspecified",
            nextQuery: null,
          },
          items,
        },
      ],
    },
    refetch: vi.fn(),
  });
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(OfapiStoredReads, { pages: [{ id: 1, label: "Creator" }] })),
  );
}
describe("local collection snapshot consumer", () => {
  it("separates list metadata preview from membership completeness and exposes lineage", () => {
    const html = render("ofapi_read_user_list", [
      {
        nativeId: "friends",
        listId: "friends",
        listName: "Friends",
        usersCount: 10,
        previewUsers: [{ fanId: "1" }],
      },
    ]);
    expect(html).toContain("превью, не полный состав");
    expect(html).toContain("пользователей: 10 · превью: 1");
    expect(html).toContain("источник #123");
    expect(html).toContain("continuation_unspecified");
  });
  it("shows member contactability and exact local mills without treating absent rows as removal", () => {
    const html = render("ofapi_read_user_list_pinned_users", [
      {
        nativeId: "9007199254740993",
        listId: "friends",
        membershipScope: "pinned_only",
        contactability: "blocked",
        lastReplyAt: "2026-09-05T10:00:00Z",
        priorSpendMills: "12345",
      },
    ]);
    expect(html).toContain("Только закреплённые участники");
    expect(html).toContain("отсутствие фана в частичном ответе не удаляет");
    expect(html).toContain("9007199254740993");
    expect(html).toContain("blocked");
    expect(html).toContain("12.34");
  });
  it("provides useful content and financial snapshot fields without raw JSON", () => {
    const html = render("ofapi_read_post_comments", [
      {
        nativeId: "4",
        text: "Captured comment",
        replies: [{ id: "5" }],
        metrics: [{ path: "totalSpent", valueMills: "6970", value: "6970" }],
      },
    ]);
    expect(html).toContain("Captured comment");
    expect(html).toContain("Вложенных ответов: 1");
    expect(html).toContain("totalSpent: $6.97");
  });
});
