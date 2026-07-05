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

> **Precondition: a clean working tree.** The script owns every file it touches (version bumps +
> `CHANGELOG.md`), so it refuses to run with uncommitted or staged changes — commit or stash first.

The script will:
1. ✅ Validate the version (semantic versioning: X.Y.Z)
2. ✅ **Roll `CHANGELOG.md` automatically** (done *first*, before the version bumps): move the
   `[Unreleased]` section to `[0.12.1] - <today>` (today's date, YYYY-MM-DD), repoint the `[Unreleased]`
   compare link to the new tag, and add the `[0.12.1]` compare link beneath it — deriving the repo URL +
   previous version from the existing footer link (nothing hardcoded). It **aborts if `[Unreleased]` is
   empty** (won't cut an empty release).
3. ✅ Bump `version` in all six packages: `package.json`, `packages/contract/package.json`,
   `packages/core/package.json`, `apps/api/package.json`, `apps/admin/package.json`,
   `apps/secure-chat/package.json` (`packages/core` matters — the runtime/log service version is read
   from its `package.json` via `lib/version.ts`)
4. ✅ Create a commit `chore(release): v0.12.1`
5. ✅ Create a git tag `v0.12.1`

There is **no manual CHANGELOG pause** — the script does the roll for you. Just keep the `[Unreleased]`
section current as you merge work (per [Keep a Changelog](https://keepachangelog.com)); the release
turns it into the versioned section. See [`CHANGELOG.md`](../CHANGELOG.md) for the format.

### Step 3: Push and publish
Once the script completes:
```bash
git push  # push the release commit
git push --tags  # push the v0.12.1 tag
```

**GitHub Actions will automatically:**
- Build `@agora-server/contract@0.12.1`
- Publish it to npm (if not already published)
- Build + push the Docker images on the release tag (`docker-publish.yml`)

> The npm-publish workflow (`npm-publish.yml`) runs on `v*` tags. It reads the package version from `packages/contract/package.json`, so the version bump MUST land in the release commit — it's gated by the npm-publish workflow's check: `if npm view @agora-server/contract@X.Y.Z exists, skip`.

## What Gets Published

- **`@agora-server/contract@X.Y.Z`** — the shared API contract (Apache-2.0, public)
- **`@agora/api`** — marked `private: true`, never published
- **`@agora/admin`** — marked `private: true`, never published
- **Docker images** — `agora-api`, `agora-scorer-worker`, etc. (built + pushed by `docker-publish.yml`)

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
