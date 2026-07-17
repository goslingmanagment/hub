# syntax=docker/dockerfile:1.7

ARG NODE_BASE_IMAGE=node:22-bookworm-slim
ARG APP_DEPENDENCY_CHECKSUM=unknown
ARG APP_SOURCE_REVISION=unknown

FROM ${NODE_BASE_IMAGE} AS target-base

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

FROM target-base AS prod-deps

ARG TARGETARCH

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/runtime/package.json ./apps/runtime/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/fansly/package.json ./packages/fansly/package.json
COPY packages/platform-core/package.json ./packages/platform-core/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN --mount=type=cache,id=agency-hub-corepack-target-${TARGETARCH},target=/corepack,sharing=locked \
    --mount=type=cache,id=agency-hub-pnpm-target-${TARGETARCH},target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --prod --frozen-lockfile --filter @agency_hub_core/runtime... \
    && pnpm rebuild --pending --filter @agency_hub_core/runtime...

FROM --platform=$BUILDPLATFORM ${NODE_BASE_IMAGE} AS build

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/corepack
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

ARG BUILDARCH

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY apps/runtime/package.json ./apps/runtime/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/fansly/package.json ./packages/fansly/package.json
COPY packages/platform-core/package.json ./packages/platform-core/package.json
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN --mount=type=cache,id=agency-hub-corepack-build-${BUILDARCH},target=/corepack,sharing=locked \
    --mount=type=cache,id=agency-hub-pnpm-build-${BUILDARCH},target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --frozen-lockfile \
    && pnpm rebuild --pending

COPY tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN --mount=type=cache,id=agency-hub-corepack-build-${BUILDARCH},target=/corepack,sharing=locked \
    pnpm build:production

FROM ${NODE_BASE_IMAGE} AS runtime

ARG APP_DEPENDENCY_CHECKSUM=unknown
ARG APP_SOURCE_REVISION=unknown

LABEL agency-hub.dependency-checksum="${APP_DEPENDENCY_CHECKSUM}"
LABEL agency-hub.source-revision="${APP_SOURCE_REVISION}"

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json ./
COPY apps/runtime/package.json ./apps/runtime/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/fansly/package.json ./packages/fansly/package.json
COPY packages/platform-core/package.json ./packages/platform-core/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/runtime/node_modules ./apps/runtime/node_modules
COPY --from=prod-deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/packages/fansly/node_modules ./packages/fansly/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
RUN node apps/runtime/node_modules/playwright/cli.js install --with-deps --only-shell chromium
COPY --from=build /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build /app/apps/runtime/dist ./apps/runtime/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations

CMD ["node", "apps/runtime/dist/startup.js", "worker"]
