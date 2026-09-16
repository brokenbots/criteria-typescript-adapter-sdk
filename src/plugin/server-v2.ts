/**
 * v2 gRPC server implementation for Criteria adapter plugins.
 */

import './long-polyfill.js';
import * as fs from 'fs';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { randomBytes } from 'node:crypto';
import type { INamespace } from 'protobufjs';
import { PROTOCOL_VERSION } from './handshake.js';
import protoJson from '../proto/criteria/v2/adapter.json' with { type: 'json' };
import type { ServeConfig, SessionStore, Helpers } from './types-v2.js';
import {
  argsDigest,
  canonicalJSON,
  joinToolCallResultOutputs,
  parseAdapterToolTarget,
  ToolCallError,
  ToolCallDeniedError,
  ToolCallStreamClosedError,
  ToolCallTimeoutError,
  CALL_ERROR_HOST_UNSUPPORTED,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  EVENT_KIND_PERMISSION_REQUEST,
  PAYLOAD_KIND_ADAPTER_TOOL,
} from './toolcall.js';
import type { ToolCallResultFragment } from './toolcall.js';

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

/**
 * One in-flight adapter tool call (CRI-152), keyed by the permission.request
 * payload's request_id — the parallel of PendingPerm on the same Permissions
 * stream. Fragments accumulate until the final chunk (or a typed call_error)
 * resolves the entry; `grant` records the bare allow-grant signature that
 * distinguishes an old host (grant only, no result) from a silent one.
 */
interface PendingToolCall {
  grant: boolean;
  fragments: ToolCallResultFragment[];
  cancelled?: { reason?: string };
  settled: boolean;
  resolve: (result: { outcome: string; outputs: Record<string, unknown> | undefined }) => void;
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
  pendingToolCalls: Map<string, PendingToolCall>;
  // Set once a tool call on this session came back as a bare allow-grant with
  // no PermissionEvent.tool_call_result within its deadline: the host predates
  // adapter tools (ADR-0004 §9), so later calls fail fast without sending.
  toolCallsUnsupported: boolean;
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
      pendingToolCalls: new Map(),
      toolCallsUnsupported: false,
      logBuffer: [],
      finalized: false,
    };
    sessions.set(sessionId, s);
  }
  return s;
}

// newToolCallRequestID mints a correlation id for one tool call (parity with
// the Go SDK's newToolCallRequestID). Falls back to a process-unique counter
// if crypto/rand ever fails, so concurrent calls still cannot collide.
let requestIDFallback = 0;
function newToolCallRequestID(): string {
  try {
    return `adapter-tool-${randomBytes(16).toString('hex')}`;
  } catch {
    requestIDFallback += 1;
    return `adapter-tool-fallback-${requestIDFallback}`;
  }
}

// Removes a pending tool-call entry unless it has already settled (its entry
// is gone from the map, e.g. resolved by a fragment after the caller stopped
// waiting).
function takePendingToolCall(requestId: string, sessionState: SessionState): PendingToolCall | undefined {
  const entry = sessionState.pendingToolCalls.get(requestId);
  if (!entry || entry.settled) {
    return undefined;
  }
  sessionState.pendingToolCalls.delete(requestId);
  return entry;
}

