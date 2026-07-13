# MarkHub multi-stage: build web SPA + run FastAPI with static files
# RQG-DOCKER-001: no secret ENV defaults; copy only required server sources.

FROM node:22-alpine AS web-build
WORKDIR /src
# Use the lockfile-declared package manager
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @markhub/core build \
 && pnpm --filter @markhub/api-client build \
 && pnpm --filter @markhub/ui build \
 && pnpm --filter @markhub/web build

FROM python:3.12-slim AS runtime
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Install Python deps first for layer caching
COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir -r /app/server/requirements.txt

# Copy only runtime application sources (never tests, venvs, local data, or .env)
COPY server/app /app/server/app
COPY server/migrations /app/server/migrations
COPY server/requirements.txt /app/server/requirements.txt
COPY --from=web-build /src/apps/web/dist /app/web-dist

# Non-secret runtime defaults only. Secrets MUST be injected at run time
# (compose/k8s/env). Application startup refuses known-weak values.
ENV DATABASE_URL=sqlite+aiosqlite:///./data/markhub.db
ENV DEFAULT_ADMIN_USERNAME=admin
ENV FORCE_ADMIN_PASSWORD_CHANGE=true
# Intentionally unset: JWT_SECRET, MARKHUB_MASTER_KEY, DEFAULT_ADMIN_PASSWORD

RUN mkdir -p /app/data /app/server/data
WORKDIR /app/server

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
