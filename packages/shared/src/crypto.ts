import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedEnvelope {
  alg: "aes-256-gcm";
  keyVersion: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

export type EncryptionKeysByVersion = ReadonlyMap<number, Buffer>;

export function encryptJson<T>(
  value: T,
  key: Buffer,
  keyVersion: number,
): EncryptedEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: "aes-256-gcm",
    keyVersion,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function parseEncryptedEnvelope(payload: EncryptedEnvelope | string) {
  return typeof payload === "string"
    ? (JSON.parse(payload) as EncryptedEnvelope)
    : payload;
}

function decryptEnvelope<T>(envelope: EncryptedEnvelope, key: Buffer): T {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function decryptJson<T>(payload: EncryptedEnvelope | string, key: Buffer): T {
  return decryptEnvelope(parseEncryptedEnvelope(payload), key);
}

export function decryptJsonWithKeyVersion<T>(
  payload: EncryptedEnvelope | string,
  encryptionKeysByVersion: EncryptionKeysByVersion,
): T {
  const envelope = parseEncryptedEnvelope(payload);
  const key = encryptionKeysByVersion.get(envelope.keyVersion);
  if (!key) {
    throw new Error(`No encryption key configured for version ${envelope.keyVersion}`);
  }

  return decryptEnvelope<T>(envelope, key);
}

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}
