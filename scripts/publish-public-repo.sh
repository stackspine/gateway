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
EXTRACT_ONLY=0
DEFAULT_BRANCH="main"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_SLUG="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --extract-only) EXTRACT_ONLY=1; shift ;;
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

# ---------- 4b. Restore guard fixtures post-redaction ----------
# The --replace-text pass above also scrubs the credential-shaped strings
# inside tests/fixtures/public-repo-guard/fail/*/leak.txt — which makes the
# fixture suite false-negative in CI ("expected exit 1, got 0"). Restore the
# fixture tree from the monorepo source and commit it as the final step so
# guard.sh in CI sees real key-shaped content again.
say "Restoring guard fixtures after redaction pass"
FIXTURES_SRC="${OSS_ROOT}/tests/fixtures/public-repo-guard"
if [[ -d "${FIXTURES_SRC}" ]]; then
  run "rm -rf '${WORKDIR}/tests/fixtures/public-repo-guard'"
  run "mkdir -p '${WORKDIR}/tests/fixtures'"
  run "cp -R '${FIXTURES_SRC}' '${WORKDIR}/tests/fixtures/'"
  (
    cd "${WORKDIR}"
    run "git add tests/fixtures/public-repo-guard"
    # Only commit if there are actual changes (idempotent re-publish).
    if [[ "${DRY_RUN}" -eq 1 ]] || ! git diff --cached --quiet; then
      run "git -c user.email=publish@stackspine.dev -c user.name='StackSpine Publish' commit -m 'fixtures: restore guard leak.txt after redaction pass'"
    fi
  )
fi

# ---------- 5. Final guard pass on rewritten worktree ----------
say "Guard pass on rewritten worktree"
run "bash '${CONFIG_STASH}/guard.sh' '${WORKDIR}'"

# Stop here when caller only wants the extracted tree (used by publish-safe.sh
# to run verify-public-tree.sh against the actual rewritten worktree).
if [[ "${EXTRACT_ONLY}" -eq 1 ]]; then
  say "Extract-only complete"
  # Machine-readable line for orchestrators:
  echo "EXTRACTED_WORKDIR=${WORKDIR}"
  echo "Run: bash '${OSS_ROOT}/scripts/verify-public-tree.sh' '${WORKDIR}'"
  exit 0
fi


# ---------- 6. Ensure public repo exists ----------
say "Ensuring ${REPO_SLUG} exists on GitHub"
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "  [dry-run] skipping gh repo view ${REPO_SLUG}"
  EXISTS=0
elif gh repo view "${REPO_SLUG}" >/dev/null 2>&1; then
  echo "  repo already exists — will force-push with lease."
  EXISTS=1
else
  echo "  creating new public repo ${REPO_SLUG}"
  run "gh repo create '${REPO_SLUG}' --public --disable-wiki --description 'StackSpine Gateway — open-source AI control plane'"
  EXISTS=0
fi

# ---------- 7. Push (HTTPS via gh credential helper; no SSH key required) ----------
say "Wiring git to use gh's credential helper (idempotent)"
run "gh auth setup-git"

