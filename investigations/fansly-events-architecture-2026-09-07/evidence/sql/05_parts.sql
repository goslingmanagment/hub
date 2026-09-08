SET statement_timeout = '180s';
select c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_get_expr(c.relpartbound, c.oid) as bounds
from pg_class c
join pg_inherits i on i.inhrelid = c.oid
join pg_class p on p.oid = i.inhparent
where p.relname = 'observations'
order by c.relname;
