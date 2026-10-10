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

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/page-browser/docker/entry.sh"]
