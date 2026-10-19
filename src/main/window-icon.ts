import path from 'node:path';

/**
 * Linux window managers do not reliably recover the icon from AppImage metadata on direct
 * launches. Windows can also show a generic taskbar icon when the running window has no native
 * icon, even when the installer and desktop shortcut have the correct executable icon.
 * Both packaged platforms ship the same PNG generated from icon_marks.png, while development
 * launches can use the tracked source PNG without depending on a prior packaging run.
 * macOS continues using its application bundle icon.
 */
export function browserWindowIconPath(
  platform: NodeJS.Platform,
  packaged: boolean,
  resourcesPath: string
): string | undefined {
  if (platform !== 'linux' && platform !== 'win32') return undefined;
  return packaged ? path.join(resourcesPath, 'runtime-icon.png') : path.join(process.cwd(), 'icon_marks.png');
}
