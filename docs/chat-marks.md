# Chat Marks

This fork started at the official Chat On Steroids v2.1.36 tag (`816b5993`)
and has incorporated the 82 subsequent upstream commits through `cc41c538`.
Both points declare package version `2.1.36`. This fork uses
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

## Automatic releases and application updates

- **Release source:** only [Marks GitHub Releases](https://github.com/mvclaudianobj/chat-on-steroids/releases/latest), never upstream. The installed app checks on startup, about every six hours thereafter, and again when Settings opens after a stale check.
- **Publishing:** a pushed version tag such as `v2.1.37` runs `.github/workflows/publish.yml` on the Marks repository. GitHub Actions builds Windows, macOS and Linux installers from that tagged commit, assembles the matching Chrome extension and `SHA256SUMS.txt`, checks the checksums and publishes the GitHub Release. The post-publication verification job checks the release artifacts. Enable GitHub Actions and give GitHub Actions permission to write releases in the repository settings.
- **Versioning:** the release tag must match the versions in `package.json`, `package-lock.json`, `extension/manifest.json`, `src/main/version.ts`, the latest `CHANGELOG.md` entry, and `docs/release-notes/v<VERSION>.md`. Bump these *together* for each new build. A rebuild keeping version `2.1.36` is **not** considered newer than an installed `2.1.36`.
- **Safe update policy:** Windows and Linux **AppImage** download the matching versioned artifact, validate its published SHA-256 and offer installation. Linux **DEB** and macOS notify and offer the exact manual download (they do not silently replace system packages or unsigned macOS apps). Installing is always initiated by the user.
- **Release procedure:** commit the version bump and release notes, push that commit to `marks/main`, create the same version tag on it, and push **only** that tag to `marks`. Example: `git tag v2.1.37 && git push marks main && git push marks v2.1.37`. Never use a force push. If publication does not start automatically, use GitHub Actions → Publish release → Run workflow on that tag.

No release can be offered until a stable release with a higher numeric version and the matching artifacts exists on the Marks GitHub repository. The fork's default GitHub Actions workflows are distinct from upstream's releases.

Validation on 2026-10-14 after merging the later upstream fixes: `npm run
typecheck` and `npm run build` passed. Seven targeted suites passed (131 tests),
covering updates, connector names, localized main text, plugin refresh,
notifications and keep-awake behavior.
The wider extension/content script test run had one failure in 904 content tests;
this is not claimed as a complete clean suite or live-installed verification.
