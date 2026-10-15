// Image check for pilot F4. Run inside an isolated image with Xkasmvnc on
// :99/:6901 and a synthetic /run/secrets/vnc_password; no Chrome or egress
// is needed. Speak the same SetDesktopSize message as Kasm's web client,
// then read X itself, including after a client disconnect/reconnect.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { encodeFrame, FrameParser, OP_BINARY, OP_PING, OP_PONG } from "../src/shared/ws.ts";

function reader(socket) {
  let bytes = Buffer.alloc(0);
  let ended = false;
  let failure;
  socket.on("error", (error) => { failure = error; });
  socket.on("close", () => { ended = true; });
  return {
    append(chunk) { bytes = Buffer.concat([bytes, chunk]); },
    async take(count) {
      const until = Date.now() + 5000;
      while (bytes.length < count) {
        if (failure) throw failure;
        if (ended || Date.now() > until) throw new Error(`screen check: waiting for ${count} bytes, got ${bytes.length}`);
        await sleep(5);
      }
      const got = bytes.subarray(0, count);
      bytes = bytes.subarray(count);
      return got;
    },
  };
}

// The X11 setup reply includes the physical screen. This also works in an
// older image without xdpyinfo, for the before/after regression proof.
async function geometry() {
  const socket = connect("/tmp/.X11-unix/X99");
  const input = reader(socket);
  socket.on("data", input.append);
  try {
    const hello = Buffer.alloc(12);
    hello[0] = 108; // little endian
    hello.writeUInt16LE(11, 2);
    socket.write(hello);
    const header = await input.take(8);
    assert.equal(header[0], 1, "X11 setup accepted");
    const setup = await input.take(header.readUInt16LE(6) * 4);
    assert.equal(setup[20], 1, "one X screen");
    const root = 32 + Math.ceil(setup.readUInt16LE(16) / 4) * 4 + setup[21] * 8;
    return { width: setup.readUInt16LE(root + 20), height: setup.readUInt16LE(root + 22) };
  } finally {
    socket.destroy();
  }
}

async function resizedClient(width, height) {
  const password = readFileSync("/run/secrets/vnc_password", "utf8").trim();
  const { socket, head } = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: 6901, path: "/websockify", headers: {
      Connection: "Upgrade", Upgrade: "websocket", Origin: "http://127.0.0.1:6901",
      Authorization: `Basic ${Buffer.from(`owner:${password}`).toString("base64")}`,
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13", "Sec-WebSocket-Protocol": "binary",
    } });
    req.setTimeout(5000, () => req.destroy(new Error("screen upgrade timed out")));
    req.on("upgrade", (_response, socket, head) => resolve({ socket, head }));
    req.on("response", (response) => { response.resume(); reject(new Error(`screen HTTP ${response.statusCode}`)); });
    req.on("error", reject);
    req.end();
  });
  const input = reader(socket);
  const parser = new FrameParser(16 * 1024 * 1024);
  const send = (bytes) => socket.write(encodeFrame(OP_BINARY, bytes, true));
  const feed = (chunk) => parser.push(chunk, ({ opcode, payload }) => {
    if (opcode === OP_PING) socket.write(encodeFrame(OP_PONG, payload, true));
    else if (opcode === OP_BINARY) input.append(payload);
  });
  socket.on("data", feed);
  feed(head);
  try {
    assert.match((await input.take(12)).toString(), /^RFB /);
    send(Buffer.from("RFB 003.008\n"));
    const types = await input.take((await input.take(1))[0]);
    assert.ok(types.includes(1), "HTTP authentication permits RFB None");
    send(Buffer.from([1]));
    assert.equal((await input.take(4)).readUInt32BE(), 0, "RFB security accepted");
    send(Buffer.from([1]));
    const init = await input.take(24);
    await input.take(init.readUInt32BE(20));
    const encodings = Buffer.alloc(8);
    encodings[0] = 2;
    encodings.writeUInt16BE(1, 2);
    encodings.writeInt32BE(-308, 4); // ExtendedDesktopSize
    send(encodings);
    const resize = Buffer.alloc(24);
    resize[0] = 251;
    resize.writeUInt16BE(width, 2);
    resize.writeUInt16BE(height, 4);
    resize[6] = 1;
    resize.writeUInt16BE(width, 16);
    resize.writeUInt16BE(height, 18);
    send(resize);
    await sleep(300);
    return await geometry();
  } finally {
    socket.destroy();
  }
}

const expected = { width: 1920, height: 1080 };
const before = await geometry();
assert.deepEqual(before, expected);
const first = await resizedClient(1728, 936);
const reconnected = await resizedClient(1280, 720);
console.log(JSON.stringify({ check: "screen_geometry_fixed", before, first, reconnected, pass: JSON.stringify(first) === JSON.stringify(expected) && JSON.stringify(reconnected) === JSON.stringify(expected) }));
assert.deepEqual(first, expected, "the first client must not resize X");
assert.deepEqual(reconnected, expected, "a reconnected client must not resize X");
