import type { ReactNode } from "react";
import { QueryNotice } from "./QueryNotice.js";
import { StatusPanel } from "./StatusPanel.js";

/** A panel keeps its identity while its own request is pending or unavailable. */
export function QuerySection({
  title,
  hasData,
  isError,
  retry,
  children,
}: {
  title: string;
  hasData: boolean;
  isError?: boolean;
  retry?: () => unknown;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      {hasData ? (
        <>
          <QueryNotice error={Boolean(isError)} stale retry={() => retry?.()} />
          {children}
        </>
      ) : (
        <StatusPanel
          title={title}
          description={
            isError ? "Не удалось загрузить данные." : "Загружаем данные…"
          }
          tone={isError ? "error" : "default"}
          action={
            isError && retry ? (
              <button
                type="button"
                className="text-accent font-semibold underline"
                onClick={() => void retry()}
              >
                Повторить
              </button>
            ) : undefined
          }
        />
      )}
    </section>
  );
}