// Interprets a settled pending tool call into the helper's result — the TS
// port of the Go SDK's finishToolCall: a cancellation is a denial, a
// call_error is typed, fragments are reassembled in seq order, and empty
// outputs decode to undefined.
function finishToolCall(entry: PendingToolCall): { outcome: string; outputs: Record<string, unknown> | undefined } {
  if (entry.cancelled) {
    throw new ToolCallDeniedError(entry.cancelled.reason);
  }
  const first = entry.fragments[0];
  const code = first.callError ?? '';
  if (code !== '') {
    throw new ToolCallError(code);
  }
  let outputsJson: Buffer;
  if (entry.fragments.length === 1 && !first.chunk) {
    // Single non-chunked message: outputs_json is the whole object.
    outputsJson = Buffer.from(first.outputsJson ?? new Uint8Array(0));
  } else {
    outputsJson = joinToolCallResultOutputs(entry.fragments);
  }
  if (outputsJson.length === 0) {
    return { outcome: first.outcome ?? '', outputs: undefined };
  }
  let outputs: Record<string, unknown>;
  try {
    outputs = JSON.parse(outputsJson.toString('utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`adapter tool call outputs_json: ${(err as Error).message}`);
  }
  if (outputs === null || typeof outputs !== 'object' || Array.isArray(outputs)) {
    throw new Error('adapter tool call outputs_json: cannot decode into an outputs object');
  }
  return { outcome: first.outcome ?? '', outputs };
}

// Resolves the entry with finishToolCall's result, or rejects it with the
// typed failure the result interpretation produced (denial, call_error,
// reassembly or decode error).
function settleToolCall(entry: PendingToolCall): void {
  try {
    entry.resolve(finishToolCall(entry));
  } catch (err) {
    entry.reject(err as Error);
  }
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

      const args = req.args ?? {};
      const argsJson = JSON.stringify(args);
      const preview = argsJson.length > 200 ? argsJson.slice(0, 200) + '...' : argsJson;
      // sha256 over canonical JSON — byte-identical with the host's and the Go
      // SDK's ArgsDigest (criteria/v2/canonical.go); the documented formula
      // behind PermissionRequest.args_digest (CRI-154).
      const digest = argsDigest(args);

      // Send permission.request event on Execute stream
      const event = {
        adapter: {
          eventKind: EVENT_KIND_PERMISSION_REQUEST,
          payload: toProtoStruct({
            requestId: requestId,
            tool: req.tool,
            argsDigest: digest,
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

  const toolsHelper = {
    /**
     * Call another adapter's tool (CRI-152). Sends the permission.request
     * AdapterEvent on the Execute stream with payload kind "adapter_tool"
     * (request_id, target, tool, args, args_digest) and blocks on the
     * correlated PermissionEvent.tool_call_result (or the cancel of a denied
     * call) with a bounded deadline. Degrades typed on old hosts: a bare
     * allow-grant with no result inside the deadline resolves with a
     * ToolCallError code "host_unsupported" and caches the session, so later
     * calls fail fast without sending (ADR-0004 §9).
     *
     * @returns the callee's outcome and typed outputs; outputs is undefined
     *   when the callee emitted none.
     * @throws ToolCallDeniedError when the host denies the call (cancel).
     * @throws ToolCallError when the host answers with a call_error (code
     *   carries the registry value) or when the old-host signature is
     *   detected.
     * @throws ToolCallTimeoutError when the deadline passes with no grant at
     *   all (the session is NOT cached as unsupported in that case).
     * @throws ToolCallStreamClosedError when the Permissions stream ends
     *   while the call is in flight.
     */
    async callAdapterTool(
      call: { target: string; args?: Record<string, unknown> },
      opts?: { timeoutMs?: number }
    ): Promise<{ outcome: string; outputs: Record<string, unknown> | undefined }> {
      if (!call || typeof call.target !== 'string' || call.target === '') {
        throw new Error('adapter tool call requires a target (adapter.<type>.<name>.tools.<tool>)');
      }
      if (session.toolCallsUnsupported) {
        throw new ToolCallError(CALL_ERROR_HOST_UNSUPPORTED);
      }
      // Tool name only (no adapter prefix). An unparseable target is still
      // sent — the host answers with the typed malformed_target call_error —
      // but the bare whole-surface form has no tool to call at all.
      const tool = parseAdapterToolTarget(call.target)?.tool ?? '';
      if (tool === '') {
        throw new Error(`adapter tool call requires a tool-scoped target (adapter.<type>.<name>.tools.<tool>), got "${call.target}"`);
      }

      // The wire args are the canonical-JSON-normalized object; nil is sent
      // as an empty object (Go parity: json.Unmarshal into a map leaves nil,
      // which buildToolCallPayload replaces with an empty object). Non-object
      // args are rejected before sending.
      const canonical = canonicalJSON(call.args ?? null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(canonical);
      } catch (err) {
        throw new Error(`adapter tool call "${tool}" args must be a JSON object: ${(err as Error).message}`);
      }
      if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error(`adapter tool call "${tool}" args must be a JSON object`);
      }
      const args = parsed === null ? {} : (parsed as Record<string, unknown>);
      const digest = argsDigest(args);
      const preview = canonical.length > 200 ? canonical.slice(0, 200) + '...' : canonical;
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
      const requestId = newToolCallRequestID();

      return new Promise((resolve, reject) => {
        const entry: PendingToolCall = {
          grant: false,
          fragments: [],
          settled: false,
          resolve: (result) => {
            if (entry.settled) return;
            entry.settled = true;
            clearTimeout(timer);
            resolve(result);
          },
          reject: (err) => {
            if (entry.settled) return;
            entry.settled = true;
            clearTimeout(timer);
            reject(err);
          },
        };

        const timer = setTimeout(() => {
          if (session.pendingToolCalls.get(requestId) !== entry) {
            return; // already settled by a correlated reply
          }
          session.pendingToolCalls.delete(requestId);
          if (entry.grant) {
            // Bare allow-grant with no result within the deadline: the host
            // predates adapter tools (ADR-0004 §9). Cache the session so
            // later calls fail fast without sending.
            session.toolCallsUnsupported = true;
            entry.reject(new ToolCallError(CALL_ERROR_HOST_UNSUPPORTED));
          } else {
            entry.reject(new ToolCallTimeoutError(`adapter tool call "${tool}" to ${call.target} timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);

        session.pendingToolCalls.set(requestId, entry);
        if (!session.executeStream) {
          session.pendingToolCalls.delete(requestId);
          entry.reject(new Error('adapter tool call requires an open Execute stream'));
          return;
        }
        try {
          session.executeStream.write({
            adapter: {
              eventKind: EVENT_KIND_PERMISSION_REQUEST,
              payload: toProtoStruct({
                kind: PAYLOAD_KIND_ADAPTER_TOOL,
                request_id: requestId,
                target: call.target,
                tool,
                args,
                args_digest: digest,
                args_preview: preview,
              }),
            },
          });
        } catch (err) {
          session.pendingToolCalls.delete(requestId);
          entry.reject(new Error(`adapter tool call "${tool}": send permission.request: ${(err as Error).message}`));
        }
      });
    },
  };

  return {
    session: sessionStore,
    secrets: secretsHelper,
    outcomes: outcomesHelper,
    log: logHelper,
    permission: permissionHelper,
    tools: toolsHelper,
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
          // proto-loader (oneofs: true) exposes the oneof members as camelCase
          // fields; tool_call_result answers an adapter tool call.
          const resultEv = ev.toolCallResult as ToolCallResultFragment | undefined;

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
            // Mark the tool call the grant correlates with: an allow-grant
            // with no following tool_call_result is the old-host signature.
            for (const session of sessions.values()) {
              const entry = session.pendingToolCalls.get(id);
              if (entry) {
                entry.grant = true;
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
            // A denied tool call never arrives as tool_call_result — it is
            // answered with cancel. A cancel for an unknown id (e.g. a late
            // denial after the caller timed out) is dropped.
            for (const session of sessions.values()) {
              const entry = takePendingToolCall(id, session);
              if (entry) {
                entry.cancelled = { reason: cancelEv.reason };
                settleToolCall(entry);
                break;
              }
            }
          }

          if (resultEv) {
            // Accumulate the fragment and resolve on the final chunk (or on a
            // typed call_error, which is never chunked). Results for unknown
            // request ids (e.g. a reply after the caller timed out) are
            // dropped, mirroring the Go SDK's dispatch.
            const id = resultEv.requestId;
            for (const session of sessions.values()) {
              const entry = session.pendingToolCalls.get(id);
              if (!entry || entry.settled) {
                continue;
              }
              entry.fragments.push(resultEv);
              const code = resultEv.callError ?? '';
              if (code !== '' || !resultEv.chunk || resultEv.chunk.final) {
                session.pendingToolCalls.delete(id);
                settleToolCall(entry);
              }
              break;
            }
          }
        };

        call.on('data', handleMessage);
        // The stream is gone (client half-close, transport error or a client
        // cancel): drain every pending permission with deny and every
        // in-flight adapter tool call with a typed stream-closed error — no
        // reply can ever arrive. Draining twice is safe; entries settle once.
        const drainStreams = () => {
          for (const session of sessions.values()) {
            for (const [, pending] of session.pendingPermissions) {
              pending.resolve({ decision: 'deny', reason: 'Permissions stream closed' });
            }
            session.pendingPermissions.clear();
            for (const [, entry] of session.pendingToolCalls) {
              entry.reject(new ToolCallStreamClosedError('adapter tool call: permissions stream closed'));
            }
            session.pendingToolCalls.clear();
          }
        };
        call.on('end', () => {
          drainStreams();
          call.end();
        });
        call.on('error', drainStreams);
        call.on('cancelled', drainStreams);
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
