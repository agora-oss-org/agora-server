# Release Process

Agora uses **semantic versioning** (X.Y.Z). All `@agora-*` packages ship on the same version, even if only one changed (monorepo convention).

## Publishing a Release

### Step 1: Prepare changes
Ensure all code is committed and `main` is up-to-date:
```bash
git checkout root  # or your main branch
git pull
```

### Step 2: Run the release script
```bash
./scripts/release.sh 0.12.1
```

The script will:
1. ✅ Validate the version (semantic versioning: X.Y.Z)
2. ✅ Bump `version` in: `package.json`, `packages/contract/package.json`, `apps/api/package.json`, `apps/admin/package.json`
3. ⏸️  **Pause** — wait for you to update `CHANGELOG.md` manually
4. ✅ Create a commit `chore(release): v0.12.1`
5. ✅ Create a git tag `v0.12.1`

### Step 3: Update CHANGELOG.md (during the pause)
The script pauses and asks you to update `CHANGELOG.md`:

1. **Find the `[Unreleased]` section** at the top
2. **Rename it to `[v0.12.1] - 2026-06-16`** (use today's date, YYYY-MM-DD format)
3. **Update the compare links** at the bottom of the file:
   ```markdown
   [v0.12.1]: https://github.com/jenova-marie/agora-server/compare/v0.12.0...v0.12.1
   [v0.12.0]: https://github.com/jenova-marie/agora-server/compare/v0.11.0...v0.12.0
   ```
4. **Create a new `[Unreleased]` section** for future work:
   ```markdown
   ## [Unreleased]

   ### Added
   ### Changed
   ### Fixed
   ### Removed
   ```
5. **Save the file** and return to the script (press Enter)

See [`CHANGELOG.md`](../CHANGELOG.md) and [Keep a Changelog](https://keepachangelog.com) for format details.

### Step 4: Push and publish
Once the script completes:
```bash
git push  # push the release commit
git push --tags  # push the v0.12.1 tag
```

**GitHub Actions will automatically:**
- Build `@agora-server/contract@0.12.1`
- Publish it to npm (if not already published)
- Docker images are built on release tags too (if configured)

> The npm-publish workflow (`npm-publish.yml`) runs on `v*` tags. It reads the package version from `packages/contract/package.json`, so the version bump MUST land in the release commit — it's gated by the npm-publish workflow's check: `if npm view @agora-server/contract@X.Y.Z exists, skip`.

## What Gets Published

- **`@agora-server/contract@X.Y.Z`** — the shared API contract (Apache-2.0, public)
- **`@agora/api`** — marked `private: true`, never published
- **`@agora/admin`** — marked `private: true`, never published
- **Docker images** — `agora-api`, `agora-scorer-worker`, etc. (if docker-publish.yml is configured)

## Troubleshooting

### "Tag v0.12.1 already exists"
The tag already exists. Either:
- Increment to a higher version: `./scripts/release.sh 0.12.2`
- Delete the old tag and try again (only if it hasn't been pushed): `git tag -d v0.12.1`

### "You have uncommitted changes"
Commit or stash them first:
```bash
git add . && git commit -m "..."
# or
git stash
```

### Release script failed mid-way
Manually undo:
```bash
git reset --hard HEAD~1  # undo the commit
git tag -d v0.12.1      # undo the tag
```

Then investigate the error and try again.

### npm-publish didn't trigger on the tag
Check:
1. Is `NPM_TOKEN` set in the repo's GitHub Actions secrets?
2. Did the tag push successfully? `git push --tags`
3. Does the contract's `package.json` version match the tag (e.g., tag `v0.12.1` and `packages/contract/package.json` has `"version": "0.12.1"`)?

## Why This Process

- **Monorepo version parity** — all `@agora-*` packages ship together, even if only the contract changed
- **Semantic versioning** — X.Y.Z is enforced by the release script
- **CHANGELOG-driven** — you control what gets documented per release (the script doesn't auto-generate)
- **Idempotent npm publish** — the workflow checks if the version is already on npm; if it is, it skips (safe to re-run on the tag if something fails)
- **One source of truth** — package.json versions are the publish trigger; git tags are just pointers

---

**See also:** `npm-publish.yml` (GitHub Actions workflow), `.github/workflows/` (all CI/CD).
