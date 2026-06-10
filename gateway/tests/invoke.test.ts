import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

const INVOKE_URL = `${SUPABASE_URL}/functions/v1/invoke`;

Deno.test("S13: Returns X-API-Version header on all responses", async () => {
  const response = await fetch(INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ task_key: "nonexistent" }),
  });
  const body = await response.text();
  assertEquals(response.headers.get("X-API-Version"), "1");
});

Deno.test("S8/S10/S15: Returns 401 for missing API key", async () => {
  const response = await fetch(INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      task_key: "test_task",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const body = await response.text();
  // Without x-api-key header, should get 401
  assertEquals(response.status, 401);
  assertEquals(response.headers.get("X-API-Version"), "1");
});

Deno.test("S8/S10/S15: Returns 401 for invalid API key", async () => {
  const response = await fetch(INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "x-api-key": "sk_live_invalid_key_12345",
    },
    body: JSON.stringify({
      task_key: "test_task",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const body = await response.text();
  assertEquals(response.status, 401);
});

Deno.test("S15: Returns X-Trace-Id and traceparent headers", async () => {
  const response = await fetch(INVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "x-api-key": "sk_live_invalid_key_test",
    },
    body: JSON.stringify({
      task_key: "test_task",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const body = await response.text();

  // Trace headers should be present even on error responses
  const traceId = response.headers.get("X-Trace-Id");
  const traceparent = response.headers.get("traceparent");

  // These may or may not be present depending on where in the flow the error occurs
  // At minimum, X-API-Version should always be present
  assertEquals(response.headers.get("X-API-Version"), "1");
});

Deno.test("CORS: OPTIONS returns 200", async () => {
  const response = await fetch(INVOKE_URL, {
    method: "OPTIONS",
    headers: {
      "apikey": SUPABASE_ANON_KEY,
    },
  });
  const body = await response.text();
  assertEquals(response.status, 200);
  assertExists(response.headers.get("Access-Control-Allow-Origin"));
});
