# syntax=docker/dockerfile:1.7
# The always-on ChatSpace tab (apps/chatspace-browser/README.md): Firefox ESR
# with the ChatGoose extension on chat.onlymonster.ai, logged into
# OnlyMonster with both OnlyFans accounts open, so ChatSpace's socket — and
# with it the hub's OnlyFans feed — never stops for the night. KasmVNC is its
# X server and the owner's screen (as in apps/page-browser), s6-overlay runs
# the services, a small watchdog restarts Firefox when the extension updated
# or a tab crashed. One container, scripts/deploy-chatspace-browser.sh builds
# it on the server and runs it with docker-compose.chatspace-browser.yml.
#
# KasmVNC and s6-overlay come from the build context `vendor` — the page
# browsers' cache on the server — checked against vendor.sha256. Firefox
# comes from Mozilla's APT repository, its key checked by fingerprint:
#
#   docker build --build-context vendor=<dir> \
#     -t hub-chatspace-browser:<firefox version>-<commit> apps/chatspace-browser
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ARG TARGETARCH
ARG KASMVNC_VERSION=1.5.0
# Empty: the newest firefox-esr of Mozilla's repository when the image is
# built; the deploy script names the one installed in the tag and a label.
ARG FIREFOX_VERSION=

# The fonts of a Linux desktop (fan names and messages carry emoji),
# matchbox to keep Firefox's one window maximized (xdotool to look at it),
# Mesa for WebGL without a GPU, gnupg for Mozilla's key.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates gnupg procps xz-utils x11-utils fontconfig \
      fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji \
      matchbox-window-manager xdotool libgl1-mesa-dri libegl1 libgles2 \
 && rm -rf /var/lib/apt/lists/*

# Firefox ESR from Mozilla (packages.mozilla.org), pinned over Debian's own
# firefox-esr. Its source goes after the install: Firefox changes only with
# a new image (`deploy-chatspace-browser.sh build`).
COPY firefox/mozilla-apt-key.asc /tmp/mozilla-apt-key.asc
RUN set -eu; \
    fpr="$(gpg --show-keys --with-colons /tmp/mozilla-apt-key.asc | awk -F: '/^fpr:/ { print $10; exit }')"; \
    [ "$fpr" = 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3 ] || { echo "Mozilla's APT key has the fingerprint $fpr" >&2; exit 1; }; \
    install -d -m 755 /etc/apt/keyrings; \
    gpg --dearmor < /tmp/mozilla-apt-key.asc > /etc/apt/keyrings/packages.mozilla.org.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.gpg] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list; \
    printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla; \
    apt-get update; \
    apt-get install -y --no-install-recommends "firefox-esr${FIREFOX_VERSION:+=$FIREFOX_VERSION}"; \
    rm -f /etc/apt/sources.list.d/mozilla.list /tmp/mozilla-apt-key.asc; \
    rm -rf /var/lib/apt/lists/*; \
    firefox-esr --version

COPY vendor.sha256 /tmp/vendor/vendor.sha256
RUN --mount=type=bind,from=vendor,target=/mnt/vendor \
    set -eu; \
    case "$TARGETARCH" in amd64) S6_ARCH=x86_64 ;; arm64) S6_ARCH=aarch64 ;; *) echo "no build for $TARGETARCH" >&2; exit 1 ;; esac; \
    KASM_DEB="kasmvncserver_bookworm_${KASMVNC_VERSION}_${TARGETARCH}.deb"; \
    cd /tmp/vendor; \
    for f in "$KASM_DEB" s6-overlay-noarch.tar.xz "s6-overlay-${S6_ARCH}.tar.xz"; do \
      cp "/mnt/vendor/$f" .; \
      grep "  $f\$" vendor.sha256 | sha256sum -c -; \
    done; \
    tar -C / -Jxpf s6-overlay-noarch.tar.xz; \
    tar -C / -Jxpf "s6-overlay-${S6_ARCH}.tar.xz"; \
    apt-get update; \
    apt-get install -y --no-install-recommends "./$KASM_DEB"; \
    rm -rf /var/lib/apt/lists/* /tmp/vendor

# Firefox, its window manager and the X server run as cs-firefox; the
# profile — the OnlyMonster session, the extension's hub sign-in — is that
# user's alone.
RUN useradd -m -u 1001 -s /usr/sbin/nologin cs-firefox \
 && mkdir -p /data/profile \
 && chown cs-firefox:cs-firefox /data/profile && chmod 700 /data/profile

COPY firefox/ /opt/chatspace-browser/firefox/
COPY watchdog/ /opt/chatspace-browser/watchdog/
COPY s6/ /etc/s6-overlay/

# A failed oneshot stops the container; Firefox gets its 8 s to write its
# profile on a stop.
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=30000 \
    S6_SERVICES_GRACETIME=10000 \
    S6_KILL_GRACETIME=2000 \
    S6_VERBOSITY=1

HEALTHCHECK --interval=15s --timeout=3s --start-period=60s \
  CMD ["/etc/s6-overlay/scripts/health"]

ENTRYPOINT ["/init"]
