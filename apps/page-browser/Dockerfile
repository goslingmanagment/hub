# syntax=docker/dockerfile:1.7
# Project Browser — the page browser image, PROTOTYPE (plan §5, stage 1).
# Google Chrome Stable from Google's .deb (pinned, passed in as the build
# context `chrome`), X virtual display, Node 22 for the holder and the
# operator, nftables for the egress rules. The production image (stage 3, PR 2)
# replaces the root supervisor with s6-overlay and adds KasmVNC, fonts and Mesa.
#
#   docker build --build-context chrome=$HOME/code/.cache/page-browser/chrome \
#     -t pb-browser apps/page-browser
FROM node:22-bookworm-slim

ARG TARGETARCH
ARG CHROME_VERSION=155.0.8059.39-1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb xauth nftables libnss3-tools procps iproute2 ca-certificates curl tini tcpdump \
      fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

COPY --from=chrome google-chrome-stable_${CHROME_VERSION}_${TARGETARCH}.deb /tmp/chrome.deb
# The package adds Google's apt source and a daily cron job that re-adds it:
# Chrome is updated only by a new image (plan §4.10).
RUN apt-get update \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list /etc/cron.daily/google-chrome \
 && rm -rf /var/lib/apt/lists/* \
 && google-chrome-stable --version

RUN useradd -m -u 1001 -s /usr/sbin/nologin pb-chrome \
 && useradd -m -u 1002 -s /usr/sbin/nologin pb-operator \
 && mkdir -p /data/profile /data/buffer /run/pb \
 && chown pb-chrome:pb-chrome /data/profile && chmod 700 /data/profile \
 && chown pb-operator:pb-operator /data/buffer && chmod 700 /data/buffer

COPY policies/hub.json /etc/opt/chrome/policies/managed/hub.json
COPY docker/ /opt/page-browser/docker/
COPY src/ /opt/page-browser/src/

# The rules extension (plan §4.6): static DNR rules, no scripts. Packed and
# signed here by Chrome itself; its ID follows from the key, and the policy
# force-installs it from the operator's own port (Chrome may reach nothing
# else). PROTOTYPE: the key is made at build time, so the ID changes with the
# image; production signs with a kept key (constant ID).
COPY extension/ /opt/page-browser/extension/
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/page-browser/extension-dist && cd /opt/page-browser \
 && openssl genrsa -out /tmp/ext-key.pem 2048 2>/dev/null \
 && ID=$(openssl rsa -in /tmp/ext-key.pem -pubout -outform DER 2>/dev/null | sha256sum | head -c32 | tr '0-9a-f' 'a-p') \
 && (google-chrome-stable --no-sandbox --user-data-dir=/tmp/pack --pack-extension=/opt/page-browser/extension --pack-extension-key=/tmp/ext-key.pem >/dev/null 2>&1 || true) \
 && test -s /opt/page-browser/extension.crx \
 && mv /opt/page-browser/extension.crx extension-dist/hub.crx && chmod 644 extension-dist/hub.crx && rm -rf /tmp/ext-key.pem /tmp/pack \
 && VERSION=$(node -e 'console.log(require("/opt/page-browser/extension/manifest.json").version)') \
 && echo "$ID" > extension-dist/id.txt \
 && printf '%s\n' "<?xml version='1.0' encoding='UTF-8'?>" "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>" "  <app appid='$ID'><updatecheck codebase='http://127.0.0.1:3128/pb-extension/hub.crx' version='$VERSION' /></app>" "</gupdate>" > extension-dist/update.xml \
 && node -e 'const fs=require("fs");const p="/etc/opt/chrome/policies/managed/hub.json";const d=JSON.parse(fs.readFileSync(p));const id=fs.readFileSync("/opt/page-browser/extension-dist/id.txt","utf8").trim();d.ExtensionSettings={"*":{installation_mode:"blocked"},[id]:{installation_mode:"force_installed",update_url:"http://127.0.0.1:3128/pb-extension/update.xml"}};fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n")' \
 && cat extension-dist/update.xml && grep -A4 ExtensionSettings /etc/opt/chrome/policies/managed/hub.json

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/page-browser/docker/entry.sh"]
