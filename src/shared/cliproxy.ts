/**
 * Chat Marks management of the locally installed CLIProxyAPI (Settings > Modules > CLIProxyAPI).
 * Shared shapes only: secrets (management password, API keys) never cross to the renderer.
 */

/** Official community releases; no fork and no local build. */
export const CLIPROXY_REPOSITORY = 'router-for-me/CLIProxyAPI';

export interface CliProxyVersions {
  /** Version the installed binary reports, without a leading "v"; null when unknown. */
  installed: string | null;
  /** The installed version is exactly an official release tag (not a local or `-dirty` build). */
  installedOfficial: boolean;
  /** Latest official release, without a leading "v"; null when GitHub did not answer. */
  latest: string | null;
  updateAvailable: boolean;
  /** This platform has a verified install/update path (Linux x64/arm64). */
  installable: boolean;
  latestError?: string;
}

/** An API key as the renderer sees it: a stable id (digest prefix) and its last four characters. */
export interface CliProxyKeyView {
  id: string;
  last4: string;
  /** This key is the one the CLIProxy chat uses. */
  chat: boolean;
}

export type CliProxyInstallPhase = 'downloading' | 'verifying' | 'extracting' | 'installing' | 'done' | 'failed';

export interface CliProxyInstallProgress {
  mode: 'install' | 'update';
  phase: CliProxyInstallPhase;
  version: string;
  /** Error code or message when `phase` is `failed`. */
  error?: string;
}

export interface CliProxyManageStatus {
  versions: CliProxyVersions;
  hasManagementKey: boolean;
  /** Result of the last check of the stored password; null when not checked (service down). */
  managementKeyValid: boolean | null;
  /** Null when the list could not be read (no password, service down, rejected). */
  keys: CliProxyKeyView[] | null;
  keysError?: string;
  install: CliProxyInstallProgress | null;
  /** The service cannot save its config (sandbox or ownership): offer the confirmed repair. */
  configRepair: boolean;
}

/**
 * A CLIProxyAPI release version: exactly three numbers. This is the third-party service's own
 * format, deliberately separate from the app's RELEASE_VERSION_PATTERN (which allows a fourth).
 */
export const CLIPROXY_VERSION = /^\d+(?:\.\d+){2}$/;
export const CLIPROXY_TAG = /^v?(\d+(?:\.\d+){2})$/;
