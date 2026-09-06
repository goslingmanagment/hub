import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
      createElement(OfapiContentEvidence, {
        pages: [{ id: 1, label: "Creator" }],
      }),
    );
    expect(html).toContain("не подтверждает доставку");
    expect(html).toContain("Без надёжной ссылки на пост: 2");
    expect(html).toContain("Завершение");
    expect(html).toContain("да / нет");
    expect(html).toContain("2026-09-05T10:00:00Z");
  });
});
