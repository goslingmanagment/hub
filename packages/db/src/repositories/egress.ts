import { sql, type SQLWrapper } from "drizzle-orm";

export function egressKeySql(
  rateLimitScopeKey: SQLWrapper,
  proxyUrl: SQLWrapper,
) {
  const urlMatch = sql`regexp_match(${proxyUrl}, '^([a-z][a-z0-9+.-]*)://(?:[^/@?#]+@)?([^/:?#]+)(?::([0-9]+))?')`;
  const scheme = sql`lower((${urlMatch})[1])`;
  const host = sql`lower((${urlMatch})[2])`;
  const port = sql`(${urlMatch})[3]`;
  const defaultPort = sql`case ${scheme}
    when 'http' then '80'
    when 'https' then '443'
    when 'socks5' then '1080'
    else null
  end`;

  return sql<string>`coalesce(
    ${rateLimitScopeKey},
    case
      when ${proxyUrl} is null then 'direct'
      when ${scheme} is null or ${host} is null then 'direct'
      else coalesce(${scheme} || '://' || ${host} || ':' || coalesce(${port}, ${defaultPort}), 'direct')
    end
  )`;
}
