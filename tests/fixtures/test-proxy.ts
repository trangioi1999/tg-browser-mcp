import http from 'node:http';
import net from 'node:net';

/** Minimal forward proxy (HTTP absolute-URI + CONNECT) with optional Basic auth, for tests only. */
export function createTestProxy(
  opts: { user?: string; pass?: string; rewrite?: Record<string, string> } = {},
) {
  const seen: string[] = [];
  const authOk = (h: string | undefined) =>
    !opts.user || h === `Basic ${Buffer.from(`${opts.user}:${opts.pass}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    if (!authOk(req.headers['proxy-authorization'])) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      return res.end();
    }
    const target = new URL(req.url!);
    seen.push(`${req.method} ${target.host}${target.pathname}`);
    const upstream = opts.rewrite?.[target.host] ?? target.host;
    const [host, port] = upstream.split(':');
    const headers = { ...req.headers, host: target.host };
    delete headers['proxy-authorization'];
    const p = http.request(
      { host, port: Number(port ?? 80), method: req.method, path: target.pathname + target.search, headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    p.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.on('error', () => p.destroy());
    res.on('error', () => p.destroy());
    req.pipe(p);
  });
  server.on('connect', (req, socket) => {
    // Tunnelled peers may hang up at any time (browser shutdown): never let EPIPE/ECONNRESET throw.
    socket.on('error', () => socket.destroy());
    if (!authOk(req.headers['proxy-authorization'])) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    seen.push(`CONNECT ${req.url}`);
    const [host, port] = (opts.rewrite?.[req.url!] ?? req.url!).split(':');
    const up = net.connect(Number(port), host!, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () =>
      up.readyState === 'open' ? socket.destroy() : socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'),
    );
    socket.on('close', () => up.destroy());
    up.on('close', () => socket.destroy());
  });
  return {
    seen,
    listen: () =>
      new Promise<string>((r) =>
        server.listen(0, '127.0.0.1', () =>
          r(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`),
        ),
      ),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
