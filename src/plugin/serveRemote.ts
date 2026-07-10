/**
 * Remote ("phone-home") serving mode for Criteria adapters (WS21 / D42).
 *
 * `serveRemote()` is the remote counterpart to `serve()`. Instead of being
 * launched locally by the Criteria host over go-plugin, the adapter is started
 * however its operator wants (k8s Deployment, ECS service, systemd unit,
 * `docker run`) and *dials out* to the host's remote-environment shim. From the
 * adapter author's perspective the only change is the function name — every
 * handler in {@link ServeConfig} behaves identically.
 *
 * Wire protocol (matches `internal/adapter/environment/remote/shim.go`):
 *   1. Open a TCP connection to the host (mTLS when `mtls` is provided).
 *   2. Write a single newline-terminated JSON identity frame:
 *      `{"name","version","digest","token"}\n`.
 *   3. Serve the gRPC AdapterService over the same held connection. The host
 *      shim bridges the connection to a local UDS where a go-plugin Reattach
 *      client consumes it as if the adapter were local.
 *
 * `@grpc/grpc-js` cannot serve on a pre-opened socket, so this runs the normal
 * gRPC server on a loopback port and bridges bytes between the held connection
 * and a fresh loopback socket — the mirror image of what the host shim does.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as tls from 'tls';
import type { Server } from '@grpc/grpc-js';
import { startServerV2, stopServerV2 } from './server-v2.js';
import { buildManifest } from './index.js';
import type { ServeConfig } from './types-v2.js';

/** Client-side mTLS material for dialing the host. PEM strings or file paths. */
export interface ServeRemoteMTLS {
  client_cert: string;
  client_key: string;
  ca_bundle: string;
}

/** Identity reported to the host during the phone-home handshake. */
export interface ServeRemoteIdentity {
  /** Defaults to `config.name`. */
  name?: string;
  /** Defaults to `config.version`. */
  version?: string;
  /**
   * The adapter artifact digest (`sha256:...`). The host verifies this against
   * its lockfile entry for this adapter, so a forged client certificate alone
   * cannot impersonate a pinned adapter.
   */
  digest: string;
}

/** Reconnection policy for a dropped host connection. */
export interface ServeRemoteReconnect {
  /** Initial backoff before the first retry. Default 1000ms. */
  initialDelayMs?: number;
  /** Maximum backoff between retries. Default 30000ms. */
  maxDelayMs?: number;
}

/** Options for {@link serveRemote}. */
export interface ServeRemoteOptions {
  /**
   * Host address to dial, e.g. `"criteria.example.com:7778"`. A `grpcs://`,
   * `wss://`, `tcp://` or `tls://` scheme prefix is accepted and stripped.
   */
  host: string;
  /** mTLS material. When omitted, a plaintext TCP connection is used. */
  mtls?: ServeRemoteMTLS;
  /** Optional bearer token presented in the handshake frame. */
  accept_token?: string;
  /** Identity overrides; `digest` is required. */
  identity: ServeRemoteIdentity;
  /**
   * Reconnect on disconnect. `true` (default) uses the default backoff policy;
   * `false` returns after the first connection ends; an object customizes the
   * backoff.
   */
  reconnect?: boolean | ServeRemoteReconnect;
}

interface HandshakeFrame {
  name: string;
  version: string;
  digest: string;
  token?: string;
}

/** Resolve a PEM value that may be either inline PEM content or a file path. */
function resolvePem(value: string): string {
  if (value.includes('-----BEGIN')) {
    return value;
  }
  return fs.readFileSync(value, 'utf8');
}

/** Strip a URL scheme prefix and return a bare `host:port`. */
function normalizeHost(host: string): string {
  return host.replace(/^[a-z0-9]+:\/\//i, '');
}

function splitHostPort(hostPort: string): { host: string; port: number } {
  const idx = hostPort.lastIndexOf(':');
  if (idx < 0) {
    throw new Error(`serveRemote: host "${hostPort}" must be in host:port form`);
  }
  return { host: hostPort.slice(0, idx), port: Number(hostPort.slice(idx + 1)) };
}

/** Open the held connection to the host and complete the identity handshake. */
function dialHost(opts: ServeRemoteOptions, frame: HandshakeFrame): Promise<net.Socket> {
  const target = splitHostPort(normalizeHost(opts.host));
  const frameBytes = Buffer.from(JSON.stringify(frame) + '\n');

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    let socket: net.Socket;
    if (opts.mtls) {
      socket = tls.connect({
        host: target.host,
        port: target.port,
        servername: target.host,
        cert: resolvePem(opts.mtls.client_cert),
        key: resolvePem(opts.mtls.client_key),
        ca: resolvePem(opts.mtls.ca_bundle),
      });
      socket.once('secureConnect', () => {
        socket.write(frameBytes, (err) => (err ? fail(err) : settle()));
      });
    } else {
      socket = net.connect({ host: target.host, port: target.port });
      socket.once('connect', () => {
        socket.write(frameBytes, (err) => (err ? fail(err) : settle()));
      });
    }
    socket.once('error', fail);

    const settle = () => {
      if (!settled) {
        settled = true;
        socket.removeListener('error', fail);
        resolve(socket);
      }
    };
  });
}

