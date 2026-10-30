import { getSession, setSessionRemoteMode } from '../session/store.js';
import { getProject } from '../projects.js';
import { listRemoteHosts, type HostProfile } from './hosts.js';
import { revokeRemoteChat } from './approval.js';

export interface RemoteModeView { profileId: string; name: string; host: string; user: string; port: number }

/** The session is authoritative; an explicit Off wins over a project's initial default. */
export async function remoteProfileForChat(sessionId: string | null | undefined, projectId?: string | null): Promise<HostProfile | null> {
  const session = sessionId ? await getSession(sessionId) : null;
  if (sessionId && !session && !projectId) throw new Error('Chat no longer exists');
  const association = session?.remoteMode !== undefined
    ? session.remoteMode
    : (await getProject(session?.projectId ?? projectId ?? ''))?.remoteProfile ?? null;
  if (!association) return null;
  const host = (await listRemoteHosts()).find(row => row.id === association.profileId && row.type === 'ssh');
  if (!host) throw new Error('The remote profile was removed or is not SSH');
  return host;
}

export async function remoteModeView(sessionId: string | null | undefined, projectId?: string | null): Promise<RemoteModeView | null> {
  const host = await remoteProfileForChat(sessionId, projectId);
  return host ? { profileId: host.id, name: host.name, host: host.host, user: host.user, port: host.port } : null;
}

export async function setChatRemoteMode(sessionId: string, profileId: string | null): Promise<RemoteModeView | null> {
  const session = await getSession(sessionId);
  if (!session || session.origin?.kind === 'worker') throw new Error('Select an existing chat');
  const host = profileId === null ? null : (await listRemoteHosts()).find(row => row.id === profileId && row.type === 'ssh');
  if (profileId !== null && !host) throw new Error('Select an existing SSH profile');
  const previous = await remoteProfileForChat(sessionId).catch(() => null);
  if (previous?.id !== profileId || (profileId === null && session.remoteMode !== null)) {
    // Revoke even queued approvals for this exact frontend before the new binding can be used.
    if (session.conversationId) revokeRemoteChat(session.conversationId);
  }
  await setSessionRemoteMode(sessionId, profileId);
  return remoteModeView(sessionId);
}

/** Repeated on authored messages: mode changes in an existing chat take effect without replaying setup. */
export async function remoteModeInstructions(sessionId: string | null | undefined, projectId?: string | null): Promise<string> {
  const session = sessionId ? await getSession(sessionId) : null;
  const mode = await remoteModeView(sessionId, projectId);
  if (!mode) return session?.remoteMode === null
    ? '[CHAT REMOTE MODE OFF] This chat no longer has an assigned remote host. Do not assume the previous host or its approvals remain valid.' : '';
  const project = await getProject(session?.projectId ?? projectId ?? '');
  const folder = project?.remoteProfile?.profileId === mode.profileId ? project.remoteProfile.folder : '~';
  return `[CHAT REMOTE MODE] Work on the remote SSH host selected by the saved profile "${mode.name}" (profile id ${mode.profileId}). ` +
    `Remote target: ${mode.user}@${mode.host}:${mode.port}, directory ${folder}. This is REMOTE work, NOT local work. ` +
    'Never run local filesystem, shell, disk or cleanup commands for work belonging to that remote host; the local mirror is only a cache. ' +
    'Execute remote commands only using remote_exec with the exact named profile and explicit approval. ' +
    'Real remote tools: remote_exec for remote shell commands, approved SFTP project file operations for remote files, and remoteHosts profile/SSH-key setup in the app. ' +
    'Access remote files using SFTP, not local filesystem paths. ' +
    'Credentials and secrets are referred to by their name in Cofre K; never copy secret values into prompts, logs or files. ' +
    'This selection does not grant permissions or approve commands.';
}

/** An SSH profile mentioned in a normal message is a remote host, not a local path. */
export async function mentionedRemoteInstructions(message: string): Promise<string> {
  // Some standalone input/IPC contexts do not initialize the optional host catalog.
  // An unavailable catalog must not interrupt delivery of a normal local chat.
  let available: HostProfile[];
  try { available = await listRemoteHosts(); }
  catch { return ''; }
  const matches = available.filter(host => {
    if (host.type !== 'ssh') return false;
    const text = message.toLocaleLowerCase(), name = host.name.toLocaleLowerCase();
    let offset = text.indexOf(name);
    while (offset >= 0) {
      const before = text[offset - 1] ?? ' ', after = text[offset + name.length] ?? ' ';
      if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
      offset = text.indexOf(name, offset + 1);
    }
    return false;
  });
  if (matches.length !== 1) return '';
  const host = matches[0]!;
  return `[SAVED REMOTE HOST] "${host.name}" means the saved SSH host ` +
    `${host.user}@${host.host}:${host.port}, not a local filesystem directory. ` +
    `For remote commands use remote_exec with the profile name "${host.name}" and approval. ` +
    'Use SFTP for remote files; do not inspect the local computer as a substitute. ' +
    'If the server refuses the key, request the approved SSH key-setup workflow without revealing secrets.';
}
