# Project Browser stand server: the stand's SOCKS5 exit, TLS/HTTP origins and
# ground-truth journal. Zero npm dependencies; Node runs the TypeScript directly.
#
#   docker build -t pb-stand-server -f apps/page-browser/stand/server/Dockerfile apps/page-browser/stand
#   docker run -d --name pb-stand -v pb-stand-ca:/stand/ca pb-stand-server
#   docker exec pb-stand sh /stand/server/selftest.sh
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY server/ /stand/server/
COPY pages/ /stand/pages/

ENV STAND_CA_DIR=/stand/ca \
    STAND_PAGES_DIR=/stand/pages
WORKDIR /stand/server
# 443 TLS front, 80 plain HTTP, 1080 SOCKS5, 8080 control API.
EXPOSE 80 443 1080 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=5s --retries=15 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1
CMD ["node", "--experimental-strip-types", "--no-warnings", "main.ts"]
