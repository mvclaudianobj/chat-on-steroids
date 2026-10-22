/**
 * Chat Marks: the Claude Code Router module (Settings > Modules, main/ccr/). Claude Code Router
 * (`@musistudio/claude-code-router`, MIT) is a third-party local gateway that Codex and Claude
 * Code chats can route through (main/agent-engine/router.ts). Shared shapes only: no key, token,
 * configuration value or web UI address crosses to the renderer.
 */
import { UPSTREAM_VERSION } from './upstream-module.js';

export const CCR_NPM_PACKAGE = '@musistudio/claude-code-router';
export const CCR_REPOSITORY = 'musistudio/claude-code-router';
export { UPSTREAM_VERSION as CCR_VERSION };

/** How this app judges a CCR version: the one it was checked against, a newer 3.x, or unsupported. */
export type CcrSupport = 'ok' | 'newer' | 'unsupported';

/** One copy of the program: Chat Marks' own (module folder) or one installed outside the app. */
export interface CcrInstallation {
  kind: 'managed' | 'external';
  version: string | null;
  /** Shown to the user ("Using installed …"), with the home folder as `~`. */
  path: string;
  /** External copies: npm can update it in place without administrator rights. */
  writable?: boolean;
}

export interface CcrServiceView {
  /** `running`: its gateway answers `/health`; `stopped`: nothing answers. */
  state: 'running' | 'stopped';
  host: string;
  port: number;
  pid: number | null;
  /** Which copy the running daemon was started from; null when unknown or stopped. */
  from: 'managed' | 'external' | 'other' | null;
  /** Its web UI is registered (Open router UI can work). */
  ui: boolean;
  /** An update was installed: the router restarts with it when no routed turn runs. */
  restartPending: boolean;
  /** Routed Codex / Claude Code turns are answering now. */
  routedTurns: boolean;
}

export type CcrInstallPhase = 'downloading' | 'verifying' | 'installing' | 'checking' | 'done' | 'failed';

export interface CcrInstallProgress {
  mode: CcrInstallMode;
  phase: CcrInstallPhase;
  version: string;
  error?: string;
}

/** `install`/`update` manage Chat Marks' own copy; `update-external` updates the found copy in place (confirmed). */
export type CcrInstallMode = 'install' | 'update' | 'update-external';
export type CcrServiceAction = 'start' | 'stop' | 'restart';

export interface CcrStatus {
  managed: CcrInstallation | null;
  external: CcrInstallation | null;
  /** The copy Start/Stop and the chats use: the managed one first, else the external one. */
  inUse: 'managed' | 'external' | null;
  latest: string | null;
  latestError?: string;
  /** A newer supported release than the copy in use. */
  updateAvailable: boolean;
  /** A newer release this version of the app does not support yet (another major). */
  latestUnsupported: boolean;
  support: CcrSupport | null;
  /** Linux with Node.js >= 22 and npm: the module can install. `installBlocked` says why not. */
  installable: boolean;
  installBlocked?: 'unsupported_platform' | 'node_missing' | 'node_too_old' | 'npm_missing';
  service: CcrServiceView;
  /** Which CLIs Claude Code Router configured itself into (read-only detection). */
  configured: { claude: boolean; codex: boolean };
  install: CcrInstallProgress | null;
}
