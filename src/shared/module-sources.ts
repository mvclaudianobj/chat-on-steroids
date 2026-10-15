/**
 * Source-only registry: module binaries and third-party web UIs are NOT bundled
 * into Chat Marks. A source descriptor grants no execution or installation
 * permission. The main process must implement and verify any acquisition flow.
 */
import type { MarksModuleId } from './modules.js';

export type MarksModuleSource =
  | {
      kind: 'github';
      repository: string;
      homepage: string;
      install: 'external-guide';
      update: 'upstream-managed';
    }
  | {
      kind: 'marks-drive';
      artifactId: string;
      sha256: string;
      install: 'verified-download';
      update: 'explicit-confirmation';
    }
  | {
      kind: 'package-manager';
      manager: 'apt' | 'dnf' | 'brew' | 'winget';
      packageName: string;
      install: 'system-managed';
      update: 'system-managed';
    };

/** Only explicitly reviewed sources appear here; no arbitrary URL/command manifests. */
export const MARKS_MODULE_SOURCES = {
  'cli-proxy-api': {
    kind: 'github',
    repository: 'router-for-me/CLIProxyAPI',
    homepage: 'https://github.com/router-for-me/CLIProxyAPI',
    install: 'external-guide',
    update: 'upstream-managed'
  }
} as const satisfies Record<MarksModuleId, MarksModuleSource>;
