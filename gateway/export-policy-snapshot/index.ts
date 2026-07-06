/**
 * @fileoverview Builds and stores signed policy snapshots per organization.
 *
 * Invoked on a 30s pg_cron schedule. Each run walks all orgs, calls the
 * `build_policy_snapshot` SECURITY DEFINER function, HMAC-signs the payload
 * with `POLICY_SNAPSHOT_SIGNING_KEY`, and upserts a new row into
 * `policy_snapshots` with a monotonically increasing version.
 *
 * @module export-policy-snapshot
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  signSnapshotPayload,
  type PolicySnapshotPayload,
} from "../_shared/policy-cache.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const signingKey = Deno.env.get("POLICY_SNAPSHOT_SIGNING_KEY") ?? "";

  if (!signingKey) {
    return new Response(
      JSON.stringify({ error: "POLICY_SNAPSHOT_SIGNING_KEY missing" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const started = Date.now();
  const summary = { orgs: 0, written: 0, failed: 0 };

  try {
    const { data: orgs, error: orgErr } = await supabase
      .from("organizations")
      .select("id")
      .is("deleted_at", null);
    if (orgErr) throw orgErr;

    for (const org of orgs ?? []) {
      summary.orgs++;
      try {
        const { data: payload, error: rpcErr } = await supabase.rpc(
          "build_policy_snapshot",
          { p_org_id: org.id },
        );
        if (rpcErr) throw rpcErr;

        const typed = payload as PolicySnapshotPayload;
        const signature = await signSnapshotPayload(typed, signingKey);

        const { data: latest } = await supabase
          .from("policy_snapshots")
          .select("version")
          .eq("org_id", org.id)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();

        const nextVersion = (latest?.version ?? 0) + 1;

        const { error: insErr } = await supabase.from("policy_snapshots").insert({
          org_id: org.id,
          version: nextVersion,
          max_stale_seconds: 900,
          signature,
          payload: typed,
        });
        if (insErr) throw insErr;
        summary.written++;
      } catch (e) {
        summary.failed++;
        console.error(`[export-policy-snapshot] org ${org.id} failed:`, e);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, duration_ms: Date.now() - started, ...summary }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[export-policy-snapshot] fatal:", e);
    return new Response(
      JSON.stringify({ ok: false, error: (e as Error).message, ...summary }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
