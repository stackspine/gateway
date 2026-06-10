/**
 * CORS utility for the StackSpine Gateway (OSS)
 *
 * Configure allowed origins via the ALLOWED_ORIGINS environment variable
 * (comma-separated). For public-facing endpoints, wildcard CORS is used.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const ALLOWED_ORIGINS_ENV = Deno.env.get("ALLOWED_ORIGINS") || "";

/** Origins that internal edge functions accept requests from */
function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  if (SUPABASE_URL) origins.push(SUPABASE_URL);

  if (ALLOWED_ORIGINS_ENV) {
    origins.push(
      ...ALLOWED_ORIGINS_ENV.split(",").map((o) => o.trim()).filter(Boolean),
    );
  }

  return origins;
}

function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const allowed = getAllowedOrigins();
  return allowed.some((a) => origin === a);
}

/**
 * Restrictive CORS headers for internal/admin edge functions.
 * Only allows configured origins.
 */
export function internalCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowedOrigin = originAllowed(origin)
    ? origin!
    : getAllowedOrigins()[0] || "";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Vary": "Origin",
  };
}

/**
 * Wildcard CORS headers for public-facing endpoints.
 */
export const publicCorsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key, x-region, x-idempotency-key",
};

/**
 * Handle an OPTIONS preflight request.
 */
export function handleCorsOptions(headers: Record<string, string>): Response {
  return new Response(null, { headers });
}
