#!/usr/bin/env bash
# publish-safe.sh
#
# One-command safe publish for the stackspine/gateway public repo.
#
# Pipeline (each gate blocks the next):
#   1. publish-public-repo.sh --dry-run   → prints exact gh/git commands and
#                                            expected file set, no GitHub I/O.
#   2. publish-public-repo.sh --extract-only → actually rewrites history into
#                                              a tmp workdir but does NOT push.
#   3. verify-public-tree.sh <workdir>     → guard.sh + fixtures + required
#                                            files on the rewritten worktree.
#   4. Interactive confirmation            → must type "PUBLISH" to proceed.
#   5. publish-public-repo.sh              → real `gh repo create` + push.
#
# Any step that exits non-zero aborts the pipeline.
#
# Usage:
#   ./gateway-oss/scripts/publish-safe.sh [--repo OWNER/NAME] [--yes]
#
#   --repo OWNER/NAME  default stackspine/gateway
#   --yes              skip the interactive confirmation (CI use)

set -euo pipefail

REPO_SLUG="stackspine/gateway"
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_SLUG="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISH="${SCRIPT_DIR}/publish-public-repo.sh"
VERIFY="${SCRIPT_DIR}/verify-public-tree.sh"

step() { printf "\n\033[1;35m━━━ %s ━━━\033[0m\n" "$*"; }

# --- Gate 1: dry run ---
step "Gate 1/4 — DRY RUN (no GitHub I/O)"
bash "${PUBLISH}" --repo "${REPO_SLUG}" --dry-run

# --- Gate 2: real extraction (no push) ---
step "Gate 2/4 — EXTRACT (rewrite history into tmp workdir, no push)"
EXTRACT_LOG="$(mktemp -t stackspine-extract-log.XXXXXX)"
bash "${PUBLISH}" --repo "${REPO_SLUG}" --extract-only 2>&1 | tee "${EXTRACT_LOG}"
WORKDIR="$(grep -E '^EXTRACTED_WORKDIR=' "${EXTRACT_LOG}" | tail -1 | cut -d= -f2-)"
rm -f "${EXTRACT_LOG}"
if [[ -z "${WORKDIR}" || ! -d "${WORKDIR}" ]]; then
  echo "ERROR: could not locate extracted workdir." >&2
  exit 1
fi
echo "Extracted tree: ${WORKDIR}"

# --- Gate 3: verify ---
step "Gate 3/4 — VERIFY rewritten worktree"
bash "${VERIFY}" "${WORKDIR}"

# --- Gate 4: confirm ---
step "Gate 4/4 — CONFIRM real publish"
echo "About to publish to: https://github.com/${REPO_SLUG}"
echo "Extracted workdir : ${WORKDIR}"
if [[ "${ASSUME_YES}" -ne 1 ]]; then
  printf 'Type "PUBLISH" to proceed (anything else aborts): '
  read -r answer
  if [[ "${answer}" != "PUBLISH" ]]; then
    echo "Aborted. The extracted workdir is preserved at: ${WORKDIR}"
    exit 1
  fi
fi

# --- Real publish ---
step "PUBLISHING (real)"
bash "${PUBLISH}" --repo "${REPO_SLUG}"

printf "\n\033[1;32m✅ Publish-safe pipeline complete.\033[0m\n"
echo "Public repo: https://github.com/${REPO_SLUG}"
echo "Extracted workdir (kept for inspection): ${WORKDIR}"
