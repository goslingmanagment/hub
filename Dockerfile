FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN cd apps/dashboard && npx vite build

CMD ["pnpm", "worker"]
