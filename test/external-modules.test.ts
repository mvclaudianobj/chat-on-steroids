import { describe, expect, it, vi } from 'vitest';
import { externalModuleAction, externalModuleStatus, type ExternalModuleDeps } from '../src/main/external-modules.js';
import { MARKS_MODULE_SOURCES } from '../src/shared/module-sources.js';

function fake(installedPaths: string[] = []): ExternalModuleDeps & { openLink: ReturnType<typeof vi.fn>; launch: ReturnType<typeof vi.fn> } {
  return {
    exists: vi.fn(async path => installedPaths.includes(path)),
    openLink: vi.fn(async (_url: string) => undefined),
    launch: vi.fn(async (_path: string) => undefined)
  };
}

describe('independent Firefox VPN and TwinDesk integrations', () => {
  it('registers pinned official sources with no bundled third-party executable', () => {
    expect(MARKS_MODULE_SOURCES['firefox-vpn'].repository).toBe('armanlife/firefox-vpn-client');
    expect(MARKS_MODULE_SOURCES.twindesk.repository).toBe('InukaAsith/TwinDesk');
    expect(MARKS_MODULE_SOURCES.twindesk.install).toBe('external-guide');
  });

  it('reports installation conservatively from allowlisted binary paths, never a peer connection', async () => {
    const deps = fake(['/usr/bin/twindesk']);
    const modules = await externalModuleStatus(deps, 'linux');
    expect(modules.map(item => item.id)).toEqual(['firefox-vpn', 'twindesk']);
    expect(modules[0]).toMatchObject({ installed: false, running: false, consoleAvailable: false });
    expect(modules[1]).toMatchObject({ installed: true, running: false, consoleAvailable: false });
    expect(JSON.stringify(modules)).not.toMatch(/connected|paired|granted|authorized/i);
  });

  it('refuses unverified or unavailable launch and never executes a command from renderer input', async () => {
    const deps = fake(['/usr/bin/twindesk']);
    await expect(externalModuleAction('firefox-vpn', 'open', deps, 'linux')).rejects.toThrow(/not installed/i);
    await expect(externalModuleAction('twindesk', 'restart', deps, 'linux')).rejects.toThrow(/not supported/i);
    expect(deps.launch).not.toHaveBeenCalled();
    await externalModuleAction('twindesk', 'open', deps, 'linux');
    expect(deps.launch).toHaveBeenCalledExactlyOnceWith('/usr/bin/twindesk');
  });

  it('offers only publisher-owned installation and update guides; never installs a package', async () => {
    const deps = fake();
    await externalModuleAction('firefox-vpn', 'install', deps, 'linux');
    await externalModuleAction('twindesk', 'update', deps, 'linux');
    expect(deps.openLink.mock.calls).toEqual([
      ['https://github.com/armanlife/firefox-vpn-client'],
      ['https://github.com/InukaAsith/TwinDesk/releases']
    ]);
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('never launches Linux-only binaries on an unsupported platform', async () => {
    const deps = fake(['/usr/bin/twindesk']);
    await expect(externalModuleAction('twindesk', 'open', deps, 'win32')).rejects.toThrow(/not supported/i);
    expect((await externalModuleStatus(deps, 'win32')).every(item => !item.supported && !item.installed)).toBe(true);
  });
});
