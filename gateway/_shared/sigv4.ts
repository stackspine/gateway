/**
 * @fileoverview Minimal AWS Signature V4 signer for Bedrock InvokeModel calls.
 * @module invoke/_shared/sigv4
 *
 * Pure Web Crypto / Deno-compatible (no aws-sdk dep). Signs a single POST request
 * to bedrock-runtime.{region}.amazonaws.com. Supports temporary creds via session token.
 */

const encoder = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf = typeof data === "string" ? encoder.encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface SigV4Options {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string; // e.g. "bedrock"
  method: string; // "POST"
  url: string; // full URL
  body: string;
  headers?: Record<string, string>;
}

/**
 * Sign an AWS request using SigV4 and return the headers to attach (including Authorization).
 */
export async function signSigV4(opts: SigV4Options): Promise<Record<string, string>> {
  const u = new URL(opts.url);
  const host = u.host;
  const canonicalUri = u.pathname || "/";
  const canonicalQuery = u.searchParams.toString();

  const now = new Date();
  const amzDate =
    now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(opts.body);

  const baseHeaders: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    ...(opts.sessionToken ? { "x-amz-security-token": opts.sessionToken } : {}),
    ...(opts.headers || {}),
  };

  const sortedHeaderEntries = Object.entries(baseHeaders)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim()] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders =
    sortedHeaderEntries.map(([k, v]) => `${k}:${v}`).join("\n") + "\n";
  const signedHeaders = sortedHeaderEntries.map(([k]) => k).join(";");

  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(encoder.encode("AWS4" + opts.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, opts.region);
  const kService = await hmac(kRegion, opts.service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization = `${algorithm} Credential=${opts.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...baseHeaders,
    Authorization: authorization,
  };
}

/**
 * Parse credentials stored as "ACCESS_KEY:SECRET_KEY" or
 * "ACCESS_KEY:SECRET_KEY:SESSION_TOKEN" out of the api_key field.
 */
export function parseAwsCredentials(raw: string): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  const parts = raw.split(":");
  if (parts.length < 2) {
    throw new Error(
      'Bedrock credentials must be formatted as "ACCESS_KEY_ID:SECRET_ACCESS_KEY" (optionally ":SESSION_TOKEN")'
    );
  }
  return {
    accessKeyId: parts[0],
    secretAccessKey: parts[1],
    sessionToken: parts[2] || undefined,
  };
}
