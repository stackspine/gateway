#!/usr/bin/env bash
# run-guard-fixtures.sh
#
# Iterate every fixture under tests/fixtures/public-repo-guard/ and assert
# that scripts/guard.sh produces the expected verdict:
#
#   pass/<case>/  → guard.sh MUST exit 0
#   fail/<case>/  → guard.sh MUST exit 1
#
# Any mismatch fails the run, so CI catches regressions in either the rules
# or the fixtures themselves.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
GUARD="${ROOT}/scripts/guard.sh"
FIXTURES="${ROOT}/tests/fixtures/public-repo-guard"

if [[ ! -x "${GUARD}" ]]; then
  chmod +x "${GUARD}" || true
fi

# CI diagnostics: shows what scanner+version the runner has, and confirms the
# canary fixture is actually on disk with expected content. Silent locally
# unless you set RUN_GUARD_DEBUG=1.
if [[ "${CI:-}" == "true" || "${RUN_GUARD_DEBUG:-0}" == "1" ]]; then
  echo "── environment ──"
  command -v rg >/dev/null && rg --version | head -1 || echo "rg: not installed"
  grep --version | head -1
  echo "FIXTURES=${FIXTURES}"
  canary="${FIXTURES}/fail/anthropic-key"
  if [[ -d "${canary}" ]]; then
    echo "canary fixture contents:"
    ls -la "${canary}" | sed 's/^/  /'
    for f in "${canary}"/*; do
      echo "  --- ${f} ---"
      sed 's/^/    /' "${f}"
    done
  else
    echo "canary fixture MISSING: ${canary}"
  fi
  echo ""
fi

FAIL_COUNT=0
TOTAL=0



run_case() {
  local dir="$1"
  local expected="$2"   # 0 or 1
  local label="$3"
  TOTAL=$((TOTAL + 1))

  local out
  out="$(bash "${GUARD}" "${dir}" 2>&1)"
  local rc=$?

  if [[ "${rc}" -eq "${expected}" ]]; then
    printf "  ✅ %s (exit %d as expected)\n" "${label}" "${rc}"
  else
    printf "  ❌ %s — expected exit %d, got %d\n" "${label}" "${expected}" "${rc}"
    printf '%s\n' "${out}" | sed 's/^/      /'
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

echo "── PASS fixtures (must exit 0) ──"
for d in "${FIXTURES}/pass"/*/; do
  [[ -d "${d}" ]] || continue
  run_case "${d%/}" 0 "pass/$(basename "${d}")"
done

echo ""
echo "── FAIL fixtures (must exit 1) ──"
for d in "${FIXTURES}/fail"/*/; do
  [[ -d "${d}" ]] || continue
  run_case "${d%/}" 1 "fail/$(basename "${d}")"
done

echo ""
echo "════════════════════════════════════════════════════════════════"
if [[ "${FAIL_COUNT}" -eq 0 ]]; then
  echo "✅ All ${TOTAL} fixtures matched expected verdict."
  exit 0
else
  echo "❌ ${FAIL_COUNT}/${TOTAL} fixtures FAILED."
  exit 1
fi
