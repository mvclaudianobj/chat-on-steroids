# Chat Marks Firefox add-on: publication and update checks

The Firefox add-on is built from `extension/` by `scripts/stage-firefox-extension.mjs`.
The Chrome manifest intentionally has no Gecko `update_url`. Staging gives the Firefox
package the permanent ID `companion@chatmarks.app`, the Firefox background module and
`update_url=https://github.com/mvclaudianobj/chat-on-steroids/releases/latest/download/firefox-updates.json`.
Never change the ID to fix an update: that would break existing installations.

**Why an installed add-on remains at 2.1.44.1:** changing the desktop app, the source
manifest or the staged tree does not install a Firefox update. Firefox obtains updates
only from the **published** `firefox-updates.json`, which must point to a real Mozilla-
signed `Chat-Marks-Firefox.xpi` with the exact Gecko ID, matching version and SHA-256.
The public `v2.1.46.1` release inspected on 2026-10-29 contains only a Debian QA
asset, without either Firefox asset. Consequently that release cannot update the
installed add-on. A future release must provide both assets and pass the checks below;
the current app's version stamp alone provides no update to Firefox.

Before a release, the repository owner must configure **GitHub Actions secrets**
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET` using their Mozilla Add-ons API credentials.
Do not put the values into source, history or a chat. Run the manual
`firefox-sign-check.yml` workflow against a probe Gecko ID to validate signing and
Mozilla's review. The `publish.yml` workflow signs the release version using `web-ext
sign --channel=unlisted` and publishes the signed XPI and update manifest alongside
the desktop artifacts. AMO permits one signing per version: if the version is already
held, publish the next legitimate Chat Marks revision instead of reusing a version.

After publishing, check these independently:

1. Release `vX.Y.Z[.N]` contains `Chat-Marks-Firefox.xpi` and `firefox-updates.json`.
2. The `/releases/latest/download/firefox-updates.json` endpoint is publicly readable
   and its `addons["companion@chatmarks.app"].updates[0]` names the expected version.
3. Its `update_link` downloads the signed XPI; `update_hash` matches that file's SHA-256.
4. `node scripts/firefox-update-manifest.mjs --verify-signed <xpi> <version>` succeeds.
5. Install in a fresh Firefox test profile and verify bridge pairing, popup, tab handling,
   MV3 background persistence and upgrade from an existing version. Test real Firefox
   separately: staging, unit tests and a successful signing job do not prove runtime behavior.

`src/main/ipc.ts` opens the version-specific release asset when Setup requests the
Firefox add-on. If a new release is missing it, Setup cannot download that release's
XPI. Publish it before offering that version to users.
