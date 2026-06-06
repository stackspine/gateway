# Self-Host Guide

StackSpine Gateway can be self-hosted using Docker Compose or Kubernetes (Helm).

## Compatibility Matrix

| Gateway image           | DB schema                              | SDK range          | Postgres |
|-------------------------|----------------------------------------|--------------------|----------|
| `ghcr.io/stackspine/gateway:1.x` | `migrations/000_core_schema.sql` @ 1.x | `>=1.0.0 <2.0.0` | 14, 15, 16 |

Pin a specific tag in production (e.g. `:1.2.3`). The `:latest` tag tracks the
newest release in the current major and may include breaking changes on a major
bump.

## Quick Start with Docker Compose

```bash
cd deploy/docker

# Configure environment
cp .env.example .env
# Edit .env with your secrets

# Start all services
docker compose up -d
```

This spins up:
- **PostgreSQL** (Supabase-compatible) on port 5432
- **GoTrue Auth** on port 9999
- **PostgREST** on port 3000
- **StackSpine Invoke Gateway** on port 8000
- **StackSpine MCP Server** on port 8001

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | Yes | Database password |
| `JWT_SECRET` | Yes | JWT signing secret (≥32 chars) |
| `SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `LOVABLE_API_KEY` | No | For Lovable-hosted model access |
| `SITE_URL` | No | Frontend URL (default: http://localhost:3000) |

## Kubernetes (Helm)

```bash
cd deploy/helm

# Install
helm install stackspine . \
  --set env.SUPABASE_URL=https://your-supabase.com \
  --set env.SUPABASE_SERVICE_ROLE_KEY=your-key \
  --set postgres.password=your-db-password

# Upgrade
helm upgrade stackspine .
```

Features:
- **HPA** auto-scales from 2 to 10 replicas based on CPU
- **Ingress** with TLS via cert-manager
- **Liveness/readiness probes** for zero-downtime deploys
- **MCP Server** deployed as a separate service

## Database Migrations

Apply migrations from `supabase/migrations/` to your PostgreSQL instance:

```bash
for f in supabase/migrations/*.sql; do
  psql -h localhost -U postgres -d stackspine -f "$f"
done
```

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌──────────────┐
│   Your App      │────▶│  Invoke GW   │────▶│  AI Provider │
│                 │     │  (port 8000) │     │  (OpenAI,    │
└─────────────────┘     └──────┬───────┘     │  Anthropic)  │
                               │              └──────────────┘
                        ┌──────▼───────┐
                        │  PostgreSQL  │
                        │  + PostgREST │
                        └──────────────┘
```
