import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "../apps/dashboard/node_modules/react-router/dist/development/index.js";
import { describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
vi.mock("../apps/dashboard/src/api/adminOfapiContentEvents.ts", () => ({
  useAdminOfapiContentEvents: query,
}));
import { OfapiContentEvidence } from "../apps/dashboard/src/pages/settings/OfapiContentEvidence.tsx";
describe("owner content evidence consumer", () => {
  it("labels canceled terminal queues and incomplete evidence without inventing delivery counts", () => {
    query.mockReturnValue({
      data: {
        queues: [
          {
            queueId: "123",
            phase: "finished",
            state: { pending: 0, total: 7, isCanceled: true, hasError: false },
            observedAt: "2026-09-06T10:00:00Z",
          },
        ],
        likes: [
          {
            postRef: "456",
            fanRef: "55",
            sourceAt: "2026-09-05T10:00:00Z",
            observedAt: "2026-09-06T10:00:00Z",
          },
        ],
        unattributedLikes: 2,
        queuesHasMore: false,
        likesHasMore: false,
      },
      refetch: vi.fn(),
    });
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(OfapiContentEvidence, {
        pages: [{ id: 1, label: "Creator" }],
      })),
    );
    expect(html).toContain("не подтверждает доставку");
    expect(html).toContain("Завершение");
    expect(html).toContain("да / нет");
    const likes = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/?contentView=likes"] }, createElement(OfapiContentEvidence, { pages: [{ id: 1, label: "Creator" }] })));
    expect(likes).toContain("Без надёжной ссылки на пост: 2");
    expect(likes).toContain("2026-09-05T10:00:00Z");
  });
});
