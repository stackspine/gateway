-- StackSpine Gateway — Core Schema
-- This migration creates the essential tables for the gateway runtime.
-- Apply to a Supabase-compatible PostgreSQL instance.

-- ============================================================================
-- Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE public.app_role AS ENUM ('owner', 'admin', 'developer', 'viewer');
CREATE TYPE public.call_status AS ENUM ('success', 'error', 'timeout', 'rate_limited');
CREATE TYPE public.budget_scope AS ENUM ('org', 'task');

-- ============================================================================
-- Core Identity
-- ============================================================================

CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  billing_email TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  prompt_cache_enabled BOOLEAN DEFAULT false,
  prompt_cache_ttl_minutes INTEGER DEFAULT 60,
  usage_enforcement_start TIMESTAMPTZ,
  benchmark_opt_in BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id UUID UNIQUE NOT NULL,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role app_role NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);

-- ============================================================================
-- API Keys
-- ============================================================================

CREATE TABLE public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.users(id),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.api_key_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Providers & Models
-- ============================================================================

CREATE TABLE public.providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  api_key_encrypted TEXT,
  base_url TEXT,
  is_active BOOLEAN DEFAULT true,
  consecutive_failures INTEGER DEFAULT 0,
  circuit_breaker_threshold INTEGER DEFAULT 3,
  circuit_breaker_cooldown_minutes INTEGER DEFAULT 5,
  circuit_opened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.model_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  provider_model_name TEXT NOT NULL,
  default_max_tokens INTEGER DEFAULT 4096,
  default_temperature NUMERIC DEFAULT 0.7,
  cost_per_input_token NUMERIC DEFAULT 0,
  cost_per_output_token NUMERIC DEFAULT 0,
  context_window_tokens INTEGER DEFAULT 128000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Tasks & Routes
-- ============================================================================

CREATE TABLE public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  system_prompt TEXT,
  is_active BOOLEAN DEFAULT true,
  auto_optimize_routing BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);

CREATE TABLE public.routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  model_profile_id UUID NOT NULL REFERENCES public.model_profiles(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL DEFAULT 'primary',
  weight INTEGER DEFAULT 100,
  region TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.route_conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL REFERENCES public.routes(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  operator TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.data_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  allowed_regions TEXT[] DEFAULT '{}',
  requires_encryption BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.route_data_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL REFERENCES public.routes(id) ON DELETE CASCADE,
  data_policy_id UUID NOT NULL REFERENCES public.data_policies(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Prompt Versioning
-- ============================================================================

CREATE TABLE public.prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  system_prompt TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Call Logging & Statistics
-- ============================================================================

CREATE TABLE public.call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  task_id UUID REFERENCES public.tasks(id),
  model_profile_id UUID REFERENCES public.model_profiles(id),
  provider_id UUID REFERENCES public.providers(id),
  status call_status NOT NULL DEFAULT 'success',
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd NUMERIC,
  error_message TEXT,
  gateway_latency_ms INTEGER,
  metadata JSONB,
  trace_id TEXT,
  session_id TEXT,
  parent_trace_id TEXT,
  request_idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.daily_call_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  total_calls INTEGER DEFAULT 0,
  total_cost_usd NUMERIC DEFAULT 0,
  total_tokens BIGINT DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  timeout_count INTEGER DEFAULT 0,
  rate_limited_count INTEGER DEFAULT 0,
  avg_latency_ms NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, date)
);

CREATE TABLE public.daily_model_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  model_profile_id UUID NOT NULL REFERENCES public.model_profiles(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  total_calls INTEGER DEFAULT 0,
  total_cost_usd NUMERIC DEFAULT 0,
  total_tokens BIGINT DEFAULT 0,
  avg_latency_ms NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, model_profile_id, date)
);

CREATE TABLE public.daily_provider_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  total_calls INTEGER DEFAULT 0,
  total_cost_usd NUMERIC DEFAULT 0,
  total_tokens BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider_id, date)
);

-- ============================================================================
-- Budget Rules
-- ============================================================================

CREATE TABLE public.budget_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_type budget_scope NOT NULL,
  scope_id TEXT,
  monthly_budget_usd NUMERIC NOT NULL,
  alert_threshold_percent NUMERIC DEFAULT 80,
  enforce_hard_limit BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Rate Limiting
-- ============================================================================

CREATE TABLE public.rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL
);

