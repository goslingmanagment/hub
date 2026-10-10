// Reads SNI and offered ALPN protocols from a raw TLS ClientHello (RFC 8446
// §4.1.2), before the TLS engine sees it. The front uses this to journal
// `tls.hello` for every handshake (resumed ones too: OpenSSL skips the
// certificate/SNI callback on resumption) and to stall a handshake by SNI.

export interface ClientHelloInfo {
  /** "incomplete": need more bytes; "ok": parsed; "not-tls": not a TLS handshake. */
  status: "incomplete" | "ok" | "not-tls";
  servername: string | null;
  alpn: string[];
}

const RECORD_HANDSHAKE = 22;
const HANDSHAKE_CLIENT_HELLO = 1;
const EXT_SERVER_NAME = 0;
const EXT_ALPN = 16;
/** Largest ClientHello we wait for (ML-KEM key shares make them ~2 KB). */
const MAX_HELLO = 64 * 1024;

/** Parse the ClientHello at the start of `buf`; the ClientHello may span several records. */
export function parseClientHello(buf: Buffer): ClientHelloInfo {
  const parts: Buffer[] = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    if (buf.length < offset + 5) return incomplete();
    if (buf[offset] !== RECORD_HANDSHAKE || buf[offset + 1] !== 3) return notTls();
    const recordLength = buf.readUInt16BE(offset + 3);
    if (recordLength === 0 || recordLength > 16384 + 256) return notTls();
    if (buf.length < offset + 5 + recordLength) return incomplete();
    parts.push(buf.subarray(offset + 5, offset + 5 + recordLength));
    total += recordLength;
    offset += 5 + recordLength;
    const handshake = parts.length === 1 ? parts[0]! : Buffer.concat(parts, total);
    if (handshake.length < 4) continue;
    if (handshake[0] !== HANDSHAKE_CLIENT_HELLO) return notTls();
    const length = handshake.readUIntBE(1, 3);
    if (length > MAX_HELLO) return notTls();
    if (handshake.length < 4 + length) continue;
    return parseBody(handshake.subarray(4, 4 + length));
  }
}

function parseBody(body: Buffer): ClientHelloInfo {
  const info: ClientHelloInfo = { status: "ok", servername: null, alpn: [] };
  try {
    let p = 2 + 32; // legacy_version, random
    p += 1 + body[p]!; // legacy_session_id
    p += 2 + body.readUInt16BE(p); // cipher_suites
    p += 1 + body[p]!; // legacy_compression_methods
    if (p + 2 > body.length) return info; // no extensions
    const end = Math.min(body.length, p + 2 + body.readUInt16BE(p));
    p += 2;
    while (p + 4 <= end) {
      const type = body.readUInt16BE(p);
      const length = body.readUInt16BE(p + 2);
      const ext = body.subarray(p + 4, p + 4 + length);
      p += 4 + length;
      if (type === EXT_SERVER_NAME) info.servername = readServerName(ext);
      else if (type === EXT_ALPN) info.alpn = readAlpn(ext);
    }
  } catch {
    // A truncated field: report what was found; the TLS engine will judge it.
  }
  return info;
}

function readServerName(ext: Buffer): string | null {
  let p = 2; // server_name_list length
  while (p + 3 <= ext.length) {
    const nameType = ext[p]!;
    const length = ext.readUInt16BE(p + 1);
    if (nameType === 0) return ext.subarray(p + 3, p + 3 + length).toString("latin1").toLowerCase();
    p += 3 + length;
  }
  return null;
}

function readAlpn(ext: Buffer): string[] {
  const out: string[] = [];
  let p = 2; // protocol_name_list length
  while (p < ext.length) {
    const length = ext[p]!;
    out.push(ext.subarray(p + 1, p + 1 + length).toString("latin1"));
    p += 1 + length;
  }
  return out;
}

function incomplete(): ClientHelloInfo {
  return { status: "incomplete", servername: null, alpn: [] };
}

function notTls(): ClientHelloInfo {
  return { status: "not-tls", servername: null, alpn: [] };
}
