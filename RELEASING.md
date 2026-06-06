# Releasing StackSpine Gateway

This document describes how maintainers cut a release of the open-source gateway
and its SDKs. Contributors do not need to follow this — opening a PR is enough.

## Versioning

StackSpine Gateway follows [Semantic Versioning 2.0.0](https://semver.org/).

| Bump | When |
|------|------|
| `MAJOR` | Breaking change to the HTTP API, on-disk schema, or SDK public surface |
| `MINOR` | New feature, new provider, additive schema column, additive SDK method |
| `PATCH` | Bug fix, dependency bump, docs-only change, performance fix |

The gateway image, the database schema, and all five SDKs share the same
version number. They are cut together so the compatibility matrix is trivial.

## Compatibility

| Gateway image | Required schema | Supported SDK range |
|---------------|-----------------|---------------------|
| `1.x`         | `migrations/000_core_schema.sql` at `1.x` | `>=1.0.0 <2.0.0` |

Rules:

- The gateway will refuse to start if the migration version recorded in the
  `schema_migrations` table is newer than its own major.
- Older SDKs in the same major continue to work against newer gateways within
  that major; new endpoints are additive.
- Cross-major upgrades require running migrations between the two versions.

## Release process

1. **Open a release PR**
   - Bump `CHANGELOG.md`: move "Unreleased" entries under a new `## [X.Y.Z] — YYYY-MM-DD` heading.
   - Confirm `deno test` and `bash scripts/scan-disclosure.sh` both pass locally.
2. **Merge to `main`**
   - CI must be green, including `public-repo-guard` and `scan-disclosure`.
3. **Tag**
   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. **Create a GitHub Release** from the tag and paste the changelog section.
   Publishing the release triggers `.github/workflows/release.yml`, which:
   - Re-runs the disclosure scan as a hard gate.
   - Publishes the Docker image to `ghcr.io/stackspine/gateway:X.Y.Z` and `:latest`.
   - Publishes SDKs to npm, PyPI, crates.io, and RubyGems with the tag version.
5. **Smoke test the published image**
   ```bash
   docker run --rm ghcr.io/stackspine/gateway:X.Y.Z --version
   ```

## Hotfixes

Branch from the latest release tag, cherry-pick the fix, bump `PATCH`, and
follow the release process from step 3.

## Yanking a release

If a release is unsafe:

- Mark the GitHub Release as a pre-release and add a `YANKED` note at the top of the changelog entry.
- `npm deprecate stackspine@X.Y.Z "yanked: <reason>"` (and equivalents for the other registries).
- Do not delete tags — downstream lockfiles depend on them.

## Maintainer checklist

- [ ] Changelog updated and dated
- [ ] `scripts/scan-disclosure.sh` clean
- [ ] All CI jobs green
- [ ] Compatibility matrix in `deploy/SELF-HOST.md` reflects the new version
- [ ] Tag signed and pushed
- [ ] GitHub Release published
- [ ] Smoke test of `ghcr.io/stackspine/gateway:X.Y.Z`
