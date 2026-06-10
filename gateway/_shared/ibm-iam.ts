/**
 * @fileoverview IBM Cloud IAM token exchange for watsonx.ai
 * @module invoke/_shared/ibm-iam
 */

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

export async function getIbmIamToken(apiKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(apiKey);
  if (cached && cached.expiresAt - 300 > now) {
    return cached.token;
  }

  const res = await fetch("https://iam.cloud.ibm.com/identity/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "urn:ibm:params:oauth:grant-type:apikey",
      apikey: apiKey,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `IBM IAM token exchange failed (${res.status}): ${await res.text()}`,
    );
  }
  const json = await res.json() as {
    access_token: string;
    expiration: number;
    expires_in: number;
  };
  const expiresAt = json.expiration || (now + (json.expires_in || 3600));
  tokenCache.set(apiKey, { token: json.access_token, expiresAt });
  return json.access_token;
}
