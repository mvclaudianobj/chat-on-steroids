/** Minimal SMTP client: implicit TLS or mandatory STARTTLS, bounded responses, no debug output. */
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';

export interface SmtpMessage { host: string; port: number; security: 'tls' | 'starttls'; username: string; password: string; from: string; to: string; subject: string; body: string }
const addr = /^[^\s<>\r\n@]+@[^\s<>\r\n@]+\.[^\s<>\r\n@]+$/;
function escapeHeader(s: string): string { return s.replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 300); }
function encodeHeader(s: string): string { return `=?UTF-8?B?${Buffer.from(escapeHeader(s)).toString('base64')}?=`; }
export async function sendSmtp(message: SmtpMessage): Promise<void> {
  if (!addr.test(message.from) || !addr.test(message.to)) throw new Error('Invalid SMTP sender or recipient');
  if (!message.host || !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) throw new Error('Invalid SMTP server');
  if (!message.username || !message.password) throw new Error('SMTP username and credential required');
  let socket: net.Socket | tls.TLSSocket = message.security === 'tls'
    ? tls.connect({ host: message.host, port: message.port, servername: message.host, rejectUnauthorized: true })
    : net.connect({ host: message.host, port: message.port });
  let stash = '';
  const responses: Array<(line: string) => void> = [];
  const pending: string[] = [];
  const receive = (chunk: Buffer | string): void => {
    stash += chunk.toString();
    if (stash.length > 16384) { socket.destroy(); return; }
    const pos = stash.lastIndexOf('\n');
    if (pos < 0) return;
    const complete = stash.slice(0, pos + 1);
    stash = stash.slice(pos + 1);
    const lines = complete.split('\n').map(s => s.trimEnd()).filter(Boolean);
    const last = lines.filter(s => /^\d{3} /.test(s)).at(-1);
    if (last) { if (responses.length) responses.shift()!(last); else pending.push(last); }
  };
  const listen = (): void => { socket.on('data', receive); };
  const deadline = setTimeout(() => socket.destroy(new Error('SMTP timeout')), 15000);
  const reply = async (expected: number[]): Promise<void> => {
    const line = pending.length ? pending.shift()! : await new Promise<string>((resolve, reject) => {
      const onClose = () => reject(new Error('SMTP connection closed'));
      socket.once('close', onClose);
      responses.push(s => { socket.off('close', onClose); resolve(s); });
    });
    if (!expected.includes(Number(line.slice(0, 3)))) throw new Error(`SMTP server rejected the command (${line.slice(0, 3)})`);
  };
  const command = async (value: string, expected: number[]): Promise<void> => { socket.write(`${value}\r\n`); await reply(expected); };
  try {
    listen();
    if (message.security === 'tls') await once(socket, 'secureConnect');
    else await once(socket, 'connect');
    await reply([220]);
    await command('EHLO chat-marks', [250]);
    if (message.security === 'starttls') {
      await command('STARTTLS', [220]);
      socket.off('data', receive);
      socket = tls.connect({ socket, servername: message.host, rejectUnauthorized: true });
      await once(socket, 'secureConnect');
      listen();
      await command('EHLO chat-marks', [250]);
    }
    await command('AUTH LOGIN', [334]);
    await command(Buffer.from(message.username).toString('base64'), [334]);
    await command(Buffer.from(message.password).toString('base64'), [235]);
    await command(`MAIL FROM:<${message.from}>`, [250]);
    await command(`RCPT TO:<${message.to}>`, [250, 251]);
    await command('DATA', [354]);
    const safeBody = message.body.replace(/\r\n|\r|\n/g, '\n').split('\n').map(s => s.startsWith('.') ? `.${s}` : s).join('\r\n');
    socket.write(`From: <${message.from}>\r\nTo: <${message.to}>\r\nSubject: ${encodeHeader(message.subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(safeBody).toString('base64')}\r\n.\r\n`);
    await reply([250]);
    socket.write('QUIT\r\n');
  } finally { clearTimeout(deadline); socket.destroy(); }
}
