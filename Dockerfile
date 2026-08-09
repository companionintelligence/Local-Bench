# Local Bench (ci-local-bench) — CI marketplace container.
# Deno HTTP server (server.ts, compiled via tsc for the CommonJS/node:sqlite
# entrypoint) that serves index.html + the /api benchmark endpoints from cwd.
# Published as ghcr.io/companionintelligence/ci-local-bench.
#
# Migrated from a node:20-bookworm-slim image to Deno: the app's only native
# addon (better-sqlite3) doesn't load under Deno's N-API compat layer, so
# database.ts now uses the built-in `node:sqlite` module instead — no native
# compilation (python3/make/g++) needed anymore. `deno run` is used (not
# `deno compile`), matching how this container was already deployed.

# ---- build stage ----
FROM denoland/deno:2.9.5 AS build
WORKDIR /app
COPY deno.json deno.lock package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN deno task build

# ---- runtime stage ----
FROM denoland/deno:2.9.5
WORKDIR /app
ENV PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/deno.json ./deno.json
COPY --from=build /app/deno.lock ./deno.lock
COPY --from=build /app/package.json ./package.json
COPY index.html ./index.html
COPY assets ./assets
EXPOSE 3000
# --cached-only makes the container fail fast at startup instead of quietly
# hitting the npm registry if node_modules and deno.lock ever drift apart.
CMD ["run", "-A", "--cached-only", "dist/server.js"]
