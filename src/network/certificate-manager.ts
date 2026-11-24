import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import type { TgConfig } from '../config/schema.js';

export interface CertificateStatus {
  verifyTls: true;
  caFile: string | null;
  caFileReadable: boolean;
  certificates: Array<{ subject: string; issuer: string; validTo: string; expired: boolean }>;
  nodeExtraCaCerts: string | null;
  notes: string[];
}

/**
 * Corporate CA support. TLS verification is never disabled.
 *  - Node.js traffic (diagnostics): uses `caFile` explicitly + NODE_EXTRA_CA_CERTS.
 *  - Chrome/Edge: trust the OS certificate store; install the corporate CA there.
 *  - Playwright Chromium on Linux: uses the NSS DB (~/.pki/nssdb) — import with certutil.
 *  - Firefox: uses its own store; enable enterprise roots via policies.
 */
export class CertificateManager {
  constructor(private readonly cfg: TgConfig['network']['tls']) {}

  loadCa(): string[] | undefined {
    if (!this.cfg.caFile) return undefined;
    try {
      const pem = fs.readFileSync(this.cfg.caFile, 'utf8');
      const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      return blocks ?? undefined;
    } catch {
      return undefined;
    }
  }

  status(): CertificateStatus {
    const notes: string[] = [];
    const certs = this.loadCa() ?? [];
    const parsed = certs.flatMap((pem) => {
      try {
        const x = new X509Certificate(pem);
        return [
          {
            subject: x.subject.replace(/\n/g, ', '),
            issuer: x.issuer.replace(/\n/g, ', '),
            validTo: x.validTo,
            expired: new Date(x.validTo) < new Date(),
          },
        ];
      } catch {
        return [];
      }
    });
    if (this.cfg.caFile && certs.length === 0)
      notes.push(`caFile ${this.cfg.caFile} is missing or contains no PEM certificates.`);
    if (parsed.some((c) => c.expired)) notes.push('One or more configured CA certificates are expired.');
    notes.push(
      'Browsers (Chrome/Edge) trust the OS certificate store. Install the corporate CA there for browser traffic.',
    );
    if (process.platform === 'linux')
      notes.push(
        'On Linux, Chromium uses the NSS DB: certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n corp-ca -i ca.pem',
      );
    return {
      verifyTls: true,
      caFile: this.cfg.caFile,
      caFileReadable: certs.length > 0,
      certificates: parsed,
      nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS ?? null,
      notes,
    };
  }
}
