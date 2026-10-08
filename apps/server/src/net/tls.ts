// Self-signed TLS certificate for the headset (WebXR requires a secure
// context). Cached in certs/. Every regeneration forces the user to accept the
// certificate on the Quest again, so it is regenerated only when it must be:
// near expiry, unreadable, the hostname changed, or a *primary* LAN address
// (private range, physical interface — see lan.ts) is not covered yet.
// Virtual adapters (WSL/Hyper-V get a new IP every boot) and link-local
// addresses don't trigger it. New certs keep covering previously seen
// addresses so switching back and forth between networks doesn't churn.
import path from 'node:path';
import os from 'node:os';
import { X509Certificate } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { generate } from 'selfsigned';
import { atomicWrite, readJsonOr } from '../util/fs.ts';
import { lanInterfaces, type LanAddress } from './lan.ts';
import type { Logger } from '../log.ts';

export interface TlsMaterial {
  key: string;
  cert: string;
  /** IP SANs the certificate covers. */
  ips: string[];
  hostnames: string[];
  /** Current LAN addresses to open on the headset (all covered by the cert), best first. */
  headsetIps: string[];
  fingerprint: string;
  regenerated: boolean;
}

interface Meta {
  ips: string[];
  hostnames: string[];
  createdAt: string;
}

/** Max IP SANs carried over from earlier certificates. */
const MAX_IPS = 24;

/** Why the cached cert can't be reused for the current addresses ('' = reuse it). */
export function regenerateReason(meta: Partial<Meta>, current: LanAddress[], hostnames: string[], daysLeft: number): string {
  if (daysLeft < 14) return `expires in ${Math.floor(daysLeft)} days`;
  const covered = new Set(meta.ips ?? []);
  const missing = current.filter((a) => a.primary && !covered.has(a.address)).map((a) => `${a.address} (${a.iface})`);
  if (missing.length) return `new LAN address ${missing.join(', ')}`;
  const names = new Set(meta.hostnames ?? []);
  if (!hostnames.every((h) => names.has(h))) return 'hostname changed';
  return '';
}

/** IP SANs for a new certificate: loopback, every current address, then earlier ones (bounded). */
export function sansFor(current: LanAddress[], previous: string[]): string[] {
  return [...new Set(['127.0.0.1', ...current.map((a) => a.address), ...previous])].slice(0, MAX_IPS);
}

/** Addresses to show as headset URLs: primary ones; else any non-link-local; else all. */
export function headsetIpsFrom(current: LanAddress[]): string[] {
  const primary = current.filter((a) => a.primary);
  if (primary.length) return primary.map((a) => a.address);
  const routable = current.filter((a) => !a.address.startsWith('169.254.'));
  return (routable.length ? routable : current).map((a) => a.address);
}

export async function ensureCert(certsDir: string, log: Logger, current: LanAddress[] = lanInterfaces()): Promise<TlsMaterial> {
  const keyFile = path.join(certsDir, 'key.pem');
  const certFile = path.join(certsDir, 'cert.pem');
  const metaFile = path.join(certsDir, 'meta.json');
  const hostnames = [...new Set(['localhost', os.hostname().toLowerCase()].filter(Boolean))];
  const meta = await readJsonOr<Partial<Meta>>(metaFile, {});

  if (existsSync(keyFile) && existsSync(certFile)) {
    const key = await fsp.readFile(keyFile, 'utf8');
    const cert = await fsp.readFile(certFile, 'utf8');
    let reason: string;
    try {
      const x = new X509Certificate(cert);
      reason = regenerateReason(meta, current, hostnames, (Date.parse(x.validTo) - Date.now()) / 86_400_000);
      if (!reason) {
        const ips = meta.ips ?? [];
        return { key, cert, ips, hostnames: meta.hostnames ?? hostnames, headsetIps: headsetIpsFrom(current).filter((ip) => ips.includes(ip)), fingerprint: x.fingerprint256, regenerated: false };
      }
    } catch (e) {
      reason = `unreadable cert (${(e as Error).message})`;
    }
    log.info(`regenerating TLS certificate: ${reason}`);
  }

  const ips = sansFor(current, meta.ips ?? []);
  const notBeforeDate = new Date(Date.now() - 86_400_000);
  const notAfterDate = new Date(Date.now() + 397 * 86_400_000);
  const pems = await generate([{ name: 'commonName', value: 'EvolSpace local' }, { name: 'organizationName', value: 'EvolSpace' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [...hostnames.map((value) => ({ type: 2 as const, value })), ...ips.map((ip) => ({ type: 7 as const, ip }))] },
    ],
  });
  await atomicWrite(keyFile, pems.private);
  await atomicWrite(certFile, pems.cert);
  await atomicWrite(metaFile, JSON.stringify({ ips, hostnames, createdAt: new Date().toISOString() } satisfies Meta, null, 2));
  const fp = new X509Certificate(pems.cert).fingerprint256;
  return { key: pems.private, cert: pems.cert, ips, hostnames, headsetIps: headsetIpsFrom(current), fingerprint: fp, regenerated: true };
}
