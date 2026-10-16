# syntax=docker/dockerfile:1.7
# Project Browser — the image of a Fansly page's browser (plan §3.1; stage 3,
# PR 2). Google Chrome Stable, KasmVNC as its X server and the owner's
# screen, Node.js 22 for the operator, nftables, s6-overlay. One container
# per page; scripts/deploy-page-browser.sh builds it on the server and runs it
# with docker-compose.page-browser.yml.
#
# Chrome, KasmVNC and s6-overlay come from the build context `vendor` — a
# flat directory the deploy script fills from its cache — and are checked
# against vendor.sha256 before anything is installed:
#
#   docker build --build-context vendor=<dir> \
#     -t hub-page-browser:<chrome version>-<commit> apps/page-browser
#
# s6 starts the egress rules, their kernel check, the screen, the CDP holder,
# the operator and its watchdog (src/, run by Node's type stripping); Chrome
# is a service that stays down until the operator starts it.
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ARG TARGETARCH
ARG CHROME_VERSION=155.0.8059.39-1
ARG KASMVNC_VERSION=1.5.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates nftables procps xz-utils x11-utils \
      fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
      libgl1-mesa-dri libegl1 libgles2 \
 && rm -rf /var/lib/apt/lists/*

COPY vendor.sha256 /tmp/vendor/vendor.sha256
RUN --mount=type=bind,from=vendor,target=/mnt/vendor \
    set -eu; \
    case "$TARGETARCH" in amd64) S6_ARCH=x86_64 ;; arm64) S6_ARCH=aarch64 ;; *) echo "no build for $TARGETARCH" >&2; exit 1 ;; esac; \
    CHROME_DEB="google-chrome-stable_${CHROME_VERSION}_${TARGETARCH}.deb"; \
    KASM_DEB="kasmvncserver_bookworm_${KASMVNC_VERSION}_${TARGETARCH}.deb"; \
    cd /tmp/vendor; \
    for f in "$CHROME_DEB" "$KASM_DEB" s6-overlay-noarch.tar.xz "s6-overlay-${S6_ARCH}.tar.xz"; do \
      cp "/mnt/vendor/$f" .; \
      grep "  $f\$" vendor.sha256 | sha256sum -c -; \
    done; \
    tar -C / -Jxpf s6-overlay-noarch.tar.xz; \
    tar -C / -Jxpf "s6-overlay-${S6_ARCH}.tar.xz"; \
    apt-get update; \
    apt-get install -y --no-install-recommends "./$CHROME_DEB" "./$KASM_DEB"; \
    # The Chrome package adds Google's apt source and a daily job that puts
    # it back: Chrome changes only with a new image (plan §4.10).
    rm -f /etc/apt/sources.list.d/google-chrome.list /etc/cron.daily/google-chrome; \
    rm -rf /var/lib/apt/lists/* /tmp/vendor; \
    google-chrome-stable --version

# Chrome and the X server run as pb-chrome; the operator and the holder as
# pb-operator. The profile is pb-chrome's alone, the buffer pb-operator's.
RUN useradd -m -u 1001 -s /usr/sbin/nologin pb-chrome \
 && useradd -m -u 1002 -s /usr/sbin/nologin pb-operator \
 && mkdir -p /data/profile /data/buffer \
 && chown pb-chrome:pb-chrome /data/profile && chmod 700 /data/profile \
 && chown pb-operator:pb-operator /data/buffer && chmod 700 /data/buffer

COPY policies/hub.json /etc/opt/chrome/policies/managed/hub.json
COPY s6/ /etc/s6-overlay/
# The holder, the operator and the watchdog: TypeScript, run as it is
# (Node's type stripping), no dependencies.
COPY src/ /opt/page-browser/src/

# The rules extension (plan §4.6; spec §2.7): rules.json from the map of
# operations (src/policy/), packed and signed here (extension/build.ts), and
# the policy entry that force-installs its ID from the operator's own port —
# every other extension stays blocked. The signing key is made in this
# step's process and is gone with it: it is in no layer, and the extension's
# ID is this image's own (why: extension/build.ts).
COPY extension/ /opt/page-browser/extension/
RUN node --no-warnings /opt/page-browser/extension/build.ts \
      --out /opt/page-browser/extension/dist \
      --policy /etc/opt/chrome/policies/managed/hub.json

# A failed oneshot (the egress rules, their kernel check) stops the
# container; Chrome gets its 5 s to exit on a stop (stage 1, amendment 28).
ARG OPERATOR_VERSION=dev
ENV PB_OPERATOR_VERSION=${OPERATOR_VERSION} \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=30000 \
    S6_SERVICES_GRACETIME=6000 \
    S6_KILL_GRACETIME=2000 \
    S6_VERBOSITY=1

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s \
  CMD ["/etc/s6-overlay/scripts/health"]

ENTRYPOINT ["/init"]
