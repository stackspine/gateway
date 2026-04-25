#!/usr/bin/env bash
# scan-disclosure.sh
#
# Pre-release disclosure scanner for the open-source gateway tree.
#
# Detects three categories of leak in any file under the gateway-oss/ tree:
#   1. Real-looking secrets / credentials  (API keys, JWTs, project refs, etc.)
#   2. Internal infrastructure paths       (private repo / production-tree refs)
#   3. Patent / IP over-disclosure         (specific claim numbers, thresholds,
#                                          composition recipes that go beyond
#                                          what is publicly disclosed on the
#                                          marketing site)
#
# Exit code:
#   0 — clean
#   1 — at least one match found (CI should block release)
#
# Run from repo root or from inside gateway-oss/. The script auto-detects.

set -uo pipefail

# Resolve the directory to scan -------------------------------------------------
if [[ -d "gateway-oss" ]]; then
  ROOT="gateway-oss"
elif [[ -f "NOTICE" && -d "gateway" ]]; then
  ROOT="."
else
  echo "❌ Could not locate gateway-oss tree. Run from repo root."
  exit 2
fi

# Files we *expect* to mention example/placeholder secrets — exclude from
# secret-pattern scan but still subject to the other scans.
SECRET_ALLOWLIST_PATHS=(
  "${ROOT}/deploy/docker/docker-compose.yml"
  "${ROOT}/deploy/docker/.env.example"
  "${ROOT}/.env.example"
  "${ROOT}/deploy/SELF-HOST.md"
  "${ROOT}/README.md"
  "${ROOT}/SECURITY.md"
  "${ROOT}/sdks/js/src/index.ts"
  "${ROOT}/sdks/js/README.md"
  "${ROOT}/sdks/python/README.md"
  "${ROOT}/sdks/go/README.md"
  "${ROOT}/sdks/ruby/README.md"
  "${ROOT}/sdks/rust/README.md"
)

# Build a ripgrep -g exclusion list for the secret scan only.
SECRET_EXCLUDES=()
for p in "${SECRET_ALLOWLIST_PATHS[@]}"; do
  SECRET_EXCLUDES+=( "-g" "!${p#${ROOT}/}" )
done

VIOLATIONS=0

run_check () {
  local label="$1"
  local pattern="$2"
  shift 2
  local extra_args=("$@")

  echo ""
  echo "── ${label} ──"

  # rg returns 1 on "no matches" — that is success here.
  local output
  if output=$(rg -n --color=never --hidden \
                 -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/target/**' \
                 -g '!scripts/scan-disclosure.sh' \
                 -g '!.github/workflows/scan-disclosure.yml' \
                 "${extra_args[@]}" \
                 -e "${pattern}" "${ROOT}"); then
    echo "${output}"
    local count
    count=$(printf "%s\n" "${output}" | wc -l | tr -d ' ')
    echo "❌ ${count} match(es) for: ${label}"
    VIOLATIONS=$((VIOLATIONS + count))
  else
    echo "✅ clean"
  fi
}

echo "🔍 Disclosure scan starting in ${ROOT}/"

# 1. SECRETS / CREDENTIALS ------------------------------------------------------
# Real-looking API keys and JWTs (placeholder formats are excluded above).
run_check "Stripe live keys"          'sk_live_[0-9a-zA-Z]{20,}'           "${SECRET_EXCLUDES[@]}"
run_check "OpenAI keys"               'sk-[A-Za-z0-9]{32,}'                "${SECRET_EXCLUDES[@]}"
run_check "Anthropic keys"            'sk-ant-[A-Za-z0-9_-]{20,}'          "${SECRET_EXCLUDES[@]}"
run_check "AWS access keys"           'AKIA[0-9A-Z]{16}'                   "${SECRET_EXCLUDES[@]}"
run_check "Google API keys"           'AIza[0-9A-Za-z_-]{35}'              "${SECRET_EXCLUDES[@]}"
run_check "GitHub PATs"               'ghp_[A-Za-z0-9]{36}'                "${SECRET_EXCLUDES[@]}"
run_check "JWT tokens (real)"         'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}' "${SECRET_EXCLUDES[@]}"
# Supabase project refs are 20 lowercase letters. Pin known refs here.
run_check "Supabase project refs"     'xcgtwqlbyztctpvujuqo'

# 2. INTERNAL INFRASTRUCTURE PATHS ---------------------------------------------
# These reveal the existence/location of the private production tree.
run_check "Private supabase function path"  'supabase/functions/(invoke|[a-z][a-z0-9_-]+)/'
run_check "Production-tree references"      '\b(production-tree|internal mirror|private mirror|kept in sync with)\b'
run_check "Private dev paths"               '/dev-server/|/Users/[a-zA-Z0-9_.-]+/|C:\\\\Users\\\\'

# 3. PATENT / IP OVER-DISCLOSURE -----------------------------------------------
# Public docs may say "pending claims cover our specific composition" — that's
# fine. What we MUST NOT publish: specific claim numbers paired with the exact
# numerical thresholds, parameter recipes, or function-by-function mappings
# that would help a competitor design around the pending claims.
run_check "Numeric threshold composition" '\b(50|≥50|>=50)\s*[/,]\s*(2|≥2|>=2)\s*[/,]\s*0?\.95\b'
run_check "Confidence-threshold leak"     '0?\.25\s*confidence|≥\s*0?\.25\s*confidence'
run_check "Savings-threshold leak"        '≥\s*20%\s*savings|>=\s*20%\s*savings|0?\.20\s*savings'
run_check "Claim-to-file mapping block"   '(?im)^.*claim[- ]?to[- ]?file[- ]?mapping'
run_check "Patent N Claim M decomposition tables" '(?m)^\s*Claim\s+[0-9]+\s+\(.*\)\s*$'

# Summary --------------------------------------------------------------------
echo ""
echo "════════════════════════════════════════════════════════════════"
if [[ "${VIOLATIONS}" -eq 0 ]]; then
  echo "✅ Disclosure scan PASSED — no secrets, internal paths, or IP over-disclosure found."
  exit 0
else
  echo "❌ Disclosure scan FAILED — ${VIOLATIONS} potential issue(s) above."
  echo ""
  echo "If a match is a false positive, either:"
  echo "  • Add the file to SECRET_ALLOWLIST_PATHS in this script (for placeholder"
  echo "    credentials in docs/examples), or"
  echo "  • Tighten the offending pattern."
  echo ""
  echo "Do NOT silence a real disclosure — scrub it from the source instead."
  exit 1
fi
