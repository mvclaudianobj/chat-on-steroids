# Integrating stable community releases into Chat Marks

Use the `upstream` remote for `https://github.com/totec448-spec/chat-on-steroids` and the `marks` remote for `https://github.com/mvclaudianobj/chat-on-steroids`. Keep community patches and authorship traceable in Git history. Review all integration conflicts and preserve intentional Marks customizations.

## Version policy

The first **three** numbers of a Marks release (`X.Y.Z`) are exactly the official community **published stable release** version being integrated. The fourth number (`.N`) counts Marks revisions **within that base version**, starting at `.1` after adopting a new upstream stable release. An additional Marks revision increments only `.N`. An upstream release replaces all three base numbers and restarts `.N` at 1.

| Official community | Marks product/tag | `package.json` and lockfile (`npm` SemVer) |
| --- | --- | --- |
| `v2.1.37` | `v2.1.37.1` | `2.1.37+1` |
| `v2.1.37` | `v2.1.37.2` | `2.1.37+2` |
| `v2.1.38` | `v2.1.38.1` | `2.1.38+1` |

Avoid plain `X.Y.Z` for Marks releases. npm package versions cannot be four-part (`X.Y.Z.N`), so the fourth Marks number is represented as SemVer build metadata (`+N`) in npm and as `.N` in the product/version, release tag, extension, installer and changelog. npm considers build metadata equal in SemVer precedence, so updater/release comparators must explicitly compare the numeric product revision; do not rely on npm's native version ordering. Follow `scripts/release-version.mjs` and `scripts/verify-release-version.mjs` for the current build encoding.

## Check and prepare safely

Run from the project root:

```sh
node scripts/check-community-release.mjs
```

This checks GitHub's *latest published stable release* (not a draft, prerelease or untagged `main` commit), checks that `upstream` points to the official community repository, verifies the release's exact remote Git tag, shows the current Marks version and any dirty files, and prints the next version and suggested integration commands. It never modifies the repository. It requires network access to GitHub.

If integration is approved and your tree is clean, fetch only the release's exact upstream tag:

```sh
node scripts/check-community-release.mjs --fetch
```

`--fetch` changes **only** a release-specific remote-tracking ref, `refs/remotes/upstream/releases/vX.Y.Z`. It never checks out, merges, commits, tags, pushes, edits source files or switches branches. Its printed commit counts compare your checked-out `HEAD` with this exact release, which is distinct from moving `upstream/main`.

For the actual merge, finish or isolate any dirty changes first. Work on a fresh integration branch with the exact release ref (`git switch -c integration/community-vX.Y.Z`), review `git log --oneline HEAD..refs/remotes/upstream/releases/vX.Y.Z` and `git diff`, then **manually** run `git merge --no-ff --no-commit refs/remotes/upstream/releases/vX.Y.Z`. Resolve conflicts deliberately, keep source attribution, validate the app and installers, update every version-bearing file and changelog/release notes together, then submit changes for review. `--no-commit` is for inspection of the merge result, not a guarantee that all Git integration state can be undone without care; never discard a dirty working tree.

Stable upstream X.Y.Z always determines the first three numbers, even if upstream `main` contains unreleased newer commits. A Marks-only release retains those first three numbers and increments N. A newer upstream stable release resets N to 1. Never silently merge upstream or push changes based solely on the check's output. Publishing to the `marks` GitHub repository remains a separately reviewed action; it does not change the community remote.

## Marks extension compatibility preflight

Keep Marks-specific implementation in `src/main/marks-*`, `src/shared/marks-*`
and `src/renderer/marks-*` adapters where practical; minimize integration hooks
in upstream-managed files. The Agency Skills UI lives in
`src/renderer/marks-agency-skills.ts`; `skills-library.ts` delegates to it.

Run this non-destructive check before every integration:

```sh
node scripts/marks-upstream-preflight.mjs
node scripts/marks-upstream-preflight.mjs --require-clean
```

These commands inspect already-fetched refs and a virtual Git merge. They never
fetch, switch, merge, commit, tag or push. They show overlaps and conflicts and
block a dirty working tree. They **do not** establish that a cached upstream
ref is the latest stable release: use `check-community-release.mjs` for that.
After fetching the official published release, inspect that exact ref with
`node scripts/marks-upstream-preflight.mjs --ref=refs/remotes/upstream/releases/vX.Y.Z`.
The `--main` option previews unreleased changes only. A conflict-free preview
does not prove runtime compatibility and cannot include uncommitted Marks edits.

Do not merge until in-progress local changes are safely preserved and
reviewed. Merge an official stable tag into a new integration branch, retain
Marks behavior and attribution, run frontend/backend/typecheck/build tests,
then adjust all version-bearing files together. Publish only to the `marks`
remote using the terminal after validation. Never rewrite a public tag.

## Verification and exceptions

Check `git status`, run `npm run typecheck`, the relevant test suites, `npm run verify` and packaging checks where appropriate. `node scripts/verify-release-version.mjs` should validate all version sources and the new product tag before release. Verify the final installed updater behavior separately; a correct source tree does not prove a deployed release.

If GitHub is unreachable, the checker fails instead of treating a cached ref as the latest release. If upstream's tag is missing, rewritten, a prerelease, or older than the current Marks base, the checker refuses to suggest a downgrade. Review upstream release notes, ownership changes and major dependency updates before merging.
