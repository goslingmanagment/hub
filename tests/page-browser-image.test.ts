import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The page browser image and its deployment (Project Browser plan §3.1,
// §4.5; stage 3, PR 2). Hub's CI never builds the image (Chrome is not in
// it): these hold the image's safety properties in its files. The image
// itself is checked on the stand (apps/page-browser/stand/image-check.sh).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "apps/page-browser");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Chrome's start", () => {
  const run = read("apps/page-browser/s6/s6-rc.d/chrome/run");
  const command = run.slice(run.indexOf("/usr/bin/google-chrome-stable"));
  const flags = [...command.matchAll(/^\s+(--[a-z-]+)/gm)].map((match) => match[1]);

  it("has the plan's flags and nothing that shows automation or drops the sandbox", () => {
    expect(flags).toEqual(["--user-data-dir", "--remote-debugging-port", "--window-size", "--lang", "--no-first-run", "--ignore-gpu-blocklist"]);
    for (const banned of ["--no-sandbox", "--enable-automation", "--headless", "--remote-debugging-pipe", "--disable-blink-features", "--remote-debugging-port=0"]) {
      expect(command).not.toContain(banned);
    }
    expect(command).toContain("--remote-debugging-port=9222");
  });

  it("runs as pb-chrome with a clean environment", () => {
    expect(run).toContain("/command/s6-setuidgid pb-chrome /usr/bin/google-chrome-stable");
    expect(run).toMatch(/exec env -i HOME=\/home\/pb-chrome PATH=\/usr\/bin:\/bin DISPLAY=:99/);
  });
});

