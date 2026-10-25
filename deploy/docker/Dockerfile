# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
FROM --platform=linux/amd64 ${NODE_IMAGE} AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
ENV NEXT_TELEMETRY_DISABLED=1 PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN npm install --global --ignore-scripts pnpm@12.6.0 && test "$(node --version)" = v24.21.0 && test "$(pnpm --version)" = 12.6.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json prisma.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY prisma ./prisma
COPY scripts/ops/set-account-password.mts ./scripts/ops/
# Windows node_modules and secrets are excluded by the repository .dockerignore.
# The store survives source changes while lifecycle scripts retain pnpm allowBuilds policy.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
ENV SHADOW_DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build_shadow
RUN --mount=type=cache,id=qisheng-pnpm-12,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY deploy/docker/assemble-runtime.mjs deploy/docker/worker-preflight.cjs ./deploy/docker/

FROM dependencies AS api-build
RUN --mount=type=cache,id=qisheng-pnpm-12,target=/pnpm/store pnpm exec prisma generate && pnpm -r --if-present --filter @xhs-agentic/api... build \
    && pnpm --filter @xhs-agentic/api deploy --prod /bundle/api \
    && node deploy/docker/assemble-runtime.mjs api

FROM dependencies AS web-build
ARG NEXT_PUBLIC_API_BASE_URL=/api
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
RUN pnpm -r --if-present --filter @xhs-agentic/admin-web... build \
    && node deploy/docker/assemble-runtime.mjs web

FROM dependencies AS worker-build
RUN --mount=type=cache,id=qisheng-pnpm-12,target=/pnpm/store pnpm exec prisma generate && pnpm -r --if-present --filter @xhs-agentic/worker... build \
    && pnpm --filter @xhs-agentic/worker deploy --prod /bundle/worker \
    && node deploy/docker/assemble-runtime.mjs worker

FROM dependencies AS readback-build
RUN --mount=type=cache,id=qisheng-pnpm-12,target=/pnpm/store pnpm -r --if-present --filter @xhs-agentic/xhs-api-collector... build \
    && pnpm --filter @xhs-agentic/xhs-api-collector deploy --prod /bundle/readback

FROM dependencies AS migrate-build
RUN node deploy/docker/assemble-runtime.mjs migrate

FROM --platform=linux/amd64 ${NODE_IMAGE} AS migrate
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY --from=migrate-build --chown=node:node /bundle/migrate/ ./
COPY --chown=node:node deploy/docker/runtime-config.cjs /app/ops/runtime-config.cjs
COPY --chown=node:node deploy/.env.example /app/ops/runtime.env.example
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 DATABASE_URL="" SHADOW_DATABASE_URL=""
USER node
ENTRYPOINT ["node", "/app/ops/runtime-config.cjs", "run"]
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM --platform=linux/amd64 ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl fontconfig fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
USER node

FROM runtime AS api
COPY --chown=node:node deploy/docker/runtime-config.cjs ./ops/runtime-config.cjs
COPY --chown=node:node deploy/.env.example ./ops/runtime.env.example
COPY --from=api-build --chown=node:node /bundle/api/package.json ./package.json
COPY --from=api-build --chown=node:node /bundle/api/node_modules ./node_modules
COPY --from=api-build --chown=node:node /bundle/api/dist ./dist
ENV API_HOST=0.0.0.0 API_PORT=3100 NODE_OPTIONS=--max-old-space-size=384
ENTRYPOINT ["node", "/app/ops/runtime-config.cjs", "run"]
CMD ["node", "dist/main.js"]

FROM runtime AS web
COPY --from=web-build --chown=node:node /bundle/web/ ./
WORKDIR /app/apps/admin-web
ENV HOSTNAME=0.0.0.0 PORT=3101 NODE_OPTIONS=--max-old-space-size=256
CMD ["node", "server.js"]

FROM runtime AS worker
COPY --chown=node:node deploy/docker/runtime-config.cjs ./ops/runtime-config.cjs
COPY --chown=node:node deploy/.env.example ./ops/runtime.env.example
COPY --from=worker-build --chown=node:node /bundle/worker/package.json ./package.json
COPY --from=worker-build --chown=node:node /bundle/worker/node_modules ./node_modules
COPY --from=worker-build --chown=node:node /bundle/worker/dist ./dist
COPY --from=worker-build --chown=node:node /bundle/worker/ops ./ops
ENV NODE_OPTIONS=--max-old-space-size=512
ENTRYPOINT ["node", "/app/ops/runtime-config.cjs", "run"]
CMD ["node", "dist/lifecycle.js"]

FROM runtime AS readback
COPY --from=readback-build --chown=node:node /bundle/readback/package.json ./package.json
COPY --from=readback-build --chown=node:node /bundle/readback/node_modules ./node_modules
COPY --from=readback-build --chown=node:node /bundle/readback/dist ./dist
ENV NODE_OPTIONS=--max-old-space-size=160
CMD ["node", "dist/main.js"]
