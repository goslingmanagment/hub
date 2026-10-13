// The rules extension as Chrome installs it (plan §4.6): a CRX3 package —
// a ZIP of manifest.json and rules.json under a header with our signature —
// and the update manifest Chrome reads at the policy's `update_url`. Built
// here, without Chrome, so a build is the same on any machine and the tests
// read every byte of it.
//
// CRX3 (Chromium components/crx_file): "Cr24", version 3, the header's
// length, a CrxFileHeader protobuf, the ZIP. The header carries an RSA
// public key (SubjectPublicKeyInfo, DER) and its PKCS#1 v1.5 SHA-256
// signature over "CRX3 SignedData\0", the signed data's length (4 bytes,
// little-endian), the signed data — SignedData{crx_id}, the first 16 bytes
// of the key's SHA-256 — and the ZIP. The extension's ID is that crx_id in
// hex with 0–f written as a–p: the key fixes the ID.

import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { crc32 } from "node:zlib";

// ── ZIP (stored entries, fixed times: the same files give the same bytes) ──

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 1980-01-01 00:00, the ZIP's earliest time. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(entry.name)) throw new Error(`a ZIP entry's name must be plain: ${entry.name}`);
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, entry.data);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The entries of a ZIP this module wrote (stored, no extras): for tests
 *  and the stand. */
export function unzip(archive: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let at = 0;
  while (archive.readUInt32LE(at) === 0x04034b50) {
    if (archive.readUInt16LE(at + 8) !== 0) throw new Error("not a stored entry");
    const size = archive.readUInt32LE(at + 18);
    const nameLength = archive.readUInt16LE(at + 26);
    const extra = archive.readUInt16LE(at + 28);
    const name = archive.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const start = at + 30 + nameLength + extra;
    const data = Buffer.from(archive.subarray(start, start + size));
    if (crc32(data) !== archive.readUInt32LE(at + 14)) throw new Error(`a bad CRC: ${name}`);
    entries.push({ name, data });
    at = start + size;
  }
  return entries;
}

// ── protobuf, the little CRX3 needs ────────────────────────────────────────

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** A length-delimited field (wire type 2). */
function field(number: number, value: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(value.length), value]);
}

/** The length-delimited fields of a message, by number (repeats kept). */
function fields(message: Buffer): Array<{ number: number; value: Buffer }> {
  const out: Array<{ number: number; value: Buffer }> = [];
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (at >= message.length) throw new Error("a truncated varint");
      const byte = message[at++]!;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 0x80;
    }
  };
  while (at < message.length) {
    const tag = readVarint();
    if (tag % 8 !== 2) throw new Error(`an unexpected wire type ${tag % 8}`);
    const length = readVarint();
    if (at + length > message.length) throw new Error("a truncated field");
    out.push({ number: Math.floor(tag / 8), value: message.subarray(at, at + length) });
    at += length;
  }
  return out;
}

// ── CRX3 ───────────────────────────────────────────────────────────────────

const MAGIC = Buffer.from("Cr24", "latin1");
const SIGNED_PREFIX = Buffer.from("CRX3 SignedData\x00", "latin1");
/** CrxFileHeader: sha256_with_rsa = 2, signed_header_data = 10000;
 *  AsymmetricKeyProof: public_key = 1, signature = 2; SignedData: crx_id = 1. */
const HEADER_RSA = 2;
const HEADER_SIGNED_DATA = 10000;

/** The 16 bytes of an ID: the start of the key's SHA-256. */
function crxIdOf(publicKeyDer: Buffer): Buffer {
  return createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);
}

/** The extension's ID: 32 letters a–p. */
export function extensionId(publicKeyDer: Buffer): string {
  return [...crxIdOf(publicKeyDer).toString("hex")].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

export function publicKeyDer(key: KeyObject): Buffer {
  return createPublicKey(key).export({ type: "spki", format: "der" });
}

function signedPayload(signedData: Buffer, archive: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedData.length, 0);
  return Buffer.concat([SIGNED_PREFIX, length, signedData, archive]);
}

/** A CRX3 of `archive`, signed with an RSA private key. */
export function packCrx3(archive: Buffer, privateKey: KeyObject): Buffer {
  if (privateKey.asymmetricKeyType !== "rsa") throw new Error("the extension's key must be RSA");
  const spki = publicKeyDer(privateKey);
  const signedData = field(1, crxIdOf(spki));
  const signature = sign("sha256", signedPayload(signedData, archive), privateKey);
  const header = Buffer.concat([field(HEADER_RSA, Buffer.concat([field(1, spki), field(2, signature)])), field(HEADER_SIGNED_DATA, signedData)]);
  const prefix = Buffer.alloc(12);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, archive]);
}

export interface Crx3 {
  id: string;
  publicKey: Buffer;
  archive: Buffer;
}

/** A CRX3 read back and verified the way Chrome does for a package without
 *  a store's proof: the signed ID is the key's, and the key's signature
 *  holds over the ZIP. Throws on anything else. */
export function verifyCrx3(crx: Buffer): Crx3 {
  if (crx.length < 12 || !crx.subarray(0, 4).equals(MAGIC) || crx.readUInt32LE(4) !== 3) throw new Error("not a CRX3");
  const headerLength = crx.readUInt32LE(8);
  if (12 + headerLength > crx.length) throw new Error("a truncated CRX3 header");
  const header = crx.subarray(12, 12 + headerLength);
  const archive = crx.subarray(12 + headerLength);
  const parts = fields(header);
  const signedData = parts.find((part) => part.number === HEADER_SIGNED_DATA)?.value;
  if (!signedData) throw new Error("no signed header data");
  const crxId = fields(signedData).find((part) => part.number === 1)?.value;
  if (!crxId || crxId.length !== 16) throw new Error("no crx_id");
  const proofs = parts.filter((part) => part.number === HEADER_RSA).map((part) => fields(part.value));
  const payload = signedPayload(signedData, archive);
  for (const proof of proofs) {
    const key = proof.find((part) => part.number === 1)?.value;
    const signature = proof.find((part) => part.number === 2)?.value;
    if (!key || !signature || !crxIdOf(key).equals(crxId)) continue;
    if (!verify("sha256", payload, createPublicKey({ key, format: "der", type: "spki" }), signature)) throw new Error("the signature does not hold");
    return { id: extensionId(key), publicKey: Buffer.from(key), archive: Buffer.from(archive) };
  }
  throw new Error("no signature by the key of the ID");
}

/** The update manifest (gupdate) at the policy's `update_url`: the package's
 *  address, version and SHA-256 — Chrome checks the bytes it fetched. */
export function updateManifest(options: { id: string; version: string; codebase: string; sha256: string }): string {
  for (const [name, value] of Object.entries(options)) {
    if (!/^[A-Za-z0-9:/._-]+$/.test(value)) throw new Error(`the update manifest's ${name} has characters it may not: ${value}`);
  }
  return [
    "<?xml version='1.0' encoding='UTF-8'?>",
    "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>",
    `  <app appid='${options.id}'>`,
    `    <updatecheck codebase='${options.codebase}' version='${options.version}' hash_sha256='${options.sha256}' />`,
    "  </app>",
    "</gupdate>",
    "",
  ].join("\n");
}
