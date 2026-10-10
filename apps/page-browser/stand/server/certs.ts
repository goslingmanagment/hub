// Test CA and the stand's leaf certificate, made with the `openssl` CLI.
//
// The CA directory is a volume shared with the browser container, which
// imports ca.pem into Chrome's NSS store; so ca.pem is world-readable while the
// keys stay 0600. The CA is created once and kept; the leaf is (re)created when
// it is missing, does not chain to the CA, lacks one of the SANs below, or
// expires within a week. Files are written to a temp dir and renamed into
// place, so a reader never sees a half-written PEM.

import { execFileSync } from "node:child_process";
import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Names the stand serves; Chrome reaches all of them through the stand's SOCKS5. */
export const LEAF_DNS_NAMES = [
  "stand.test",
  "*.stand.test",
  "site.stand.test",
  "api.stand.test",
  "ws.stand.test",
  "cdn.stand.test",
  "api.ipify.org",
];

const CA_SUBJECT = "Project Browser Stand CA";
const CA_DAYS = 3650;
/** Chrome rejects leaves valid for more than 398 days; stay below. */
const LEAF_DAYS = 397;
const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;

export interface StandCerts {
  dir: string;
  caCertPath: string;
  leafCertPath: string;
  leafKeyPath: string;
  /** Leaf private key (PEM). */
  key: Buffer;
  /** Leaf certificate (PEM); the CA is a trust anchor, so it is not sent. */
  cert: Buffer;
  caCert: Buffer;
  /** What happened at startup, for the log line. */
  created: { ca: boolean; leaf: boolean };
}

export function ensureCerts(dir: string): StandCerts {
  fs.mkdirSync(dir, { recursive: true });
  tryChmod(dir, 0o755);
  const caCertPath = path.join(dir, "ca.pem");
  const caKeyPath = path.join(dir, "ca.key");
  const leafCertPath = path.join(dir, "leaf.pem");
  const leafKeyPath = path.join(dir, "leaf.key");

  let caCreated = false;
  if (!caIsUsable(caCertPath, caKeyPath)) {
    createCa(dir, caCertPath, caKeyPath);
    caCreated = true;
  }
  let leafCreated = false;
  if (caCreated || !leafIsUsable(leafCertPath, leafKeyPath, caCertPath)) {
    createLeaf(dir, leafCertPath, leafKeyPath, caCertPath, caKeyPath);
    leafCreated = true;
  }
  // Re-assert modes on every start: the volume may have been created by
  // another container with a different umask.
  tryChmod(caCertPath, 0o644);
  tryChmod(leafCertPath, 0o644);
  tryChmod(caKeyPath, 0o600);
  tryChmod(leafKeyPath, 0o600);

  return {
    dir,
    caCertPath,
    leafCertPath,
    leafKeyPath,
    key: fs.readFileSync(leafKeyPath),
    cert: fs.readFileSync(leafCertPath),
    caCert: fs.readFileSync(caCertPath),
    created: { ca: caCreated, leaf: leafCreated },
  };
}

function caIsUsable(certPath: string, keyPath: string): boolean {
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return false;
  try {
    const cert = new X509Certificate(fs.readFileSync(certPath));
    return cert.ca && cert.checkPrivateKey(createPrivateKey(fs.readFileSync(keyPath)));
  } catch {
    return false;
  }
}

function leafIsUsable(certPath: string, keyPath: string, caCertPath: string): boolean {
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return false;
  try {
    const leaf = new X509Certificate(fs.readFileSync(certPath));
    const ca = new X509Certificate(fs.readFileSync(caCertPath));
    if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) return false;
    if (!leaf.checkPrivateKey(createPrivateKey(fs.readFileSync(keyPath)))) return false;
    if (Date.parse(leaf.validTo) - Date.now() < RENEW_BEFORE_MS) return false;
    const sans = new Set((leaf.subjectAltName ?? "").split(",").map((s) => s.trim()));
    return LEAF_DNS_NAMES.every((name) => sans.has(`DNS:${name}`));
  } catch {
    return false;
  }
}

function createCa(dir: string, certPath: string, keyPath: string): void {
  const tmp = fs.mkdtempSync(path.join(dir, ".tmp-ca-"));
  try {
    const config = path.join(tmp, "ca.cnf");
    // An explicit config so the system openssl.cnf cannot add or clash with extensions.
    fs.writeFileSync(
      config,
      [
        "[req]",
        "distinguished_name = dn",
        "prompt = no",
        "x509_extensions = v3_ca",
        "[dn]",
        `CN = ${CA_SUBJECT}`,
        "[v3_ca]",
        "basicConstraints = critical,CA:TRUE",
        "keyUsage = critical,keyCertSign,cRLSign",
        "subjectKeyIdentifier = hash",
        "",
      ].join("\n"),
    );
    const key = path.join(tmp, "ca.key");
    const cert = path.join(tmp, "ca.pem");
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key]);
    openssl(["req", "-x509", "-new", "-config", config, "-key", key, "-sha256", "-days", String(CA_DAYS), "-set_serial", serial(), "-out", cert]);
    fs.chmodSync(key, 0o600);
    fs.chmodSync(cert, 0o644);
    fs.renameSync(key, keyPath);
    fs.renameSync(cert, certPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function createLeaf(dir: string, certPath: string, keyPath: string, caCertPath: string, caKeyPath: string): void {
  const tmp = fs.mkdtempSync(path.join(dir, ".tmp-leaf-"));
  try {
    const config = path.join(tmp, "leaf.cnf");
    fs.writeFileSync(
      config,
      [
        "[req]",
        "distinguished_name = dn",
        "prompt = no",
        "[dn]",
        "CN = stand.test",
        "[v3_leaf]",
        "basicConstraints = critical,CA:FALSE",
        "keyUsage = critical,digitalSignature",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = ${LEAF_DNS_NAMES.map((name) => `DNS:${name}`).join(",")}`,
        "subjectKeyIdentifier = hash",
        "authorityKeyIdentifier = keyid,issuer",
        "",
      ].join("\n"),
    );
    const key = path.join(tmp, "leaf.key");
    const csr = path.join(tmp, "leaf.csr");
    const cert = path.join(tmp, "leaf.pem");
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key]);
    openssl(["req", "-new", "-config", config, "-key", key, "-out", csr]);
    openssl([
      "x509", "-req", "-in", csr, "-CA", caCertPath, "-CAkey", caKeyPath, "-set_serial", serial(),
      "-days", String(LEAF_DAYS), "-sha256", "-extfile", config, "-extensions", "v3_leaf", "-out", cert,
    ]);
    fs.chmodSync(key, 0o600);
    fs.chmodSync(cert, 0o644);
    fs.renameSync(key, keyPath);
    fs.renameSync(cert, certPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function openssl(args: string[]): void {
  try {
    execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
    throw new Error(`openssl ${args[0]} failed: ${stderr.trim() || String(err)}`);
  }
}

/** A random positive 127-bit serial number in hex. */
function serial(): string {
  const bytes = randomBytes(16);
  bytes[0] = bytes[0]! & 0x7f;
  return "0x" + bytes.toString("hex");
}

function tryChmod(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Not ours to change (e.g. a read-only bind mount); readers will tell.
  }
}
