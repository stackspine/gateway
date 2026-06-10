/**
 * @fileoverview Rate limiting utilities for the invoke endpoint
 * @module invoke/_shared/rate-limit
 */

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const RATE_LIMIT_MAX_REQUESTS_PER_KEY = 60;
export const RATE_LIMIT_MAX_REQUESTS_PER_IP = 120;

/**
 * Extract client IP address from request headers
 */
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();

  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  const cfConnectingIp = req.headers.get("cf-connecting-ip");
  if (cfConnectingIp) return cfConnectingIp.trim();

  return "unknown";
}
