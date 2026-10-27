/**
 * Throwaway X.509 certificates for local TLS tests, built in memory with node:crypto (no openssl,
 * no key material in the repository). EC P-256, SHA-256, one CN, optional SAN, optional CA flag.
 */
import { generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import net from 'node:net';

const tlv = (tag: number, content: Buffer): Buffer => {
  const n = content.length;
  const length = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split('.').map(Number) as [number, number, ...number[]];
  const bytes = [a * 40 + b];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = value >> 7; v; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const integer = (value: Buffer): Buffer => tlv(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
const time = (date: Date): Buffer => tlv(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const name = (cn: string): Buffer => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

export interface TestCertificate { cert: string; key: string; keyObject: KeyObject; fingerprint256: string; subject: string }

export function makeCertificate(options: { cn: string; altNames?: string[]; ca?: boolean; issuer?: TestCertificate }): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const extensions: Buffer[] = [];
  if (options.altNames?.length) {
    const names = options.altNames.map(value => net.isIP(value)
      ? tlv(0x87, Buffer.from(value.split('.').map(Number)))
      : tlv(0x82, Buffer.from(value)));
    extensions.push(seq(oid('2.5.29.17'), tlv(0x04, seq(...names))));
  }
  if (options.ca) extensions.push(seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))));
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(Buffer.from([0x01, ...randomBytes(7)])),
    ECDSA_SHA256,
    name(options.issuer?.subject ?? options.cn),
    seq(time(new Date(now - 86400000)), time(new Date(now + 365 * 86400000))),
    name(options.cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    ...(extensions.length ? [tlv(0xa3, seq(...extensions))] : [])
  );
  const signature = sign('sha256', tbs, options.issuer?.keyObject ?? privateKey);
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return {
    cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), keyObject: privateKey,
    fingerprint256: new X509Certificate(cert).fingerprint256, subject: options.cn
  };
}
