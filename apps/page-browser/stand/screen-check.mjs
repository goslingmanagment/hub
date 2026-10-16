// Local image check, run as root only to read its synthetic VNC password.
// Exercise a real RFB SetDesktopSize over Kasm's authenticated WebSocket;
// a viewer with another window size must not resize the page's X desktop.
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const src = process.env.PB_SRC ?? "/opt/page-browser/src";
const { WsConnection, acceptKey } = await import(pathToFileURL(`${src}/shared/ws.ts`).href);
const { readXGeometry } = await import(pathToFileURL(`${src}/env/display.ts`).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const password = readFileSync(process.env.PB_VNC_PASSWORD_FILE ?? "/run/secrets/vnc_password", "utf8").trim();
const key = randomBytes(16).toString("base64");
let ws;
let incoming = Buffer.alloc(0);
let closed = false;
const results = [];
try {
  const before = await readXGeometry();
  if (before.width !== 1920 || before.height !== 1080 || before.depth !== 24) throw new Error("X was not 1920×1080×24 before the check");
  ws = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: 6901, path: "/websockify", headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Protocol": "binary", Origin: "http://127.0.0.1:6901",
      Authorization: `Basic ${Buffer.from(`owner:${password}`).toString("base64")}`,
    } });
    req.setTimeout(3000, () => req.destroy(new Error("Kasm WebSocket upgrade timed out")));
    req.on("error", reject);
    req.on("response", (res) => { res.resume(); reject(new Error(`Kasm refused the check (${res.statusCode})`)); });
    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== acceptKey(key)) { socket.destroy(); reject(new Error("wrong WebSocket upgrade")); return; }
      const link = new WsConnection(socket, true, 32 * 1024 * 1024);
      link.onBinary = (data) => { incoming = Buffer.concat([incoming, data]); };
      link.onClose = () => { closed = true; };
      if (head.length) globalThis.queueMicrotask(() => socket.emit("data", head));
      resolve(link);
    });
    req.end();
  });
  const take = async (n) => {
    const deadline = Date.now() + 3000;
    while (incoming.length < n) {
      if (closed || Date.now() > deadline) throw new Error("RFB handshake ended or timed out");
      await sleep(10);
    }
    const bytes = incoming.subarray(0, n); incoming = incoming.subarray(n); return bytes;
  };
  const version = (await take(12)).toString("ascii");
  if (!/^RFB 003\.00[89]\n$/.test(version)) throw new Error("unsupported RFB version");
  ws.sendBinary(Buffer.from("RFB 003.008\n"));
  const count = (await take(1))[0];
  if (!count || !(await take(count)).includes(1)) throw new Error("no RFB None security after HTTP authentication");
  ws.sendBinary(Buffer.from([1]));
  if ((await take(4)).readUInt32BE(0) !== 0) throw new Error("RFB authentication failed");
  ws.sendBinary(Buffer.from([1])); // shared desktop
  const init = await take(24);
  await take(init.readUInt32BE(20));
  if (init.readUInt16BE(0) !== 1920 || init.readUInt16BE(2) !== 1080) throw new Error("RFB and X disagree on the initial size");
  const encodings = Buffer.alloc(8);
  encodings[0] = 2; encodings.writeUInt16BE(1, 2); encodings.writeInt32BE(-308, 4); // ExtendedDesktopSize
  ws.sendBinary(encodings);
  for (const [width, height] of [[1728, 936], [800, 600]]) {
    const resize = Buffer.alloc(24);
    resize[0] = 251; resize.writeUInt16BE(width, 2); resize.writeUInt16BE(height, 4); resize[6] = 1;
    resize.writeUInt16BE(width, 16); resize.writeUInt16BE(height, 18);
    ws.sendBinary(resize);
    await sleep(500);
    const after = await readXGeometry();
    results.push({ requested: { width, height }, actual: after });
    if (after.width !== before.width || after.height !== before.height || after.depth !== before.depth) throw new Error("RFB SetDesktopSize changed X geometry");
  }
  console.log(JSON.stringify({ pass: true, check: "x_screen_fixed", before, results }));
} catch (error) {
  // No raw request, credentials or remote error text is printed.
  console.log(JSON.stringify({ pass: false, check: "x_screen_fixed", error: error.message, results }));
  process.exitCode = 1;
} finally {
  ws?.destroy();
}
