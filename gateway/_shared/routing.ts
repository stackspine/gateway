/**
 * @fileoverview Route selection and circuit breaker logic
 * @module invoke/_shared/routing
 *
 * This file implements behavior subject to pending US patent applications;
 * see gateway-oss/NOTICE.
 */


import type { RouteWithProfile, RouteConditionRow, RouteContext } from "./types.ts";

// ============================================================================
// Circuit Breaker
// ============================================================================

const CIRCUIT_BREAKER_THRESHOLD_DEFAULT = 3;
const CIRCUIT_BREAKER_COOLDOWN_DEFAULT = 5;

export function getCircuitState(provider: {
  consecutive_failures: number;
  circuit_breaker_threshold?: number;
  circuit_breaker_cooldown_minutes?: number;
  circuit_opened_at?: string | null;
}): "closed" | "open" | "half-open" {
  const threshold = provider.circuit_breaker_threshold ?? CIRCUIT_BREAKER_THRESHOLD_DEFAULT;
  if (provider.consecutive_failures < threshold) return "closed";

  const cooldownMinutes = provider.circuit_breaker_cooldown_minutes ?? CIRCUIT_BREAKER_COOLDOWN_DEFAULT;
  if (provider.circuit_opened_at) {
    const openedAt = new Date(provider.circuit_opened_at).getTime();
    const cooldownMs = cooldownMinutes * 60 * 1000;
    if (Date.now() >= openedAt + cooldownMs) return "half-open";
  }
  return "open";
}

export function isCircuitOpen(provider: {
  consecutive_failures: number;
  is_active: boolean;
  circuit_breaker_threshold?: number;
  circuit_breaker_cooldown_minutes?: number;
  circuit_opened_at?: string | null;
}): boolean {
  return getCircuitState(provider) === "open";
}

// ============================================================================
// Condition Evaluation
// ============================================================================

function resolveField(context: RouteContext, field: string): unknown {
  if (field.startsWith('metadata.')) {
    const parts = field.slice('metadata.'.length).split('.');
    let current: unknown = context.metadata;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
  return (context as unknown as Record<string, unknown>)[field];
}

function evaluateCondition(condition: RouteConditionRow, context: RouteContext): boolean {
  const fieldValue = resolveField(context, condition.field);
  if (fieldValue === undefined) return false;

  const condValue = condition.value;

  switch (condition.operator) {
    case 'eq': return String(fieldValue) === String(condValue);
    case 'neq': return String(fieldValue) !== String(condValue);
    case 'gt': return Number(fieldValue) > Number(condValue);
    case 'gte': return Number(fieldValue) >= Number(condValue);
    case 'lt': return Number(fieldValue) < Number(condValue);
    case 'lte': return Number(fieldValue) <= Number(condValue);
    case 'in':
      if (Array.isArray(condValue)) return condValue.map(String).includes(String(fieldValue));
      return false;
    case 'contains': return String(fieldValue).includes(String(condValue));
    case 'regex':
      try { return new RegExp(String(condValue)).test(String(fieldValue)); }
      catch { return false; }
    default: return false;
  }
}

function evaluateRouteConditions(route: RouteWithProfile, context: RouteContext): boolean {
  if (!route.route_conditions || route.route_conditions.length === 0) return true;
  return route.route_conditions.every(c => evaluateCondition(c, context));
}

// ============================================================================
// Route Selection
// ============================================================================

export function selectRoute(routes: RouteWithProfile[], context?: RouteContext): {
  selectedRoute: RouteWithProfile;
  isCanary: boolean;
  circuitBreakerSkipped: string[];
  conditionFilteredCount: number;
  dataPolicyFilteredCount: number;
} {
  let conditionFilteredCount = 0;
  let dataPolicyFilteredCount = 0;
  let eligible = routes;

  //   policies constrain route selection *before* any payload is transmitted
  //   to a downstream provider.
  //   zero or more data policy associations (e.g., GDPR, HIPAA) specifying
  //   allowed geographic regions; only routes whose policies permit the
  //   detected region survive filtering.
  //   the required data policy, the system returns an error without
  //   transmitting any payload to a downstream provider.
  if (context?.data_policy) {
    const policyName = context.data_policy;
    const policyFiltered = eligible.filter(r => {
      if (!r.route_data_policies || r.route_data_policies.length === 0) return false;
      return r.route_data_policies.some(rdp => 
        rdp.data_policies?.name === policyName && 
        (rdp.data_policies.allowed_regions.length === 0 || !context.region || rdp.data_policies.allowed_regions.includes(context.region))
      );
    });
    dataPolicyFilteredCount = eligible.length - policyFiltered.length;
    if (policyFiltered.length > 0) {
      eligible = policyFiltered;
    } else {
      throw new Error(`No routes match data policy: ${policyName}`);
    }
  }

  //   a specific region are excluded when they do not match the detected
  //   caller region; untagged (global) routes serve as fallbacks.
  if (context?.region) {
    eligible = eligible.filter(r => !r.region || r.region === context.region);
    if (eligible.length === 0) eligible = routes.filter(r => !r.region);
  }

  //   undergo further filtering via route-level conditions before strategy
  //   selection.
  if (context) {
    eligible = eligible.filter(r => {
      const passes = evaluateRouteConditions(r, context);
      if (!passes) conditionFilteredCount++;
      return passes;
    });
    if (eligible.length === 0) eligible = routes.filter(r => !r.route_conditions || r.route_conditions.length === 0);
    if (eligible.length === 0) throw new Error("No active routes available (all conditions filtered out)");
  }

  const circuitBreakerSkipped: string[] = [];

  const isRouteHealthy = (r: RouteWithProfile): boolean => {
    const provider = r.model_profiles?.providers_with_key;
    if (!provider?.is_active) return false;
    if (isCircuitOpen(provider)) {
      circuitBreakerSkipped.push(`${provider.type}/${r.model_profiles.provider_model_name}`);
      return false;
    }
    return true;
  };

  //   primary → fallback, with circuit-breaker exclusion at each tier.
  const primaryRoutes = eligible.filter(r => r.strategy === "primary" && isRouteHealthy(r));
  const canaryRoutes = eligible.filter(r => r.strategy === "canary" && isRouteHealthy(r));

  if (canaryRoutes.length > 0 && primaryRoutes.length > 0) {
    const canaryTotalWeight = canaryRoutes.reduce((sum, r) => sum + (r.weight || 0), 0);
    const random = Math.random() * 100;
    if (random < canaryTotalWeight) {
      let cumulative = 0;
      for (const route of canaryRoutes) {
        cumulative += (route.weight || 0);
        if (random < cumulative) return { selectedRoute: route, isCanary: true, circuitBreakerSkipped, conditionFilteredCount, dataPolicyFilteredCount };
      }
      return { selectedRoute: canaryRoutes[0], isCanary: true, circuitBreakerSkipped, conditionFilteredCount, dataPolicyFilteredCount };
    }
    return { selectedRoute: primaryRoutes[0], isCanary: false, circuitBreakerSkipped, conditionFilteredCount, dataPolicyFilteredCount };
  }

  if (primaryRoutes.length > 0) return { selectedRoute: primaryRoutes[0], isCanary: false, circuitBreakerSkipped, conditionFilteredCount, dataPolicyFilteredCount };

  const fallbackRoutes = eligible
    .filter(r => r.strategy === "fallback" && isRouteHealthy(r))
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));

  if (fallbackRoutes.length > 0) return { selectedRoute: fallbackRoutes[0], isCanary: false, circuitBreakerSkipped, conditionFilteredCount, dataPolicyFilteredCount };

  throw new Error("No active routes available");
}
