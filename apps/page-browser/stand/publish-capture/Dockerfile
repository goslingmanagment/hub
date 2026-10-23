# syntax=docker/dockerfile:1.7
# The stand's publish capture image (docs/plans/2026-10-23-wall-posts, plan
# PR 0.1; runbook stand-session-0.2.md) — NEVER a page's in production. It
# is the production page image of the same tree (stand.sh build:
# pb-suite/page-browser:<rev>) with one change: its rules extension is built
# again with `--capture publish` (extension/build.ts), so that
#   - the rules let the site's own publishing requests go (src/policy/rules.ts,
#     levels 265 and 260), and
#   - the marker next to the package turns the operator's side on: the upload
#     host open at the proxy, the `publish` journal (src/capture/).
# A new key, so a new extension ID, and the policy names it. Nothing else of
# the image changes: Chrome, the operator, s6, the fonts are production's.
#
# Its label keeps it off the pages: host/page.sh refuses an image that has
# it, and the stand's guard stops every container of it (agency.stand).
#
#   docker build --build-arg BASE=pb-suite/page-browser:<rev> \
#     -t pb-suite/page-browser-capture:<rev> apps/page-browser/stand/publish-capture
ARG BASE
FROM ${BASE}
ARG OPERATOR_VERSION=dev
RUN node --no-warnings /opt/page-browser/extension/build.ts --capture publish \
      --out /opt/page-browser/extension/dist \
      --policy /etc/opt/chrome/policies/managed/hub.json
ENV PB_OPERATOR_VERSION=${OPERATOR_VERSION}-publish-capture
LABEL agency.page-browser.capture="publish" \
      agency.stand="pb-suite"
