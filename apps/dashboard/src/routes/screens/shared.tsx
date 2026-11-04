/**
 * What the groups' route files share. Each group owns one file next to this one:
 * its routes and what they render (design/build-rules.md). A rebuild replaces the
 * element of its own routes there; App.tsx does not change.
 */
import { Fragment, lazy, type ComponentType, type ReactNode } from "react";
import { Outlet } from "react-router";
import { OwnerRoute } from "@/components/layout/OwnerRoute";
import { useRoutePageLabel } from "@/components/layout/usePageFilter";
import { Notice } from "@/components/ui/Notice";

/** A lazily loaded named export of a screen's module. */
export const named = <T extends string>(load: () => Promise<Record<T, ComponentType>>, name: T) =>
  lazy(() => load().then((module) => ({ default: module[name] })));

/** Every screen behind it is the owner's: hidden in the menu (lib/sections.ts) and
 *  refused here, both. The server's own check stays the real protection. */
export function Owner() {
  return <OwnerRoute><Outlet /></OwnerRoute>;
}

/** A one-page list starts anew when its page changes: no row, panel or draft of
 *  another page survives. */
export function OnePage({ children }: { children: ReactNode }) {
  const pageLabel = useRoutePageLabel();
  if (!pageLabel) return null;
  return <Fragment key={pageLabel}>{children}</Fragment>;
}

/** The sentence over what the switched-off OnlyFans API left behind. */
export function OfapiOffNotice({ children }: { children?: ReactNode }) {
  return (
    <Notice tone="off">
      <b>OnlyFans API выключен с 1 ноября.</b> {children}
    </Notice>
  );
}
