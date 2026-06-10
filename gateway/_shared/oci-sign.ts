/**
 * @fileoverview Oracle OCI Request Signing v1 (Signature scheme)
 * @module invoke/_shared/oci-sign
 */

export interface OciCredentials {
  tenancyId: string;
  userId: string;
  fingerprint: string;
  region: string;
  privateKeyPem: string;
}

export function parseOciCredentials(raw: string): OciCredentials {
  const parts = raw.split(":");
  if (parts.length < 5) {
    throw new Error(
      'OCI credentials must be formatted as "tenancy:user:fingerprint:region:base64_pkcs8_private_key"',
    );
  }
  const [tenancyId, userId, fingerprint, region, ...keyParts] = parts;
  const privateKeyRaw = keyParts.join(":");
  const privateKeyPem = privateKeyRaw
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  return { tenancyId, userId, fingerprint, region, privateKeyPem };
}

async function importOciPrivateKey(b64: string): Promise<CryptoKey> {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    bin,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sha256Base64(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export async function signOciRequest(opts: {
  creds: OciCredentials;
  method: string;
  url: string;
  body: string;
}): Promise<Record<string, string>> {
  const u = new URL(opts.url);
  const requestTarget = `${opts.method.toLowerCase()} ${u.pathname}${u.search}`;
  const date = new Date().toUTCString();
  const xContentSha = await sha256Base64(opts.body);
  const contentLength = String(new TextEncoder().encode(opts.body).length);
  const contentType = "application/json";

  const signingString = [
    `(request-target): ${requestTarget}`,
    `host: ${u.host}`,
    `date: ${date}`,
    `x-content-sha256: ${xContentSha}`,
    `content-type: ${contentType}`,
    `content-length: ${contentLength}`,
  ].join("\n");

  const key = await importOciPrivateKey(opts.creds.privateKeyPem);
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingString),
    ),
  );
  const signatureB64 = toBase64(sig);

  const keyId =
    `${opts.creds.tenancyId}/${opts.creds.userId}/${opts.creds.fingerprint}`;
  const authorization = [
    `Signature version="1"`,
    `keyId="${keyId}"`,
    `algorithm="rsa-sha256"`,
    `headers="(request-target) host date x-content-sha256 content-type content-length"`,
    `signature="${signatureB64}"`,
  ].join(",");

  return {
    host: u.host,
    date,
    "x-content-sha256": xContentSha,
    "content-type": contentType,
    "content-length": contentLength,
    authorization,
  };
}
