#!/usr/bin/env bash
# preflight-extract.sh
#
# Run BEFORE executing the git filter-repo extraction documented in
# EXTRACTION.md. Verifies:
#   1. The current gateway-oss/ tree passes scripts/guard.sh.
#   2. The fixture suite still produces the expected pass/fail matrix.
#   3. No historical commit touching gateway-oss/ ever introduced a path that
#      is on the current deny list. Any such path MUST be in
#      .git-filter-repo/paths-to-remove.txt so it gets scrubbed from
#      rewritten history.
#
# Exits non-zero on any surprise. Safe to re-run.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${OSS_ROOT}/.." && pwd)"

FAIL=0

echo "==> [1/3] guard.sh on current gateway-oss/ tree"
if ! "${OSS_ROOT}/scripts/guard.sh" "${OSS_ROOT}"; then
  echo "    guard.sh reported violations in HEAD — fix before extracting."
  FAIL=1
fi

echo "==> [2/3] fixture suite"
if ! "${OSS_ROOT}/scripts/run-guard-fixtures.sh"; then
  echo "    fixture suite failed — guard rules drifted from fixtures."
  FAIL=1
fi

echo "==> [3/3] historical path audit (paths ever under gateway-oss/)"
if ! git -C "${REPO_ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
  echo "    not inside a git repo — skipping historical audit."
else
  DENYLIST="${OSS_ROOT}/.git-filter-repo/paths-to-remove.txt"
  TMP_HIST="$(mktemp)"
  TMP_MISS="$(mktemp)"
  trap 'rm -f "${TMP_HIST}" "${TMP_MISS}"' EXIT

  # Every path that has EVER lived under gateway-oss/, across all refs.
  git -C "${REPO_ROOT}" log --all --pretty=format: --name-only -- gateway-oss/ \
    | sed -n 's|^gateway-oss/||p' \
    | sort -u \
    | grep -v '^$' > "${TMP_HIST}" || true

  # Disallowed prefixes from guard.sh (kept in sync manually).
  DENY_PREFIXES=(
    "src/" "supabase/" "android/" "ios/"
    "capacitor.config.ts" "capacitor.config.json"
    "packages/sdk-js/" "packages/sdk-python/" "packages/sdk-go/"
    "packages/sdk-ruby/" "packages/sdk-rust/"
    "docs/internal-ip/" ".env"
  )

  : > "${TMP_MISS}"
  while IFS= read -r path; do
    for prefix in "${DENY_PREFIXES[@]}"; do
      case "${path}" in
        "${prefix}"*|"${prefix}")
          # Ensure denylist file covers it (loose grep is fine — operator review).
          if ! grep -qF "${prefix%/}" "${DENYLIST}" 2>/dev/null; then
            echo "${path}  (uncovered prefix: ${prefix})" >> "${TMP_MISS}"
          fi
          ;;
      esac
    done
  done < "${TMP_HIST}"

  if [[ -s "${TMP_MISS}" ]]; then
    echo "    historical paths NOT covered by paths-to-remove.txt:"
    sed 's/^/      - /' "${TMP_MISS}"
    FAIL=1
  else
    echo "    OK — all historically-disallowed paths are covered."
  fi
fi

if [[ "${FAIL}" -ne 0 ]]; then
  echo
  echo "Preflight FAILED. Do NOT proceed with extraction."
  exit 1
fi

echo
echo "Preflight OK. Safe to run the steps in EXTRACTION.md."
