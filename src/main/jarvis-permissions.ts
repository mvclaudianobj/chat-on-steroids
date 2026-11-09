/**
 * Jarvis J3: the only OS permission the app page may receive is an audio-only microphone request
 * from its own main frame (Jarvis push-to-talk; J2's MediaRecorder needs it on Linux and macOS).
 * Everything else, including camera, screen capture and any other page or frame, stays denied.
 */
export interface MicrophoneRequest {
  permission: string;
  /** The requester is the main window's own webContents. */
  fromMainWindow: boolean;
  isMainFrame: boolean;
  requestingUrl: string;
  /** The URL the main window loaded (file:// in packaged builds, the dev server in development). */
  appUrl: string;
  mediaTypes?: readonly string[];
}

const sameApp = (requesting: string, app: string): boolean => {
  try {
    const a = new URL(requesting), b = new URL(app);
    if (a.protocol === 'file:' && b.protocol === 'file:') return a.pathname === b.pathname;
    return (a.protocol === 'http:' || a.protocol === 'https:') && a.origin === b.origin && (b.hostname === 'localhost' || b.hostname === '127.0.0.1');
  } catch { return false; }
};

export function allowJarvisMicrophone(request: MicrophoneRequest): boolean {
  return request.permission === 'media' && request.fromMainWindow && request.isMainFrame &&
    !!request.mediaTypes?.length && request.mediaTypes.every(type => type === 'audio') &&
    !!request.appUrl && sameApp(request.requestingUrl, request.appUrl);
}
