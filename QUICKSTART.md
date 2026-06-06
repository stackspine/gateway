# StackSpine Gateway — Quickstart

End-to-end install in under 5 minutes. Pick **Docker Compose** for local
development or **Helm** for Kubernetes.

## Option A — Docker Compose

Spins up Postgres + Auth + PostgREST + Gateway.

```bash
git clone https://github.com/stackspine/gateway.git
cd gateway/deploy/docker

cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, JWT_SECRET (>=32 chars), SERVICE_ROLE_KEY

docker compose up -d
docker compose ps   # all services healthy
```

Apply the schema:

```bash
psql -h localhost -U postgres -d stackspine -f ../../migrations/000_core_schema.sql
```

Smoke test (replace `sk_demo` with a real key after seeding an org + task):

```bash
curl -sS http://localhost:8000/healthz
# {"ok":true,"version":"1.x.x"}

curl -sS -X POST http://localhost:8000/v1/invoke \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk_demo" \
  -d '{"task_key":"chat-support","messages":[{"role":"user","content":"ping"}]}'
```

Tear down:

```bash
docker compose down -v
```

## Option B — Helm (minimal)

```bash
helm install ss ./deploy/helm \
  --namespace stackspine --create-namespace \
  --set image.tag=1.0.0 \
  --set postgres.password=$(openssl rand -hex 24) \
  --set env.SUPABASE_URL=http://ss-postgrest:3000 \
  --set env.SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY

kubectl -n stackspine rollout status deploy/ss-gateway
kubectl -n stackspine port-forward svc/ss-gateway 8000:8000

curl -sS http://localhost:8000/healthz
```

For ingress + TLS, edit `deploy/helm/values.yaml` (`ingress.hosts`, `ingress.tls`)
and re-run `helm upgrade ss ./deploy/helm`.

## Pin a version

Always pin a specific tag in production. See the [compatibility matrix](deploy/SELF-HOST.md#compatibility-matrix):

```bash
# Docker
docker pull ghcr.io/stackspine/gateway:1.0.0

# Helm
helm install ss oci://ghcr.io/stackspine/charts/stackspine --version 1.0.0
```

## What you just installed

You're running the **enforcement data plane**: routing, budget enforcement,
guardrails, rate limiting, and prompt cache. Dashboards, SSO, audit evidence,
and the self-optimizing optimizer are part of [StackSpine Cloud](https://stackspine.com).
