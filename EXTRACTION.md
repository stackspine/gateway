# Extracting `gateway-oss/` into the public `stackspine/gateway` repo

This is the canonical, reproducible procedure for publishing the `gateway-oss/`
subtree of the private StackSpine monorepo as the public OSS repository at
**`github.com/stackspine/gateway`**.

History is rewritten with [`git-filter-repo`](https://github.com/newren/git-filter-repo)
so:

- Only commits/blobs that touched `gateway-oss/` are kept.
- The `gateway-oss/` prefix is stripped — it becomes the repo root.
- Any historically-present disallowed paths are scrubbed.
- Any token-shaped strings in historical blobs are redacted.
- Author/committer emails can be rewritten via the bundled mailmap.

> ⚠️ Rewriting history changes commit SHAs. The public repo is a one-way
> mirror — external contributors must rebase if you re-publish.

---

## Prerequisites

- `git` ≥ 2.30
- `git-filter-repo` installed and on `PATH`
  (`pipx install git-filter-repo` or `brew install git-filter-repo`)
- Push access to an **empty** `github.com/stackspine/gateway` repo
  (create it on GitHub first, do **not** initialize with README/license)
- `gh` CLI authenticated (optional, used for release publishing)

---

## Phase 1 — Preflight (inside the monorepo)

```bash
cd <monorepo-root>
./gateway-oss/scripts/preflight-extract.sh
```

This runs `guard.sh` against the current tree, replays the fixture suite, and
audits every path ever committed under `gateway-oss/` to make sure anything
currently disallowed is covered by `.git-filter-repo/paths-to-remove.txt`.

Fix any reported issues before continuing.

---

## Phase 2 — Extraction (throwaway clone)

Run these in a **fresh clone**, never in your working monorepo.

```bash
# 0. Fresh clone of the PRIVATE monorepo (no --local hardlinks)
git clone --no-local <private-monorepo-url> /tmp/stackspine-extract
cd /tmp/stackspine-extract

# Stash the filter config from the monorepo BEFORE we rewrite history,
# because step 1 will move the repo root.
cp -R gateway-oss/.git-filter-repo /tmp/ssx-filter-config
cp gateway-oss/scripts/guard.sh /tmp/ssx-guard.sh
cp gateway-oss/scripts/run-guard-fixtures.sh /tmp/ssx-fixtures.sh

# 1. Keep ONLY gateway-oss/ history; promote it to repo root.
git filter-repo \
  --subdirectory-filter gateway-oss

# 2. Scrub any historically-present disallowed paths.
git filter-repo --force \
  --invert-paths \
  --paths-from-file /tmp/ssx-filter-config/paths-to-remove.txt

# 3. Redact token-shaped strings from historical blobs.
git filter-repo --force \
  --replace-text /tmp/ssx-filter-config/replacements.txt

# 4. (Optional) Rewrite committer/author identities for public visibility.
git filter-repo --force --mailmap /tmp/ssx-filter-config/mailmap

# 5. Final guard pass on the rewritten worktree.
bash /tmp/ssx-guard.sh .
bash /tmp/ssx-fixtures.sh
```

If any step exits non-zero, **stop**. Diagnose, update the relevant config
file back in the monorepo, commit, and restart Phase 2 from a fresh clone.

---

## Phase 3 — Push to the public repo

```bash
git remote add origin git@github.com:stackspine/gateway.git
git push -u origin main
git push origin --tags
```

On GitHub:

1. Repo settings → **Branches** → require PRs + status checks on `main`
   (`public-repo-guard`, `guard-fixtures`, `ci`, `release-notes-dry-run`).
2. **Security** → enable Dependabot alerts, secret scanning, push protection,
   CodeQL.
3. Add release secrets only if needed (`DOCKERHUB_TOKEN`, `HELM_REPO_TOKEN`).
4. Cut `v0.1.0` — the existing `.github/workflows/release.yml` will run
   `scripts/release-notes.sh` and publish Docker/Helm artifacts.

---

## Re-publishing later

The public repo is treated as a **one-way mirror**. To publish a new version:

1. Land changes in the monorepo's `gateway-oss/` directory as usual.
2. Re-run Phase 1 → Phase 2 → Phase 3 from scratch in a fresh clone.
3. Force-push to `main` if history was rewritten differently
   (`git push --force-with-lease`). Tag releases monotonically.

Until automated mirroring is in place, this is intentionally manual so each
publication is reviewed.

---

## Troubleshooting

- **`git-filter-repo: error: cannot use --force ... not a fresh clone`** —
  re-clone with `git clone --no-local` and retry. filter-repo refuses to run
  on a repo with reflogs/stash from prior work.
- **Guard fails on rewritten tree but not on HEAD** — a historical commit
  introduced a disallowed path; add the path to
  `.git-filter-repo/paths-to-remove.txt` and restart.
- **Token regex matched a legitimate example** — narrow the pattern in
  `.git-filter-repo/replacements.txt` or move the example into a
  guard-exempt file (see `scripts/guard.sh` exemption globs).
