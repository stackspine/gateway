#!/usr/bin/env bash
# publish-public-repo.sh
#
# End-to-end: extract gateway-oss/ from the monorepo and push it to the
# public github.com/stackspine/gateway repo using the GitHub CLI (`gh`).
#
# Wraps preflight + git-filter-repo + `gh repo create` + push. Idempotent on
# re-publish: detects an existing public repo and force-pushes with lease.
#
# Usage:
#   ./gateway-oss/scripts/publish-public-repo.sh [--repo OWNER/NAME] [--dry-run]
#
# Defaults:
#   --repo stackspine/gateway
#
# Requires (script aborts if missing):
#   git >= 2.30, git-filter-repo, gh (authenticated with `repo` scope).

set -euo pipefail

REPO_SLUG="stackspine/gateway"
DRY_RUN=0
DEFAULT_BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_SLUG="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OSS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MONO_ROOT="$(cd "${OSS_ROOT}/.." && pwd)"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }
run() { if [[ "${DRY_RUN}" -eq 1 ]]; then printf "  [dry-run] %s\n" "$*"; else eval "$@"; fi; }

# ---------- 0. Tool checks ----------
for bin in git gh git-filter-repo; do
  command -v "${bin}" >/dev/null 2>&1 || {
    echo "ERROR: '${bin}' not found on PATH." >&2
    case "${bin}" in
      git-filter-repo) echo "  Install: pipx install git-filter-repo  (or brew install git-filter-repo)" >&2 ;;
      gh) echo "  Install: https://cli.github.com/  then run: gh auth login --scopes repo,workflow" >&2 ;;
    esac
    exit 1
  }
done

if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run: gh auth login --scopes repo,workflow" >&2
  exit 1
fi

# ---------- 1. Preflight on monorepo HEAD ----------
say "Preflight on monorepo HEAD"
run "bash '${OSS_ROOT}/scripts/preflight-extract.sh'"

# ---------- 2. Fresh clone into a throwaway workdir ----------
WORKDIR="$(mktemp -d -t stackspine-extract-XXXXXX)"
say "Fresh clone of monorepo into ${WORKDIR}"
MONO_REMOTE="$(git -C "${MONO_ROOT}" remote get-url origin 2>/dev/null || true)"
if [[ -z "${MONO_REMOTE}" ]]; then
  echo "ERROR: monorepo has no 'origin' remote; clone manually and re-run with --repo." >&2
  exit 1
fi
run "git clone --no-local '${MONO_REMOTE}' '${WORKDIR}'"

# ---------- 3. Stash filter config (it gets rewritten away by step 4) ----------
CONFIG_STASH="${WORKDIR}.config"
run "cp -R '${OSS_ROOT}/.git-filter-repo' '${CONFIG_STASH}'"
run "cp '${OSS_ROOT}/scripts/guard.sh' '${CONFIG_STASH}/guard.sh'"
run "cp '${OSS_ROOT}/scripts/run-guard-fixtures.sh' '${CONFIG_STASH}/run-guard-fixtures.sh'"

# ---------- 4. git filter-repo rewrites ----------
say "Rewriting history (subdirectory + path/secret scrubs)"
(
  cd "${WORKDIR}"
  run "git filter-repo --subdirectory-filter gateway-oss"
  run "git filter-repo --force --invert-paths --paths-from-file '${CONFIG_STASH}/paths-to-remove.txt'"
  run "git filter-repo --force --replace-text '${CONFIG_STASH}/replacements.txt'"
  run "git filter-repo --force --mailmap '${CONFIG_STASH}/mailmap'"
)

# ---------- 5. Final guard pass on rewritten worktree ----------
say "Guard pass on rewritten worktree"
run "bash '${CONFIG_STASH}/guard.sh' '${WORKDIR}'"

# ---------- 6. Ensure public repo exists ----------
say "Ensuring ${REPO_SLUG} exists on GitHub"
if gh repo view "${REPO_SLUG}" >/dev/null 2>&1; then
  echo "  repo already exists — will force-push with lease."
  EXISTS=1
else
  echo "  creating new public repo ${REPO_SLUG}"
  run "gh repo create '${REPO_SLUG}' --public --disable-wiki --description 'StackSpine Gateway — open-source AI control plane'"
  EXISTS=0
fi

# ---------- 7. Push ----------
say "Pushing to ${REPO_SLUG}"
(
  cd "${WORKDIR}"
  run "git remote add origin 'git@github.com:${REPO_SLUG}.git' 2>/dev/null || git remote set-url origin 'git@github.com:${REPO_SLUG}.git'"
  if [[ "${EXISTS}" -eq 1 ]]; then
    run "git push --force-with-lease -u origin HEAD:${DEFAULT_BRANCH}"
  else
    run "git push -u origin HEAD:${DEFAULT_BRANCH}"
  fi
  run "git push origin --tags --force-with-lease"
)

# ---------- 8. Trigger verify workflow (best-effort) ----------
if gh workflow list -R "${REPO_SLUG}" 2>/dev/null | grep -q "Verify Public Tree"; then
  say "Dispatching Verify Public Tree workflow"
  run "gh workflow run 'Verify Public Tree' -R '${REPO_SLUG}'"
fi

say "Done. Public repo: https://github.com/${REPO_SLUG}"
echo "Workdir kept at: ${WORKDIR}  (delete manually when satisfied)"
