import { Navigate, useSearchParams } from "react-router";

/**
 * Where an old /notifications link belongs now. The screen held three jobs:
 * incidents are work and live in «Требует внимания»; Telegram and the daily
 * report are settings.
 */
export function notificationsRedirectTarget(search: URLSearchParams): string {
  return search.get("tab") === "incidents" ? "/incidents" : "/settings?tab=notifications";
}

export function NotificationsPage() {
  const [searchParams] = useSearchParams();
  return <Navigate to={notificationsRedirectTarget(searchParams)} replace />;
}
