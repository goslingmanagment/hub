import { isSafeInAppPath } from "./navigation.js";

export function authReturnTo(value: string | null | undefined): string {
  if (!value || !isSafeInAppPath(value)) return "/";
  // Never loop between the login page and itself, including encoded paths.
  const pathname = decodeURIComponent(new URL(value, "https://hub.invalid").pathname);
  return /^\/login\/?$/i.test(pathname) ? "/" : value;
}

export function buildLoginRoute(returnTo: string): string {
  const safe = authReturnTo(returnTo);
  return safe === "/"
    ? "/login"
    : `/login?${new URLSearchParams({ returnTo: safe })}`;
}
