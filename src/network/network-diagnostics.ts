import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import type { ProxyManager } from './proxy-manager.js';
import type { CertificateManager } from './certificate-manager.js';
import type { DomainPolicy } from '../security/domain-policy.js';
import { TgError, type ErrorCode } from '../shared/errors.js';

export interface DiagnosticStep {
  step: 'policy' | 'dns' | 'tcp' | 'proxy' | 'tls' | 'http';
  ok: boolean;
  durationMs: number;
  detail: string;
  code?: ErrorCode;
}

export interface DiagnosticReport {
  url: string;
  viaProxy: string | null;
  ok: boolean;
  steps: DiagnosticStep[];
  conclusion: string;
}

const TIMEOUT = 8000;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: Error }> {
  const t = Date.now();
  try {
    const value = await fn();
    return { ms: Date.now() - t, value };
  } catch (error) {
    return { ms: Date.now() - t, error: error as Error };
  }
}

function tcpConnect(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port, timeout: TIMEOUT });
    s.once('connect', () => resolve(s));
    s.once('timeout', () => {
      s.destroy();
      reject(Object.assign(new Error('TCP connect timed out'), { code: 'ETIMEDOUT' }));
    });
    s.once('error', reject);
  });
}

/** Issues an HTTP CONNECT through the proxy and resolves with the tunnelled socket. */
function proxyConnect(
  proxy: URL,
  targetHost: string,
  targetPort: number,
  auth?: string,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    tcpConnect(proxy.hostname, Number(proxy.port || 80)).then((sock) => {
      const headers = [`CONNECT ${targetHost}:${targetPort} HTTP/1.1`, `Host: ${targetHost}:${targetPort}`];
      if (auth) headers.push(`Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}`);
      sock.write(`${headers.join('\r\n')}\r\n\r\n`);
      let buf = '';
      const onData = (d: Buffer) => {
        buf += d.toString('latin1');
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        sock.off('data', onData);
        const status = Number(buf.split(' ')[1]);
        if (status === 200) resolve(sock);
        else {
          sock.destroy();
          reject(
            Object.assign(
              new Error(
                `Proxy CONNECT returned HTTP ${status}${status === 407 ? ' (proxy authentication required)' : ''}`,
              ),
              { code: 'EPROXY' },
            ),
          );
        }
      };
      sock.on('data', onData);
      sock.setTimeout(TIMEOUT, () => {
        sock.destroy();
        reject(Object.assign(new Error('Proxy CONNECT timed out'), { code: 'EPROXY' }));
      });
    }, reject);
  });
}

function tlsHandshake(
  socket: net.Socket | undefined,
  host: string,
  port: number,
  ca?: string[],
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const opts: tls.ConnectionOptions = {
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: true,
      timeout: TIMEOUT,
    };
    if (ca) opts.ca = [...tls.rootCertificates, ...ca];
    if (socket) opts.socket = socket;
    else {
      opts.host = host;
      opts.port = port;
    }
    const t = tls.connect(opts, () => resolve(t));
    t.once('error', reject);
    t.once('timeout', () => {
      t.destroy();
      reject(new Error('TLS handshake timed out'));
    });
  });
}

function shouldBypass(host: string, bypass: string[]): boolean {
  return bypass.some((b) => {
    const p = b.trim().toLowerCase();
    if (!p) return false;
    if (p === '*') return true;
    if (p.startsWith('*.')) return host.endsWith(p.slice(1)) || host === p.slice(2);
    if (p.startsWith('.')) return host.endsWith(p);
    return host === p;
  });
}

/**
 * Step-by-step diagnosis of how the MCP host reaches a URL (policy → DNS → TCP/proxy → TLS → HTTP).
 * NOTE: this tests Node.js connectivity from the MCP process using the same proxy and CA settings
 * as the browser; the browser itself may still differ (OS proxy/PAC, its own cert store).
 */
