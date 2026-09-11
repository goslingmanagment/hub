import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TrendSparkline } from "../apps/dashboard/src/components/shared/TrendSparkline.tsx";

function render(values: number[]) {
  return renderToStaticMarkup(createElement(TrendSparkline, { values }));
}

function coordinates(markup: string, tag: "polyline" | "polygon") {
  const points = markup.match(new RegExp(`<${tag}[^>]*points="([^"]+)"`))?.[1];
  expect(points).toBeDefined();
  return points!.split(" ").map((point): [number, number] => {
    const [x, y] = point.split(",");
    return [Number(x), Number(y)];
  });
}

describe("revenue trend sparklines", () => {
  it.each([64000, 0, -64000])("does not invent a trend from one daily total (%s mills)", value => {
    const markup = render([value]);
    expect(markup).not.toContain("<polygon");
    expect(markup).not.toContain("<polyline");
    expect(markup).toContain("<circle");
  });

  it("keeps a refund day visible below the zero level", () => {
    const markup = render([100000, -20000, 0]);
    const points = coordinates(markup, "polyline");
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(140);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(36);
    }
    expect(points).toHaveLength(3);
    expect(points[0]![1]).toBeLessThan(points[2]![1]);
    expect(points[1]![1]).toBeGreaterThan(points[2]![1]);
    const area = coordinates(markup, "polygon");
    expect(area[0]![1]).toBe(points[2]![1]);
    expect(area.at(-1)![1]).toBe(points[2]![1]);
  });

  it("keeps an entirely negative series inside the chart", () => {
    const points = coordinates(render([-100000, -50000]), "polyline");
    expect(points).toHaveLength(2);
    expect(points[0]![1]).toBeGreaterThan(points[1]![1]);
    for (const [, y] of points) {
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(36);
    }
  });

  it("renders an all-zero series as a finite flat line", () => {
    const points = coordinates(render([0, 0, 0]), "polyline");
    expect(new Set(points.map(([, y]) => y)).size).toBe(1);
    expect(points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });
});
