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

## TL;DR — copy-paste checklist

Target public repo: **`https://github.com/stackspine/gateway`**

For routine republishes, the entire flow is wrapped by
`scripts/publish-public-repo.sh`. Run it from the monorepo root after you've
authenticated with GitHub:

```bash
# one-time tooling
brew install gh git-filter-repo            # or: pipx install git-filter-repo
gh auth login --scopes repo,workflow       # browser flow; choose HTTPS
gh auth setup-git                          # wires git to use gh's credential helper
gh auth status                             # should report "Logged in to github.com"

# every publish
./gateway-oss/scripts/publish-public-repo.sh                 # dry run? add --dry-run
# custom owner/name? add: --repo my-org/my-fork
```

> Pushes use **HTTPS** via `gh`'s credential helper — no SSH key required.
> If you prefer SSH, run `gh auth setup-git` after `gh auth login -p ssh` and
> swap the remote URL in `publish-public-repo.sh` back to `git@github.com:...`.

The script:

1. Verifies `git`, `gh`, and `git-filter-repo` are installed and `gh` is
   authenticated.
2. Runs `scripts/preflight-extract.sh` (guard + fixtures + historical audit).
3. Clones the monorepo into a throwaway tmp dir.
4. Runs `git filter-repo` (subdirectory + path scrub + token scrub + mailmap).
5. Runs `guard.sh` on the rewritten worktree.
6. Creates `stackspine/gateway` if it doesn't exist (`gh repo create --public`).
7. Pushes (`--force-with-lease` on republish).
8. Dispatches the `Verify Public Tree` workflow on the public repo.

If the script aborts, fix the cause in the monorepo, commit, and rerun. The
manual phase-by-phase procedure below is the reference for what the wrapper
does.

---

## Prerequisites

- `git` ≥ 2.30
- `git-filter-repo` installed and on `PATH`
  (`pipx install git-filter-repo` or `brew install git-filter-repo`)
- `gh` CLI installed and authenticated with `repo` + `workflow` scopes
  (`gh auth login --scopes repo,workflow`)
- SSH key registered with your GitHub account (or use `https` URLs and a PAT)
- Permission to create repos in the `stackspine` org (or pass `--repo <fork>`)

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
cp gateway-oss/scripts/guard.sh /tmp/ssx-filter-config/guard.sh
cp gateway-oss/scripts/run-guard-fixtures.sh /tmp/ssx-filter-config/run-guard-fixtures.sh

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
bash /tmp/ssx-filter-config/guard.sh .
```

If any step exits non-zero, **stop**. Diagnose, update the relevant config
file back in the monorepo, commit, and restart Phase 2 from a fresh clone.

---

## Phase 3 — Create and push to the public repo

```bash
# Create the empty public repo (skip if it already exists)
gh repo create stackspine/gateway --public \
  --disable-wiki \
  --description "StackSpine Gateway — open-source AI control plane"

# Push the rewritten tree (HTTPS via gh credential helper — no SSH key needed)
gh auth setup-git
git remote add origin https://github.com/stackspine/gateway.git
git push -u origin HEAD:main
git push origin --tags

# Republishing? Force-push with lease instead:
# git push --force-with-lease -u origin HEAD:main
# git push --force-with-lease origin --tags
```

Then, on GitHub:

1. Repo settings → **Branches** → require PRs + status checks on `main`
   (`public-repo-guard`, `guard-fixtures`, `verify-public-tree`, `ci`,
   `release-notes-dry-run`).
2. **Security** → enable Dependabot alerts, secret scanning, push protection,
   CodeQL.
3. Add release secrets only if needed (`DOCKERHUB_TOKEN`, `HELM_REPO_TOKEN`).
4. Cut `v0.1.0` — `.github/workflows/release.yml` runs `release-notes.sh` and
   publishes Docker/Helm artifacts.

---

## Re-publishing later

The public repo is treated as a **one-way mirror**. To publish a new version:

1. Land changes in the monorepo's `gateway-oss/` directory as usual.
2. Re-run `./gateway-oss/scripts/publish-public-repo.sh` (or Phase 1 → 2 → 3
   manually) from a fresh clone.
3. Tag releases monotonically. The wrapper script force-pushes with lease
   when the public repo already exists.

Until automated mirroring is in place, this is intentionally manual so each
publication is reviewed.

---

## Troubleshooting

- **`gh: not authenticated`** — run `gh auth login --scopes repo,workflow`
  and re-check with `gh auth status`.
- **`gh repo create: name already exists`** — the repo exists; the wrapper
  script handles this automatically. For the manual path, skip `gh repo
  create` and use `git push --force-with-lease`.
- **`Permission denied (publickey)` on push** — register your SSH key with
  `gh ssh-key add ~/.ssh/id_ed25519.pub`, or switch the remote to
  `https://github.com/stackspine/gateway.git` and let `gh auth` provide the
  credential.
- **`git-filter-repo: error: cannot use --force ... not a fresh clone`** —
  re-clone with `git clone --no-local` and retry.
- **Guard fails on rewritten tree but not on HEAD** — a historical commit
  introduced a disallowed path; add the path to
  `.git-filter-repo/paths-to-remove.txt` and restart.
- **Token regex matched a legitimate example** — narrow the pattern in
  `.git-filter-repo/replacements.txt` or move the example into a
  guard-exempt file (see `scripts/guard.sh` exemption globs).
