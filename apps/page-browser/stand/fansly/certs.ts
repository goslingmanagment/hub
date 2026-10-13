// The stand's certificate authority and the certificate of its Fansly. The
// page container reaches the stand's Fansly under Fansly's real names
// (fansly.com, apiv3.fansly.com, wsv3.fansly.com, cdn*.fansly.com) and the
// exit-IP service under its own (api.ipify.org) — the operator and the rules
// extension name them, and the stand must not change either. So the stand
// has a CA of its own, trusted only inside the stand:
//
//   <private>/ca.key, leaf.key      never leave the Fansly container
//   <shared>/ca.crt                 for the operator's Node (the exit-IP check)
//   <shared>/nssdb/                 for Chrome: an NSS database that trusts
//                                   the CA, copied into Chrome's home by the
//                                   stand's entry (inside/entry.sh)
//
// Made once per stand (the private volume keeps the keys): a Fansly
// container that starts again serves the same chain, so a running operator
// keeps trusting it.

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STAND_NAMES = ["fansly.com", "*.fansly.com", "api.ipify.org"] as const;

export interface StandCerts {
  key: Buffer;
  cert: Buffer;
  caCertPath: string;
  created: boolean;
}

function openssl(args: string[], cwd: string): void {
  execFileSync("openssl", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

/** The CA and the leaf, made if they are not there yet; the public part is
 *  (re)published into `sharedDir` every time. */
export function ensureCerts(privateDir: string, sharedDir: string): StandCerts {
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  mkdirSync(sharedDir, { recursive: true, mode: 0o755 });
  const have = ["ca.key", "ca.crt", "leaf.key", "leaf.crt"].every((name) => existsSync(join(privateDir, name)));
  if (!have) {
    for (const name of ["ca.key", "ca.crt", "ca.srl", "leaf.key", "leaf.csr", "leaf.crt", "leaf.ext"]) rmSync(join(privateDir, name), { force: true });
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"], privateDir);
    openssl(
      ["req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "90", "-subj", "/O=pb-suite stand/CN=pb-suite stand CA", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.crt"],
      privateDir,
    );
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"], privateDir);
    openssl(["req", "-new", "-key", "leaf.key", "-subj", "/O=pb-suite stand/CN=fansly.com", "-out", "leaf.csr"], privateDir);
    writeFileSync(
      join(privateDir, "leaf.ext"),
      [`subjectAltName=${STAND_NAMES.map((name) => `DNS:${name}`).join(",")}`, "basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature", "extendedKeyUsage=serverAuth", ""].join("\n"),
    );
    openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "90", "-sha256", "-extfile", "leaf.ext", "-out", "leaf.crt"], privateDir);
    for (const name of ["ca.key", "leaf.key"]) chmodSync(join(privateDir, name), 0o600);
  }
  const caCertPath = join(sharedDir, "ca.crt");
  cpSync(join(privateDir, "ca.crt"), caCertPath);
  chmodSync(caCertPath, 0o644);
  publishNssDb(privateDir, sharedDir);
  return { key: readFileSync(join(privateDir, "leaf.key")), cert: readFileSync(join(privateDir, "leaf.crt")), caCertPath, created: !have };
}

/** Chrome on Linux takes extra trust anchors from the NSS database of its
 *  user (~/.pki/nssdb). The page image has no certutil — and must not get
 *  one for the stand — so the database is made here and only copied there. */
function publishNssDb(privateDir: string, sharedDir: string): void {
  const dir = join(sharedDir, "nssdb");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { mode: 0o755 });
  execFileSync("certutil", ["-d", `sql:${dir}`, "-N", "--empty-password"], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSync("certutil", ["-d", `sql:${dir}`, "-A", "-t", "C,,", "-n", "pb-suite-stand-ca", "-i", join(privateDir, "ca.crt")], { stdio: ["ignore", "ignore", "pipe"] });
  for (const name of ["cert9.db", "key4.db", "pkcs11.txt"]) chmodSync(join(dir, name), 0o644);
}