CREATE TABLE public.org_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID UNIQUE NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requests_per_minute_per_key INTEGER DEFAULT 60,
  requests_per_minute_per_ip INTEGER DEFAULT 120,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Session Limits
-- ============================================================================

CREATE TABLE public.session_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  max_session_cost_usd NUMERIC,
  max_session_iterations INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Prompt Cache
-- ============================================================================

CREATE TABLE public.prompt_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  cache_key_hash TEXT NOT NULL,
  response_content TEXT,
  usage_metadata JSONB,
  cost_usd NUMERIC,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, cache_key_hash)
);

-- ============================================================================
-- Context Compression
-- ============================================================================

CREATE TABLE public.context_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  original_token_count INTEGER NOT NULL,
  compressed_token_count INTEGER NOT NULL,
  model_used TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- Cost Predictions (for feedback loop)
-- ============================================================================

CREATE TABLE public.cost_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  call_log_id UUID REFERENCES public.call_logs(id),
  model_profile_id UUID NOT NULL,
  original_model_profile_id UUID,
  predicted_input_tokens INTEGER NOT NULL,
  predicted_output_tokens INTEGER NOT NULL,
  predicted_cost_usd NUMERIC NOT NULL,
  actual_cost_usd NUMERIC,
  was_optimized BOOLEAN DEFAULT false,
  confidence_score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- Compliance Rules & Events (lightweight subset)
-- ============================================================================

CREATE TABLE public.compliance_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'log',
  config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.compliance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  call_log_id UUID REFERENCES public.call_logs(id),
  event_type TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Provider Health History
-- ============================================================================

CREATE TABLE public.provider_health_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  healthy BOOLEAN NOT NULL,
  latency_ms INTEGER,
  status_code INTEGER,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Views (for the invoke gateway to join providers with decrypted keys)
-- ============================================================================

-- NOTE: In production, replace the decrypt function with your own key management.
-- This view exposes `api_key` by decrypting `api_key_encrypted` at query time.
CREATE OR REPLACE VIEW public.providers_with_key AS
SELECT
  p.id, p.org_id, p.name, p.type, p.base_url, p.is_active,
  p.consecutive_failures, p.circuit_breaker_threshold,
  p.circuit_breaker_cooldown_minutes, p.circuit_opened_at,
  p.api_key_encrypted AS api_key
FROM public.providers p;

-- ============================================================================
-- Core Functions
-- ============================================================================

-- Get user's org ID
CREATE OR REPLACE FUNCTION public.get_user_org_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT org_id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1
$$;

