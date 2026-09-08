// Offline regression evidence only. No real browser, network, credentials, or messages.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const snippetPath = 'investigations/fansly-events-architecture-2026-09-07/evidence/ws-tap-snippet.js';
const source = fs.readFileSync(snippetPath, 'utf8');
class FakeWS {
  constructor(url) { this.url = url; this.listeners = {}; }
  addEventListener(kind, listener) { this.listeners[kind] = listener; }
  send() {}
}
const context = { window: { WebSocket: FakeWS }, copy() {}, console: { log() {} } };
vm.runInNewContext(source, context, { timeout: 1000 });
const marker = 'SAFE_SYNTHETIC_TOKEN_123';
const bodyMarker = 'SAFE_SYNTHETIC_MESSAGE';
const socket = new context.window.WebSocket('wss://wsv3.fansly.com/?v=3');
socket.send(JSON.stringify({ t: 1, d: JSON.stringify({ token: marker, v: 3 }) }));
socket.send(JSON.stringify({ token: marker }));
const unrelated = new context.window.WebSocket('wss://another.example');
unrelated.listeners.message({ data: JSON.stringify({ content: bodyMarker }) });
const records = context.window.__wsLog;
const result = {
  evidenceKind: 'offline-synthetic-test',
  snippetPath,
  snippetSha256: crypto.createHash('sha256').update(source).digest('hex'),
  networkConnections: 0,
  realSecretsUsed: false,
  realBusinessDataUsed: false,
  loggedFrames: records.length,
  nestedAuthTokenLeaked: records[0].data.includes(marker),
  plainTokenLeaked: records[1].data.includes(marker),
  unrelatedSocketCaptured: records[2].url === 'wss://another.example',
  messageBodyRetained: records[2].data.includes(bodyMarker),
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
