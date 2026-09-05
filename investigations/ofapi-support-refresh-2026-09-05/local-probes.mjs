#!/usr/bin/env -S node --import tsx/esm
// Run from the Hub root:
// node --import tsx/esm /Users/dmitriy/code/goose/hub/investigations/ofapi-support-refresh-2026-09-05/local-probes.mjs
// Pure local validation only: no API key, network calls, DB connection or production writes.
import { resolveOfapiReadGatewayRequest } from '/Users/dmitriy/code/goose/hub/apps/runtime/src/services/ofapi-read-gateway.ts';
import { createOfapiCommandBodySchema } from '/Users/dmitriy/code/goose/hub/packages/contracts/src/routes.ts';

const cases = [
  ['documented-gallery-photos', 'acct_AUDIT/chats/123/media', { type: 'photos' }],
  ['legacy-gallery-photo', 'acct_AUDIT/chats/123/media', { type: 'photo' }],
  ['banned-words', 'banned-words', {}],
  ['documented-message-filter-pinned', 'acct_AUDIT/chats/123/messages', { filter: 'pinned' }],
  ['blocked-static-collision', 'acct_AUDIT/users/blocked', {}],
  ['restricted-static-collision', 'acct_AUDIT/users/restricted', {}],
  ['message-search-static-collision', 'acct_AUDIT/chats/123/messages/search', {}],
  ['documented-message-search', 'acct_AUDIT/chats/123/messages/search', { query: 'hello' }],
  ['fans-max-spend', 'acct_AUDIT/fans/all', { 'filter[max_total_spent]': '0' }],
  ['documented-vault-lightweight', 'acct_AUDIT/media/vault/lists', { lightweight: 'true' }],
  ['documented-list-view-queue', 'acct_AUDIT/user-lists', { view: 'queue' }],
];
const rows = cases.map(([name, path, query]) => {
  try {
    return { name, path, query, result: resolveOfapiReadGatewayRequest(path, query) };
  } catch (error) {
    return { name, path, query, error: error.message };
  }
});
const fractionalPrice = {
  clientCommandId: '00000000-0000-4000-8000-000000000001',
  kind: 'send_media_message_v1',
  accountId: 'acct_AUDIT',
  conversationId: '123',
  payload: { text: 'fixture', price: 6.97, mediaFiles: ['456'], previews: [] },
};
const parsed = createOfapiCommandBodySchema.safeParse(fractionalPrice);
rows.push({
  name: 'documented-fractional-ppv-price',
  providerDocumentedPrice: 6.97,
  hubSchemaAccepted: parsed.success,
  ...(!parsed.success ? { issues: parsed.error.issues } : {}),
});
console.log(JSON.stringify(rows, null, 2));
