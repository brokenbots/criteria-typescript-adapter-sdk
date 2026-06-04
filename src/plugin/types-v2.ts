/**
 * v2 SDK types for Criteria adapter plugins.
 */

import type {
  ConfigFieldProto,
  AdapterSchemaProto,
  InfoResponse,
  OpenSessionRequest,
  OpenSessionResponse,
  ExecuteRequest,
  ExecuteEvent,
  LogEvent,
  PermissionEvent,
  PermissionDecision,
  SnapshotRequest,
  SnapshotResponse,
  RestoreRequest,
  RestoreResponse,
  CloseSessionRequest,
  CloseSessionResponse,
} from '../proto/criteria/v2/adapter_pb.js';

export type {
  ConfigFieldProto,
  AdapterSchemaProto as AdapterSchema,
  InfoResponse,
  OpenSessionRequest,
  OpenSessionResponse,
  ExecuteRequest,
  ExecuteEvent,
  LogEvent,
  PermissionEvent,
  PermissionDecision,
  SnapshotRequest,
  SnapshotResponse,
  RestoreRequest,
  RestoreResponse,
  CloseSessionRequest,
  CloseSessionResponse,
};

/** Config field definition for adapter schemas. */
export interface ConfigField {
  type?: string;
  required?: boolean;
  description?: string;
}

/** Secret declaration for adapter manifest. */
export interface SecretDecl {
  name: string;
  required: boolean;
  description: string;
}

/** Schema definition for config / input / output. */
export interface SchemaDef {
  fields: Record<string, ConfigField>;
}

/** Session key-value store. */
export interface SessionStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

/** Secrets helper. */
export interface SecretsHelper {
  get(name: string): Promise<string | undefined>;
}

/** Outcomes helper. */
export interface OutcomesHelper {
  validate(outcome: string): Promise<{ valid: boolean; error?: string }>;
  finalize(outcome: string, opts?: { reason?: string }): Promise<void>;
}

/** Log helper. */
export interface LogHelper {
  stdout(chunk: string | Uint8Array): Promise<void>;
  stderr(chunk: string | Uint8Array): Promise<void>;
  adapterEvent(kind: string, data?: Record<string, unknown>): Promise<void>;
}

/** Permission request helper. */
export interface PermissionHelper {
  request(req: { tool: string; args?: Record<string, unknown> }): Promise<{
    decision: 'allow' | 'deny';
    reason?: string;
  }>;
}

/** Helpers injected into adapter callbacks. */
export interface Helpers {
  session: SessionStore;
  secrets: SecretsHelper;
  outcomes: OutcomesHelper;
  log: LogHelper;
  permission: PermissionHelper;
}

/** v2 adapter configuration passed to serve(). */
export interface ServeConfig {
  name: string;
  version: string;
  description: string;
  source_url?: string;
  capabilities?: string[];
  platforms?: string[];
  config_schema?: SchemaDef;
  input_schema?: SchemaDef;
  output_schema?: SchemaDef;
  secrets?: (SecretDecl | string)[];
  permissions?: ({ name: string; description?: string } | string)[];

  openSession?(req: OpenSessionRequest, helpers: Helpers): Promise<void>;
  execute(req: ExecuteRequest, helpers: Helpers): Promise<void>;
  snapshot?(sessionId: string, helpers: Helpers): Promise<{ state: Uint8Array; schemaVersion?: number }>;
  restore?(sessionId: string, blob: { state: Uint8Array; schemaVersion?: number }, helpers: Helpers): Promise<void>;
  closeSession?(req: CloseSessionRequest, helpers: Helpers): Promise<void>;
}
