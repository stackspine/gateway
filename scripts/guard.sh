#!/usr/bin/env bash
# guard.sh
#
# Local mirror of the rules enforced by .github/workflows/public-repo-guard.yml.
# Run against a single directory (defaults to the gateway-oss tree). Used by:
#   - Developers, for a fast pre-push check.
#   - tests/fixtures/public-repo-guard/, to verify each fixture pass/fails.
#
# Exit 0 = clean, 1 = at least one violation found.

set -uo pipefail

ROOT="${1:-.}"

# Only exclude the fixture library when ROOT is *above* it. When ROOT IS a
# fixture (run-guard-fixtures.sh passes fixture dirs directly), we must scan
# everything so fail/* cases actually trip.
if [[ -d "${ROOT}/tests/fixtures/public-repo-guard" ]]; then
  EXCLUDE_FIXTURES=1
else
  EXCLUDE_FIXTURES=0
fi

DISALLOWED=(
  "src"
  "supabase/functions"
  "supabase/config.toml"
  "android"
  "ios"
  "capacitor.config.ts"
  "packages/sdk-js"
  "packages/sdk-python"
  "packages/sdk-go"
  "packages/sdk-ruby"
  "packages/sdk-rust"
  "docs/internal-ip"
  ".env"
)

FAIL=0

for p in "${DISALLOWED[@]}"; do
  if [[ -e "${ROOT}/${p}" ]]; then
    echo "❌ disallowed path: ${ROOT}/${p}"
    FAIL=1
  fi
done

# Control-plane imports. Skip the fixture library when scanning from above it
# (run-guard-fixtures.sh passes individual fixture dirs as ROOT, so their
# contents are still scanned correctly there).
if grep -rEn \
    -e 'from ["'"'"']@/(pages|components|contexts|hooks|integrations/supabase)' \
    -e 'supabase/functions/(invoke|write-audit-log|optimize-route-weights|cost-optimizer)' \
    --include='*.ts' --include='*.tsx' --include='*.js' \
    --exclude-dir='tests' \
    "${ROOT}" 2>/dev/null; then
  echo "❌ control-plane import detected"
  FAIL=1
fi

# Credential patterns (mirrors the "Extra credential patterns" step).
PATTERNS=(
  'BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'gh[ousr]_[A-Za-z0-9]{30,}'
  'AIza[0-9A-Za-z_-]{35}'
  'sk-[A-Za-z0-9]{32,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'AKIA[0-9A-Z]{16}'
  'eyJhbGciOi[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
)

RG="$(command -v rg || true)"
for pat in "${PATTERNS[@]}"; do
  if [[ -n "${RG}" ]]; then
    if "${RG}" -n --hidden \
         -g '!**/node_modules/**' \
         -g '!**/guard.sh' \
         -g '!**/run-guard-fixtures.sh' \
         -g '!**/public-repo-guard.yml' \
         -g '!**/scan-disclosure.sh' \
         -g '!**/tests/fixtures/public-repo-guard/**' \
         -g '!**/.git-filter-repo/**' \
         -e "${pat}" "${ROOT}" >/dev/null; then
      echo "❌ credential pattern matched: ${pat}"
      FAIL=1
    fi
  else
    if grep -rEn --binary-files=without-match \
         --exclude-dir=node_modules \
         --exclude-dir=tests \
         --exclude-dir=.git-filter-repo \
         --exclude='guard.sh' \
         --exclude='run-guard-fixtures.sh' \
         --exclude='public-repo-guard.yml' \
         --exclude='scan-disclosure.sh' \
         -e "${pat}" "${ROOT}" >/dev/null 2>&1; then
      echo "❌ credential pattern matched: ${pat}"
      FAIL=1
    fi
  fi
done

exit "${FAIL}"