/** Bridge the held host connection to a fresh loopback gRPC connection. */
function bridge(held: net.Socket, localPort: number): Promise<void> {
  return new Promise((resolve) => {
    const local = net.connect({ host: '127.0.0.1', port: localPort });
    let done = false;
    const teardown = () => {
      if (done) return;
      done = true;
      held.destroy();
      local.destroy();
      resolve();
    };

    local.once('connect', () => {
      held.pipe(local);
      local.pipe(held);
    });

    held.once('close', teardown);
    held.once('error', teardown);
    local.once('close', teardown);
    local.once('error', teardown);
  });
}

function resolveBackoff(reconnect: ServeRemoteOptions['reconnect']): ServeRemoteReconnect | null {
  if (reconnect === false) return null;
  if (reconnect === undefined || reconnect === true) {
    return { initialDelayMs: 1000, maxDelayMs: 30000 };
  }
  return { initialDelayMs: reconnect.initialDelayMs ?? 1000, maxDelayMs: reconnect.maxDelayMs ?? 30000 };
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Serve a v2 adapter by dialing out to a remote Criteria host (D42).
 *
 * @example
 * ```typescript
 * import { serveRemote } from '@brokenbots/criteria-typescript-adapter-sdk';
 *
 * serveRemote(
 *   {
 *     name: 'my-adapter',
 *     version: '1.0.0',
 *     description: 'Does useful things',
 *     async execute(req, helpers) { helpers.outcomes.finalize('success'); },
 *   },
 *   {
 *     host: 'criteria.example.com:7778',
 *     mtls: {
 *       client_cert: process.env.CRITERIA_REMOTE_TLS_CERT!,
 *       client_key: process.env.CRITERIA_REMOTE_TLS_KEY!,
 *       ca_bundle: process.env.CRITERIA_REMOTE_CA!,
 *     },
 *     accept_token: process.env.CRITERIA_REMOTE_TOKEN,
 *     identity: { digest: process.env.CRITERIA_REMOTE_DIGEST! },
 *   },
 * );
 * ```
 */
export async function serveRemote(config: ServeConfig, opts: ServeRemoteOptions): Promise<void> {
  // Parity with serve(): support manifest extraction without a host.
  if (process.argv.includes('--emit-manifest')) {
    console.log(JSON.stringify(buildManifest(config), null, 2));
    process.exit(0);
  }

  if (!opts.identity || !opts.identity.digest) {
    throw new Error('serveRemote: opts.identity.digest is required');
  }

  const frame: HandshakeFrame = {
    name: opts.identity.name ?? config.name,
    version: opts.identity.version ?? config.version,
    digest: opts.identity.digest,
    token: opts.accept_token,
  };

  // The held connection is reused for the whole session, so Info()/Execute
  // completion must NOT terminate the process the way serve() does.
  const { server, address } = await startServerV2(config, { emitHandshake: false });
  const localPort = Number(address.split(':').pop());

  let server_: Server | undefined = server;
  const shutdown = () => {
    if (server_) {
      stopServerV2(server_);
      server_ = undefined;
    }
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  const backoff = resolveBackoff(opts.reconnect);
  let nextDelay = backoff?.initialDelayMs ?? 1000;

  for (;;) {
    try {
      const held = await dialHost(opts, frame);
      // Connection established: reset backoff for the next disconnect.
      nextDelay = backoff?.initialDelayMs ?? 1000;
      await bridge(held, localPort);
    } catch {
      // Fall through to the reconnect decision below.
    }

    if (!backoff) {
      break;
    }
    await delay(nextDelay);
    nextDelay = Math.min(nextDelay * 2, backoff.maxDelayMs ?? 30000);
  }

  if (server_) {
    await stopServerV2(server_);
  }
}
