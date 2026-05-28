import { sql, type SQLWrapper } from "drizzle-orm";

export function egressKeySql(
  rateLimitScopeKey: SQLWrapper,
  proxyUrl: SQLWrapper,
) {
  return sql<string>`coalesce(
    ${rateLimitScopeKey},
    canonical_proxy_egress_key(${proxyUrl}),
    'direct'
  )`;
}
