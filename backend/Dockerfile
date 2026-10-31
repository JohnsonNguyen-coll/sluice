FROM oven/bun:1.4.4

WORKDIR /app

# Install workspace dependencies before copying sources for a stable build cache.
COPY package.json bun.lock ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
COPY backend/packages/sdk/package.json backend/packages/sdk/package.json
COPY backend/packages/middleware/package.json backend/packages/middleware/package.json
COPY contract/package.json contract/package.json
RUN bun install --frozen-lockfile

COPY backend backend
COPY contract/deployments contract/deployments

ENV NODE_ENV=production
CMD ["bun", "run", "--cwd", "backend", "start"]
