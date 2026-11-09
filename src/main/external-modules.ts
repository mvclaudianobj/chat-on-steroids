/**
 * Integrations with separately installed GPL-3.0 applications, not copies of their code.
 * TwinDesk is a person-paired remote desktop, never an unattended remote-execution grant.
 * Firefox VPN manages its own network routing; Chat Marks must not change system routes.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { shell } from 'electron';
import { MARKS_MODULE_SOURCES } from '../shared/module-sources.js';
import type { MarksModuleAction, MarksModuleId, MarksModuleState } from '../shared/modules.js';

export type ExternalModuleId = Extract<MarksModuleId, 'firefox-vpn' | 'twindesk'>;

export interface ExternalModuleDeps {
  /** Read-only existence check of known executable locations. */
  exists(path: string): Promise<boolean>;
  /** Launch an installed app by a fixed, allowlisted executable path only. */
  launch(path: string): Promise<void>;
  /** Open a fixed, vetted upstream URL; no URL supplied by the renderer. */
  openLink(url: string): Promise<void>;
}

const SPECS = {
  'firefox-vpn': {
    name: 'Firefox VPN',
    description: 'VPN/proxy independente; configurações, contas e rotas geridas pelo próprio cliente.',
    executables: ['/usr/local/bin/firefox-vpn', '/usr/bin/firefox-vpn'] as const,
    /** The CLI is a privileged management menu, not a safe desktop launcher. */
    open: 'http://127.0.0.1:10820/app/'
  },
  twindesk: {
    name: 'TwinDesk',
    description: 'Acesso visual remoto assistido, compartilhamento de tela, teclado e arquivos com pareamento próprio.',
    executables: ['/usr/bin/twindesk', '/usr/local/bin/twindesk', '/opt/TwinDesk/twindesk'] as const,
    open: null
  }
} as const;

/** GUI availability is checked only on Linux, where the paths and launcher were reviewed. */
export async function externalModuleStatus(
  deps: Pick<ExternalModuleDeps, 'exists'> = externalModuleDeps,
  platform: NodeJS.Platform = process.platform
): Promise<MarksModuleState[]> {
  return Promise.all((['firefox-vpn', 'twindesk'] as const).map(async id => {
    const spec = SPECS[id];
    const supported = platform === 'linux';
    const installed = supported && (await Promise.all(spec.executables.map(path => deps.exists(path).catch(() => false)))).some(Boolean);
    return {
      id, name: spec.name, description: spec.description,
      source: MARKS_MODULE_SOURCES[id],
      installed, supported, running: false, enabled: false, consoleAvailable: false, managementUrl: '',
      detail: !supported ? 'Integração executável local ainda não verificada para este sistema; use as versões oficiais.'
        : !installed ? 'Executável não encontrado nos caminhos conhecidos. A instalação é externa e opcional.'
          : id === 'twindesk'
            ? 'Aplicativo encontrado. Conexão, pareamento e permissões remotas são controlados pelo TwinDesk; nenhum dispositivo foi autorizado pelo Chat Marks.'
            : 'Gerenciador encontrado. O status da VPN e suas rotas não são consultados; configure e autentique no painel próprio.'
    } satisfies MarksModuleState;
  }));
}

export async function externalModuleAction(
  id: ExternalModuleId,
  action: MarksModuleAction,
  deps: ExternalModuleDeps = externalModuleDeps,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const spec = SPECS[id];
  if (!spec) throw new Error('Unknown external module.');
  if (action === 'install' || action === 'update') {
    const homepage = MARKS_MODULE_SOURCES[id].homepage;
    await deps.openLink(action === 'install' ? homepage : `${homepage}/releases`);
    return;
  }
  if (action !== 'open') throw new Error('Service and remote-control actions are not supported for this external module.');
  if (platform !== 'linux') throw new Error('Local app opening is not supported on this system yet.');
  const path = (await Promise.all(spec.executables.map(async file => await deps.exists(file).catch(() => false) ? file : null)))
    .find(file => file !== null);
  if (!path) throw new Error('External module is not installed in a known location.');
  if (id === 'firefox-vpn') {
    // Do not invoke the privileged `firefox-vpn` CLI, import accounts or modify DNS/routes.
    // A loopback browser opens only after an explicit click, with the VPN's own login.
    await deps.openLink(SPECS['firefox-vpn'].open);
  } else {
    await deps.launch(path);
  }
}

const externalModuleDeps: ExternalModuleDeps = {
  exists: async path => {
    const entry = await stat(path).catch(() => null);
    return !!entry?.isFile();
  },
  openLink: url => shell.openExternal(url),
  launch: path => new Promise<void>((resolve, reject) => {
    const child = spawn(path, [], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  })
};