describe("the services", () => {
  const services = "apps/page-browser/s6/s6-rc.d";
  const bundle = "apps/page-browser/s6/user-bundles.d/user/contents.d";

  it("Chrome stays down until the operator starts it, and the operator may", () => {
    expect(existsSync(path.join(root, bundle, "chrome"))).toBe(false);
    for (const started of ["init-net", "net-selftest", "chrome-control", "xvnc"]) expect(existsSync(path.join(root, bundle, started))).toBe(true);
    expect(read("apps/page-browser/s6/scripts/chrome-control")).toContain("s6-svperms -G pb-operator /run/service/chrome");
    expect(read(`${services}/chrome/timeout-kill`).trim()).toBe("5000");
  });

  it("the container is healthy only with the kernel check passed and the X server up", () => {
    expect(read("apps/page-browser/Dockerfile")).toContain('CMD ["/etc/s6-overlay/scripts/health"]');
    const health = read("apps/page-browser/s6/scripts/health");
    const checks = health.split("\n").filter((line) => /\|\| exit 1$/.test(line));
    expect(checks).toEqual([
      `grep -q '"ok":true' /run/pb/net-selftest.json || exit 1`,
      "up_for xvnc 5 || exit 1",
      "[ -S /tmp/.X11-unix/X99 ] || exit 1",
    ]);
    expect(health).toContain('s6-svstat -o up,updownfor "/run/service/$1"');
  });

  it("fails the script on any failed check (a test inside `a && b` does not stop a `set -e` script)", () => {
    const health = read("apps/page-browser/s6/scripts/health");
    // The checks, with s6-svstat answering from a table and the files there.
    const checks = health
      .slice(health.indexOf("up_for() {"))
      .replace('/command/s6-svstat -o up,updownfor "/run/service/$1"', 'svstat "$1"')
      .replace(/^grep .*$/m, "true || exit 1")
      .replace(/^\[ -S .*$/m, "true || exit 1");
    const status = (xvnc: string) => {
      const svstat = `svstat() { case "$1" in xvnc) echo "${xvnc}" ;; *) echo "true 9" ;; esac; }`;
      return spawnSync("sh", ["-c", `set -eu\n${svstat}\n${checks}`]).status;
    };
    expect(status("true 10")).toBe(0);
    expect(status("false 0")).toBe(1);
    expect(status("true 3")).toBe(1);
  });

  it("nothing starts before the egress rules and their kernel check", () => {
    expect(existsSync(path.join(root, services, "net-selftest/dependencies.d/init-net"))).toBe(true);
    expect(existsSync(path.join(root, services, "xvnc/dependencies.d/net-selftest"))).toBe(true);
    expect(read("apps/page-browser/Dockerfile")).toContain("S6_BEHAVIOUR_IF_STAGE2_FAILS=2");
  });
});

describe("the egress rules (init-net)", () => {
  const initNet = read("apps/page-browser/s6/scripts/init-net");
  const chain = (name: string) => {
    const match = initNet.match(new RegExp(`chain ${name} \\{([\\s\\S]*?)\\n  \\}`));
    return (match?.[1] ?? "").split("\n").map((line) => line.replace(/#.*/, "").trim()).filter(Boolean);
  };

  it("lets each user reach only its own way out, and refuses the rest", () => {
    expect(initNet).toContain("flush ruleset");
    expect(chain("output")).toEqual([
      "type filter hook output priority 0; policy drop;",
      "ct state established,related accept",
      "oif lo meta skuid pb-chrome tcp dport 3128 accept",
      "oif lo meta skuid pb-operator tcp dport 9222 accept",
      "meta skuid pb-operator ip daddr $SOCKS_IP tcp dport $SOCKS_PORT accept",
      "reject with icmpx admin-prohibited",
    ]);
  });

  it("lets in only the engine's RPC and the API", () => {
    expect(chain("input")).toEqual([
      "type filter hook input priority 0; policy drop;",
      "iif lo accept",
      "ct state established,related accept",
      "ip saddr $SYNC_IP tcp dport 7700 accept",
      "ip saddr $API_IP tcp dport { 6901, 7700 } accept",
    ]);
  });

  it("the kernel check expects a refusal for every way Chrome must not take", () => {
    const selftest = read("apps/page-browser/s6/scripts/net-selftest.mjs");
    const chromeRefused = [...selftest.matchAll(/user: "pb-chrome".*?what: "([^"]+)"/g)]
      .filter((match) => match[0].includes('expect: "refused"'))
      .map((match) => match[1]);
    expect(chromeRefused).toEqual(["the internet", "the page's SOCKS5", "CDP", "the operator's RPC", "the screen", "DNS", "Docker's DNS"]);
  });
});

describe("the host's layer (egress-rules.sh)", () => {
  const rules = read("apps/page-browser/host/egress-rules.sh");

  it("holds pb-egress to each page's SOCKS5, pb-control to sync's and api's own ports, and the host shut", () => {
    expect(rules).toContain('-s "$egress" -d "$socks_ip" -p tcp --dport "$socks_port" -j RETURN');
    expect(rules).toContain('-s "$egress" -j DROP');
    expect(rules).toContain('-s "$SYNC_IP" -d "$control" -p tcp --dport 7700 -j RETURN');
    expect(rules).toContain('-s "$API_IP" -d "$control" -p tcp -m multiport --dports 6901,7700 -j RETURN');
    expect(rules).toContain('-d "$control" -j DROP');
    expect(rules).toContain('-s "$control" -j DROP');
    expect(rules).toContain('-A "$NEW_IN" -s "$CONTROL_SUBNET" -j DROP');
    expect(rules).toContain('-A "$NEW_IN" -s "$EGRESS_SUBNET" -j DROP');
  });

  it("refuses to run where bridge traffic skips iptables, and swaps whole chain sets one run at a time", () => {
    expect(rules).toContain("net.bridge.bridge-nf-call-iptables");
    expect(rules).toMatch(/flock -w 30 9/);
    // New chains are hooked before the old ones are unhooked; nothing hooked is flushed.
    const apply = rules.slice(rules.indexOf("\napply() {"));
    expect(apply.indexOf('-I DOCKER-USER 1 -j "$NEW_FWD"')).toBeLessThan(apply.indexOf('-D DOCKER-USER -j "$chain"'));
    expect(apply.indexOf('-D DOCKER-USER -j "$chain"')).toBeLessThan(apply.indexOf('-F "$chain"'));
    expect(rules).toContain("trap drop_unhooked EXIT");
    // Every state's allows before any page address's drops: while a page
    // switches, both of its SOCKS5 pass (Astra's re-check of PR 2).
    expect(apply.lastIndexOf("-j RETURN\n  done")).toBeLessThan(apply.indexOf('-s "$egress" -j DROP'));
    expect(read("scripts/deploy-page-browser.sh")).toContain("modprobe br_netfilter");
  });
});

describe("a page's container on the server (page.sh)", () => {
  const page = read("apps/page-browser/host/page.sh");

  it("switches to a new state only when it is healthy, else brings the old one back", () => {
    expect(page).toContain('switch_to "up $IMAGE"');
    expect(page).toContain('switch_to "rollback to $previous"');
    const switchTo = page.slice(page.indexOf("switch_to() {"), page.indexOf("\n}\n", page.indexOf("switch_to() {")));
    // The host's rules admit the candidate before it starts; failing, nothing changes.
    expect(switchTo.indexOf('egress-rules.sh" apply')).toBeLessThan(switchTo.indexOf('compose_with "$next" up'));
    expect(switchTo.indexOf("healthy")).toBeLessThan(switchTo.indexOf('mv "$next" "$(env_file)"'));
    expect(switchTo).toContain('compose_with "$(env_file)" up -d --force-recreate --no-build');
    expect(read("apps/page-browser/host/egress-rules.sh")).toContain('"$BASE"/pages/*/page.env "$BASE"/pages/*/page.env.next');
  });

  it("runs one page operation at a time", () => {
    expect(page).toMatch(/\^\(up\|rollback\|down\|forget\)\$ \]\]; then\n {2}exec 8>"\$PB_BASE\/\.page\.lock"\n {2}flock -w 900 8/);
  });

  it("gives a profile to one page at a time, and Chrome keeps its own profile lock", () => {
    expect(page).toContain('owner="$(profile_owner "$profile")"');
    expect(page).toContain('--filter "volume=pb-profile-$profile"');
    expect(read("apps/page-browser/s6/s6-rc.d/chrome/run")).not.toMatch(/rm -f \/data\/profile\/Singleton/);
  });
});

describe("the seccomp profile", () => {
  const profile = JSON.parse(read("apps/page-browser/security/seccomp-chrome.json")) as {
    defaultAction: string;
    syscalls: Array<{ names: string[]; action: string; comment?: string }>;
  };

  it("is Docker 29.9's default with one rule more: what Chrome's sandbox needs", () => {
    const ours = profile.syscalls.filter((rule) => rule.comment?.startsWith("Project Browser"));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ names: ["clone", "unshare", "chroot"], action: "SCMP_ACT_ALLOW" });
    // github.com/moby/profiles/seccomp/default.json as vendored by
    // moby/moby docker-v29.9.0, sha256 of its JSON.stringify.
    const upstream = { ...profile, syscalls: profile.syscalls.filter((rule) => rule !== ours[0]) };
    expect(createHash("sha256").update(JSON.stringify(upstream)).digest("hex")).toBe("4dc1298afa7676147c1320afa42d72691fc55379ae762b392b56853574a7a38a");
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  });
});