export async function diagnose(
  rawUrl: string,
  deps: { proxy: ProxyManager; certs: CertificateManager; policy: DomainPolicy },
): Promise<DiagnosticReport> {
  const steps: DiagnosticStep[] = [];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TgError('INVALID_ARGUMENT', 'url must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new TgError('INVALID_ARGUMENT', 'Only http(s) URLs can be diagnosed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

  const pol = await deps.policy.check(rawUrl);
  steps.push({
    step: 'policy',
    ok: pol.allowed,
    durationMs: 0,
    detail: pol.allowed ? 'Allowed by domain policy' : pol.reason,
    ...(pol.allowed ? {} : { code: 'DOMAIN_NOT_ALLOWED' as const }),
  });
  if (!pol.allowed) return finish(rawUrl, null, steps);

  const proxyCfg = deps.proxy.playwrightProxy();
  const useProxy = proxyCfg && !shouldBypass(host, proxyCfg.bypass?.split(',') ?? []) ? proxyCfg : undefined;
  const ca = deps.certs.loadCa();

  let socket: net.Socket | undefined;
  if (useProxy) {
    const purl = new URL(useProxy.server.includes('://') ? useProxy.server : `http://${useProxy.server}`);
    if (purl.protocol.startsWith('socks')) {
      steps.push({
        step: 'proxy',
        ok: false,
        durationMs: 0,
        detail: 'SOCKS proxy diagnostics are not supported; test with the browser instead.',
      });
      return finish(rawUrl, useProxy.server, steps);
    }
    const r = await timed(() =>
      proxyConnect(
        purl,
        host,
        port,
        useProxy.username ? `${useProxy.username}:${useProxy.password ?? ''}` : undefined,
      ),
    );
    steps.push({
      step: 'proxy',
      ok: !r.error,
      durationMs: r.ms,
      detail: r.error ? r.error.message : `CONNECT tunnel to ${host}:${port} established via ${purl.host}`,
      ...(r.error ? { code: 'NETWORK_PROXY_FAILED' as const } : {}),
    });
    if (r.error) return finish(rawUrl, useProxy.server, steps);
    socket = r.value;
  } else {
    const d = await timed(() =>
      net.isIP(host) ? Promise.resolve([{ address: host }]) : dns.lookup(host, { all: true }),
    );
    steps.push({
      step: 'dns',
      ok: !d.error,
      durationMs: d.ms,
      detail: d.error
        ? `${(d.error as NodeJS.ErrnoException).code ?? ''} ${d.error.message}`.trim()
        : `Resolved to ${d.value?.map((a) => a.address).join(', ')}`,
      ...(d.error ? { code: 'NETWORK_DNS_FAILED' as const } : {}),
    });
    if (d.error) return finish(rawUrl, null, steps);
    const t = await timed(() => tcpConnect(host, port));
    steps.push({
      step: 'tcp',
      ok: !t.error,
      durationMs: t.ms,
      detail: t.error
        ? `${(t.error as NodeJS.ErrnoException).code ?? ''} ${t.error.message}`.trim()
        : `Connected to ${host}:${port}`,
      ...(t.error ? { code: 'NETWORK_CONNECTION_FAILED' as const } : {}),
    });
    if (t.error) return finish(rawUrl, null, steps);
    socket = t.value;
  }

  let stream: net.Socket = socket!;
  if (url.protocol === 'https:') {
    const t = await timed(() => tlsHandshake(socket, host, port, ca));
    const errCode = (t.error as NodeJS.ErrnoException | undefined)?.code;
    steps.push({
      step: 'tls',
      ok: !t.error,
      durationMs: t.ms,
      detail: t.error
        ? `${errCode ?? ''} ${t.error.message}${/CERT|SELF_SIGNED|UNABLE_TO/.test(errCode ?? '') ? ' — configure network.tls.caFile with your corporate CA' : ''}`.trim()
        : `TLS ${t.value?.getProtocol()} verified (${t.value?.getPeerCertificate()?.subject?.CN ?? 'peer'})`,
      ...(t.error ? { code: 'NETWORK_TLS_FAILED' as const } : {}),
    });
    if (t.error) {
      socket?.destroy();
      return finish(rawUrl, useProxy?.server ?? null, steps);
    }
    stream = t.value!;
  }

  const h = await timed(
    () =>
      new Promise<number>((resolve, reject) => {
        stream.write(
          `HEAD ${url.pathname || '/'} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nUser-Agent: tg-browser-mcp-doctor\r\n\r\n`,
        );
        stream.once('data', (d: Buffer) => resolve(Number(d.toString('latin1').split(' ')[1])));
        stream.once('error', reject);
        stream.setTimeout(TIMEOUT, () => reject(new Error('HTTP response timed out')));
      }),
  );
  stream.destroy();
  steps.push({
    step: 'http',
    ok: !h.error,
    durationMs: h.ms,
    detail: h.error ? h.error.message : `HTTP ${h.value}`,
    ...(h.error ? { code: 'NETWORK_CONNECTION_FAILED' as const } : {}),
  });
  return finish(rawUrl, useProxy?.server ?? null, steps);
}

function finish(url: string, viaProxy: string | null, steps: DiagnosticStep[]): DiagnosticReport {
  const failed = steps.find((s) => !s.ok);
  return {
    url,
    viaProxy: viaProxy ? viaProxy.replace(/\/\/[^@/]+@/, '//') : null,
    ok: !failed,
    steps,
    conclusion: failed ? `Failed at ${failed.step}: ${failed.detail}` : 'Reachable from the MCP host.',
  };
}
