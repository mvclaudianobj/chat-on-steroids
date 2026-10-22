/**
 * Chat Marks: modules that install an upstream CLI from its official GitHub release into the
 * user's module folder (Settings > Modules): OpenCode (also the `opencode` chat engine) and
 * ZeroClaw. Shared shapes only; no paths, binaries or secrets cross to the renderer.
 */
export const UPSTREAM_MODULE_IDS = ['opencode', 'zeroclaw'] as const;
export type UpstreamModuleId = typeof UPSTREAM_MODULE_IDS[number];

export const UPSTREAM_REPOSITORIES: Readonly<Record<UpstreamModuleId, string>> = {
  opencode: 'anomalyco/opencode',
  zeroclaw: 'zeroclaw-labs/zeroclaw'
};

/** Exactly three numbers, the upstream tag without its `v`. */
export const UPSTREAM_VERSION = /^\d+\.\d+\.\d+$/;
export const UPSTREAM_TAG = /^v(\d+\.\d+\.\d+)$/;

/** How this app's checked integration judges a version: tested, newer than tested, or not supported. */
export type UpstreamSupport = 'ok' | 'newer' | 'unsupported';

export interface UpstreamModuleVersions {
  /** What the managed binary (the module folder's own) reports; null when it is not installed. */
  installed: string | null;
  /** A binary on PATH this app did not install, by version only (shown as "unmanaged"). */
  unmanaged: string | null;
  latest: string | null;
  /** The latest release is newer than the managed one and supported by this version of the app. */
  updateAvailable: boolean;
  /** A newer release exists that this version of the app does not support yet (e.g. OpenCode 2.x). */
  latestUnsupported: boolean;
  /** Support of the version in use (managed first, else unmanaged); null when none. */
  support: UpstreamSupport | null;
  /** This platform has a verified install path (Linux x64/arm64, Windows through WSL). */
  installable: boolean;
  latestError?: string;
}

export type UpstreamInstallPhase = 'downloading' | 'verifying' | 'extracting' | 'checking' | 'installing' | 'done' | 'failed';

export interface UpstreamInstallProgress {
  module: UpstreamModuleId;
  mode: 'install' | 'update';
  phase: UpstreamInstallPhase;
  version: string;
  /** Error code when `phase` is `failed`. */
  error?: string;
}

/** The OpenCode server the app runs for its chats (one per app instance). */
export interface OpenCodeServerView {
  running: boolean;
  /** The loopback port it listens on; null while stopped. */
  port: number | null;
  version: string | null;
  /** An update was installed while a turn ran: the server restarts when the last turn ends. */
  restartPending: boolean;
}

export interface UpstreamModuleStatus {
  module: UpstreamModuleId;
  versions: UpstreamModuleVersions;
  install: UpstreamInstallProgress | null;
  /** OpenCode only. */
  server?: OpenCodeServerView;
}
