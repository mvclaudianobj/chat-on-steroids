# Chat Marks

This fork started at the official Chat On Steroids v2.1.36 tag (`816b5993`)
and incorporated the official v2.1.38 release (`84ecbd69`) into Chat Marks
v2.1.38.1. Later community improvements are adopted only through reviewed
upstream merges, not untagged automatic updates. This fork uses
**Chat Marks** for its app, connectors, extension and installation labels.

The application and Chrome extension icons are generated from `icon_marks.png`
(the transparent metallic wolf artwork). Run `npm run icon` to regenerate the
multi-resolution Windows ICO, macOS/Linux app icons, browser card and extension
assets without changing the source's colours or alpha details.

The bridge protocol, app ID, internal package name and persistent data locations
retain their upstream identifiers to preserve compatibility with existing settings
and connector installations. Third-party license, authorship and upstream source
references remain attributed to their owners.

The customized updater targets `mvclaudianobj/chat-on-steroids` and the fork's
`Chat-Marks-*` release assets. A fork release must publish matching
artifacts and checksums before automatic updates can be applied.

## Manually reviewed releases and application updates

- **Release source:** only [Marks GitHub Releases](https://github.com/mvclaudianobj/chat-on-steroids/releases/latest), never upstream. The installed app checks on startup, about every six hours thereafter, and again when Settings opens after a stale check.
- **Publishing:** Chat Marks currently publishes manually through Git and the GitHub CLI (`gh`). Do **not** initiate a new GitHub Actions run to publish Marks. Upload only installers built from and attributable to the intended new commit; compare their versions and SHA-256 with the official assets. Publishing a tag does not prove that a release is complete. Existing artifacts from earlier runs may be reused only with verified commit provenance and successful platform-specific checks.
- **Versioning:** the release tag must match the versions in `package.json`, `package-lock.json`, `extension/manifest.json`, `src/main/version.ts`, the latest `CHANGELOG.md` entry, and `docs/release-notes/v<VERSION>.md`. Bump these *together* for each new build. A rebuild keeping version `2.1.36` is **not** considered newer than an installed `2.1.36`.
- **Safe update policy:** Windows and Linux **AppImage** download the matching versioned artifact, validate its published SHA-256 and offer installation. Linux **DEB** and macOS notify and offer the exact manual download (they do not silently replace system packages or unsigned macOS apps). Installing is always initiated by the user.
- **Release procedure:** prepare and validate a new Marks revision (e.g. community 2.1.38 → Marks 2.1.38.2); verify the source commit, all artifacts and checksums, then push the reviewed commit only to `marks`, create a **new** annotated tag and upload assets using `gh release create` / `gh release upload`. Never force-push, rewrite an existing published tag or publish an unsigned Firefox XPI. If a platform's artifact cannot be verified, report the release as incomplete; do not upload an unrelated build as a substitute.

No release can be offered until a stable Marks release with a higher numeric version and matching verified assets exists in the Marks GitHub repository. The fork's GitHub Actions workflows are distinct from upstream's releases but are not the current publishing path.

**Upstream compatibility:** use `node scripts/check-community-release.mjs` to verify the latest published community version, then `node scripts/marks-upstream-preflight.mjs --ref=refs/remotes/upstream/releases/vX.Y.Z` for the local conflict preview. Complete/secure all staged and untracked work before an actual merge; see `docs/community-merge.md`. Marks Agency Skills and external module sources are isolated under `marks-*` adapters so the upstream-managed files retain minimal hooks.

Validation on 2026-10-14 after merging the later upstream fixes: `npm run
typecheck` and `npm run build` passed. Seven targeted suites passed (131 tests),
covering updates, connector names, localized main text, plugin refresh,
notifications and keep-awake behavior.
The wider extension/content script test run had one failure in 904 content tests;
this is not claimed as a complete clean suite or live-installed verification.
