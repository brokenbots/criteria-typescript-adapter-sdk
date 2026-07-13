/**
 * Test harness for Criteria adapter plugins (v2).
 *
 * `TestHost` starts an adapter either **in-process** (pass `config`) or
 * **sub-process** (pass `binary`) and provides a friendly API that mirrors
 * the real Criteria host.
 *
 * @example In-process
 * ```ts
 * import { TestHost } from "@brokenbots/criteria-typescript-adapter-sdk/testing";
 *
 * const host = new TestHost({
 *   config: {
 *     name: "test-adapter",
 *     version: "1.0.0",
 *     description: "test",
 *     async execute(req, helpers) {
 *       await helpers.outcomes.finalize("success");
 *     },
 *   },
 * });
 *
 * await host.openSession({ config: {}, secrets: {} });
 * const result = await host.execute({ step: "s1", input: {}, allowed_outcomes: ["success"] });
 * expect(result.outcome).toBe("success");
 * ```
 */

import { spawn } from "child_process";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { ServeConfig } from "../plugin/types-v2.js";
import { startServerV2, stopServerV2, fromProtoStruct } from "../plugin/server-v2.js";

/* -------------------------------------------------------------------------- */
/*  Proto loading (client side)                                               */
/* -------------------------------------------------------------------------- */

const PROTO_PATH = new URL("../../proto/criteria/v2/adapter.proto", import.meta.url).pathname;
const INCLUDE_DIR = new URL("../../proto", import.meta.url).pathname;

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [INCLUDE_DIR],
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const criteriaPkg = protoDescriptor.criteria as grpc.GrpcObject | undefined;
const v2Pkg = criteriaPkg?.v2 as grpc.GrpcObject | undefined;
const AdapterService = (v2Pkg?.AdapterService ||
  protoDescriptor.AdapterService) as grpc.ServiceClientConstructor;

/* -------------------------------------------------------------------------- */
/*  Helper to parse go-plugin handshake line                                  */
/* -------------------------------------------------------------------------- */

