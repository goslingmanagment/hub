import { useEffect, useRef, useState } from "react";
import { useLocation, Link } from "react-router";
import { LogOut, ChevronDown, Menu } from "lucide-react";
import { useLogout } from "@/api/queries";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { clearDashboardSession } from "@/lib/queryClient";
import { buildPageRoute, decodeRouteSegment, isSafeInAppPath, resolveFanLabelFromState, resolveFanProfileBackTarget } from "@/lib/navigation";
import { useDashboardShell } from "./DashboardShellContext.js";

interface TopbarProps {
  onOpenNavigation?: () => void;
  user: { username: string; role: string };
}

export function Topbar({ user, onOpenNavigation }: TopbarProps) {
  const location = useLocation();
  const logout = useLogout();
  const { pages } = useDashboardShell();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);

  const backTo = new URLSearchParams(location.search).get("backTo") ?? resolveFanProfileBackTarget(location.state, undefined);
  const overviewBack = backTo && isSafeInAppPath(backTo) && (backTo === "/" || backTo.startsWith("/?")) ? backTo : "/";
  const breadcrumbs = buildBreadcrumbs(location.pathname, pages, location.state).map((crumb) => crumb.href === "/" ? { ...crumb, href: overviewBack } : crumb);
  const periodSelectorMode = getPeriodSelectorMode(location.pathname);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { setMenuOpen(false); menuButtonRef.current?.focus(); }
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function handleLogout() {
    if (logout.isPending) return;
    try {
      await logout.mutateAsync();
      clearDashboardSession();
      window.location.assign("/login");
    } catch { /* The mutation retains the failure; do not report an unconfirmed logout. */ }
  }

  return (
    <div className="h-[56px] bg-card border-b border-border flex items-center justify-between px-3 md:px-7 fixed top-0 left-0 md:left-[248px] right-0 z-10">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden">
        <button type="button" className="shrink-0 rounded p-1 md:hidden" aria-label="Открыть навигацию" onClick={onOpenNavigation}><Menu size={20} /></button>
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex min-w-0 items-center gap-2">
            {i > 0 && <span className="text-text-muted/60 text-sm">›</span>}
            {crumb.href ? (
              <Link to={crumb.href} className="truncate text-sm text-text-muted hover:text-text-secondary cursor-pointer">
                {crumb.label}
              </Link>
            ) : (
              <span className="truncate text-base font-semibold text-text-primary tracking-[-0.02em]">
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {periodSelectorMode && <PeriodSelector mode={periodSelectorMode} />}

        <div className="relative ml-1 sm:ml-2.5" ref={menuRef}>
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Меню аккаунта"
            aria-expanded={menuOpen}
            className="flex items-center gap-2 rounded-full border border-border bg-card px-2 py-1 hover:bg-hover-alt"
          >
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-hover flex items-center justify-center text-[13px] text-text-secondary font-semibold">
              {user.username.charAt(0).toUpperCase()}
            </div>
            <ChevronDown size={14} className="hidden sm:block text-text-muted" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-2 w-56 rounded-xl border border-border bg-card p-2 shadow-lg">
              <div className="px-3 py-2 border-b border-border-light">
                <div className="text-sm font-semibold text-text-primary">{user.username}</div>
                <div className="text-xs capitalize text-text-muted">{user.role.replaceAll("_", " ")}</div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                disabled={logout.isPending}
                className="mt-2 flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-secondary hover:bg-hover hover:text-text-primary disabled:opacity-50"
              >
                <LogOut size={14} />
                {logout.isPending ? "Выходим…" : "Выйти"}
              </button>
              {logout.isError && <p role="alert" className="px-3 py-2 text-sm text-danger">Выход не подтверждён. Повторите попытку.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getPeriodSelectorMode(pathname: string): "dashboard" | "spender" | "topSupporters" | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "dashboard";
  if (parts[0] === "pages" && parts[1]) {
    if (!parts[2]) return "dashboard"; // PageDetail
    if (parts[2] === "top-supporters") return "topSupporters";
    if (parts[2] === "spender-autolists") return "spender";
    if (parts[2] === "fans" && parts[3] && parts[4]) return "spender";
    return null;
  }
  if (parts[0] === "usage") return null;
  return null;
}

function buildBreadcrumbs(
  pathname: string,
  pages: Array<{ label: string }>,
  locationState?: unknown,
): { label: string; href?: string }[] {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 0) return [{ label: "Overview" }];

  if (parts[0] === "ofapi-actions") return [{ label: "Управление OnlyFans" }];

  if (parts[0] === "settings") return [{ label: "Overview", href: "/" }, { label: "Settings" }];

  if (parts[0] === "usage") return [{ label: "Overview", href: "/" }, { label: "Usage" }];
  if (parts[0] === "transactions") return [{ label: "Overview", href: "/" }, { label: "Операции" }];

  if (parts[0] === "ofapi-credits") return [{ label: "Overview", href: "/" }, { label: "OFAPI Credits" }];

  if (parts[0] === "notifications") return [{ label: "Overview", href: "/" }, { label: "Notifications" }];

  if (parts[0] === "agent-hydration") {
    return [{ label: "Overview", href: "/" }, { label: "Hydration requests" }];
  }

  if (parts[0] === "dev") {
    const devLabels: Record<string, string> = {
      log: "Log",
      "sync-status": "Sync Status",
      queue: "Queue",
      "db-stats": "DB Stats",
      incidents: "Incidents",
    };
    const crumbs: { label: string; href?: string }[] = [
      { label: "Overview", href: "/" },
      parts[1] ? { label: "Dev", href: "/dev/log" } : { label: "Dev" },
    ];
    if (parts[1] && devLabels[parts[1]]) {
      crumbs.push({ label: devLabels[parts[1]] });
    }
    return crumbs;
  }

  if (parts[0] === "pages" && parts[1]) {
    const pageLabel = decodeRouteSegment(parts[1]);
    const page = pages.find((item) => item.label === pageLabel);
    const pageTitle = page?.label ?? pageLabel;
    const crumbs: { label: string; href?: string }[] = [
      { label: "Overview", href: "/" },
      parts.length > 2
        ? { label: pageTitle, href: buildPageRoute(pageLabel) }
        : { label: pageTitle },
    ];

    if (parts[2] === "subscribers") {
      crumbs.push({ label: "Subscribers" });
    } else if (parts[2] === "followers") {
      crumbs.push({ label: "Followers" });
    } else if (parts[2] === "top-supporters") {
      crumbs.push({ label: "Top Supporters" });
    } else if (parts[2] === "deleted-fans") {
      crumbs.push({ label: "Deleted Fans" });
    } else if (parts[2] === "spender-autolists") {
      crumbs.push({ label: "Auto List" });
    } else if (parts[2] === "workboard" || parts[2] === "crm") {
      crumbs.push({ label: "Workboard" });
    } else if (parts[2] === "fans" && parts[3] && parts[4]) {
      const fanLabel = resolveFanLabelFromState(locationState) ?? decodeRouteSegment(parts[4]);
      crumbs.push({ label: fanLabel });
    }

    return crumbs;
  }

  return [{ label: "Overview" }];
}
