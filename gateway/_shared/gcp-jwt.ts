/**
 * @fileoverview GCP service-account JWT exchange for Vertex AI
 * @module invoke/_shared/gcp-jwt
 *
 * Implements the OAuth 2.0 service-account flow (RFC 7523):
 * 1. Build & sign a JWT with the service account's private key (RS256).
 * 2. POST it to https://oauth2.googleapis.com/token to exchange for an
 *    access token scoped to cloud-platform.
 *
 * Tokens are cached in-memory per service-account email until ~5 minutes
 * before expiry to avoid re-signing on every request.
 */

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const parsed = JSON.parse(raw) as ServiceAccountKey;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Service account key missing client_email or private_key");
  }
  return parsed;
}

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    bin,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function getGcpAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = parseServiceAccountKey(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);

  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expiresAt - 300 > now) {
    return cached.token;
  }

  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`GCP token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json() as { access_token: string; expires_in: number };
  const expiresAt = now + (json.expires_in || 3600);
  tokenCache.set(sa.client_email, { token: json.access_token, expiresAt });
  return json.access_token;
}
