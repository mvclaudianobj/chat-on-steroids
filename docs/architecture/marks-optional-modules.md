# Chat Marks: optional modules and Skills

The base desktop app contains only the **module manager**, source metadata, and
minimal adapters. Do not package third-party service binaries, whole GitHub
repositories, agent catalogs or downloadable module archives into the desktop
installer.

## Source registry

`src/shared/module-sources.ts` is a typed, reviewed registry. A descriptor is
**data, not a command or permission**. The supported source categories are:

| Source | Intended installation | Required integrity |
| --- | --- | --- |
| GitHub upstream | Explicitly open verified official installation instructions | Review repository identity; prefer pinned release and digest for future managed downloads |
| Marks Drive | Future explicit file download (not yet implemented) | Verified SHA-256 and trusted manifest; no arbitrary URL supplied by model |
| System package manager | Future user-approved package-manager adapter (not yet implemented) | Fixed package identity and repository trust; root elevation only for that specific approved operation |

The only registered external module today is CLIProxyAPI, which **continues
to use its existing systemd service**. The installation button opens its
official repository documentation; the update button opens the publisher's
releases page. **Neither performs an installation or upgrades the service.**
They never execute remote installers or call `sudo`/`pkexec`. Service
start/stop/restart is a distinct existing operation with a narrowly scoped
PolicyKit command. Do not present source browsing as a completed upgrade.

## Lifecycle contract for new modules

1. **Discover** only signed/trusted or pinned catalog metadata; no executable
   downloads on app startup. An offline app should still open normally.
2. **Inspect** provenance, requested access, platform, version and expected
   size; distinguish available from installed and from running.
3. **Install** only after explicit user confirmation. Verify content hash,
   bound size, path and package identity; refuse links, traversal, extra
   executable hooks and command strings supplied by remote metadata.
4. **Activate** a module as a separate preference, never silently enable its
   operating-system service or grant privileged access.
5. **Open** third-party management UIs in isolated, sandboxed Electron windows
   with no Node integration and restricted navigation, not inside privileged
   renderer iframes.
6. **Check updates** by fetching bounded metadata; show available versions or
   changed files without replacing installed content.
7. **Update/remove** only with explicit confirmation, with rollback for future
   managed packages and preservation of user data/configuration. Never
   automatically run remote scripts.

## Agency Agents / Marks Skills

The `msitarzewski/agency-agents` catalog is **not bundled**. Opening Skills
loads a bounded GitHub tree pinned to a commit, without downloading agent
instructions. Each explicitly imported agent becomes one managed `SKILL.md`
with source attribution and license. The managed library's 64-skill limit
still applies. The repository-refresh button should update catalog metadata
first; replacing an installed skill requires a separate confirmation.

**Do not conflate** changing the catalog's upstream SHA with permission to
overwrite a locally modified Skill. Record provenance per imported item and
check its installed contents before offering any replacement.

## Release policy

These are source changes for a *future* Chat Marks build. They do not mutate
the published `v2.1.38.1` binaries. No GitHub Actions or remote publication
is required to add/remove optional content after the eventual base release.