say "Pushing to ${REPO_SLUG}"
(
  cd "${WORKDIR}"
  run "git remote add origin 'https://github.com/${REPO_SLUG}.git' 2>/dev/null || git remote set-url origin 'https://github.com/${REPO_SLUG}.git'"

  # ---- Pre-push validation ----
  # Fetch current remote state so we can (a) log the SHA we're about to
  # overwrite and (b) optionally enforce that the remote matches a caller-
  # supplied SHA via EXPECTED_REMOTE_SHA. Tolerate empty repo (no refs yet).
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    git fetch origin --tags --prune || true

    LOCAL_SHA="$(git rev-parse HEAD)"
    REMOTE_SHA=""
    if git rev-parse --verify --quiet "refs/remotes/origin/${DEFAULT_BRANCH}" >/dev/null; then
      REMOTE_SHA="$(git rev-parse "refs/remotes/origin/${DEFAULT_BRANCH}")"
    fi

    echo "  local  HEAD                  = ${LOCAL_SHA}"
    echo "  remote ${DEFAULT_BRANCH} (pre-push)   = ${REMOTE_SHA:-<empty repo>}"

    if [[ -n "${EXPECTED_REMOTE_SHA:-}" ]]; then
      if [[ "${REMOTE_SHA}" != "${EXPECTED_REMOTE_SHA}" ]]; then
        echo "ERROR: remote ${DEFAULT_BRANCH} is ${REMOTE_SHA:-<empty>}, expected ${EXPECTED_REMOTE_SHA}." >&2
        echo "  Aborting force push. Reconcile, or unset EXPECTED_REMOTE_SHA." >&2
        exit 1
      fi
      echo "  pre-push lease OK (remote matches EXPECTED_REMOTE_SHA)."
    fi

    if [[ -n "${REMOTE_SHA}" && "${REMOTE_SHA}" == "${LOCAL_SHA}" ]]; then
      echo "  remote already at LOCAL_SHA; push is a no-op."
    fi
  fi

  # One-way mirror: history is rewritten every publish, so a server-side
  # CAS lease is meaningless. The EXPECTED_REMOTE_SHA check above is the
  # opt-in safety net for callers that want it.
  run "git push --force -u origin HEAD:${DEFAULT_BRANCH}"

  # Tags: only push if we have local tags.
  if git for-each-ref --format='%(refname)' refs/tags | grep -q .; then
    run "git push origin --tags --force || true"
  fi

  # ---- Post-push verification ----
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    git fetch origin --prune || true
    NEW_REMOTE_SHA="$(git rev-parse "refs/remotes/origin/${DEFAULT_BRANCH}" 2>/dev/null || echo "")"
    LOCAL_SHA="$(git rev-parse HEAD)"
    echo "  remote ${DEFAULT_BRANCH} (post-push)  = ${NEW_REMOTE_SHA:-<missing>}"
    if [[ "${NEW_REMOTE_SHA}" != "${LOCAL_SHA}" ]]; then
      echo "ERROR: post-push remote ${DEFAULT_BRANCH} (${NEW_REMOTE_SHA}) != local HEAD (${LOCAL_SHA})." >&2
      exit 1
    fi
    echo "  post-push verification OK: ${REPO_SLUG}@${DEFAULT_BRANCH} = ${LOCAL_SHA}"
  fi
)

# ---------- 8. Trigger verify workflow (best-effort) ----------
if [[ "${DRY_RUN}" -eq 0 ]] && gh workflow list -R "${REPO_SLUG}" 2>/dev/null | grep -q "Verify Public Tree"; then
  say "Dispatching Verify Public Tree workflow"
  run "gh workflow run 'Verify Public Tree' -R '${REPO_SLUG}'"
fi

# ---------- 9. Dry-run summary ----------
if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo
  say "DRY RUN SUMMARY — nothing was sent to GitHub"

  echo
  echo "  Exact GitHub commands that WOULD run:"
  echo "    gh repo create ${REPO_SLUG} --public --disable-wiki \\"
  echo "        --description 'StackSpine Gateway — open-source AI control plane'"
  echo "    gh auth setup-git"
  echo "    git -C <workdir> remote add origin https://github.com/${REPO_SLUG}.git"
  echo "    git -C <workdir> push --force -u origin HEAD:${DEFAULT_BRANCH}"
  echo "    git -C <workdir> push origin --tags --force"
  echo "    gh workflow run 'Verify Public Tree' -R ${REPO_SLUG}"

  echo
  echo "  Expected top-level file set on ${REPO_SLUG} after publish:"
  # Compute: current gateway-oss/ top-level entries MINUS anything matched by
  # the deny list (best-effort prefix match against paths-to-remove.txt).
  DENY_FILE="${OSS_ROOT}/.git-filter-repo/paths-to-remove.txt"
  while IFS= read -r entry; do
    name="$(basename "${entry}")"
    # Skip hidden dirs we don't want to advertise except .github.
    case "${name}" in
      .git|.git-filter-repo) continue ;;
    esac
    skip=0
    if [[ -f "${DENY_FILE}" ]]; then
      while IFS= read -r rule; do
        [[ -z "${rule}" || "${rule}" =~ ^# ]] && continue
        rule="${rule#glob:}"
        # Compare on the top-level name only.
        top="${rule%%/*}"
        if [[ "${top}" == "${name}" || "${rule}" == "${name}" ]]; then
          skip=1; break
        fi
      done < "${DENY_FILE}"
    fi
    [[ "${skip}" -eq 1 ]] && continue
    if [[ -d "${entry}" ]]; then
      echo "    ${name}/"
    else
      echo "    ${name}"
    fi
  done < <(find "${OSS_ROOT}" -mindepth 1 -maxdepth 1 | sort)

  echo
  echo "  Re-run without --dry-run to publish."
  exit 0
fi

say "Done. Public repo: https://github.com/${REPO_SLUG}"
echo "Workdir kept at: ${WORKDIR}  (delete manually when satisfied)"
