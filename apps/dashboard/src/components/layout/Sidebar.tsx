import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import {
  CalendarClock,
  ChartColumn,
  ChevronsUpDown,
  Heart,
  House,
  LogOut,
  Monitor,
  Moon,
  Search,
  Settings,
  Sun,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useLogout } from "@/api/queries";
import { useWaitingCounts } from "@/api/waiting";
import { PALETTE_ARIA_SHORTCUT, PALETTE_SHORTCUT } from "@/lib/paletteShortcut";
import { clearDashboardSession } from "@/lib/queryClient";
import { matchScreen, menuOf, sectionHome, type Section } from "@/lib/sections";
import { THEME_OPTIONS, useThemeStore, type ThemePreference } from "@/lib/theme";

interface SidebarProps {
  user: { username: string; role: string };
  onOpenPalette?: (() => void) | undefined;
}

const ICONS: Readonly<Record<Section["icon"], LucideIcon>> = {
  House,
  Wallet,
  Heart,
  ChartColumn,
  CalendarClock,
  Users,
  Settings,
  Wrench,
};

const THEME_ICONS: Record<ThemePreference, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

const ROLE_LABELS: Record<string, string> = {
  owner: "Владелец",
  team_lead: "Тимлид",
  chatter: "Чаттер",
};

function ThemeSwitch() {
  const { theme, setTheme } = useThemeStore();
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1">
      <span className="text-sm text-text-secondary" id="theme-switch-label">Тема</span>
      <div className="segmented" role="group" aria-labelledby="theme-switch-label">
        {THEME_OPTIONS.map((option) => {
          const Icon = THEME_ICONS[option.value];
          return (
            <button
              key={option.value}
              type="button"
              className="segment !px-2"
              aria-pressed={theme === option.value}
              aria-label={option.label}
              title={option.label}
              onClick={() => setTheme(option.value)}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Who is signed in, the theme and the way out: at the bottom of the menu. */
function AccountMenu({ user }: { user: SidebarProps["user"] }) {
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleLogout() {
    if (logout.isPending) return;
    try {
      await logout.mutateAsync();
      clearDashboardSession();
      window.location.assign("/login");
    } catch { /* The mutation retains the failure; do not report an unconfirmed logout. */ }
  }

  return (
    <div ref={wrap} className="account-wrap">
      {open && (
        <div className="menu account-menu !w-auto">
          <ThemeSwitch />
          <div className="menu-rule" />
          <button type="button" className="menu-item" disabled={logout.isPending} onClick={() => void handleLogout()}>
            <LogOut size={16} aria-hidden="true" />
            {logout.isPending ? "Выходим…" : "Выйти"}
          </button>
          {logout.isError && <p role="alert" className="field-error px-2 py-1">Выход не подтверждён. Повторите попытку.</p>}
        </div>
      )}
      <button
        ref={button}
        type="button"
        className="account"
        aria-label="Меню аккаунта"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="avatar" aria-hidden="true">{user.username.charAt(0).toUpperCase()}</span>
        <span className="account-text">
          <span className="account-name">{user.username}</span>
          <span className="account-role">{ROLE_LABELS[user.role] ?? "Сотрудник"}</span>
        </span>
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The menu by topics (owner, 2026-11-04). One number only: at «Главная», the sum
 * of what waits for the owner; no dots anywhere else. A page is not a branch of
 * the menu: it is a filter in the screen's header.
 */
export function Sidebar({ user, onOpenPalette }: SidebarProps) {
  const location = useLocation();
  const waiting = useWaitingCounts(user.role);
  const currentSection = matchScreen(location.pathname)?.screen.section ?? null;
  const menu = menuOf(user.role);
  const upper = menu.filter((section) => !section.lower);
  const lower = menu.filter((section) => section.lower);

  const item = (section: Section) => {
    const Icon = ICONS[section.icon];
    return (
      <Link
        key={section.id}
        to={sectionHome(section, user.role)}
        className="nav-item"
        aria-current={currentSection === section.id ? "page" : undefined}
      >
        <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 truncate">{section.label}</span>
        {section.id === "home" && waiting.total > 0 && (
          <span className="nav-count" aria-label={`Ждут вас: ${waiting.total}`}>{waiting.total}</span>
        )}
      </Link>
    );
  };

  return (
    <nav aria-label="Разделы" className="sidebar">
      <Link to="/" className="logo"><span>Agency</span>Hub</Link>
      {onOpenPalette && (
        <button type="button" className="palette-trigger" onClick={onOpenPalette} aria-keyshortcuts={PALETTE_ARIA_SHORTCUT} title="Найти: раздел, страницу, фана">
          <Search size={16} aria-hidden="true" />
          <span>Найти</span>
          <kbd className="kbd" aria-hidden="true">{PALETTE_SHORTCUT}</kbd>
        </button>
      )}
      <div className="nav">{upper.map(item)}</div>
      {lower.length > 0 && (
        <>
          <div className="nav-rule" />
          <div className="nav !mt-0">{lower.map(item)}</div>
        </>
      )}
      <AccountMenu user={user} />
    </nav>
  );
}
