import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { vi } from 'vitest';

/** Exercise the real HTTP handler without opening a listening socket. Integration tests use TCP. */
export function memoryListener() {
  const holder: { server?: http.Server } = {};
  const listen = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
    this: http.Server,
    ...args: unknown[]
  ) {
    holder.server = this;
    if (args[1] !== '127.0.0.1') throw new Error('Expected loopback binding');
    queueMicrotask(args.at(-1) as () => void);
    return this;
  } as typeof http.Server.prototype.listen);
  const address = vi
    .spyOn(http.Server.prototype, 'address')
    .mockReturnValue({ address: '127.0.0.1', family: 'IPv4', port: 18940 });
  const close = vi.spyOn(http.Server.prototype, 'close').mockImplementation(function (
    this: http.Server,
    callback?: (error?: Error) => void,
  ) {
    callback?.();
    return this;
  });
  return {
    restore() {
      listen.mockRestore();
      address.mockRestore();
      close.mockRestore();
    },
    request(
      origin: string,
      route: string,
      options: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ) {
      return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>(
        (resolve, reject) => {
          const req = Object.assign(Readable.from(options.body ? [Buffer.from(options.body)] : []), {
            method: options.method ?? 'GET',
            url: route,
            headers: {
              host: new URL(origin).host,
              ...Object.fromEntries(
                Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
              ),
            },
          });
          const chunks: Buffer[] = [];
          class Response extends Writable {
            statusCode = 200;
            headersSent = false;
            headers: http.IncomingHttpHeaders = {};
            setHeader(key: string, value: string | number) {
              this.headers[key.toLowerCase()] =
                key.toLowerCase() === 'set-cookie' ? [String(value)] : String(value);
            }
            writeHead(status: number, headers: Record<string, string>) {
              this.statusCode = status;
              for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
              this.headersSent = true;
            }
            override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error) => void) {
              chunks.push(Buffer.from(chunk));
              cb();
            }
            override _final(cb: (error?: Error) => void) {
              resolve({
                status: this.statusCode,
                headers: this.headers,
                text: Buffer.concat(chunks).toString(),
              });
              cb();
            }
          }
          const res = new Response();
          res.on('error', reject);
          holder.server!.emit('request', req, res);
        },
      );
    },
  };
}
