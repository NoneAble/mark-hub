# MarkHub

Self-hosted **Web** bookmark hub: public navigation, tree folders, tags, sharing, WebDAV + **S3/R2** scheduled backups.

**Delivery:** React SPA + REST API. Deploy with **Docker** (FastAPI + SQLite/Postgres) or **Cloudflare Workers + D1**. No browser extension.

## Monorepo

```
apps/web          React SPA (/  /admin  /app)
apps/worker       Cloudflare Workers + D1
packages/core     Shared pure logic (normalizeUrl, visibility, import parsing, …)
packages/api-client
packages/ui
server            Python FastAPI (Docker)
docs/openapi.yaml API contract
docker/           Dockerfile
```

## Quick start (dev)

### Server

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
mkdir -p data
export JWT_SECRET=dev-secret
export MARKHUB_MASTER_KEY=dev-master-key-32-bytes-long!!
uvicorn app.main:app --reload --port 8000
```

Default admin: `admin` / `admin123` (forced password change on first use).

### Web

```bash
pnpm install
pnpm --filter @markhub/core build
pnpm --filter @markhub/web dev
```

Vite proxies `/api` → `http://127.0.0.1:8000`.

### Tests

```bash
pnpm --filter @markhub/core test
cd server && source .venv/bin/activate && pytest -q
```

## Docker

Compose **requires** application secrets. There are no insecure defaults in the image or compose file.

### 1. Create `.env` (once, from a clean checkout)

```bash
# Option A — generate strong secrets (recommended)
./scripts/generate-docker-env.sh

# Option B — copy the template and edit
cp .env.example .env
# Required for every Compose path:
#   JWT_SECRET, MARKHUB_MASTER_KEY, DEFAULT_ADMIN_PASSWORD, POSTGRES_PASSWORD
# (Compose evaluates the Postgres service definition even when the SQLite
#  profile is used; keep POSTGRES_PASSWORD set. Use URL-safe characters.)
```

### 2. SQLite quick start (default)

```bash
docker compose up --build
# http://localhost:8080
```

Without `.env` (or exported secrets), `docker compose config` fails fast with a clear missing-variable error — that is intentional.

### 3. Postgres full stack (internal DB only)

```bash
# Uses the same .env; POSTGRES_PASSWORD is required and shared by app + DB
docker compose --profile postgres-app up --build
# App: http://localhost:8081
# Postgres is reachable only on the compose network (no host port published)
```

The `postgres` service is included in both the `postgres` and `postgres-app` profiles so `markhub-pg` always has its database dependency. Do not hard-code database passwords; use the same `POSTGRES_PASSWORD` for the DB and the app `DATABASE_URL`.

### Deployment regression

```bash
pnpm test:docker
```

This bounded harness builds the real image, allocates run-unique high loopback ports and a unique Compose project, exercises browser login plus SQLite/Postgres restart persistence, upgrades a populated legacy Postgres database, and removes only its owned containers, volumes, network, image, and listeners.

## Cloudflare

### Local dev (Worker + SPA assets)

Wrangler serves the built SPA from `apps/web/dist` — rebuild after frontend changes:

```bash
pnpm dev:cf
# equivalent: pnpm --filter @markhub/web build && cd apps/worker && pnpm exec wrangler dev --local
```

For UI-only work with hot reload, use `pnpm dev:web` instead.

### Production deploy

Production deploy (remote D1 + all required secrets). Do **not** use `--local` for production migrations.

```bash
# 0) Prerequisites
# - Cloudflare account + wrangler logged in: pnpm exec wrangler login
# - SPA built so Worker assets resolve: pnpm --filter @markhub/web build

# 1) Create remote D1 and set database_id in apps/worker/wrangler.toml
cd apps/worker
pnpm exec wrangler d1 create markhub
# copy the printed database_id into [[d1_databases]].database_id

# 2) Apply migrations to REMOTE D1 (not --local)
pnpm exec wrangler d1 migrations apply markhub --remote

# 3) Set every required secret (Worker refuses insecure/missing bootstrap secrets)
pnpm exec wrangler secret put JWT_SECRET              # long random string
pnpm exec wrangler secret put MARKHUB_MASTER_KEY      # Fernet/master encryption key
pnpm exec wrangler secret put DEFAULT_ADMIN_PASSWORD  # initial admin password

# optional: DEFAULT_ADMIN_USERNAME is already "admin" in [vars]

# 4) Deploy
pnpm exec wrangler deploy

# 5) Smoke-test
curl -sS "https://<your-worker>.workers.dev/api/v1/health"
curl -sS -X POST "https://<your-worker>.workers.dev/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"<DEFAULT_ADMIN_PASSWORD>"}'
```

Local development only (ephemeral D1 state):

```bash
cd apps/worker
pnpm exec wrangler d1 migrations apply markhub --local
pnpm exec wrangler dev --local
```

Cron: Worker uses `*/15 * * * *` so the configured `backup_time` (HH:mm) is honored within the matching 15-minute window.

Worker implements the same `/api/v1` contract for core CRUD/nav/export; long jobs prefer Docker.

## License

Self-hosted software — see repository policy.
