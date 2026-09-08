SET statement_timeout = '180s';
select table_name from information_schema.tables where table_schema='public' order by 1;
