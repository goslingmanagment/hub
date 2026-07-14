-- Clock-independent lifecycle token for optimistic persona writes and
-- tombstone-aware Desktop migration. The counter is per key and advances on
-- every accepted update/archive; legacy rows begin at revision 1.
alter table ai_personas
  add column revision bigint not null default 1;
