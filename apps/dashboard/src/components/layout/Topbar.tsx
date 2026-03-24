import { useEffect, useRef, useState } from "react";
import { useLocation, Link } from "react-router";
import { LogOut, ChevronDown } from "lucide-react";
import { useLogout, useOverview } from "@/api/queries";
import { PeriodSelector } from "@/components/shared/PeriodSelector";
import { clearDashboardSession } from "@/lib/queryClient";

interface TopbarProps {
  user: { username: string; role: string };
}

export function Topbar({ user }: TopbarProps) {
  const location = useLocation();
  const logout = useLogout();
  const { data: overview } = useOverview();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const breadcrumbs = buildBreadcrumbs(location.pathname, overview);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  async function handleLogout() {
    try {
      await logout.mutateAsync();
    } finally {
      clearDashboardSession();
      window.location.assign("/login");
    }
  }

  return (
    <div className="h-[56px] bg-card border-b border-border flex items-center justify-between px-7 fixed top-0 left-[248px] right-0 z-10">
      <div className="flex items-center gap-2">
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && <span className="text-text-muted/60 text-sm">›</span>}
            {crumb.href ? (
              <Link to={crumb.href} className="text-sm text-text-muted hover:text-text-secondary cursor-pointer">
                {crumb.label}
              </Link>
            ) : (
              <span className="text-base font-semibold text-text-primary tracking-[-0.02em]">
                {crumb.label}
              </span>
            )}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <PeriodSelector />

        <div className="relative ml-2.5" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex items-center gap-2 rounded-full border border-border bg-card px-2 py-1 hover:bg-hover-alt"
          >
            <div className="w-8 h-8 rounded-full bg-hover flex items-center justify-center text-[13px] text-text-secondary font-semibold">
              {user.username.charAt(0).toUpperCase()}
            </div>
            <ChevronDown size={14} className="text-text-muted" />
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
                className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text-secondary hover:bg-hover hover:text-text-primary"
              >
                <LogOut size={14} />
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function buildBreadcrumbs(
  pathname: string,
  overview?: OverviewResponse | null,
): { label: string; href?: string }[] {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 0) return [{ label: "Overview" }];

  if (parts[0] === "sync") return [{ label: "Overview", href: "/" }, { label: "Sync Diagnostics" }];

  if (parts[0] === "settings") return [{ label: "Overview", href: "/" }, { label: "Settings" }];

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
    const pageLabel = parts[1];
    const page = overview?.pages.find((item) => item.label === pageLabel);
    const pageTitle = page?.label ?? pageLabel;
    const crumbs: { label: string; href?: string }[] = [
      { label: "Overview", href: "/" },
      parts.length > 2
        ? { label: pageTitle, href: `/pages/${pageLabel}` }
        : { label: pageTitle },
    ];

    if (parts[2] === "subscribers") {
      crumbs.push({ label: "Subscribers" });
    } else if (parts[2] === "followers") {
      crumbs.push({ label: "Followers" });
    } else if (parts[2] === "top-supporters") {
      crumbs.push({ label: "Top Supporters" });
    } else if (parts[2] === "crm") {
      crumbs.push({ label: "CRM" });
    } else if (parts[2] === "fans" && parts[3] && parts[4]) {
      crumbs.push({ label: parts[4] });
    }

    return crumbs;
  }

  return [{ label: "Overview" }];
}

type OverviewResponse = NonNullable<ReturnType<typeof useOverview>["data"]>;
