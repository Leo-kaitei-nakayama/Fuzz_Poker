# ---- build stage ---------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# Build the web client bundle and the single-file server bundle.
RUN pnpm --filter @cute-poker/web build \
  && pnpm --filter @cute-poker/game-server build

# ---- runtime stage -------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PUBLIC_DIR=/app/public \
    DB_PATH=/data/cute-poker.db
# The server is bundled (ws inlined); node:sqlite is a Node builtin, so the
# runtime image needs only the bundle and the static client.
COPY --from=build /repo/apps/game-server/dist/server.js ./server.js
COPY --from=build /repo/apps/web/public ./public
RUN mkdir -p /data
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "server.js"]
