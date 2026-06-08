#!/usr/bin/env bash
# verify-public-tree.sh
#
# Local mirror of .github/workflows/verify-public-tree.yml. Runs the same
# guard.sh checks, fixture suite, and required-files assertions against an
# extracted public tree.
#
# Usage:
#   ./gateway-oss/scripts/verify-public-tree.sh [PATH]
#
# PATH defaults to the gateway-oss/ directory (when run from the monorepo)
# or "." (when run inside an already-extracted public clone). Use this on a
# rewritten worktree before `git push` to catch regressions locally.
#
# Exit 0 = clean and publish-ready. Exit 1 = at least one check failed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TARGET="${1:-}"
if [[ -z "${TARGET}" ]]; then
  if [[ -f "${OSS_ROOT}/README.md" && -d "${OSS_ROOT}/scripts" ]]; then
    TARGET="${OSS_ROOT}"
  else
    TARGET="."
  fi
fi
TARGET="$(cd "${TARGET}" && pwd)"

GUARD="${OSS_ROOT}/scripts/guard.sh"
FIXTURES="${OSS_ROOT}/scripts/run-guard-fixtures.sh"

REQUIRED_FILES=(
  "README.md"
  "LICENSE"
  "CONTRIBUTING.md"
  "SECURITY.md"
  "CODEOWNERS"
)

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$*"; }

FAIL=0

bold "Verifying public tree: ${TARGET}"

# ---- 1. guard.sh ----
echo
bold "[1/3] guard.sh"
if bash "${GUARD}" "${TARGET}"; then
  ok "guard.sh clean"
else
  bad "guard.sh reported violations"
  FAIL=1
fi

# ---- 2. fixture suite (only when fixtures are present) ----
echo
bold "[2/3] fixture suite"
if [[ -d "${TARGET}/tests/fixtures/public-repo-guard" ]]; then
  if bash "${FIXTURES}"; then
    ok "fixtures passed"
  else
    bad "fixture suite failed"
    FAIL=1
  fi
else
  ok "fixture tree absent in this view — skipping (expected when extracted tree omits tests/)"
fi

# ---- 3. required files ----
echo
bold "[3/3] required public-repo files"
for f in "${REQUIRED_FILES[@]}"; do
  if [[ -f "${TARGET}/${f}" ]]; then
    ok "${f}"
  else
    bad "missing: ${f}"
    FAIL=1
  fi
done

echo
if [[ "${FAIL}" -eq 0 ]]; then
  bold "✅ Public tree is ready to publish."
  exit 0
else
  bold "❌ Public tree is NOT ready. Fix the issues above before pushing."
  exit 1
fi