describe("the AppArmor profile", () => {
  const apparmor = read("apps/page-browser/security/apparmor-page-browser");

  it("adds user namespaces to Docker's default rules", () => {
    expect(apparmor).toMatch(/^abi <abi\/4\.0>,$/m);
    expect(apparmor).toMatch(/^profile page-browser flags=\(attach_disconnected,mediate_deleted\) \{$/m);
    for (const rule of ["userns,", "unix,", "deny mount,", "deny network vsock,", "deny @{PROC}/sysrq-trigger rwklx,", "deny /sys/kernel/security/** rwklx,"]) {
      expect(apparmor).toContain(`\n  ${rule}`);
    }
  });
});

describe("the page's container (docker-compose.page-browser.yml)", () => {
  const compose = read("docker-compose.page-browser.yml");

  it("publishes nothing and gets no privileges", () => {
    expect(compose).not.toMatch(/^\s+ports:/m);
    expect(compose).not.toMatch(/privileged:\s*true/);
    expect(compose).toMatch(/cap_drop: \[ALL\]/);
    expect(compose).toMatch(/cap_add: \[CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID, KILL, NET_ADMIN\]/);
    expect(compose).toContain("- no-new-privileges:true");
    expect(compose).toContain("- seccomp=${PB_SECCOMP_PROFILE:?");
    expect(compose).toContain("- apparmor=${PB_APPARMOR_PROFILE:-page-browser}");
    expect(compose).not.toMatch(/(seccomp|apparmor)[:=]unconfined/);
  });

  it("joins only the two page networks and the profile's volumes, all made by the deploy script", () => {
    expect(compose).toContain("\nnetworks:\n  pb-control:\n    external: true\n  pb-egress:\n    external: true\n");
    expect(compose).toMatch(/name: pb-profile-\$\{PB_PROFILE_ID\}/);
    expect(compose).toMatch(/name: pb-buffer-\$\{PB_PROFILE_ID\}/);
    expect(compose).toContain("hostname: pb-${PB_PROFILE_ID}");
  });

  it("stays out of Hub's stack", () => {
    // Hub's deploy refuses any service but api, worker, scheduler, sync and
    // postgres, and its stack scope recreates PostgreSQL.
    const services = read("docker-compose.production.yml").match(/^services:\n([\s\S]*?)(?=^\S)/m)?.[1] ?? "";
    expect([...services.matchAll(/^ {2}([a-z0-9][a-z0-9_-]*):$/gm)].map((match) => match[1])).toEqual(["postgres", "api", "scheduler", "worker", "sync"]);
  });
});

describe("the image", () => {
  const dockerfile = read("apps/page-browser/Dockerfile");
  const vendor = read("apps/page-browser/vendor.sha256");

  it("pins its base and checks every vendored file before installing it", () => {
    expect(dockerfile).toMatch(/^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toContain('grep "  $f\\$" vendor.sha256 | sha256sum -c -');
    const chrome = dockerfile.match(/^ARG CHROME_VERSION=(\S+)$/m)?.[1];
    const kasm = dockerfile.match(/^ARG KASMVNC_VERSION=(\S+)$/m)?.[1];
    for (const arch of ["amd64", "arm64"]) {
      expect(vendor).toMatch(new RegExp(`^[0-9a-f]{64}  google-chrome-stable_${chrome}_${arch}\\.deb$`, "m"));
      expect(vendor).toMatch(new RegExp(`^[0-9a-f]{64}  kasmvncserver_bookworm_${kasm}_${arch}\\.deb$`, "m"));
    }
    for (const s6 of ["noarch", "x86_64", "aarch64"]) expect(vendor).toMatch(new RegExp(`^[0-9a-f]{64}  s6-overlay-${s6}\\.tar\\.xz$`, "m"));
  });

  it("Chrome's policies: only through the operator's proxy, nothing saved, no extension but ours", () => {
    const policies = JSON.parse(read("apps/page-browser/policies/hub.json")) as Record<string, unknown>;
    expect(policies).toMatchObject({
      ProxySettings: { ProxyMode: "fixed_servers", ProxyServer: "127.0.0.1:3128" },
      QuicAllowed: false,
      WebRtcIPHandling: "disable_non_proxied_udp",
      NetworkPredictionOptions: 2,
      PasswordManagerEnabled: false,
      PasswordLeakDetectionEnabled: false,
      BrowserSignin: 0,
      SyncDisabled: true,
      DownloadRestrictions: 3,
      RestoreOnStartup: 4,
      RemoteDebuggingAllowed: true,
      ExtensionSettings: { "*": { installation_mode: "blocked" } },
    });
  });

  it("keeps the stand out of the build context", () => {
    expect(readFileSync(path.join(app, ".dockerignore"), "utf8").split("\n")).toContain("stand");
  });
});
