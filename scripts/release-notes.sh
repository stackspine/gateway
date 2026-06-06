#!/usr/bin/env bash
# release-notes.sh
#
# Derive a consistent GitHub Release body from a version tag.
#
# Inputs:
#   $1  version tag (e.g. "v1.2.3" or "1.2.3")
#   $2  output file path (defaults to ./release-notes.md)
#
# Behavior:
#   - Extracts the matching `## [X.Y.Z]` section from CHANGELOG.md.
#     If no section is found, emits a placeholder so releases never ship
#     with empty notes.
#   - Appends a Compatibility section with the Docker image, Helm chart,
#     DB schema reference, SDK semver range, and a link to the full
#     compatibility matrix in deploy/SELF-HOST.md.
#
# This script is the single source of truth for release-note formatting.
# Both the release.yml workflow and local dry-runs invoke it so the
# rendered notes are identical everywhere.

set -euo pipefail

TAG="${1:?usage: release-notes.sh <tag> [output-file]}"
OUT="${2:-release-notes.md}"

VERSION="${TAG#v}"
MAJOR="${VERSION%%.*}"
NEXT_MAJOR=$((MAJOR + 1))

CHANGELOG="${CHANGELOG_PATH:-CHANGELOG.md}"

extract_section() {
  awk -v v="${VERSION}" '
    $0 ~ "^## \\[" v "\\]" { flag = 1; print; next }
    flag && /^## \[/        { exit }
    flag                    { print }
  ' "${CHANGELOG}"
}

SECTION="$(extract_section || true)"

{
  if [[ -n "${SECTION}" ]]; then
    printf '%s\n' "${SECTION}"
  else
    echo "## [${VERSION}]"
    echo ""
    echo "_No changelog entry was found for this version in \`CHANGELOG.md\`._"
    echo "_Add a \`## [${VERSION}]\` section before the next release._"
  fi
  echo ""
  echo "## Compatibility"
  echo ""
  echo "| Component | Version |"
  echo "|---|---|"
  echo "| Docker image | \`ghcr.io/stackspine/gateway:${VERSION}\` |"
  echo "| Helm chart   | \`oci://ghcr.io/stackspine/charts/stackspine:${VERSION}\` |"
  echo "| DB schema    | \`migrations/000_core_schema.sql\` @ ${VERSION} |"
  echo "| SDK range    | \`>=${MAJOR}.0.0 <${NEXT_MAJOR}.0.0\` |"
  echo ""
  echo "See [deploy/SELF-HOST.md](./deploy/SELF-HOST.md#compatibility-matrix) for the full matrix."
  echo ""
  echo "## Install"
  echo ""
  echo "\`\`\`bash"
  echo "# Docker"
  echo "docker pull ghcr.io/stackspine/gateway:${VERSION}"
  echo ""
  echo "# Helm"
  echo "helm install stackspine oci://ghcr.io/stackspine/charts/stackspine \\"
  echo "  --version ${VERSION}"
  echo "\`\`\`"
} > "${OUT}"

echo "✅ Wrote release notes for ${VERSION} → ${OUT}"
