#!/bin/bash
# Release script: bump versions in all package.json files, update CHANGELOG, and create a tagged commit.
# Usage: ./scripts/release.sh 0.12.0
#
# This script:
# 1. Validates the version format (semantic versioning)
# 2. Bumps version in: root, packages/contract, packages/core, apps/api, apps/admin, apps/secure-chat
# 3. Auto-updates CHANGELOG.md: moves [Unreleased] → [<VERSION>] - <today> and fixes the compare
#    links (aborts if [Unreleased] is empty — won't cut an empty release)
# 4. Stages the version bumps + CHANGELOG
# 5. Commits with message "chore(release): v<VERSION>"
# 6. Creates a git tag "v<VERSION>"
#
# WARNING: If anything fails, you'll need to manually reset:
#   git reset --hard HEAD~1 (to undo the commit)
#   git tag -d v<VERSION> (to undo the tag)

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.12.1"
  exit 1
fi

VERSION="$1"
RELEASE_DATE="$(date +%F)"  # today's date, YYYY-MM-DD, for the CHANGELOG heading

# Validate semantic versioning (X.Y.Z)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ Invalid version: $VERSION"
  echo "Expected semantic versioning (e.g., 0.12.1)"
  exit 1
fi

# Check if tag already exists
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "❌ Tag v$VERSION already exists"
  exit 1
fi

# Require a clean tree — the script now owns every file it touches (version bumps + CHANGELOG),
# so the release commit is exactly those changes and nothing accidentally swept in.
if ! git diff --quiet -- . || ! git diff --cached --quiet -- .; then
  echo "❌ You have uncommitted changes. Please commit or stash them first."
  exit 1
fi

# ── Update CHANGELOG.md FIRST: move [Unreleased] → [VERSION] - DATE + fix the compare links. ─────────
# Done before the version bumps so the most likely abort (an empty [Unreleased]) leaves the tree
# untouched. The repo URL + previous version are derived from the existing [Unreleased] compare link,
# so nothing is hardcoded. Refuses to cut a release whose [Unreleased] has no entries.
echo "📝 Updating CHANGELOG.md ($VERSION, $RELEASE_DATE)..."
VERSION="$VERSION" RELEASE_DATE="$RELEASE_DATE" node -e '
  const fs = require("fs");
  const file = "CHANGELOG.md";
  const VERSION = process.env.VERSION, DATE = process.env.RELEASE_DATE;
  const lines = fs.readFileSync(file, "utf8").split("\n");

  const unrIdx = lines.findIndex((l) => /^## \[Unreleased\]/.test(l));
  if (unrIdx === -1) { console.error("❌ CHANGELOG.md: no \"## [Unreleased]\" heading"); process.exit(1); }
  let nextIdx = lines.findIndex((l, i) => i > unrIdx && /^## \[/.test(l));
  if (nextIdx === -1) nextIdx = lines.length;

  // Body under [Unreleased], trimmed of surrounding blank lines. Must contain at least one bullet.
  let body = lines.slice(unrIdx + 1, nextIdx);
  while (body.length && body[0].trim() === "") body.shift();
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  if (!body.some((l) => /^\s*-\s+\S/.test(l))) {
    console.error("❌ CHANGELOG.md: [Unreleased] has no entries — refusing to cut an empty release.");
    process.exit(1);
  }

  // Reassemble: keep an empty [Unreleased], insert the new version section with the captured body.
  const head = lines.slice(0, unrIdx);
  const tail = lines.slice(nextIdx);
  const moved = ["## [Unreleased]", "", `## [${VERSION}] - ${DATE}`, "", ...body, ""];
  let out = [...head, ...moved, ...tail].join("\n");

  // Footer compare links: repoint [Unreleased] to the new tag and add the [VERSION] line beneath it.
  const re = /^\[Unreleased\]:\s*(.*)\/compare\/v(\d+\.\d+\.\d+)\.\.\.HEAD\s*$/m;
  const m = out.match(re);
  if (!m) { console.error("❌ CHANGELOG.md: could not parse the [Unreleased] compare link in the footer"); process.exit(1); }
  const base = m[1], prev = m[2];
  if (prev === VERSION) { console.error(`❌ CHANGELOG.md: previous version in footer is already ${VERSION}`); process.exit(1); }
  out = out.replace(re, `[Unreleased]: ${base}/compare/v${VERSION}...HEAD\n[${VERSION}]: ${base}/compare/v${prev}...v${VERSION}`);

  fs.writeFileSync(file, out);
  console.error(`  ✓ CHANGELOG.md: [Unreleased] → [${VERSION}] - ${DATE} (previous ${prev})`);
'

echo "📦 Bumping version to $VERSION..."

# Helper: bump version in a package.json
bump_version() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "⚠️  File not found: $file (skipping)"
    return
  fi
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$file', 'utf8'));
    pkg.version = '$VERSION';
    fs.writeFileSync('$file', JSON.stringify(pkg, null, 2) + '\n');
  "
  echo "  ✓ $file"
}

bump_version "package.json"
bump_version "packages/contract/package.json"
bump_version "packages/core/package.json"
bump_version "apps/api/package.json"
bump_version "apps/admin/package.json"
bump_version "apps/secure-chat/package.json"

echo ""
echo "🔗 Staging version bumps + CHANGELOG..."
git add package.json packages/contract/package.json packages/core/package.json apps/api/package.json apps/admin/package.json apps/secure-chat/package.json CHANGELOG.md

echo "💾 Creating release commit..."
git commit -m "chore(release): v$VERSION"

echo "🏷️  Creating tag v$VERSION..."
git tag "v$VERSION"

echo ""
echo "✅ Release v$VERSION complete!"
echo ""
echo "📤 Next step (when ready): git push && git push --tags"
echo "   This will trigger GitHub Actions to publish the npm package."
