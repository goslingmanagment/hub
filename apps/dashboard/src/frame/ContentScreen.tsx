import { useEffect, useMemo, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuthMe } from "@/api/auth";
import { usePages } from "@/api/pages";
import { KernelApiError } from "@/api/sdk";
import { DashboardShellProvider } from "@/components/layout/DashboardShellContext";
import { ScreenFrame } from "@/components/layout/ScreenFrame";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { StatusPanel } from "@/components/shared/StatusPanel";
import { frameModel } from "@/lib/frameScope";
import { buildLoginRoute } from "@/lib/navigation";

/**
 * One screen of Hub inside ContentOps (products plan §2.4, package C2): «Публикации» or «Статистика», the console's own
 * screen and its header, without the console's frame, menu or search. ContentOps frames it on its whole working area
 * and names the model in the address; the person acts with their own Hub session (the owner every page, a content
 * manager the pages of their models — Hub cuts every read and write). Opened by its own address (ContentOps is off),
 * it is the same page on its own.
 *
 * To the frame around it (another window, ContentOps) it says two things, no more: where it is now (`location`: the
 * query of its address, which ContentOps mirrors into its own so «Назад» and a reload keep the place) and that nobody
 * is signed in to Hub here (`signed-out`: ContentOps shows «Войдите через Hub» instead of the screen).
 */
export type ContentScreenId = "publications" | "stats";

export const CONTENT_SCREEN_PATH: Readonly<Record<ContentScreenId, string>> = {
  publications: "/frame/publications",
  stats: "/frame/content-stats",
};

const MESSAGE_SOURCE = "hub-content-screen";

function framed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/** A word to the frame around: the address's query here, or that nobody is signed in. Nothing else is sent. */
function tellFrame(message: { type: "location"; search: string } | { type: "signed-out" }) {
  if (!framed()) return;
  // Only ContentOps' public name may frame this page (Hub's frame-ancestors), so the window above is that one.
  window.parent.postMessage({ source: MESSAGE_SOURCE, ...message }, "*");
}

/** The query without the model: ContentOps keeps the model in its own path. */
function mirroredSearch(search: string): string {
  const query = new URLSearchParams(search);
  query.delete("model");
  const text = query.toString();
  return text ? `?${text}` : "";
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-bg p-6"><div className="card card-body max-w-md">{children}</div></div>;
}

function Mirror() {
  const location = useLocation();
  useEffect(() => {
    tellFrame({ type: "location", search: mirroredSearch(location.search) });
  }, [location.search]);
  return null;
}

export function ContentScreen({ screen, children }: { screen: ContentScreenId; children: ReactNode }) {
  const location = useLocation();
  const me = useAuthMe();
  const signedIn = Boolean(me.data?.user);
  const role = me.data?.user.role;
  const allowed = role === "owner" || role === "content_manager";
  const catalog = usePages({ enabled: signedIn && allowed });
  const noSession = me.error instanceof KernelApiError && me.error.status === 401;

  useEffect(() => {
    if (noSession) tellFrame({ type: "signed-out" });
  }, [noSession]);

  // The model ContentOps named: its pages alone are offered (the reads are cut by Hub anyway).
  const model = frameModel();
  const pages = useMemo(
    () => (catalog.data ?? []).filter((page) => model === null || page.modelSlug.toLowerCase() === model),
    [catalog.data, model],
  );

  if (me.isLoading) return <div role="status" className="py-16 text-center text-sm text-text-muted">Проверяем вход…</div>;
  if (noSession) {
    // On its own: Hub's sign-in, back here after. Inside ContentOps: the frame around says it with its button.
    if (!framed()) return <Navigate to={buildLoginRoute(`${location.pathname}${location.search}${location.hash}`)} replace />;
    return (
      <Centered>
        <h1 className="card-title">Войдите через Hub</h1>
        <p className="mt-2 text-sm text-text-secondary">Этот экран открывается с вашим входом в Hub.</p>
      </Centered>
    );
  }
  if (me.isError || !me.data) {
    return (
      <Centered>
        <h1 className="card-title">Не удалось проверить вход</h1>
        <p className="mt-2 text-sm text-text-secondary">Hub не ответил. Повторите, когда связь восстановится.</p>
        <button type="button" disabled={me.isFetching} onClick={() => void me.refetch()} className="btn btn-primary mt-4">{me.isFetching ? "Проверяем…" : "Повторить"}</button>
      </Centered>
    );
  }
  if (!allowed) {
    return (
      <Centered>
        <StatusPanel title="Этот экран для владельца и контент-менеджера" description="Ваш вход его не открывает." />
      </Centered>
    );
  }

  const shell = {
    pageCatalogState: catalog.data ? "ready" : catalog.isLoading ? "loading" : "error",
    pageCatalogError: catalog.isError ? (catalog.error instanceof Error ? catalog.error : new Error("Page catalog failed to load")) : null,
    retryPageCatalog: catalog.refetch,
    pages,
    findPageByLabel: (label: string | undefined) => pages.find((page) => page.label === label) ?? null,
  } as const;

  return (
    <DashboardShellProvider value={shell}>
      <Mirror />
      <main className="app-main">
        <div className="app-content">
          <ErrorBoundary resetKey={location.pathname}>
            <Routes>
              <Route element={<ScreenFrame />}>
                <Route path={CONTENT_SCREEN_PATH[screen]} element={children} />
              </Route>
              <Route path="*" element={<Navigate to={`${CONTENT_SCREEN_PATH[screen]}${location.search}`} replace />} />
            </Routes>
          </ErrorBoundary>
        </div>
      </main>
    </DashboardShellProvider>
  );
}
