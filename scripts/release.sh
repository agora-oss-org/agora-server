#!/bin/bash
# Release script: bump versions in all package.json files, update CHANGELOG, and create a tagged commit.
# Usage: ./scripts/release.sh 0.12.0
#
# This script:
# 1. Validates the version format (semantic versioning)
# 2. Bumps version in: root, packages/contract, apps/api, apps/admin
# 3. Reminds you to update CHANGELOG.md manually (it won't auto-update)
# 4. Stages the version bumps
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

# Check for uncommitted changes (except CHANGELOG which the user will update)
if ! git diff --quiet -- . ':!CHANGELOG.md'; then
  echo "❌ You have uncommitted changes (excluding CHANGELOG.md). Please commit or stash them first."
  exit 1
fi

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
bump_version "apps/api/package.json"
bump_version "apps/admin/package.json"

echo ""
echo "📝 Next step: Update CHANGELOG.md"
echo "   1. Move the [Unreleased] section to [v$VERSION] with today's date"
echo "   2. Update the compare links at the bottom"
echo "   3. Save the file"
echo ""
echo "   ⏸️  Pausing — press Enter once you've updated CHANGELOG.md"
read -p ""

# Check if CHANGELOG was updated
if ! git diff --quiet CHANGELOG.md; then
  echo "✓ CHANGELOG.md detected"
else
  echo "⚠️  CHANGELOG.md was not modified (is that intentional?)"
fi

echo ""
echo "🔗 Staging version bumps + CHANGELOG..."
git add package.json packages/contract/package.json apps/api/package.json apps/admin/package.json CHANGELOG.md

echo "💾 Creating release commit..."
git commit -m "chore(release): v$VERSION"

echo "🏷️  Creating tag v$VERSION..."
git tag "v$VERSION"

echo ""
echo "✅ Release v$VERSION complete!"
echo ""
echo "📤 Next step (when ready): git push && git push --tags"
echo "   This will trigger GitHub Actions to publish the npm package."