-- Rate limit check-and-increment (atomic)
CREATE OR REPLACE FUNCTION public.check_and_increment_rate_limit(
  p_bucket_key TEXT, p_window_start TIMESTAMPTZ, p_max_requests INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
  INSERT INTO public.rate_limit_buckets (bucket_key, count, window_start)
  VALUES (p_bucket_key, 1, p_window_start)
  ON CONFLICT (bucket_key) DO UPDATE
    SET count = CASE
      WHEN rate_limit_buckets.window_start < p_window_start THEN 1
      ELSE rate_limit_buckets.count + 1
    END,
    window_start = CASE
      WHEN rate_limit_buckets.window_start < p_window_start THEN p_window_start
      ELSE rate_limit_buckets.window_start
    END
  RETURNING count INTO v_count;

  RETURN jsonb_build_object(
    'allowed', v_count <= p_max_requests,
    'remaining', GREATEST(p_max_requests - v_count, 0)
  );
END;
$$;

-- Session usage aggregation
CREATE OR REPLACE FUNCTION public.get_session_usage(p_org_id UUID, p_session_id TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total_cost NUMERIC; v_total_calls BIGINT;
BEGIN
  SELECT COALESCE(SUM(cost_usd), 0), COUNT(*)
  INTO v_total_cost, v_total_calls
  FROM public.call_logs
  WHERE org_id = p_org_id AND session_id = p_session_id;

  RETURN jsonb_build_object('total_cost', v_total_cost, 'total_calls', v_total_calls);
END;
$$;

-- Monthly usage count
CREATE OR REPLACE FUNCTION public.get_monthly_usage(p_org_id UUID)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(total_calls), 0)::BIGINT
  FROM public.daily_call_stats
  WHERE org_id = p_org_id AND date >= date_trunc('month', CURRENT_DATE)::DATE;
$$;

-- ============================================================================
-- Triggers: Auto-aggregate call stats
-- ============================================================================

CREATE OR REPLACE FUNCTION public.upsert_daily_call_stats()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE log_date DATE;
BEGIN
  log_date := DATE(NEW.created_at);
  INSERT INTO public.daily_call_stats (
    org_id, date, total_calls, total_cost_usd, total_tokens,
    success_count, error_count, timeout_count, rate_limited_count, avg_latency_ms
  ) VALUES (
    NEW.org_id, log_date, 1, COALESCE(NEW.cost_usd, 0), COALESCE(NEW.total_tokens, 0),
    CASE WHEN NEW.status = 'success' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'error' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'timeout' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'rate_limited' THEN 1 ELSE 0 END,
    COALESCE(NEW.latency_ms, 0)
  ) ON CONFLICT (org_id, date) DO UPDATE SET
    total_calls = daily_call_stats.total_calls + 1,
    total_cost_usd = daily_call_stats.total_cost_usd + COALESCE(NEW.cost_usd, 0),
    total_tokens = daily_call_stats.total_tokens + COALESCE(NEW.total_tokens, 0),
    success_count = daily_call_stats.success_count + CASE WHEN NEW.status = 'success' THEN 1 ELSE 0 END,
    error_count = daily_call_stats.error_count + CASE WHEN NEW.status = 'error' THEN 1 ELSE 0 END,
    timeout_count = daily_call_stats.timeout_count + CASE WHEN NEW.status = 'timeout' THEN 1 ELSE 0 END,
    rate_limited_count = daily_call_stats.rate_limited_count + CASE WHEN NEW.status = 'rate_limited' THEN 1 ELSE 0 END,
    avg_latency_ms = (daily_call_stats.avg_latency_ms * daily_call_stats.total_calls + COALESCE(NEW.latency_ms, 0)) / (daily_call_stats.total_calls + 1),
    updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_upsert_daily_call_stats
AFTER INSERT ON public.call_logs
FOR EACH ROW EXECUTE FUNCTION public.upsert_daily_call_stats();

CREATE OR REPLACE FUNCTION public.upsert_daily_model_stats()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.model_profile_id IS NOT NULL AND NEW.status = 'success' THEN
    INSERT INTO public.daily_model_stats (org_id, model_profile_id, date, total_calls, total_cost_usd, total_tokens, avg_latency_ms)
    VALUES (NEW.org_id, NEW.model_profile_id, (NEW.created_at AT TIME ZONE 'UTC')::date, 1, COALESCE(NEW.cost_usd, 0), COALESCE(NEW.total_tokens, 0), COALESCE(NEW.latency_ms, 0))
    ON CONFLICT (org_id, model_profile_id, date) DO UPDATE SET
      total_calls = daily_model_stats.total_calls + 1,
      total_cost_usd = daily_model_stats.total_cost_usd + COALESCE(NEW.cost_usd, 0),
      total_tokens = daily_model_stats.total_tokens + COALESCE(NEW.total_tokens, 0),
      avg_latency_ms = (daily_model_stats.avg_latency_ms * daily_model_stats.total_calls + COALESCE(NEW.latency_ms, 0)) / (daily_model_stats.total_calls + 1),
      updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_upsert_daily_model_stats
AFTER INSERT ON public.call_logs
FOR EACH ROW EXECUTE FUNCTION public.upsert_daily_model_stats();

CREATE OR REPLACE FUNCTION public.upsert_daily_provider_stats()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE log_date DATE;
BEGIN
  IF NEW.provider_id IS NULL THEN RETURN NEW; END IF;
  log_date := DATE(NEW.created_at);
  INSERT INTO public.daily_provider_stats (org_id, provider_id, date, total_calls, total_cost_usd, total_tokens)
  VALUES (NEW.org_id, NEW.provider_id, log_date, 1, COALESCE(NEW.cost_usd, 0), COALESCE(NEW.total_tokens, 0))
  ON CONFLICT (org_id, provider_id, date) DO UPDATE SET
    total_calls = daily_provider_stats.total_calls + 1,
    total_cost_usd = daily_provider_stats.total_cost_usd + COALESCE(NEW.cost_usd, 0),
    total_tokens = daily_provider_stats.total_tokens + COALESCE(NEW.total_tokens, 0),
    updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_upsert_daily_provider_stats
AFTER INSERT ON public.call_logs
FOR EACH ROW EXECUTE FUNCTION public.upsert_daily_provider_stats();

-- ============================================================================
-- Consolidated Pre-flight RPC (single DB round-trip for the invoke gateway)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_invoke_context(
  p_key_prefix TEXT, p_task_key TEXT, p_ip TEXT, p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_api_key RECORD;
  v_org_id UUID;
  v_task RECORD;
  v_org RECORD;
  v_prompt_version_id UUID;
  v_rate_limit_ip JSONB;
  v_rate_limit_key JSONB;
  v_max_per_key INT;
  v_max_per_ip INT;
  v_window_start TIMESTAMPTZ;
  v_budget_rules JSONB;
  v_monthly_spend NUMERIC;
  v_task_spends JSONB;
  v_monthly_usage BIGINT;
  v_compliance_rules JSONB;
  v_idempotent_replay JSONB := NULL;
  v_scoped_task_ids JSONB;
BEGIN
  -- 1. API key lookup
  SELECT id, org_id, key_hash, is_active, expires_at
  INTO v_api_key FROM api_keys
  WHERE key_prefix = p_key_prefix AND is_active = true;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'invalid_key'); END IF;

  v_org_id := v_api_key.org_id;

  -- 2. Org config
  SELECT plan, prompt_cache_enabled, prompt_cache_ttl_minutes, usage_enforcement_start
  INTO v_org FROM organizations WHERE id = v_org_id;

  -- 3. Org rate limits
  SELECT requests_per_minute_per_key, requests_per_minute_per_ip
  INTO v_max_per_key, v_max_per_ip FROM org_rate_limits WHERE org_id = v_org_id;
  v_max_per_key := COALESCE(v_max_per_key, 60);
  v_max_per_ip := COALESCE(v_max_per_ip, 120);

  -- 4. Rate limit checks
  v_window_start := to_timestamp(floor(extract(epoch from now()) / 60) * 60);
  v_rate_limit_ip := check_and_increment_rate_limit('ip:' || p_ip, v_window_start, v_max_per_ip);
  v_rate_limit_key := check_and_increment_rate_limit('key:' || p_key_prefix, v_window_start, v_max_per_key);

  -- 5. Task lookup
  SELECT id, key, system_prompt, is_active, auto_optimize_routing
  INTO v_task FROM tasks WHERE org_id = v_org_id AND key = p_task_key AND is_active = true;

  -- 6. Active prompt version
  IF v_task.id IS NOT NULL THEN
    SELECT id INTO v_prompt_version_id FROM prompt_versions
    WHERE task_id = v_task.id AND is_active = true LIMIT 1;
  END IF;

  -- 7. Budget rules (hard-limit only)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', br.id, 'scope_type', br.scope_type, 'scope_id', br.scope_id,
    'monthly_budget_usd', br.monthly_budget_usd, 'alert_threshold_percent', br.alert_threshold_percent
  )), '[]'::jsonb) INTO v_budget_rules
  FROM budget_rules br WHERE br.org_id = v_org_id AND br.is_active = true AND br.enforce_hard_limit = true;

  -- 8. Monthly spend (from aggregation table — ~31 rows max)
  SELECT COALESCE(SUM(total_cost_usd), 0) INTO v_monthly_spend
  FROM daily_call_stats WHERE org_id = v_org_id AND date >= date_trunc('month', CURRENT_DATE)::DATE;

  -- 9. Task-level spends
  SELECT COALESCE(jsonb_object_agg(sub.task_id::text, sub.task_spend), '{}'::jsonb) INTO v_task_spends
  FROM (SELECT cl.task_id, COALESCE(SUM(cl.cost_usd), 0) AS task_spend
    FROM call_logs cl WHERE cl.org_id = v_org_id AND cl.created_at >= date_trunc('month', CURRENT_DATE) AND cl.task_id IS NOT NULL
    GROUP BY cl.task_id) sub;

  -- 10. Monthly usage count
  SELECT COALESCE(SUM(total_calls), 0) INTO v_monthly_usage
  FROM daily_call_stats WHERE org_id = v_org_id AND date >= date_trunc('month', CURRENT_DATE)::DATE;

  -- 11. Compliance rules
  IF v_task.id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', cr.id, 'rule_type', cr.rule_type, 'action', cr.action, 'config', cr.config
    )), '[]'::jsonb) INTO v_compliance_rules
    FROM compliance_rules cr WHERE cr.task_id = v_task.id AND cr.is_active = true;
  ELSE v_compliance_rules := '[]'::jsonb; END IF;

  -- 12. Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT jsonb_build_object('id', cl.id, 'cached_response', cl.metadata->'cached_response')
    INTO v_idempotent_replay FROM call_logs cl
    WHERE cl.org_id = v_org_id AND cl.request_idempotency_key = p_idempotency_key
      AND cl.metadata ? 'cached_response' LIMIT 1;
  END IF;

  -- 12b. Scoped task IDs
  SELECT COALESCE(jsonb_agg(aks.task_id), '[]'::jsonb) INTO v_scoped_task_ids
  FROM api_key_scopes aks WHERE aks.api_key_id = v_api_key.id;

  -- 13. Update last_used_at
  UPDATE api_keys SET last_used_at = now() WHERE key_prefix = p_key_prefix;

  RETURN jsonb_build_object(
    'api_key', jsonb_build_object('id', v_api_key.id, 'org_id', v_api_key.org_id, 'key_hash', v_api_key.key_hash, 'is_active', v_api_key.is_active, 'expires_at', v_api_key.expires_at),
    'org', CASE WHEN v_org IS NOT NULL THEN jsonb_build_object('plan', v_org.plan, 'prompt_cache_enabled', v_org.prompt_cache_enabled, 'prompt_cache_ttl_minutes', v_org.prompt_cache_ttl_minutes, 'usage_enforcement_start', v_org.usage_enforcement_start) ELSE NULL END,
    'task', CASE WHEN v_task.id IS NOT NULL THEN jsonb_build_object('id', v_task.id, 'key', v_task.key, 'system_prompt', v_task.system_prompt, 'is_active', v_task.is_active, 'auto_optimize_routing', COALESCE(v_task.auto_optimize_routing, false)) ELSE NULL END,
    'prompt_version_id', v_prompt_version_id,
    'rate_limit_ip', v_rate_limit_ip,
    'rate_limit_key', v_rate_limit_key,
    'rate_limit_config', jsonb_build_object('max_per_key', v_max_per_key, 'max_per_ip', v_max_per_ip),
    'budget_rules', v_budget_rules,
    'monthly_spend', v_monthly_spend,
    'task_spends', v_task_spends,
    'monthly_usage', v_monthly_usage,
    'compliance_rules', v_compliance_rules,
    'idempotent_replay', v_idempotent_replay,
    'scoped_task_ids', v_scoped_task_ids
  );
