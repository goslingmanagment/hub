import { Navigate, useLocation, useParams } from "react-router";
import { legacyTarget, type LegacyRule } from "@/lib/redirects";

/**
 * Takes an old address to its new place: its query parameters, its anchor and
 * `location.state` come along. Only `<Navigate replace>`: nothing here writes,
 * and the route it lands on checks the rights.
 */
export function Legacy({ rule }: { rule: LegacyRule }) {
  const params = useParams();
  const location = useLocation();
  const target = legacyTarget(rule, params, location.search, location.hash);
  return <Navigate to={target} state={location.state} replace />;
}
