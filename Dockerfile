# Local Bench (ci-local-bench) — CI marketplace container.
# Node HTTP server that serves index.html + the /api benchmark endpoints from cwd.
# Published as ghcr.io/companionintelligence/ci-local-bench.

# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/index.html ./index.html
COPY --from=build /app/assets ./assets
COPY --from=build /app/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/server.js"]