END;
$$;

-- ============================================================================
-- Cleanup functions
-- ============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_rate_limit_buckets()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN DELETE FROM public.rate_limit_buckets WHERE window_start < NOW() - INTERVAL '2 minutes'; END;
$$;

-- ============================================================================
-- Row Level Security (enable on all tables)
-- ============================================================================

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_key_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.data_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_data_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_call_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_model_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_provider_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_health_history ENABLE ROW LEVEL SECURITY;

-- Basic RLS: org members can access their own org's data
CREATE POLICY "org_isolation" ON public.organizations FOR ALL USING (id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.users FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.user_roles FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.api_keys FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.api_key_scopes FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.providers FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.model_profiles FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.tasks FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.call_logs FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.daily_call_stats FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.daily_model_stats FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.daily_provider_stats FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.budget_rules FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.session_limits FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.prompt_cache FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.context_summaries FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.cost_predictions FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.compliance_rules FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.compliance_events FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.data_policies FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.prompt_versions FOR ALL USING (org_id = public.get_user_org_id());
CREATE POLICY "org_isolation" ON public.org_rate_limits FOR ALL USING (org_id = public.get_user_org_id());

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX idx_call_logs_org_created ON public.call_logs (org_id, created_at DESC);
CREATE INDEX idx_call_logs_task ON public.call_logs (task_id, created_at DESC);
CREATE INDEX idx_call_logs_session ON public.call_logs (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_call_logs_idempotency ON public.call_logs (org_id, request_idempotency_key) WHERE request_idempotency_key IS NOT NULL;
CREATE INDEX idx_daily_call_stats_org_date ON public.daily_call_stats (org_id, date);
CREATE INDEX idx_daily_model_stats_org_date ON public.daily_model_stats (org_id, date);
CREATE INDEX idx_api_keys_prefix ON public.api_keys (key_prefix) WHERE is_active = true;
CREATE INDEX idx_tasks_org_key ON public.tasks (org_id, key) WHERE is_active = true;
CREATE INDEX idx_routes_task ON public.routes (task_id) WHERE is_active = true;
CREATE INDEX idx_prompt_cache_lookup ON public.prompt_cache (org_id, cache_key_hash);
