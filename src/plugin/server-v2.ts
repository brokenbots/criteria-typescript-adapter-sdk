/**
 * v2 gRPC server implementation for Criteria adapter plugins.
 */

import './long-polyfill.js';
import * as fs from 'fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type { INamespace } from 'protobufjs';
import { PROTOCOL_VERSION } from './handshake.js';
import protoJson from '../proto/criteria/v2/adapter.json' with { type: 'json' };
import type { ServeConfig, SessionStore, Helpers } from './types-v2.js';

// Idle server-streams must emit a Heartbeat on this cadence. The host's
// stall detector, fed solely by the Log stream, declares a session crashed
// after ~90s (three missed heartbeats) of silence. Keep this in sync with the
// Go SDK's criteriav2.HeartbeatInterval.
const HEARTBEAT_INTERVAL_MS = 30_000;

// Grace window between the last Log stream closing and triggering onTeardown.
// Long enough to absorb the host cancelling+reopening the Log stream during
// stall recovery / respawn (synchronous, completes in a single round-trip),
// short enough to stay well inside go-plugin's ~2s teardown grace window.
const HOST_DISCONNECT_GRACE_MS = 500;

/** Convert a plain JS value to proto-loader's google.protobuf.Value wire format. */
function toProtoValue(value: unknown): object {
  if (value === null || value === undefined) {
    return { nullValue: 0 };
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'number') {
    return { numberValue: value };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { listValue: { values: value.map(toProtoValue) } };
  }
  if (typeof value === 'object') {
    return { structValue: toProtoStruct(value as Record<string, unknown>) };
  }
  return { stringValue: String(value) };
}

/** Convert a plain JS object to proto-loader's google.protobuf.Struct wire format. */
function toProtoStruct(obj: Record<string, unknown>): object {
  const fields: Record<string, object> = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = toProtoValue(v);
  }
  return { fields };
}

/** Parse a proto google.protobuf.Struct back to a plain JS object. */
export function fromProtoStruct(struct: unknown): Record<string, unknown> {
  if (!struct || typeof struct !== 'object') return {};
  const s = struct as Record<string, unknown>;
  const fields = s.fields as Record<string, { kind?: string; [key: string]: unknown }> | undefined;
  if (!fields) return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    result[k] = fromProtoValue(v);
  }
  return result;
}

export function fromProtoValue(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  const val = v as Record<string, unknown>;
  if ('stringValue' in val) return val.stringValue;
  if ('numberValue' in val) return val.numberValue;
  if ('boolValue' in val) return val.boolValue;
  if ('nullValue' in val) return null;
  if ('listValue' in val) {
    const lv = val.listValue as Record<string, unknown[]>;
    return (lv.values ?? []).map(fromProtoValue);
  }
  if ('structValue' in val) {
    return fromProtoStruct(val.structValue);
  }
  return v;
}

// ─── State ───────────────────────────────────────────────────────────────────

interface PendingPerm {
  resolve: (value: { decision: 'allow' | 'deny'; reason?: string }) => void;
  reject: (err: Error) => void;
}

interface SessionState {
  sessionId: string;
  store: Map<string, unknown>;
  secrets: Map<string, string>;
  allowedOutcomes: string[];
  logStream?: grpc.ServerWritableStream<unknown, unknown>;
  executeStream?: grpc.ServerWritableStream<unknown, unknown>;
  permissionsStream?: grpc.ServerDuplexStream<unknown, unknown>;
  pendingPermissions: Map<string, PendingPerm>;
  logBuffer: unknown[];
  finalized: boolean;
}

const sessions = new Map<string, SessionState>();

function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

function ensureSession(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      sessionId,
      store: new Map(),
      secrets: new Map(),
      allowedOutcomes: [],
      pendingPermissions: new Map(),
      logBuffer: [],
      finalized: false,
    };
    sessions.set(sessionId, s);
  }
  return s;
}

// ─── Helpers factory ─────────────────────────────────────────────────────────

