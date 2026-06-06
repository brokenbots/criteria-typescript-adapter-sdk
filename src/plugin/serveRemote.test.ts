import { describe, it, expect, afterEach } from 'bun:test';
import * as net from 'net';
import { serveRemote } from './serveRemote.js';
import type { ServeConfig } from './types-v2.js';

const config: ServeConfig = {
  name: 'remote-test',
  version: '1.2.3',
  description: 'remote serving test fixture',
  async execute(_req, helpers) {
    await helpers.outcomes.finalize('success');
  },
};

/** A stand-in for the host shim: captures the first handshake line per conn. */
function startFakeHost(onHandshake: (line: string, sock: net.Socket) => void): Promise<{ port: number; close: () => Promise<void>; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          sock.removeListener('data', onData);
          onHandshake(buf.slice(0, nl), sock);
        }
      };
      sock.on('data', onData);
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        server,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('serveRemote', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('sends a newline-terminated identity handshake frame', async () => {
    const received = new Promise<string>((resolve) => {
      void startFakeHost((line, sock) => {
        resolve(line);
        sock.destroy();
      }).then((host) => {
        cleanups.push(host.close);
        void serveRemote(config, {
          host: `127.0.0.1:${host.port}`,
          accept_token: 'tok-123',
          identity: { digest: 'sha256:abc' },
          reconnect: false,
        });
      });
    });

    const line = await received;
    const frame = JSON.parse(line);
    expect(frame).toEqual({
      name: 'remote-test',
      version: '1.2.3',
      digest: 'sha256:abc',
      token: 'tok-123',
    });
  });

  it('defaults identity name/version from the config and omits an unset token', async () => {
    const received = new Promise<string>((resolve) => {
      void startFakeHost((line, sock) => {
        resolve(line);
        sock.destroy();
      }).then((host) => {
        cleanups.push(host.close);
        void serveRemote(config, {
          host: `127.0.0.1:${host.port}`,
          identity: { digest: 'sha256:def' },
          reconnect: false,
        });
      });
    });

    const frame = JSON.parse(await received);
    expect(frame.name).toBe('remote-test');
    expect(frame.version).toBe('1.2.3');
    expect('token' in frame).toBe(false);
  });

  it('strips a URL scheme prefix from the host', async () => {
    const received = new Promise<string>((resolve) => {
      void startFakeHost((line, sock) => {
        resolve(line);
        sock.destroy();
      }).then((host) => {
        cleanups.push(host.close);
        void serveRemote(config, {
          host: `grpcs://127.0.0.1:${host.port}`,
          identity: { digest: 'sha256:xyz' },
          reconnect: false,
        });
      });
    });

    const frame = JSON.parse(await received);
    expect(frame.digest).toBe('sha256:xyz');
  });

  it('reconnects after the host drops the connection', async () => {
    let connections = 0;
    const twoSeen = new Promise<void>((resolve) => {
      void startFakeHost((_line, sock) => {
        connections += 1;
        sock.destroy(); // force a disconnect to trigger reconnect
        if (connections >= 2) resolve();
      }).then((host) => {
        cleanups.push(host.close);
        void serveRemote(config, {
          host: `127.0.0.1:${host.port}`,
          identity: { digest: 'sha256:abc' },
          reconnect: { initialDelayMs: 10, maxDelayMs: 20 },
        });
      });
    });

    await twoSeen;
    expect(connections).toBeGreaterThanOrEqual(2);
  });

  it('rejects when identity.digest is missing', async () => {
    await expect(
      serveRemote(config, {
        host: '127.0.0.1:1',
        // @ts-expect-error intentionally missing digest
        identity: {},
        reconnect: false,
      }),
    ).rejects.toThrow('digest is required');
  });
});
