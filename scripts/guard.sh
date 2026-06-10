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

# Control-plane imports. Exclude fixture tree only when scanning above it.
CP_ARGS=(-rEn
  -e 'from ["'"'"']@/(pages|components|contexts|hooks|integrations/supabase)'
  -e 'supabase/functions/(invoke|write-audit-log|optimize-route-weights|cost-optimizer)'
  --include='*.ts' --include='*.tsx' --include='*.js')
if [[ "${EXCLUDE_FIXTURES}" -eq 1 ]]; then
  CP_ARGS+=(--exclude-dir='public-repo-guard')
fi
if grep "${CP_ARGS[@]}" "${ROOT}" 2>/dev/null; then
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

if [[ "${GUARD_DEBUG:-0}" == "1" ]]; then
  echo "[guard] ROOT=${ROOT}"
  echo "[guard] EXCLUDE_FIXTURES=${EXCLUDE_FIXTURES}"
  if [[ -n "${RG}" ]]; then
    echo "[guard] scanner=rg ($("${RG}" --version | head -1))"
  else
    echo "[guard] scanner=grep ($(grep --version | head -1))"
  fi
  echo "[guard] files visible to scan:"
  find "${ROOT}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's/^/  /' || true
fi

for pat in "${PATTERNS[@]}"; do
  if [[ -n "${RG}" ]]; then
    # -uu = --no-ignore --hidden ; -a treats binary files as text so .pem-style
    # fixtures (id_rsa) and any UTF-8-edgy leak.txt aren't silently skipped.
    RG_ARGS=(-n -a -uu
      -g '!**/node_modules/**'
      -g '!**/.git/**'
      -g '!**/guard.sh'
      -g '!**/run-guard-fixtures.sh'
      -g '!**/public-repo-guard.yml'
      -g '!**/scan-disclosure.sh'
      -g '!**/.git-filter-repo/**')
    if [[ "${EXCLUDE_FIXTURES}" -eq 1 ]]; then
      RG_ARGS+=(-g '!**/tests/fixtures/public-repo-guard/**')
    fi
    "${RG}" "${RG_ARGS[@]}" -e "${pat}" "${ROOT}" >/tmp/.guard-rg.$$ 2>&1
    rc=$?
    if [[ "${GUARD_DEBUG:-0}" == "1" ]]; then
      echo "[guard] rg pattern='${pat}' rc=${rc}"
      sed 's/^/  /' /tmp/.guard-rg.$$ || true
    fi
    if [[ "${rc}" -eq 0 ]]; then
      echo "❌ credential pattern matched: ${pat}"
      FAIL=1
    elif [[ "${rc}" -ne 1 ]]; then
      echo "⚠️  rg error (rc=${rc}) for pattern: ${pat}"
      cat /tmp/.guard-rg.$$ >&2 || true
      FAIL=1
    fi
    rm -f /tmp/.guard-rg.$$
  else
    GREP_ARGS=(-rEn --binary-files=text
      --exclude-dir=node_modules
      --exclude-dir=.git-filter-repo
      --exclude='guard.sh'
      --exclude='run-guard-fixtures.sh'
      --exclude='public-repo-guard.yml'
      --exclude='scan-disclosure.sh')
    if [[ "${EXCLUDE_FIXTURES}" -eq 1 ]]; then
      GREP_ARGS+=(--exclude-dir='public-repo-guard')
    fi
    grep "${GREP_ARGS[@]}" -e "${pat}" "${ROOT}" >/tmp/.guard-grep.$$ 2>&1
    rc=$?
    if [[ "${GUARD_DEBUG:-0}" == "1" ]]; then
      echo "[guard] grep pattern='${pat}' rc=${rc}"
      sed 's/^/  /' /tmp/.guard-grep.$$ || true
    fi
    if [[ "${rc}" -eq 0 ]]; then
      echo "❌ credential pattern matched: ${pat}"
      FAIL=1
    elif [[ "${rc}" -ne 1 ]]; then
      echo "⚠️  grep error (rc=${rc}) for pattern: ${pat}"
      cat /tmp/.guard-grep.$$ >&2 || true
      FAIL=1
    fi
    rm -f /tmp/.guard-grep.$$
  fi
done

exit "${FAIL}"