function createHelpers(_config: ServeConfig, session: SessionState): Helpers {
  const sessionStore: SessionStore = {
    get<T>(key: string): T | undefined {
      return session.store.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      session.store.set(key, value);
    },
  };

  const secretsHelper = {
    async get(name: string): Promise<string | undefined> {
      return session.secrets.get(name);
    },
  };

  const outcomesHelper = {
    async validate(outcome: string): Promise<{ valid: boolean; error?: string }> {
      if (session.allowedOutcomes.length > 0 && !session.allowedOutcomes.includes(outcome)) {
        return { valid: false, error: `Outcome "${outcome}" is not allowed. Allowed: ${session.allowedOutcomes.join(', ')}` };
      }
      return { valid: true };
    },
    async finalize(outcome: string, opts?: { reason?: string }): Promise<void> {
      if (session.finalized) {
        throw new Error('Result already sent');
      }
      session.finalized = true;
      const outputsMap: Record<string, unknown> = {
        reason: opts?.reason ?? '',
      };
      const event = {
        result: {
          outcome,
          outputsJson: Buffer.from(JSON.stringify(outputsMap)),
        },
      };
      if (session.executeStream) {
        session.executeStream.write(event);
      }
    },
  };

  const logHelper = {
    async stdout(chunk: string | Uint8Array): Promise<void> {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const event = {
        sessionId: session.sessionId,
        stepName: '', // filled below if available
        streamName: 'stdout',
        line: buffer,
      };
      if (session.logStream) {
        session.logStream.write(event);
      } else {
        session.logBuffer.push(event);
      }
    },
    async stderr(chunk: string | Uint8Array): Promise<void> {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const event = {
        sessionId: session.sessionId,
        stepName: '',
        streamName: 'stderr',
        line: buffer,
      };
      if (session.logStream) {
        session.logStream.write(event);
      } else {
        session.logBuffer.push(event);
      }
    },
    async adapterEvent(kind: string, data?: Record<string, unknown>): Promise<void> {
      const event = {
        adapter: {
          eventKind: kind,
          payload: data ? toProtoStruct(data) : undefined,
        },
      };
      if (session.executeStream) {
        session.executeStream.write(event);
      }
    },
  };

  const permissionHelper = {
    async request(req: { tool: string; args?: Record<string, unknown> }): Promise<{ decision: 'allow' | 'deny'; reason?: string }> {
      const requestId = `perm-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

      // Build args digest (simplified: JSON.stringify)
      const argsJson = req.args ? JSON.stringify(req.args) : '{}';
      const preview = argsJson.length > 200 ? argsJson.slice(0, 200) + '...' : argsJson;

      // Send permission.request event on Execute stream
      const event = {
        adapter: {
          eventKind: 'permission.request',
          payload: toProtoStruct({
            requestId: requestId,
            tool: req.tool,
            argsDigest: '', // TODO: proper digest
            argsPreview: preview,
          }),
        },
      };
      if (session.executeStream) {
        session.executeStream.write(event);
      }

      // Wait for PermissionEvent from host via Permissions stream
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          session.pendingPermissions.delete(requestId);
          reject(new Error(`Permission request ${requestId} timed out`));
        }, 60000);

        session.pendingPermissions.set(requestId, {
          resolve: (val) => {
            clearTimeout(timeout);
            resolve(val);
          },
          reject: (err) => {
            clearTimeout(timeout);
            reject(err);
          },
        });
      });
    },
  };

  return {
    session: sessionStore,
    secrets: secretsHelper,
    outcomes: outcomesHelper,
    log: logHelper,
    permission: permissionHelper,
  };
}

// ─── gRPC service implementation ─────────────────────────────────────────────

function loadProtoService(): grpc.GrpcObject {
  // Loaded from a bundled JSON descriptor rather than the .proto on disk:
  // `bun build --compile` cannot bundle a file read at runtime, which would
  // leave the compiled binary dependent on its working directory.
  // Regenerate with `bun run proto:json` after editing adapter.proto.
  const packageDefinition = protoLoader.fromJSON(protoJson as INamespace, {
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDefinition);
}

function buildInfoResponse(config: ServeConfig): object {
  const secretsMap: Record<string, string> = {};
  if (config.secrets) {
    for (const s of config.secrets) {
      if (typeof s === 'string') {
        secretsMap[s] = '';
      } else {
        secretsMap[s.name] = s.description ?? '';
      }
    }
  }
  // InfoResponse.permissions is `repeated string` — names only, no descriptions.
  const permissionNames = (config.permissions ?? []).map((p) => (typeof p === 'string' ? p : p.name));
  const schemaFromDef = (def?: { fields: Record<string, { type?: string; required?: boolean; description?: string }> }): object | undefined => {
    if (!def) return undefined;
    const fields: Record<string, object> = {};
    for (const [k, v] of Object.entries(def.fields)) {
      fields[k] = {
        type: v.type ?? 'string',
        required: v.required ?? false,
        description: v.description ?? '',
      };
    }
    return { fields };
  };

  return {
    name: config.name,
    version: config.version,
    description: config.description ?? '',
    capabilities: config.capabilities ?? [],
    platforms: config.platforms ?? [],
    sdk_protocol_version: '2',
    source_url: config.source_url ?? '',
    config_schema: schemaFromDef(config.config_schema),
    input_schema: schemaFromDef(config.input_schema),
    output_schema: schemaFromDef(config.output_schema),
    secrets: secretsMap,
    permissions: permissionNames,
    compatible_environments: [],
    container_image: '',
    supported_features: config.snapshot || config.restore ? ['snapshot', 'restore'] : [],
    max_chunk_bytes: 0,
  };
}

/** Options controlling how {@link startServerV2} brings up the gRPC server. */
export interface StartServerV2Options {
  /**
   * When false, the go-plugin handshake line is not written to stdout. Used by
   * `serveRemote()`, where the host learns the address via the phone-home
   * bridge rather than by reading the child process's stdout. Defaults to true.
   */
  emitHandshake?: boolean;

  /**
   * Invoked when the host appears to have torn down the gRPC connection.
   *
   * go-plugin's graceful teardown does NOT send a signal: it closes its gRPC
   * client (`client.Close()`), waits ~2s for the plugin to exit on its own, and
   * only then SIGKILLs ("plugin failed to exit gracefully"). An adapter that
   * parks forever never notices the disconnect and always hits the SIGKILL.
   *
   * We detect the disconnect via the long-lived Log stream(s) closing — the host
   * keeps one open per session for the lifetime of the session and cancels it
   * (along with the rest of the gRPC connection) on teardown. The host also
   * cancels+reopens the Log stream during stall recovery / respawn, so this is
   * debounced: a prompt reopen cancels the pending teardown, and only a
   * disconnect with no reopen fires it. Receiving this callback does not itself
   * exit the process — the caller decides (typically: drain the server then
   * `process.exit(0)`), so that the SDK stays generic and testable.
   */
  onTeardown?: (server: grpc.Server) => void;
}

export function startServerV2(config: ServeConfig, opts: StartServerV2Options = {}): Promise<{ server: grpc.Server; address: string }> {
  const emitHandshake = opts.emitHandshake ?? true;
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();

    // ─── Host-disconnect detection ───────────────────────────────────────────
    // See StartServerV2Options.onTeardown. We count open Log streams (one per
    // session, kept open for the session lifetime); when the last one closes we
    // schedule a teardown, and any prompt reopen (stall-recovery restart / host
    // reusing the adapter for a new session) cancels it. Only a true disconnect
    // — close with no reopen — fires onTeardown, well inside go-plugin's ~2s
    // grace window, so the host never reaches its SIGKILL backstop.
    const onTeardown = opts.onTeardown;
    let openLogStreams = 0;
    let teardownTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelPendingTeardown = () => {
      if (teardownTimer) {
        clearTimeout(teardownTimer);
        teardownTimer = undefined;
      }
    };
    const scheduleTeardown = () => {
      if (!onTeardown) return;
      cancelPendingTeardown();
      teardownTimer = setTimeout(() => {
        teardownTimer = undefined;
        onTeardown(server);
      }, HOST_DISCONNECT_GRACE_MS);
      teardownTimer.unref?.();
    };

    const protoDescriptor = loadProtoService();
    const criteriaPkg = protoDescriptor.criteria as grpc.GrpcObject | undefined;
    const v2Pkg = criteriaPkg?.v2 as grpc.GrpcObject | undefined;
    const serviceCtor = (v2Pkg?.AdapterService || protoDescriptor.AdapterService) as grpc.ServiceClientConstructor | undefined;
    const serviceDef = serviceCtor?.service;

    const impl: grpc.UntypedServiceImplementation = {
      Info: (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        callback(null, buildInfoResponse(config));
      },

      OpenSession: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        const req = call.request as Record<string, unknown>;
        const sessionId = String(req.sessionId ?? '');
        const session = ensureSession(sessionId);

        const cfg = req.config as Record<string, string> ?? {};
        session.allowedOutcomes = (req.allowedOutcomes as string[]) ?? [];

        const secrets = req.secrets as Record<string, string> ?? {};
        for (const [k, v] of Object.entries(secrets)) {
          session.secrets.set(k, v);
        }

        // Also set config values in session store for adapter convenience
        for (const [k, v] of Object.entries(cfg)) {
          session.store.set(`config.${k}`, v);
        }

        const helpers = createHelpers(config, session);

        if (config.openSession) {
          config.openSession(req as any, helpers)
            .then(() => callback(null, {}))
            .catch((err) => callback(err as Error));
        } else {
          callback(null, {});
        }
      },

      Execute: (call: grpc.ServerWritableStream<unknown, unknown>) => {
        const req = call.request as Record<string, unknown>;
        const sessionId = String(req.sessionId ?? '');
        const stepName = String(req.stepName ?? '');
        const session = getSession(sessionId);

        if (!session) {
          call.emit('error', new Error(`Session not found: ${sessionId}`));
          call.end();
          return;
        }

        session.executeStream = call;
        session.logBuffer = [];
        session.finalized = false;

        // Flush buffered log events once Log stream arrives
        const flushLogs = () => {
          if (session.logStream && session.logBuffer.length > 0) {
            for (const ev of session.logBuffer) {
              session.logStream.write(ev);
            }
            session.logBuffer = [];
          }
        };
        // Poll briefly for log stream
        const logInterval = setInterval(flushLogs, 50);
        setTimeout(() => clearInterval(logInterval), 5000);

        const input = (req.input as Record<string, string>) ?? {};
        const secretInputs = (req.secretInputs as Record<string, string>) ?? {};
        const allowedOutcomes = (req.allowedOutcomes as string[]) ?? [];
        session.allowedOutcomes = allowedOutcomes;

        const executeReq = {
          sessionId,
          stepName,
          input,
          secretInputs,
          allowedOutcomes,
        };

        const helpers = createHelpers(config, session);

        config.execute(executeReq as any, helpers)
          .then(() => {
            if (!session.finalized) {
              call.emit('error', new Error('Execute completed without sending result'));
            }
          })
          .catch((err) => {
            call.emit('error', err);
          })
          .finally(() => {
            clearInterval(logInterval);
            call.end();
          });
      },

      Log: (call: grpc.ServerWritableStream<unknown, unknown>) => {
        const req = call.request as Record<string, unknown>;
        const sessionId = String(req.sessionId ?? '');
        const session = getSession(sessionId);

        if (!session) {
          call.emit('error', new Error(`Session not found: ${sessionId}`));
          call.end();
          return;
        }

        session.logStream = call;

        // A (re)opened Log stream means the host is still connected — cancel any
        // pending teardown that an earlier close may have scheduled.
        openLogStreams++;
        cancelPendingTeardown();

        // Flush buffered logs
        if (session.logBuffer.length > 0) {
          for (const ev of session.logBuffer) {
            call.write(ev);
          }
          session.logBuffer = [];
        }

        // Emit periodic heartbeats on the Log stream. The host's stall detector
        // is fed solely by this stream and an idle session emits no log traffic
        // while it waits behind a long-running step on another session, so
        // without these it is falsely declared crashed after ~90s. The host only
        // checks that the heartbeat field is present, not its contents.
        const heartbeat = setInterval(() => {
          if (!session.logStream) {
            return;
          }
          try {
            session.logStream.write({ heartbeat: { streamName: 'log' } });
          } catch {
            /* stream is closing; the close/cancelled handler clears the timer */
          }
        }, HEARTBEAT_INTERVAL_MS);
        // Don't let the heartbeat timer keep the process alive on its own.
        heartbeat.unref?.();

        let stopped = false;
        const stop = () => {
          if (stopped) return;
          stopped = true;
          clearInterval(heartbeat);
          session.logStream = undefined;
          // Last long-lived Log stream gone → host is likely disconnecting.
          // Debounced: a prompt reopen (stall recovery) cancels the teardown.
          openLogStreams--;
          if (openLogStreams <= 0) {
            openLogStreams = 0;
            scheduleTeardown();
          }
        };
        // Keep stream open until client closes it
        call.on('cancelled', stop);
        call.on('close', stop);
      },

      Permissions: (call: grpc.ServerDuplexStream<unknown, unknown>) => {
        // We need to find the session. Unfortunately LogRequest doesn't have sessionId
        // but the ExecuteRequest does. The Permissions stream doesn't have a request message.
        // Wait, looking at the proto, Permissions is bidi streaming with PermissionEvent as input
        // and PermissionDecision as output. There's no initial request.
        // How do we know which session the permissions belong to?

        // Looking at the Go SDK, the Permissions stream is per-adapter, not per-session.
        // The PermissionEvent contains requestId which is globally unique.
        // So we can look up any pending permission across all sessions.

        const handleMessage = (msg: unknown) => {
          const ev = msg as Record<string, unknown>;
          const reqEv = ev.request as Record<string, string> | undefined;
          const cancelEv = ev.cancel as Record<string, string> | undefined;

          if (reqEv) {
            const id = reqEv.requestId;
            // Find pending permission across all sessions
            for (const session of sessions.values()) {
              const pending = session.pendingPermissions.get(id);
              if (pending) {
                session.pendingPermissions.delete(id);
                pending.resolve({ decision: 'allow', reason: reqEv.reason });
                break;
              }
            }
            // Acknowledge
            call.write({ requestId: id, decision: 'allow' });
          }

          if (cancelEv) {
            const id = cancelEv.requestId;
            for (const session of sessions.values()) {
              const pending = session.pendingPermissions.get(id);
              if (pending) {
                session.pendingPermissions.delete(id);
                pending.resolve({ decision: 'deny', reason: cancelEv.reason });
                break;
              }
            }
          }
        };

        call.on('data', handleMessage);
        call.on('end', () => {
          // Drain all pending permissions with deny
          for (const session of sessions.values()) {
            for (const [, pending] of session.pendingPermissions) {
              pending.resolve({ decision: 'deny', reason: 'Permissions stream closed' });
            }
            session.pendingPermissions.clear();
          }
          call.end();
        });
        call.on('error', () => {
          for (const session of sessions.values()) {
            for (const [, pending] of session.pendingPermissions) {
              pending.resolve({ decision: 'deny', reason: 'Permissions stream error' });
            }
            session.pendingPermissions.clear();
          }
        });
      },

      Pause: (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        callback(null, {});
      },

      Resume: (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        callback(null, {});
      },

      Snapshot: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        const req = call.request as Record<string, unknown>;
        const sessionId = String(req.sessionId ?? '');
        const session = getSession(sessionId);
        if (!session) {
          callback(new Error(`Session not found: ${sessionId}`));
          return;
        }
        const helpers = createHelpers(config, session);
        if (config.snapshot) {
          config.snapshot(sessionId, helpers)
            .then((resp) => callback(null, resp))
            .catch((err) => callback(err as Error));
        } else {
          callback(null, { state: Buffer.alloc(0), schemaVersion: 1 });
        }
      },

      Restore: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        const req = call.request as Record<string, unknown>;
        const sessionId = String(req.sessionId ?? '');
        const session = getSession(sessionId);
        if (!session) {
          callback(new Error(`Session not found: ${sessionId}`));
          return;
        }
        const helpers = createHelpers(config, session);
        if (config.restore) {
          const blob = {
            state: (req.state as Uint8Array) ?? new Uint8Array(0),
            schemaVersion: (req.schemaVersion as number) ?? 1,
          };
          config.restore(sessionId, blob, helpers)
            .then(() => callback(null, {}))
            .catch((err) => callback(err as Error));
        } else {
          callback(null, {});
        }
      },

      Inspect: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        const req = call.request as Record<string, unknown>;
        const sessionId = String(req.sessionId ?? '');
        const session = getSession(sessionId);
        if (!session) {
          callback(new Error(`Session not found: ${sessionId}`));
          return;
        }
        callback(null, {
          current_step: '',
          pending_permission_count: session.pendingPermissions.size,
          last_activity_at: new Date(),
          fields: [],
        });
      },

      CloseSession: (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        const req = call.request as Record<string, unknown>;
        const sessionId = String(req.sessionId ?? '');
        const session = getSession(sessionId);
        if (!session) {
          callback(new Error(`Session not found: ${sessionId}`));
          return;
        }
        const helpers = createHelpers(config, session);
        if (config.closeSession) {
          config.closeSession(req as any, helpers)
            .then(() => {
              sessions.delete(sessionId);
              callback(null, {});
            })
            .catch((err) => callback(err as Error));
        } else {
          sessions.delete(sessionId);
          callback(null, {});
        }
      },
    };

    if (!serviceDef) {
      // Fallback manual service definition
      const manualServiceDef: grpc.ServiceDefinition = {
        Info: { path: '/criteria.v2.AdapterService/Info', requestStream: false, responseStream: false,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        OpenSession: { path: '/criteria.v2.AdapterService/OpenSession', requestStream: false, responseStream: false,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        Execute: { path: '/criteria.v2.AdapterService/Execute', requestStream: false, responseStream: true,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        Log: { path: '/criteria.v2.AdapterService/Log', requestStream: false, responseStream: true,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        Permissions: { path: '/criteria.v2.AdapterService/Permissions', requestStream: true, responseStream: true,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        Pause: { path: '/criteria.v2.AdapterService/Pause', requestStream: false, responseStream: false,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        Resume: { path: '/criteria.v2.AdapterService/Resume', requestStream: false, responseStream: false,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        Snapshot: { path: '/criteria.v2.AdapterService/Snapshot', requestStream: false, responseStream: false,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        Restore: { path: '/criteria.v2.AdapterService/Restore', requestStream: false, responseStream: false,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        Inspect: { path: '/criteria.v2.AdapterService/Inspect', requestStream: false, responseStream: false,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
        CloseSession: { path: '/criteria.v2.AdapterService/CloseSession', requestStream: false, responseStream: false,
          requestSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), requestDeserialize: (arg: Buffer) => JSON.parse(arg.toString()),
          responseSerialize: (arg: unknown) => Buffer.from(JSON.stringify(arg)), responseDeserialize: (arg: Buffer) => JSON.parse(arg.toString()) },
      };
      server.addService(manualServiceDef, impl);
    } else {
      server.addService(serviceDef, impl);
    }

    // Determine bind address
    const tcpPort = process.env['PLUGIN_TCP_PORT'];
    const unixSocket = process.env['PLUGIN_UNIX_SOCKET'];

    let bindAddress: string;
    let handshakeNetwork: string;
    let handshakeAddress: string;

    if (unixSocket) {
      try { fs.unlinkSync(unixSocket); } catch { /* not present */ }
      bindAddress = `unix:${unixSocket}`;
      handshakeNetwork = 'unix';
      handshakeAddress = unixSocket;
    } else if (tcpPort) {
      bindAddress = `0.0.0.0:${tcpPort}`;
      handshakeNetwork = 'tcp';
      handshakeAddress = `127.0.0.1:${tcpPort}`;
    } else {
      bindAddress = '127.0.0.1:0';
      handshakeNetwork = 'tcp';
      handshakeAddress = '127.0.0.1:0';
    }

    server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) {
        reject(err);
        return;
      }
      if (handshakeNetwork === 'tcp') {
        handshakeAddress = `127.0.0.1:${port}`;
      }
      // go-plugin handshake: CORE-VERSION|APP-VERSION|NETWORK|ADDRESS|PROTOCOL|
      if (emitHandshake) {
        process.stdout.write(`1|${PROTOCOL_VERSION}|${handshakeNetwork}|${handshakeAddress}|grpc|\n`);
      }
      resolve({ server, address: handshakeAddress });
    });
  });
}

/**
 * Stop the gRPC server, preferring a graceful drain but never hanging.
 *
 * `tryShutdown` waits for in-flight RPCs to finish. That is normally instant
 * at teardown (the host has already closed its side), but a stream that never
 * drains would make the adapter un-exitable — and re-introduce the very
 * "parked forever" failure this module now avoids. So: try graceful first, but
 * bound it. If the drain stalls, `forceShutdown` closes the transport promptly.
 * This shuts down the gRPC server only — it does NOT signal or kill any child
 * process the adapter may have spawned; those are cleaned up by the adapter's
 * own `process.on('exit')` handlers.
 */
export function stopServerV2(server: grpc.Server, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    server.tryShutdown((err) => {
      if (err) {
        // Drain stalled (e.g. an open stream that won't end) — close the
        // transport so the process can still exit on its own schedule.
        try { server.forceShutdown(); } catch { /* already stopped */ }
      }
      done();
    });
    const timer = setTimeout(() => {
      try { server.forceShutdown(); } catch { /* already stopped */ }
      done();
    }, timeoutMs);
    timer.unref?.();
  });
}
