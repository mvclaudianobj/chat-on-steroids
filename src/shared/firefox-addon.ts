/**
 * The Firefox add-on: the signed companion each release publishes beside the installers.
 *
 * Firefox installs only add-ons Mozilla signed. Releases attach the self-hosted ("unlisted")
 * signed package under the fork's own Gecko ID, and Setup opens the one for this app's version, so
 * app and add-on start out on the same build. Firefox keeps it current through the update
 * manifest named in the add-on itself.
 */
import { isReleaseVersion } from './types.js';

export const FIREFOX_ADDON_ASSET = 'Chat-Marks-Firefox.xpi';
const RELEASES = 'https://github.com/mvclaudianobj/chat-on-steroids/releases/download';

export function firefoxAddonUrl(version: string): string {
  if (!isReleaseVersion(version)) throw new Error('Not a release version');
  return `${RELEASES}/v${version}/${FIREFOX_ADDON_ASSET}`;
}
