import { describe, expect, it } from 'vitest';
import { decodeFanslyWsFrame } from '../apps/runtime/src/sync/fansly/ws/decode.ts';
import { routeWsItems, unknownRouteThread, type RouteContext, type RouteThread } from '../apps/runtime/src/sync/fansly/ws/router.ts';
import { serviceFrame } from './helpers/fansly-ws-fixtures.ts';

const OWN = '100000000000000001';
const GROUP = '300000000000000001';
const message = { id: '964743364991795201', groupId: GROUP, senderId: OWN, createdAt: 1791540000,
  content: 'synthetic broadcast', attachments: [], type: 2, correlationId: '990000000000000001' };
const bound: RouteThread = {known: true, bound: true, excluded: false, headConfirmedId: null};
function route(thread: RouteThread, own = true) {
  const ctx: RouteContext = {pageId: 7, nowMs: Date.now(), thread: () => thread,
    knownPendingTransaction: () => false, ownBroadcastActive: item => item.message.type === 2};
  const decoded = decodeFanslyWsFrame(serviceFrame({type: 1, message: {...message, senderId: own ? OWN : '200000000000000001'}}), OWN);
  return routeWsItems(decoded.items, ctx);
}

describe('audit: owner decision D22 own broadcasts create no work', () => {
  it('control: a known bound broadcast creates no work', () => expect(route(bound)).toEqual([]));
  it('an unknown chat still suppresses a positively identified own broadcast', () => expect(route(unknownRouteThread())).toEqual([]));
  it('an unbound chat still suppresses a positively identified own broadcast', () => expect(route({...bound, bound: false})).toEqual([]));
  it('control: an unknown fan message is still discovered', () => expect(route(unknownRouteThread(), false)).toMatchObject([{resource:'dm-conversations.find',subject:GROUP}]));
});
