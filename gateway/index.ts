/**
 * @fileoverview StackSpine Unified AI Invoke API
 * 
 * Core API endpoint for routing AI model requests across multiple providers.
 * Implements intelligent routing (canary, primary, fallback), rate limiting,
 * budget enforcement, and comprehensive logging.
 * 
 * @module invoke
 * @version 1.0.0
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { timingSafeEqual } from "https://deno.land/std@0.168.0/crypto/timing_safe_equal.ts";
// OSS: import { triggerCallCompletedWebhook, triggerCallFailedWebhook } // Webhook triggers removed for OSS — implement your own notification logic

import type { InvokeRequest, RouteWithProfile, RouteContext } from "./_shared/types.ts";
import { getClientIp, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS_PER_KEY, RATE_LIMIT_MAX_REQUESTS_PER_IP } from "./_shared/rate-limit.ts";
import { selectRoute, getCircuitState, isCircuitOpen } from "./_shared/routing.ts";
import { callProvider } from "./_shared/providers.ts";
import { portContext } from "./_shared/context-porter.ts";
import { optimizeForCost, recordCostPrediction, type CostOptimizationResult } from "./_shared/cost-optimizer.ts";
import { scanForTopics, scanForCompetitors, scanForProfanity, redactGuardrailMatches, type GuardrailScanResult } from "./_shared/guardrails.ts";

// ============================================================================
// Utilities
// ============================================================================

async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-api-key, x-api-version, x-region",
  "X-API-Version": "1",
  
};

// ============================================================================
// Budget Alerts (fire-and-forget post-call)
// ============================================================================

async function checkBudgetAlerts(
  supabaseUrl: string,
  supabaseServiceKey: string,
  orgId: string,
  taskId: string | null,
  newCost: number
) {
  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data: rules } = await supabase
      .from("budget_rules")
      .select("*")
      .eq("org_id", orgId)
      .eq("is_active", true);

    if (!rules || rules.length === 0) return;

    const { data: spendRows, error: spendError } = await supabase
      .rpc("get_monthly_spend", { p_org_id: orgId });

    if (spendError) {
      console.error("Budget alert spend RPC failed:", spendError);
      return;
    }

    let orgSpend = newCost;
    const taskSpends: Record<string, number> = {};
    
    for (const row of (spendRows || [])) {
      if (row.task_id === null) {
        orgSpend += Number(row.org_spend) || 0;
      } else {
        taskSpends[row.task_id] = Number(row.task_spend) || 0;
      }
    }
    
    if (taskId) {
      taskSpends[taskId] = (taskSpends[taskId] || 0) + newCost;
    }

    for (const rule of rules) {
      const ruleData = rule as {
        id: string;
        scope_type: string;
        scope_id: string | null;
        monthly_budget_usd: number;
        alert_threshold_percent: number;
      };
      
      const spend = ruleData.scope_type === "org" 
        ? orgSpend 
        : (ruleData.scope_id ? taskSpends[ruleData.scope_id] || 0 : 0);
      
      const thresholdAmount = (ruleData.monthly_budget_usd * ruleData.alert_threshold_percent) / 100;
      
      if (spend >= thresholdAmount) {
        const alertUrl = `${supabaseUrl}/functions/v1/budget-alert`;
        fetch(alertUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            org_id: orgId,
            budget_rule_id: ruleData.id,
            current_spend: spend,
            budget_limit: ruleData.monthly_budget_usd,
            threshold_percent: ruleData.alert_threshold_percent,
            scope_type: ruleData.scope_type,
            scope_name: ruleData.scope_type === "org" ? "Organization" : `Task ${ruleData.scope_id}`,
            notification_type: "both",
          }),
        }).catch((e) => console.error("Budget alert trigger failed:", e));
      }
    }
  } catch (error) {
    console.error("Budget check error:", error);
  }
}

// ============================================================================
// PII / Compliance Helpers
// ============================================================================

const PII_REGEXES: Record<string, RegExp> = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone_us: /(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/g,
  ssn: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  credit_card: /\b(?:\d[-\s]?){13,19}\b/g,
  ip_address: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  date_of_birth: /\b(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/g,
};

const PII_LABELS: Record<string, string> = {
  email: 'Email Address',
  phone_us: 'US Phone Number',
  ssn: 'Social Security Number',
  credit_card: 'Credit Card Number',
  ip_address: 'IP Address',
  date_of_birth: 'Date of Birth',
};

function scanTextForPii(text: string, patternIds: string[]): Array<{ patternId: string; label: string; count: number }> {
  const results: Array<{ patternId: string; label: string; count: number }> = [];
  for (const pid of patternIds) {
    const regex = PII_REGEXES[pid];
    if (!regex) continue;
    const re = new RegExp(regex.source, regex.flags);
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      results.push({ patternId: pid, label: PII_LABELS[pid] || pid, count: matches.length });
    }
  }
  return results;
}

function redactText(text: string, patternIds: string[]): string {
  let result = text;
  for (const pid of patternIds) {
    const regex = PII_REGEXES[pid];
    if (!regex) continue;
    const re = new RegExp(regex.source, regex.flags);
    result = result.replace(re, '[REDACTED]');
  }
  return result;
}

// ============================================================================
// Region Detection
// ============================================================================

const COUNTRY_TO_REGION: Record<string, string> = {
  AT: 'EU', BE: 'EU', BG: 'EU', HR: 'EU', CY: 'EU', CZ: 'EU',
  DK: 'EU', EE: 'EU', FI: 'EU', FR: 'EU', DE: 'EU', GR: 'EU',
  HU: 'EU', IE: 'EU', IT: 'EU', LV: 'EU', LT: 'EU', LU: 'EU',
  MT: 'EU', NL: 'EU', PL: 'EU', PT: 'EU', RO: 'EU', SK: 'EU',
  SI: 'EU', ES: 'EU', SE: 'EU', GB: 'EU', CH: 'EU', NO: 'EU',
  US: 'US', CA: 'US', MX: 'US', BR: 'US', AR: 'US',
  JP: 'APAC', KR: 'APAC', AU: 'APAC', NZ: 'APAC', SG: 'APAC',
  IN: 'APAC', CN: 'APAC', TW: 'APAC', HK: 'APAC',
};

// ============================================================================
// Main Request Handler
// ============================================================================

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  let orgId: string | null = null;
  let taskId: string | null = null;
  let modelProfileId: string | null = null;
  let providerId: string | null = null;

  const traceId = crypto.randomUUID();
  const traceparentHeader = `00-${traceId.replace(/-/g, '')}-${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}-01`;

  // Region detection
  const explicitRegion = req.headers.get('x-region')?.toUpperCase() || null;
  const cfCountry = req.headers.get('cf-ipcountry')?.toUpperCase() || null;
  const detectedRegion = explicitRegion || (cfCountry ? COUNTRY_TO_REGION[cfCountry] || 'OTHER' : null);

  // Sunset header for unversioned calls
  const requestUrl = new URL(req.url);
  const isUnversioned = !requestUrl.pathname.includes('/v1/');
  const sunsetHeaders: Record<string, string> = isUnversioned
    ? { "Sunset": "Sat, 01 Jan 2027 00:00:00 GMT", "Deprecation": "true", "Link": '</v1/tasks>; rel="successor-version"' }
    : {};

  const responseHeaders: Record<string, string> = {
    ...corsHeaders,
    "X-API-Version": "1",
    "X-Trace-Id": traceId,
    "traceparent": traceparentHeader,
    ...(detectedRegion ? { "X-Resolved-Region": detectedRegion } : {}),
    ...sunsetHeaders,
  };

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ========================================================================
    // Step 1: API Key Authentication & Version Check
    // ========================================================================

    const apiVersion = req.headers.get("x-api-version") || "1";
    if (apiVersion !== "1") {
      console.warn(`Client requested unknown API version: ${apiVersion}, defaulting to v1 logic`);
    }

    const apiKey = req.headers.get("x-api-key");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing x-api-key header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========================================================================
    // Step 2: Parse Request Body
    // ========================================================================

    const keyPrefix = apiKey.substring(0, 8);
    const providedKeyHash = await hashApiKey(apiKey);
    const clientIp = getClientIp(req);

    const body: InvokeRequest = await req.json();
    const { messages, max_tokens, temperature, stream = false, idempotency_key, session_id, parent_trace_id } = body;
    let { task_key } = body;

    if (!task_key || !messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: "task_key and messages array are required" }),
        { status: 400, headers: { ...responseHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse routing suffix (:cost or :speed)
    let routingSuffix: "cost" | "speed" | null = null;
    if (task_key.endsWith(":cost")) {
      routingSuffix = "cost";
      task_key = task_key.slice(0, -5);
    } else if (task_key.endsWith(":speed")) {
      routingSuffix = "speed";
      task_key = task_key.slice(0, -6);
    }

    // ========================================================================
    // Step 3: Consolidated Pre-flight RPC (single DB round-trip)
    // ========================================================================

    // deno-lint-ignore no-explicit-any
    const { data: ctx, error: ctxError } = await supabase.rpc(
      'resolve_invoke_context',
      {
        p_key_prefix: keyPrefix,
        p_task_key: task_key,
        p_ip: clientIp,
        p_idempotency_key: idempotency_key || null,
      }
    // deno-lint-ignore no-explicit-any
    ) as { data: any; error: any };

    if (ctxError || !ctx) {
      console.error("resolve_invoke_context RPC failed:", ctxError);
      return new Response(
        JSON.stringify({ error: "Internal server error" }),
        { status: 500, headers: { ...responseHeaders, "Content-Type": "application/json" } }
      );
    }

    if (ctx.error === 'invalid_key') {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 401, headers: { ...responseHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate API key hash (timing-safe)
    const apiKeyData = ctx.api_key;
    if (!apiKeyData || !secureCompare(providedKeyHash, apiKeyData.key_hash)) {
      return new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 401, headers: { ...responseHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check scope restrictions
    if (ctx.scoped_task_ids && ctx.scoped_task_ids.length > 0) {
      const task = ctx.task;
      if (task && !ctx.scoped_task_ids.includes(task.id)) {
        return new Response(
          JSON.stringify({ error: "API key does not have access to this task" }),
          { status: 403, headers: { ...responseHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Check key expiry
    if (apiKeyData.expires_at && new Date(apiKeyData.expires_at).getTime() < Date.now()) {
      return new Response(
        JSON.stringify({ error: "API key expired" }),
        { status: 401, headers: { ...responseHeaders, "Content-Type": "application/json" } }
      );
    }

    orgId = apiKeyData.org_id;

    // ========================================================================
    // Step 3b: Rate Limit Checks
    // ========================================================================

    const maxRequestsPerKey = ctx.rate_limit_config?.max_per_key || RATE_LIMIT_MAX_REQUESTS_PER_KEY;
    const maxRequestsPerIp = ctx.rate_limit_config?.max_per_ip || RATE_LIMIT_MAX_REQUESTS_PER_IP;
    const now = Date.now();
    const resetAt = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS + RATE_LIMIT_WINDOW_MS;

    if (!ctx.rate_limit_ip?.allowed) {
      console.warn(`IP rate limit exceeded: ${clientIp}`);
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded (IP)", retry_after_ms: resetAt - now, limit: maxRequestsPerIp, window_ms: RATE_LIMIT_WINDOW_MS }),
        { status: 429, headers: { ...responseHeaders, "Content-Type": "application/json", "X-RateLimit-Limit": maxRequestsPerIp.toString(), "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": Math.ceil(resetAt / 1000).toString(), "Retry-After": Math.ceil((resetAt - now) / 1000).toString() } }
      );
    }

    if (!ctx.rate_limit_key?.allowed) {
      console.warn(`API key rate limit exceeded: ${keyPrefix}`);
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded (API key)", retry_after_ms: resetAt - now, limit: maxRequestsPerKey, window_ms: RATE_LIMIT_WINDOW_MS }),
        { status: 429, headers: { ...responseHeaders, "Content-Type": "application/json", "X-RateLimit-Limit": maxRequestsPerKey.toString(), "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": Math.ceil(resetAt / 1000).toString(), "Retry-After": Math.ceil((resetAt - now) / 1000).toString() } }
      );
    }

    // ========================================================================
    // Step 3c: Idempotency Check
    // ========================================================================

    if (idempotency_key && ctx.idempotent_replay?.cached_response) {
      console.log(`Idempotent replay for key: ${idempotency_key}`);
      return new Response(
        JSON.stringify(ctx.idempotent_replay.cached_response),
        { status: 200, headers: { ...responseHeaders, "Content-Type": "application/json", "X-Idempotent-Replay": "true" } }
      );
    }

    // ========================================================================
    // Step 4: Task Validation
    // ========================================================================

    const task = ctx.task;
    if (!task) {
      return new Response(
        JSON.stringify({ error: `Task not found: ${task_key}` }),
        { status: 404, headers: { ...responseHeaders, "Content-Type": "application/json" } }
      );
    }
    taskId = task.id;
    const promptVersionId: string | null = ctx.prompt_version_id || null;

    // ========================================================================
    // Step 5: Budget Enforcement
    // ========================================================================

    const budgetRules = ctx.budget_rules || [];
    const orgSpend = Number(ctx.monthly_spend) || 0;
    const taskSpends: Record<string, number> = ctx.task_spends || {};

    for (const rule of budgetRules) {
      const spend = rule.scope_type === "org" 
        ? orgSpend 
        : (rule.scope_id ? Number(taskSpends[rule.scope_id]) || 0 : 0);
      
      if (spend >= rule.monthly_budget_usd) {
        const blockedBy = rule.scope_type === "org" ? "Organization budget" : "Task budget";
        console.warn(`Budget exceeded for org ${orgId}: $${spend.toFixed(4)} / $${rule.monthly_budget_usd.toFixed(2)}`);
        
        await supabase.from("call_logs").insert({
          org_id: orgId, task_id: taskId, status: "error",
          error_message: `Budget limit exceeded: $${spend.toFixed(4)} / $${rule.monthly_budget_usd.toFixed(2)}`,
          latency_ms: Date.now() - startTime, input_tokens: 0, output_tokens: 0, cost_usd: 0,
          metadata: { blocked_by: blockedBy, budget_blocked: true },
          trace_id: traceId, session_id: session_id || null, parent_trace_id: parent_trace_id || null,
        });
        
        return new Response(
          JSON.stringify({ error: "Budget limit exceeded", code: "BUDGET_EXCEEDED", details: { blocked_by: blockedBy, current_spend_usd: spend, monthly_limit_usd: rule.monthly_budget_usd, message: `Monthly spending ($${spend.toFixed(4)}) has reached the budget limit ($${rule.monthly_budget_usd.toFixed(2)}).` } }),
          { status: 402, headers: { ...responseHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // ========================================================================
    // Step 5a: Usage Enforcement
    // ========================================================================

    const PLAN_CALL_LIMITS: Record<string, number> = { free: 1_000, pro: 100_000 };
    const orgData = ctx.org;
    const orgPlan = orgData?.plan || "free";
    const usageLimit = PLAN_CALL_LIMITS[orgPlan];
    const usageHeaders: Record<string, string> = {};

    const keyRemaining = ctx.rate_limit_key?.remaining ?? maxRequestsPerKey;
    const ipRemaining = ctx.rate_limit_ip?.remaining ?? maxRequestsPerIp;
    const effectiveRemaining = Math.min(keyRemaining, ipRemaining);
    const effectiveLimit = Math.min(maxRequestsPerKey, maxRequestsPerIp);
    usageHeaders["X-RateLimit-Limit"] = effectiveLimit.toString();
    usageHeaders["X-RateLimit-Remaining"] = Math.max(0, effectiveRemaining).toString();
    usageHeaders["X-RateLimit-Reset"] = Math.ceil(resetAt / 1000).toString();

    if (orgPlan !== "enterprise" && usageLimit) {
      const usage = Number(ctx.monthly_usage) || 0;
      const usagePercent = usage / usageLimit;

      usageHeaders["X-Usage-Percent"] = (usagePercent * 100).toFixed(1);
      usageHeaders["X-Usage-Limit"] = usageLimit.toString();
      usageHeaders["X-Usage-Current"] = usage.toString();

      if (usagePercent >= 0.95) usageHeaders["X-Usage-Warning"] = "critical";
      else if (usagePercent >= 0.80) usageHeaders["X-Usage-Warning"] = "approaching_limit";

      if (usagePercent >= 1.0) {
        const enforcementStart = orgData?.usage_enforcement_start;
        const gracePeriodOver = enforcementStart &&
          (Date.now() - new Date(enforcementStart).getTime()) > 30 * 24 * 60 * 60 * 1000;

        if (gracePeriodOver) {
          await supabase.from("call_logs").insert({
            org_id: orgId, task_id: taskId, status: "error",
            error_message: `Usage limit exceeded: ${usage}/${usageLimit} calls`,
            latency_ms: Date.now() - startTime, input_tokens: 0, output_tokens: 0, cost_usd: 0,
            metadata: { usage_blocked: true, plan: orgPlan },
            trace_id: traceId, session_id: session_id || null, parent_trace_id: parent_trace_id || null,
          });
          return new Response(
            JSON.stringify({ error: "Usage limit exceeded", code: "USAGE_LIMIT_EXCEEDED", details: { current_usage: usage, monthly_limit: usageLimit, plan: orgPlan, message: `You have used ${usage.toLocaleString()} of ${usageLimit.toLocaleString()} monthly API calls. Upgrade your plan to continue.` } }),
            { status: 402, headers: { ...responseHeaders, ...usageHeaders, "Content-Type": "application/json" } }
          );
        } else {
          usageHeaders["X-Usage-Warning"] = "exceeded_grace";
        }
      }
    }

    // ========================================================================
    // Step 5c: Session Budget & Iteration Enforcement
    // ========================================================================

    const sessionHeaders: Record<string, string> = {};

    if (session_id && taskId) {
      // Fetch session limits for this task
      const { data: sessionLimit } = await supabase
        .from("session_limits")
        .select("max_session_cost_usd, max_session_iterations, is_active")
        .eq("task_id", taskId)
        .eq("is_active", true)
        .maybeSingle();

      if (sessionLimit) {
        // Get current session usage
        const { data: sessionUsage } = await supabase.rpc("get_session_usage", {
          p_org_id: orgId,
          p_session_id: session_id,
        });

        const sessionCost = Number(sessionUsage?.total_cost) || 0;
        const sessionCalls = Number(sessionUsage?.total_calls) || 0;

        sessionHeaders["X-Session-Iterations"] = sessionCalls.toString();
        sessionHeaders["X-Session-Cost"] = sessionCost.toFixed(6);

        // Check iteration limit
        if (sessionLimit.max_session_iterations && sessionCalls >= sessionLimit.max_session_iterations) {
          await supabase.from("call_logs").insert({
            org_id: orgId, task_id: taskId, status: "error",
            error_message: `Session iteration limit exceeded: ${sessionCalls}/${sessionLimit.max_session_iterations}`,
            latency_ms: Date.now() - startTime, input_tokens: 0, output_tokens: 0, cost_usd: 0,
            metadata: { session_blocked: true, session_id, block_reason: "iteration_limit" },
            trace_id: traceId, session_id, parent_trace_id: parent_trace_id || null,
          });
          return new Response(
            JSON.stringify({
              error: "Session iteration limit exceeded",
              code: "SESSION_ITERATION_LIMIT",
              details: {
                session_id,
                current_iterations: sessionCalls,
                max_iterations: sessionLimit.max_session_iterations,
                message: `Session has used ${sessionCalls} of ${sessionLimit.max_session_iterations} allowed iterations.`,
              },
            }),
            { status: 429, headers: { ...responseHeaders, ...usageHeaders, ...sessionHeaders, "Content-Type": "application/json" } }
          );
        }

        // Check session budget cap
        if (sessionLimit.max_session_cost_usd && sessionCost >= Number(sessionLimit.max_session_cost_usd)) {
          await supabase.from("call_logs").insert({
            org_id: orgId, task_id: taskId, status: "error",
            error_message: `Session budget exceeded: $${sessionCost.toFixed(4)}/$${Number(sessionLimit.max_session_cost_usd).toFixed(2)}`,
            latency_ms: Date.now() - startTime, input_tokens: 0, output_tokens: 0, cost_usd: 0,
            metadata: { session_blocked: true, session_id, block_reason: "budget_cap" },
            trace_id: traceId, session_id, parent_trace_id: parent_trace_id || null,
          });
          return new Response(
            JSON.stringify({
              error: "Session budget exceeded",
              code: "SESSION_BUDGET_EXCEEDED",
              details: {
                session_id,
                current_cost_usd: sessionCost,
                max_cost_usd: Number(sessionLimit.max_session_cost_usd),
                message: `Session spending ($${sessionCost.toFixed(4)}) has reached the session budget cap ($${Number(sessionLimit.max_session_cost_usd).toFixed(2)}).`,
              },
            }),
            { status: 402, headers: { ...responseHeaders, ...usageHeaders, ...sessionHeaders, "Content-Type": "application/json" } }
          );
        }
      }
    }

    // ========================================================================
    // Step 5d: Compliance Pre-scan
    // ========================================================================

    const complianceRules = ctx.compliance_rules || [];
    let complianceModifiedMessages = messages;

    if (complianceRules.length > 0) {
      const inputText = messages.map((m: { content: string }) => m.content).join(' ');

      for (const rule of complianceRules) {
        const config = rule.config as Record<string, unknown> | null;

        // --- PII Detection ---
        if (rule.rule_type === 'pii_detection') {
          const patterns = (config?.patterns as string[]) || Object.keys(PII_REGEXES);
          const detections = scanTextForPii(inputText, patterns);

          if (detections.length > 0) {
            const eventType = rule.action === 'block' ? 'pii_blocked' : rule.action === 'redact' ? 'pii_redacted' : 'pii_detected';
            supabase.from("compliance_events").insert({ org_id: orgId, rule_id: rule.id, event_type: eventType, details: { scan_phase: 'pre', action: rule.action, matches: detections } }).then(() => {});

            if (rule.action === 'block') {
              await supabase.from("call_logs").insert({
                org_id: orgId, task_id: taskId, status: "error",
                error_message: `Compliance violation: PII detected (${detections.map(d => d.label).join(', ')})`,
                latency_ms: Date.now() - startTime, input_tokens: 0, output_tokens: 0, cost_usd: 0,
                metadata: { compliance_blocked: true, detections },
                trace_id: traceId, session_id: session_id || null, parent_trace_id: parent_trace_id || null,
              });
              return new Response(
                JSON.stringify({ error: "Compliance violation", code: "COMPLIANCE_VIOLATION", details: { message: "Request blocked: PII detected in input", detections: detections.map(d => ({ type: d.label, count: d.count })) } }),
                { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }

            if (rule.action === 'redact') {
              complianceModifiedMessages = messages.map((m: { role: string; content: string }) => ({ ...m, content: redactText(m.content, patterns) }));
            }
          }
          continue;
        }

        // --- Content Guardrails (topic_blocking, competitor_mention, profanity_filter) ---
        let scanResult: GuardrailScanResult | null = null;
        let violationLabel = '';

        if (rule.rule_type === 'topic_blocking') {
          const blockedTopics = (config?.blocked_topics as string[]) || [];
          if (blockedTopics.length > 0) {
            scanResult = scanForTopics(inputText, blockedTopics);
            violationLabel = 'Blocked topic detected';
          }
        } else if (rule.rule_type === 'competitor_mention') {
          const competitorNames = (config?.competitor_names as string[]) || [];
          if (competitorNames.length > 0) {
            scanResult = scanForCompetitors(inputText, competitorNames);
            violationLabel = 'Competitor mention detected';
          }
        } else if (rule.rule_type === 'profanity_filter') {
          const useBuiltin = config?.use_builtin !== false;
          const customWords = (config?.custom_words as string[]) || [];
          if (useBuiltin || customWords.length > 0) {
            scanResult = scanForProfanity(inputText, customWords);
            violationLabel = 'Profanity detected';
          }
        }

        if (scanResult && scanResult.matched) {
          const eventType = rule.action === 'block' ? `${rule.rule_type}_blocked` : rule.action === 'redact' ? `${rule.rule_type}_redacted` : scanResult.eventType;
          supabase.from("compliance_events").insert({ org_id: orgId, rule_id: rule.id, event_type: eventType, details: { scan_phase: 'pre', action: rule.action, matches: scanResult.matches.map(m => ({ label: m.keyword, count: m.count })) } }).then(() => {});

          if (rule.action === 'block') {
            await supabase.from("call_logs").insert({
              org_id: orgId, task_id: taskId, status: "error",
              error_message: `Compliance violation: ${violationLabel} (${scanResult.matches.map(m => m.keyword).join(', ')})`,
              latency_ms: Date.now() - startTime, input_tokens: 0, output_tokens: 0, cost_usd: 0,
              metadata: { compliance_blocked: true, rule_type: rule.rule_type, matches: scanResult.matches },
              trace_id: traceId, session_id: session_id || null, parent_trace_id: parent_trace_id || null,
            });
            return new Response(
              JSON.stringify({ error: "Compliance violation", code: "COMPLIANCE_VIOLATION", details: { message: `Request blocked: ${violationLabel}`, rule_type: rule.rule_type, matches: scanResult.matches.map(m => ({ keyword: m.keyword, count: m.count })) } }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

          if (rule.action === 'redact') {
            complianceModifiedMessages = complianceModifiedMessages.map((m: { role: string; content: string }) => ({ ...m, content: redactGuardrailMatches(m.content, scanResult!.matches) }));
          }
        }
      }
    }

    // ========================================================================
    // Step 5c: Prompt Cache Check
    // ========================================================================

    let cacheHit = false;
    const cacheEnabled = orgData?.prompt_cache_enabled === true && !stream;
    let cacheKeyHash = "";

    if (cacheEnabled) {
      const cachePayload = JSON.stringify({ task_key, messages: complianceModifiedMessages });
      const cacheEncoder = new TextEncoder();
      const cacheHashBuffer = await crypto.subtle.digest("SHA-256", cacheEncoder.encode(cachePayload));
      cacheKeyHash = Array.from(new Uint8Array(cacheHashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

      const { data: cached } = await supabase
        .from("prompt_cache")
        .select("response_content, usage_metadata, cost_usd")
        .eq("org_id", orgId)
        .eq("cache_key_hash", cacheKeyHash)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

      if (cached) {
        cacheHit = true;
        await supabase.from("call_logs").insert({
          org_id: orgId, task_id: taskId, status: "success", latency_ms: Date.now() - startTime,
          input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0,
          metadata: { cache_hit: true, original_cost_usd: cached.cost_usd },
          trace_id: traceId, session_id: session_id || null, parent_trace_id: parent_trace_id || null,
        });
        return new Response(
          JSON.stringify({ trace_id: traceId, content: cached.response_content, ...cached.usage_metadata, cost_usd: 0, latency_ms: Date.now() - startTime, cache: "HIT" }),
          { status: 200, headers: { ...responseHeaders, ...usageHeaders, ...sessionHeaders, "Content-Type": "application/json", "X-Cache": "HIT" } }
        );
      }
    }

    // ========================================================================
    // Step 6: Route Selection
    // ========================================================================

    const { data: routes, error: routeError } = await supabase
      .from("routes")
      .select("*, model_profiles(*, providers_with_key(*)), route_conditions(*), route_data_policies(data_policy_id, data_policies(id, name, allowed_regions, requires_encryption))")
      .eq("task_id", task.id)
      .eq("is_active", true)
      .order("strategy", { ascending: true })
      .order("weight", { ascending: false });

    if (routeError || !routes || routes.length === 0) {
      return new Response(
        JSON.stringify({ error: "No active route configured for this task" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let sortedRoutes = routes.sort((a, b) => {
      if (a.strategy === "primary" && b.strategy !== "primary") return -1;
      if (a.strategy !== "primary" && b.strategy === "primary") return 1;
      return (b.weight || 0) - (a.weight || 0);
    }) as RouteWithProfile[];

    // Apply routing suffix preference
    if (routingSuffix === "cost") {
      sortedRoutes = sortedRoutes.sort((a, b) => {
        const costA = (a.model_profiles?.cost_per_input_token || 0) + (a.model_profiles?.cost_per_output_token || 0);
        const costB = (b.model_profiles?.cost_per_input_token || 0) + (b.model_profiles?.cost_per_output_token || 0);
        return costA - costB;
      });
    } else if (routingSuffix === "speed") {
      // Prefer routes with lower default_max_tokens (smaller/faster models) and higher weight
      sortedRoutes = sortedRoutes.sort((a, b) => {
        const tokensA = a.model_profiles?.default_max_tokens || 4096;
        const tokensB = b.model_profiles?.default_max_tokens || 4096;
        return tokensA - tokensB;
      });
    }

    const effectiveMessages = complianceModifiedMessages;

    // ========================================================================
    // Step 6b: Experiment-aware routing
    // ========================================================================

    let experimentId: string | null = null;
    let experimentVariantId: string | null = null;
    let experimentPromptOverride: string | null = null;

    // Check for running experiments on this task
    const { data: runningExperiments } = await supabase
      .from("experiments")
      .select("id")
      .eq("task_id", task.id)
      .eq("status", "running")
      .limit(1);

    if (runningExperiments && runningExperiments.length > 0) {
      const expId = runningExperiments[0].id;
      const { data: expVariants } = await supabase
        .from("experiment_variants")
        .select("id, name, is_control, route_id, system_prompt_override, traffic_percent")
        .eq("experiment_id", expId)
        .order("is_control", { ascending: false });

      if (expVariants && expVariants.length >= 2) {
        experimentId = expId;
        // Weighted random selection
        const roll = Math.random() * 100;
        let cumulative = 0;
        let chosen = expVariants[0];
        for (const v of expVariants) {
          cumulative += v.traffic_percent;
          if (roll < cumulative) { chosen = v; break; }
        }
        experimentVariantId = chosen.id;

        // Override route if variant specifies one
        if (chosen.route_id) {
          const variantRoute = sortedRoutes.find(r => r.id === chosen.route_id);
          if (variantRoute) {
            // Move this route to the front of primary consideration
            const idx = sortedRoutes.indexOf(variantRoute);
            if (idx > 0) {
              sortedRoutes.splice(idx, 1);
              sortedRoutes.unshift(variantRoute);
            }
          }
        }

        // Override system prompt if variant specifies one
        if (chosen.system_prompt_override) {
          experimentPromptOverride = chosen.system_prompt_override;
        }
      }
    }

    const activeSystemPrompt = experimentPromptOverride || task.system_prompt;
    const fullMessages = activeSystemPrompt
      ? [{ role: "system", content: activeSystemPrompt }, ...effectiveMessages]
      : effectiveMessages;

    const routeContext: RouteContext = {
      metadata: body.metadata || {},
      message_count: messages.length,
      estimated_tokens: messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0),
      time_utc_hour: new Date().getUTCHours(),
      task_key,
      region: detectedRegion,
      data_policy: (body.metadata?.data_policy as string) || null,
    };

    // ========================================================================
    // Step 7: Provider Call with Fallback
    // ========================================================================

    let result: { ok: boolean; status: number; data?: unknown; errorText?: string; response?: Response } | null = null;
    let usedRoute: RouteWithProfile | null = null;
    let wasCanary = false;
    let lastError = "";
    let circuitBreakerSkipped: string[] = [];
    let contextCompressed = false;
    let contextOriginalTokens = 0;
    let contextCompressedTokens = 0;
    let costOptResult: CostOptimizationResult | null = null;

    try {
      const selection = selectRoute(sortedRoutes, routeContext);
      let selectedRoute = selection.selectedRoute;
      circuitBreakerSkipped = selection.circuitBreakerSkipped;

      // Cost optimization: auto-select cheapest qualifying model if confidence is high
      const autoOptimize = task.auto_optimize_routing ?? false;
      if (autoOptimize && !experimentId && routingSuffix !== "speed") {
        try {
          costOptResult = await optimizeForCost(
            selectedRoute, sortedRoutes, routeContext.estimated_tokens,
            taskId, orgId, supabase
          );
          if (costOptResult.wasOptimized) {
            selectedRoute = costOptResult.optimizedRoute;
            console.log(`Cost optimization: switched from ${costOptResult.originalModelProfileId} to ${selectedRoute.model_profile_id}`);
          }
        } catch (e) {
          console.error("Cost optimization failed, using original route:", e);
        }
      }

      const modelProfile = selectedRoute.model_profiles;
      const provider = modelProfile?.providers_with_key;

      if (modelProfile && provider) {
        modelProfileId = modelProfile.id;
        providerId = provider.id;

        // Context portability: compress/adapt messages for target model
        const ported = await portContext(fullMessages, modelProfile, session_id || null, orgId, supabase, lovableApiKey);
        contextCompressed = ported.compressed;
        contextOriginalTokens = ported.originalTokens;
        contextCompressedTokens = ported.compressedTokens;

        result = await callProvider(provider, modelProfile, ported.messages, task.system_prompt, max_tokens || null, temperature ?? null, stream, lovableApiKey);

        if (result.ok) {
          usedRoute = selectedRoute;
          wasCanary = selection.isCanary;

          // Reset circuit breaker on half-open success
          const cbState = getCircuitState(provider);
          if (cbState === "half-open") {
            supabase.from("providers").update({ consecutive_failures: 0, circuit_opened_at: null }).eq("id", provider.id).then(() => {});
          }
        } else {
          lastError = result.errorText || "Unknown error";
          const newFailures = (provider.consecutive_failures || 0) + 1;
          const threshold = provider.circuit_breaker_threshold ?? 3;
          const updateData: Record<string, unknown> = { consecutive_failures: newFailures };
          if (newFailures >= threshold) updateData.circuit_opened_at = new Date().toISOString();
          supabase.from("providers").update(updateData).eq("id", provider.id).then(() => {});
          
          await supabase.from("call_logs").insert({
            org_id: orgId, task_id: taskId, model_profile_id: modelProfile.id, provider_id: provider.id,
            status: result.status === 429 ? "rate_limited" : "error",
            error_message: lastError.substring(0, 1000), latency_ms: Date.now() - startTime,
            input_tokens: 0, output_tokens: 0, cost_usd: 0,
            metadata: { route_strategy: selectedRoute.strategy, was_canary: selection.isCanary },
            trace_id: traceId, session_id: session_id || null, parent_trace_id: parent_trace_id || null,
          });
        }
      }
    } catch (e) {
      console.log("No valid initial route found, trying fallbacks");
    }

    // Fallback routes
    if (!result?.ok) {
      const fallbackRoutes = sortedRoutes
        .filter(r => r.strategy === "fallback" && r.model_profiles?.providers_with_key?.is_active && !isCircuitOpen(r.model_profiles.providers_with_key))
        .sort((a, b) => (b.weight || 0) - (a.weight || 0));

      for (const route of fallbackRoutes) {
        const modelProfile = route.model_profiles;
        const provider = modelProfile?.providers_with_key;
        if (!modelProfile || !provider || !provider.is_active) continue;

        // Context portability: re-port messages for fallback model's context window
        const fbPorted = await portContext(fullMessages, modelProfile, session_id || null, orgId, supabase, lovableApiKey);
        contextCompressed = fbPorted.compressed;
        contextOriginalTokens = fbPorted.originalTokens;
        contextCompressedTokens = fbPorted.compressedTokens;

        result = await callProvider(provider, modelProfile, fbPorted.messages, task.system_prompt, max_tokens || null, temperature ?? null, stream, lovableApiKey);

        if (result.ok) {
          usedRoute = route;
          wasCanary = false;
          modelProfileId = modelProfile.id;
          providerId = provider.id;

          const fbCbState = getCircuitState(provider);
          if (fbCbState === "half-open") {
            supabase.from("providers").update({ consecutive_failures: 0, circuit_opened_at: null }).eq("id", provider.id).then(() => {});
          }
          break;
        } else {
          lastError = result.errorText || "Unknown error";
          const fbNewFailures = (provider.consecutive_failures || 0) + 1;
          const fbThreshold = provider.circuit_breaker_threshold ?? 3;
          const fbUpdateData: Record<string, unknown> = { consecutive_failures: fbNewFailures };
          if (fbNewFailures >= fbThreshold) fbUpdateData.circuit_opened_at = new Date().toISOString();
          supabase.from("providers").update(fbUpdateData).eq("id", provider.id).then(() => {});

          await supabase.from("call_logs").insert({
            org_id: orgId, task_id: taskId, model_profile_id: modelProfile.id, provider_id: provider.id,
            status: result.status === 429 ? "rate_limited" : "error",
            error_message: lastError.substring(0, 1000), latency_ms: Date.now() - startTime,
            input_tokens: 0, output_tokens: 0, cost_usd: 0,
            metadata: { route_strategy: route.strategy, was_canary: false },
            trace_id: traceId, session_id: session_id || null, parent_trace_id: parent_trace_id || null,
          });
        }
      }
    }

    // All routes failed
    if (!result?.ok || !usedRoute) {
      if (orgId) {
// OSS:         triggerCallFailedWebhook(supabaseUrl, supabaseServiceKey, orgId, {
          task_key, task_id: taskId, error: lastError, latency_ms: Date.now() - startTime, routes_attempted: sortedRoutes.length,
        });
      }
      return new Response(
        JSON.stringify({ error: "All routes failed", details: lastError }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ========================================================================
    // Step 8: Response Processing & Logging
    // ========================================================================

    const latencyMs = Date.now() - startTime;
    const modelProfile = usedRoute.model_profiles;
    const provider = modelProfile.providers_with_key;

    // Handle streaming responses
    if (stream && result.response) {
      const decoder = new TextDecoder();
      let inputTokens = 0;
      let outputTokens = 0;

      const transformStream = new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          const text = decoder.decode(chunk, { stream: true });
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.usage) { inputTokens = data.usage.prompt_tokens || inputTokens; outputTokens = data.usage.completion_tokens || outputTokens; }
                if (data.type === 'message_start' && data.message?.usage) inputTokens = data.message.usage.input_tokens || 0;
                if (data.type === 'message_delta' && data.usage) outputTokens = data.usage.output_tokens || 0;
              } catch { /* ignore */ }
            }
          }
        },
        async flush() {
          const totalTokens = inputTokens + outputTokens;
          const inputCost = inputTokens * (modelProfile.cost_per_input_token || 0);
          const outputCost = outputTokens * (modelProfile.cost_per_output_token || 0);
          const totalCost = inputCost + outputCost;
          const finalLatency = Date.now() - startTime;

          await supabase.from("call_logs").insert({
            org_id: orgId, task_id: taskId, model_profile_id: modelProfileId, provider_id: providerId,
            status: "success", latency_ms: finalLatency, input_tokens: inputTokens, output_tokens: outputTokens,
            total_tokens: totalTokens, cost_usd: totalCost, request_idempotency_key: idempotency_key || null,
            metadata: { streaming: true, route_strategy: usedRoute!.strategy, was_canary: wasCanary, prompt_version_id: promptVersionId, region: detectedRegion, context_compressed: contextCompressed, original_tokens: contextOriginalTokens, compressed_tokens: contextCompressedTokens, ...(costOptResult?.wasOptimized ? { cost_optimized: true, original_model_profile_id: costOptResult.originalModelProfileId, predicted_cost: costOptResult.predictedCostUsd, confidence: costOptResult.confidence } : {}) },
            trace_id: traceId, session_id: session_id || null, parent_trace_id: parent_trace_id || null,
          });

          if (orgId && totalCost > 0) checkBudgetAlerts(supabaseUrl, supabaseServiceKey, orgId, taskId, totalCost);
        }
      });

      const wrappedStream = result.response.body!.pipeThrough(transformStream);
      if (circuitBreakerSkipped.length > 0) usageHeaders["X-Circuit-Breaker-Skipped"] = circuitBreakerSkipped.join(", ");
      usageHeaders["X-Circuit-Breaker-State"] = getCircuitState(provider);

      return new Response(wrappedStream, { headers: { ...corsHeaders, ...usageHeaders, ...sessionHeaders, "Content-Type": "text/event-stream" } });
    }

    // Parse non-streaming response
    const data = result.data as Record<string, unknown>;
    let inputTokens = 0;
    let outputTokens = 0;

    if (provider.type === "anthropic") {
      const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      inputTokens = usage?.input_tokens || 0;
      outputTokens = usage?.output_tokens || 0;
    } else {
      const usage = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      inputTokens = usage?.prompt_tokens || 0;
      outputTokens = usage?.completion_tokens || 0;
    }

    const totalTokens = inputTokens + outputTokens;
    const inputCost = inputTokens * (modelProfile.cost_per_input_token || 0);
    const outputCost = outputTokens * (modelProfile.cost_per_output_token || 0);
    const totalCost = inputCost + outputCost;

    let content: string;
    if (provider.type === "anthropic") {
      const contentArr = data.content as Array<{ text?: string }> | undefined;
      content = contentArr?.[0]?.text || "";
    } else {
      const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
      content = choices?.[0]?.message?.content || "";
    }

    // Post-call compliance scan
    if (complianceRules.length > 0 && content) {
      for (const rule of complianceRules) {
        const config = rule.config as Record<string, unknown> | null;

        // PII post-scan
        if (rule.rule_type === 'pii_detection') {
          const patterns = (config?.patterns as string[]) || Object.keys(PII_REGEXES);
          const detections = scanTextForPii(content, patterns);
          if (detections.length > 0) {
            supabase.from("compliance_events").insert({ org_id: orgId, rule_id: rule.id, event_type: rule.action === 'redact' ? 'pii_redacted' : 'pii_detected', details: { scan_phase: 'post', action: rule.action, matches: detections } }).then(() => {});
            if (rule.action === 'redact') content = redactText(content, patterns);
          }
          continue;
        }

        // Guardrail post-scan
        let postScanResult: GuardrailScanResult | null = null;
        if (rule.rule_type === 'topic_blocking') {
          const blockedTopics = (config?.blocked_topics as string[]) || [];
          if (blockedTopics.length > 0) postScanResult = scanForTopics(content, blockedTopics);
        } else if (rule.rule_type === 'competitor_mention') {
          const competitorNames = (config?.competitor_names as string[]) || [];
          if (competitorNames.length > 0) postScanResult = scanForCompetitors(content, competitorNames);
        } else if (rule.rule_type === 'profanity_filter') {
          const customWords = (config?.custom_words as string[]) || [];
          postScanResult = scanForProfanity(content, customWords);
        }

        if (postScanResult && postScanResult.matched) {
          const eventType = rule.action === 'redact' ? `${rule.rule_type}_redacted` : postScanResult.eventType;
          supabase.from("compliance_events").insert({ org_id: orgId, rule_id: rule.id, event_type: eventType, details: { scan_phase: 'post', action: rule.action, matches: postScanResult.matches.map(m => ({ label: m.keyword, count: m.count })) } }).then(() => {});
          if (rule.action === 'redact') content = redactGuardrailMatches(content, postScanResult.matches);
        }
      }
    }

    // Log successful call
    const { data: callLog } = await supabase.from("call_logs").insert({
      org_id: orgId, task_id: taskId, model_profile_id: modelProfileId, provider_id: providerId,
      status: "success", latency_ms: latencyMs, input_tokens: inputTokens, output_tokens: outputTokens,
      total_tokens: totalTokens, cost_usd: totalCost, request_idempotency_key: idempotency_key || null,
      trace_id: traceId, session_id: session_id || null, parent_trace_id: parent_trace_id || null,
      metadata: {
        route_strategy: usedRoute.strategy, was_canary: wasCanary, prompt_version_id: promptVersionId, region: detectedRegion,
        context_compressed: contextCompressed, original_tokens: contextOriginalTokens, compressed_tokens: contextCompressedTokens,
        experiment_id: experimentId, experiment_variant_id: experimentVariantId,
        ...(costOptResult?.wasOptimized ? { cost_optimized: true, original_model_profile_id: costOptResult.originalModelProfileId, predicted_cost: costOptResult.predictedCostUsd, confidence: costOptResult.confidence } : {}),
        ...(idempotency_key ? { cached_response: { trace_id: traceId, content, model: modelProfile.provider_model_name, provider: provider.type, route_strategy: usedRoute.strategy, was_canary: wasCanary, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens }, cost_usd: totalCost, latency_ms: latencyMs } } : {})
      },
    }).select("id").single();

    // Record experiment assignment
    if (experimentId && experimentVariantId && callLog?.id) {
      supabase.from("experiment_assignments").insert({
        experiment_id: experimentId,
        variant_id: experimentVariantId,
        call_log_id: callLog.id,
        org_id: orgId,
        session_id: session_id || null,
      }).then(() => {}).catch((e: Error) => console.error("Experiment assignment failed:", e));
    }

    // Record cost prediction for feedback loop
    if (costOptResult && costOptResult.predictedCostUsd > 0) {
      recordCostPrediction(supabase, orgId, taskId, callLog?.id || null, costOptResult, totalCost)
        .catch((e: Error) => console.error("Cost prediction recording failed:", e));
    }

    if (cacheEnabled && !cacheHit && cacheKeyHash && content) {
      const cacheTtlMinutes = orgData?.prompt_cache_ttl_minutes || 60;
      const expiresAt = new Date(Date.now() + cacheTtlMinutes * 60 * 1000).toISOString();
      supabase.from("prompt_cache").upsert({
        org_id: orgId, cache_key_hash: cacheKeyHash, response_content: content,
        usage_metadata: { model: modelProfile.provider_model_name, provider: provider.type, route_strategy: usedRoute.strategy, was_canary: wasCanary, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens } },
        cost_usd: totalCost, expires_at: expiresAt,
      }, { onConflict: "org_id,cache_key_hash" }).then(() => {}).catch((e: Error) => console.error("Cache write failed:", e));
    }

    // ========================================================================
    // Step 9: Webhooks & Budget Alerts
    // ========================================================================

    if (orgId && callLog?.id) {
// OSS:       triggerCallCompletedWebhook(supabaseUrl, supabaseServiceKey, orgId, {
        call_id: callLog.id, task_key, task_id: taskId, model: modelProfile.provider_model_name,
        provider: provider.type, provider_name: provider.name, route_strategy: usedRoute.strategy,
        was_canary: wasCanary, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
        cost_usd: totalCost, latency_ms: latencyMs,
      });
    }

    if (orgId) checkBudgetAlerts(supabaseUrl, supabaseServiceKey, orgId, taskId, totalCost);

    if (orgId && callLog?.id && taskId) {
      fetch(`${supabaseUrl}/functions/v1/eval-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseServiceKey}` },
        body: JSON.stringify({ call_log_id: callLog.id, org_id: orgId, task_id: taskId, response_content: content }),
      }).catch((e) => console.error("Eval trigger failed:", e));
    }

    // ========================================================================
    // Step 10: Return Response
    // ========================================================================

    if (circuitBreakerSkipped.length > 0) usageHeaders["X-Circuit-Breaker-Skipped"] = circuitBreakerSkipped.join(", ");
    usageHeaders["X-Circuit-Breaker-State"] = getCircuitState(provider);
    if (cacheEnabled) usageHeaders["X-Cache"] = "MISS";
    if (routingSuffix) usageHeaders["X-Routing-Suffix"] = routingSuffix;
    usageHeaders["X-Completion-Insurance"] = "active";

    return new Response(
      JSON.stringify({
        trace_id: traceId, content, model: modelProfile.provider_model_name, provider: provider.type,
        route_strategy: usedRoute.strategy, was_canary: wasCanary,
        ...(routingSuffix ? { routing_suffix: routingSuffix } : {}),
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
        cost_usd: totalCost, latency_ms: latencyMs,
        ...(contextCompressed ? { context_compressed: true, original_tokens: contextOriginalTokens, compressed_tokens: contextCompressedTokens } : {}),
        ...(costOptResult?.wasOptimized ? { cost_optimized: true, predicted_cost: costOptResult.predictedCostUsd, optimization_confidence: costOptResult.confidence } : {}),
        completion_insurance: true,
      }),
      { status: 200, headers: { ...responseHeaders, ...usageHeaders, ...sessionHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Invoke error:", errorMessage);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (supabaseUrl && supabaseServiceKey && orgId) {
      try {
        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        await supabase.from("call_logs").insert({
          org_id: orgId, task_id: taskId, model_profile_id: modelProfileId, provider_id: providerId,
          status: "error", error_message: errorMessage.substring(0, 1000), latency_ms: Date.now() - startTime,
          input_tokens: 0, output_tokens: 0, cost_usd: 0,
          trace_id: traceId, metadata: { unhandled_error: true },
        });
      } catch (logError) {
        console.error("Failed to log error:", logError);
      }
    }

    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...responseHeaders, "Content-Type": "application/json" } }
    );
  }
});
