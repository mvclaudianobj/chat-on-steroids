/**
 * Chat Marks: modules that install an upstream CLI from its official release into the user's
 * module folder (Settings > Modules): OpenCode 2.x from the npm registry (also the `opencode`
 * chat engine) and ZeroClaw from its GitHub releases. Shared shapes only; no paths, binaries or
 * secrets cross to the renderer.
 */
export const UPSTREAM_MODULE_IDS = ['opencode', 'zeroclaw'] as const;
export type UpstreamModuleId = typeof UPSTREAM_MODULE_IDS[number];

export const UPSTREAM_REPOSITORIES: Readonly<Record<UpstreamModuleId, string>> = {
  opencode: 'anomalyco/opencode',
  zeroclaw: 'zeroclaw-labs/zeroclaw'
};

/**
 * Exactly three numbers, the upstream tag without its `v`: the third-party projects' own format,
 * deliberately separate from the app's RELEASE_VERSION_PATTERN (which allows a fourth).
 */
export const UPSTREAM_VERSION = /^\d+(?:\.\d+){2}$/;
export const UPSTREAM_TAG = /^v(\d+(?:\.\d+){2})$/;

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
  /** A newer release exists that this version of the app does not support yet (e.g. OpenCode 3.x). */
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

/**
 * OpenCode's background service (`opencode service`, one per user, shared with its TUI):
 * `running` by the binary this app uses, `foreign` when another OpenCode program runs it.
 */
export interface OpenCodeServiceView {
  state: 'running' | 'stopped' | 'foreign';
  /** The loopback port it listens on; null while stopped. */
  port: number | null;
  version: string | null;
  /** An update was installed while a session ran: the service restarts when nothing runs. */
  restartPending: boolean;
}

export type OpenCodeServiceAction = 'start' | 'stop' | 'restart';

/**
 * Read-only key facts of the user's ZeroClaw setup for its Settings page (main/zeroclaw/settings.ts):
 * no secret, nothing read before ZeroClaw has a configuration. The page grows with settings over time.
 */
export interface ZeroClawFacts {
  /** ZeroClaw has a configuration (`~/.zeroclaw/config.toml`); false until the first Configure agent. */
  configured: boolean;
  agents: Array<{ alias: string; provider: string | null; memory: string | null; enabled: boolean | null }>;
  runtime: string | null;
  /** `host:port` of its gateway. */
  gateway: string | null;
  dailyLimitUsd: number | null;
  monthlyLimitUsd: number | null;
  /** `not_installed` | `read_failed`. */
  error?: string;
}

export interface UpstreamModuleStatus {
  module: UpstreamModuleId;
  versions: UpstreamModuleVersions;
  install: UpstreamInstallProgress | null;
  /** OpenCode only. */
  service?: OpenCodeServiceView;
}
