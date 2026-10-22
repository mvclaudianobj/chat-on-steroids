import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { sendSmtp } from '../src/main/notification-smtp.js';

describe('SMTP TLS policy', () => {
  it('refuses a relay that cannot negotiate STARTTLS without revealing credentials', async () => {
    const commands: string[] = [];
    const server = net.createServer(socket => {
      socket.write('220 local.test ESMTP\r\n');
      let pending = '';
      socket.on('data', buffer => {
        pending += buffer.toString();
        let index: number;
        while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index).trim();
          pending = pending.slice(index + 1);
          commands.push(line);
          if (line.startsWith('EHLO')) socket.write('250-local.test\r\n250 STARTTLS\r\n');
          else if (line === 'STARTTLS') socket.write('454 TLS not currently available\r\n');
          else socket.write('500 Unsupported\r\n');
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing local port');
      await expect(sendSmtp({ host: '127.0.0.1', port: address.port, security: 'starttls', username: 'synthetic-user', password: 'synthetic-only-password', from: 'from@example.com', to: 'to@example.com', subject: 'test', body: 'synthetic body' })).rejects.toThrow(/SMTP server rejected/);
      expect(commands).toEqual(['EHLO chat-marks', 'STARTTLS']);
      expect(commands.join(' ')).not.toContain('synthetic-only-password');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('rejects header injection before any network operation', async () => {
    await expect(sendSmtp({ host: '127.0.0.1', port: 587, security: 'starttls', username: 'fake', password: 'fake', from: 'sender@example.com\r\nBcc: secret@example.com', to: 'to@example.com', subject: 'test', body: '' })).rejects.toThrow(/Invalid SMTP sender/);
  });
});
