import type { ReactNode } from "react";
import { Card, EmptyState } from "@agency_hub_core/ui";

/** A screen that is not built yet: what it will answer (spec §4). Removed by its builder. */
export function ScreenStub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <EmptyState title={title}>{children}</EmptyState>
    </Card>
  );
}