function parseHandshakeLine(line: string): {
  coreProtocol: number;
  appProtocol: number;
  network: string;
  address: string;
  protocol: string;
} {
  const parts = line.trim().split("|");
  return {
    coreProtocol: parseInt(parts[0] || "0", 10),
    appProtocol: parseInt(parts[1] || "0", 10),
    network: parts[2] || "tcp",
    address: parts[3] || "",
    protocol: parts[4] || "grpc",
  };
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/* -------------------------------------------------------------------------- */
/*  TestHost                                                                  */
/* -------------------------------------------------------------------------- */

export class TestHost {
  private binary?: string;
  private config?: ServeConfig;

  private server?: grpc.Server;
  private client?: grpc.Client;
  private child?: ReturnType<typeof spawn>;
  private address?: string;

  private sessionId?: string;
  private _logChunks: { stream: "stdout" | "stderr"; chunk: string }[] = [];
  private _permStream?: grpc.ClientDuplexStream<unknown, unknown>;
  private _autoGrantPermissions = false;
  private _permissionDelayMs = 0;

  constructor(opts: { binary?: string; config?: ServeConfig; autoGrantPermissions?: boolean; permissionDelayMs?: number }) {
    if (!opts.binary && !opts.config) {
      throw new Error("TestHost requires either `binary` or `config`");
    }
    this.binary = opts.binary;
    this.config = opts.config;
    this._autoGrantPermissions = opts.autoGrantPermissions ?? false;
    this._permissionDelayMs = opts.permissionDelayMs ?? 0;
  }

  /** Start the adapter and connect. */
  async start(): Promise<void> {
    if (this.config) {
      // In-process
      const { server, address } = await startServerV2(this.config);
      this.server = server;
      this.address = address;
      this.client = new AdapterService(address, grpc.credentials.createInsecure());
    } else if (this.binary) {
      // Sub-process handshake
      const child = spawn(this.binary, [], {
        env: {
          ...process.env,
          CRITERIA_PLUGIN: "7a1bf31f-c805-4e75-a31c-22195c9fdd4c",
        },
      });
      this.child = child;

      const handshake = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error("Handshake timeout")), 10000);
        child.stdout!.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const idx = buf.indexOf("\n");
          if (idx >= 0) {
            clearTimeout(timer);
            resolve(buf.slice(0, idx));
          }
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Adapter exited early with code ${code}`));
        });
      });

      const parsed = parseHandshakeLine(handshake);
      this.address = parsed.address;
      this.client = new AdapterService(this.address, grpc.credentials.createInsecure());
    }
  }

  /** Ensure started. */
  private async ensureStarted(): Promise<void> {
    if (!this.client) await this.start();
  }

  /** Open a session. */
  async openSession(opts: { sessionId?: string; config?: Record<string, unknown>; secrets?: Record<string, string> }): Promise<void> {
    await this.ensureStarted();
    const client = this.client!;
    const sid = opts.sessionId ?? randomId();
    this.sessionId = sid;
    return new Promise((resolve, reject) => {
      (client as any).OpenSession(
        { sessionId: sid, config: opts.config ?? {}, secrets: opts.secrets ?? {} },
        (err: any, _resp: any) => {
          if (err) return reject(err);
          resolve(undefined);
        }
      );
    });
  }

  /** Execute a step. */
  async execute(opts: {
    stepName: string;
    input?: Record<string, unknown>;
    allowedOutcomes?: string[];
  }): Promise<{ outcome: string; reason?: string; payload?: Record<string, unknown> }> {
    await this.ensureStarted();
    if (!this.sessionId) throw new Error("Session not open");
    const client = this.client!;

    // Start streams
    const execStream = (client as any).Execute({
      sessionId: this.sessionId,
      stepName: opts.stepName,
      input: opts.input ?? {},
      allowedOutcomes: opts.allowedOutcomes ?? [],
    });

    const logStream = (client as any).Log({ sessionId: this.sessionId });
    const permStream = (client as any).Permissions();
    this._permStream = permStream;

    // Collect logs
    logStream.on("data", (evt: any) => {
      if (evt.stdout) this._logChunks.push({ stream: "stdout", chunk: evt.stdout });
      if (evt.stderr) this._logChunks.push({ stream: "stderr", chunk: evt.stderr });
    });

    // Handle permission decisions from adapter -> host (acknowledge)
    permStream.on("data", (evt: any) => {
      if (evt.acknowledge?.requestId) {
        // Server acknowledged our allow/deny
      }
    });

    // Collect result and handle permission requests from adapter
    const result = await new Promise<any>((resolve, reject) => {
      let resolved = false;
      execStream.on("data", (evt: any) => {
        if (resolved) return;
        if (evt.result) {
          resolved = true;
          resolve(evt.result);
          permStream.end();
          this._permStream = undefined;
          return;
        }
        const adapterEvt = evt.adapter as Record<string, unknown> | undefined;
        if (adapterEvt?.eventKind === "permission.request") {
          const payload = fromProtoStruct(adapterEvt.payload);
          const reqId = payload.requestId as string | undefined;
          if (reqId && this._autoGrantPermissions) {
            if (this._permissionDelayMs > 0) {
              setTimeout(() => {
                permStream.write({ request: { requestId: reqId } });
              }, this._permissionDelayMs);
            } else {
              permStream.write({ request: { requestId: reqId } });
            }
          }
        }
      });
      execStream.on("error", (err: any) => {
        if (!resolved) reject(err);
      });
      execStream.on("end", () => {
        if (!resolved) reject(new Error("Execute stream ended without result"));
      });
      permStream.on("data", (evt: any) => {
        if (evt.acknowledge?.requestId) {
          // Server acknowledged our allow/deny
        }
      });
      permStream.on("error", (_err: any) => {
        // ignore
      });
    });

    // outputs travel on the outputs_json bytes field (the legacy map<string,string>
    // outputs field was removed in the v2 typed-outputs cutover). proto-loader
    // maps outputs_json → outputsJson.
    const outputsJson = (result as { outputsJson?: Uint8Array | string }).outputsJson;
    const outputs: Record<string, unknown> = outputsJson
      ? JSON.parse(Buffer.from(outputsJson).toString("utf8"))
      : {};

    return {
      outcome: result.outcome ?? "",
      reason: typeof outputs.reason === "string" ? outputs.reason : undefined,
      payload: result.payload ? fromProtoStruct(result.payload) : undefined,
    };
  }

  /** Grant a pending permission (by requestId). */
  async grantPermission(requestId: string): Promise<void> {
    const permStream = this._permStream ?? (this.client as any).Permissions();
    permStream.write({ request: { requestId } });
    return new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** Deny a pending permission (by requestId). */
  async denyPermission(requestId: string): Promise<void> {
    const permStream = this._permStream ?? (this.client as any).Permissions();
    permStream.write({ cancel: { requestId, reason: "denied by test" } });
    return new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** Snapshot the current session. */
  async snapshot(): Promise<{ schemaVersion: number; state: Uint8Array }> {
    await this.ensureStarted();
    if (!this.sessionId) throw new Error("Session not open");
    const client = this.client!;
    return new Promise((resolve, reject) => {
      (client as any).Snapshot({ sessionId: this.sessionId }, (err: any, resp: any) => {
        if (err) return reject(err);
        resolve({ schemaVersion: resp.schemaVersion ?? 1, state: resp.state ?? new Uint8Array() });
      });
    });
  }

  /** Restore a snapshot. */
  async restore(snapshot: { schemaVersion: number; state: Uint8Array }): Promise<void> {
    await this.ensureStarted();
    if (!this.sessionId) throw new Error("Session not open");
    const client = this.client!;
    return new Promise((resolve, reject) => {
      (client as any).Restore(
        { sessionId: this.sessionId, schemaVersion: snapshot.schemaVersion, state: snapshot.state },
        (err: any, _resp: any) => {
          if (err) return reject(err);
          resolve(undefined);
        }
      );
    });
  }

  /** Close the session. */
  async closeSession(): Promise<void> {
    await this.ensureStarted();
    if (!this.sessionId) return;
    const client = this.client!;
    return new Promise((resolve, reject) => {
      (client as any).CloseSession({ sessionId: this.sessionId }, (err: any, _resp: any) => {
        if (err) return reject(err);
        this.sessionId = undefined;
        resolve(undefined);
      });
    });
  }

  /** Stop the adapter / disconnect. */
  async stop(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = undefined;
    }
    if (this.server) {
      stopServerV2(this.server);
      this.server = undefined;
    }
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = undefined;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Struct helpers                                                            */
/* -------------------------------------------------------------------------- */

function toProtoValue(value: unknown): object {
  if (value === null || value === undefined) return { nullValue: 0 };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(toProtoValue) } };
  if (typeof value === "object") return { structValue: toProtoStruct(value as Record<string, unknown>) };
  return { stringValue: String(value) };
}

function toProtoStruct(obj: Record<string, unknown>): object {
  const fields: Record<string, object> = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = toProtoValue(v);
  }
  return { fields };
}
