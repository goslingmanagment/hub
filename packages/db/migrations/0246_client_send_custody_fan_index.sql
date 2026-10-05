-- 0246_client_send_custody_fan_index.sql
--
-- chat-extension send custody (hub-pr-plan H-7b): the sends to one fan, in
-- every state, newest last.
--
-- The claim status read reports the reader's own last dispatched send to a fan
-- in the state it ended (sent, failed, resolved either way): the one way a
-- client that lost track of its send learns of a manual resolve. Every index
-- of 0241 on client_send_custody is partial (the open send, the parts that
-- count as sent, the message ids, the reader's rate window), so a failed or
-- resolved-not-sent row of a fan could be found only by walking every dispatch
-- of the reader. This index reads a fan's sends directly: the cost is the
-- sends to one fan, a handful.
--
-- Built in the migration's own transaction, without CONCURRENTLY: no route
-- has written client_send_custody before the release that carries this
-- migration (H-7b adds the first), so the table is empty and the build is
-- instant. Purely additive; the previous image never names the index.

create index if not exists client_send_custody_fan
  on client_send_custody (page_id, fan_ref, created_at);

comment on index client_send_custody_fan is
  'chat-extension (H-7b): the sends to one fan in every state, by time. The claim status read finds the reader''s own last dispatched send through it.';
