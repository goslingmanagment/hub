// A fake Anthropic Messages API for a LOCAL hub (docs/runbooks/client-dev-hub.md).
//
// The hub's AI gateway reaches its provider only through the page's egress
// proxy, so this one port is both: the proxy (CONNECT tunnels are fed back into
// this same server) and the API. Every POST /v1/messages is written in full to
// the capture directory and answered with a short streamed reply, so a client
// developer sees exactly what the hub assembled and spends nothing. Nothing
// leaves the machine.
//
// Hub side: CHATMUSE_AI_GATEWAY_ENABLED=true ANTHROPIC_API_KEY=dev-fake
// ANTHROPIC_BASE_URL=http://127.0.0.1:8787, and the seeded pages' proxy
// http://127.0.0.1:8787 (pnpm dev:seed-client stores it by default).

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8787" },
    "capture-dir": { type: "string", default: join(tmpdir(), "agency-hub-dev-ai-captures") },
    reply: { type: "string", default: "Fake dev reply: the hub's prompt was captured, nothing was sent to a provider." },
  },
});
const captureDir = values["capture-dir"];
mkdirSync(captureDir, { recursive: true });
let sequence = 0;

function textLength(blocks) {
  if (typeof blocks === "string") return blocks.length;
  if (!Array.isArray(blocks)) return 0;
  return blocks.reduce((sum, block) => sum + (typeof block?.text === "string" ? block.text.length : 0), 0);
}

function sse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

function answerMessages(request, response, body) {
  sequence += 1;
  const id = `msg_dev_fake_${Date.now()}_${sequence}`;
  const userChars = (body.messages ?? []).reduce((sum, message) => sum + textLength(message?.content), 0);
  const systemChars = textLength(body.system);
  const file = join(captureDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${sequence}.json`);
  const headers = { ...request.headers };
  delete headers["x-api-key"];
  delete headers.authorization;
  writeFileSync(file, `${JSON.stringify({ id, receivedAt: new Date().toISOString(), headers, body }, null, 2)}\n`);
  console.log(`[fake-ai] ${id} model=${body.model} system=${systemChars} chars user=${userChars} chars -> ${file}`);

  const inputTokens = Math.ceil((systemChars + userChars) / 4);
  const words = values.reply.split(/(?<= )/);
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": id });
  sse(response, "message_start", {
    message: {
      id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
  sse(response, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (const word of words) {
    sse(response, "content_block_delta", { index: 0, delta: { type: "text_delta", text: word } });
  }
  sse(response, "content_block_stop", { index: 0 });
  sse(response, "message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { input_tokens: inputTokens, output_tokens: words.length, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
  sse(response, "message_stop", {});
  response.end();
}

const server = createServer((request, response) => {
  // A forward-proxy request carries an absolute URL; a tunnelled one a path.
  const { pathname } = new URL(request.url ?? "/", "http://fake-ai.local");
  if (request.method === "GET" && pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, captureDir }));
    return;
  }
  if (request.method !== "POST" || !pathname.endsWith("/v1/messages")) {
    response.writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `fake provider serves POST /v1/messages, not ${request.method} ${pathname}` } }));
    return;
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "body is not JSON" } }));
      return;
    }
    answerMessages(request, response, body);
  });
});

// The proxy half: accept the tunnel, then let this server parse what flows
// through it (the hub's base URL is plain http, so no TLS inside).
server.on("connect", (_request, socket, head) => {
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) socket.unshift(head);
  server.emit("connection", socket);
});

server.listen(Number(values.port), values.host, () => {
  console.log(`[fake-ai] listening on http://${values.host}:${values.port} (proxy + Anthropic Messages API); captures in ${captureDir}`);
});
