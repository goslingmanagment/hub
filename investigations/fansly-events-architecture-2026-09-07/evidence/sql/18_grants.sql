SET statement_timeout = '180s';
select table_name, privilege_type, string_agg(column_name, ',' order by column_name) as cols
from information_schema.column_privileges
where grantee = 'read_only' and table_schema = 'public'
group by 1,2 order by 1;
