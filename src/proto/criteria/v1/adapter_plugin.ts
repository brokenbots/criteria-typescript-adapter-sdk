/**
 * Generated proto bindings for criteria/v1/adapter_plugin.proto
 * 
 * This file contains TypeScript interfaces matching the protobuf definitions
 * for the Criteria adapter plugin protocol.
 */

/**
 * ConfigFieldProto - Describes a single field in an adapter's config or input schema.
 */
export interface ConfigFieldProto {
  required: boolean;
  type: string; // "string", "number", "bool", "list_string"
  doc: string;
}

/**
 * AdapterSchemaProto - Holds a named set of config fields for schema validation.
 */
export interface AdapterSchemaProto {
  fields: Record<string, ConfigFieldProto>;
}

/**
 * InfoRequest - Request for adapter metadata.
 */
export interface InfoRequest {}

/**
 * InfoResponse - Adapter metadata.
 */
export interface InfoResponse {
  name: string;
  version: string;
  capabilities: string[];
  configSchema?: AdapterSchemaProto;
  inputSchema?: AdapterSchemaProto;
}

/**
 * OpenSessionRequest - Initialize a new session.
 */
export interface OpenSessionRequest {
  sessionId: string;
  config: Record<string, string>;
}

/**
 * OpenSessionResponse - Empty success response.
 */
export interface OpenSessionResponse {}

/**
 * ExecuteRequest - Request to execute a step.
 */
export interface ExecuteRequest {
  sessionId: string;
  stepName: string;
  config: Record<string, string>;
  allowedOutcomes: string[];
}

/**
 * LogEvent - Log output from adapter.
 */
export interface LogEvent {
  stream: string; // "stdout" or "stderr"
  chunk: Uint8Array;
}

/**
 * AdapterEvent - Adapter-specific structured event (from events.proto).
 * Emitted inside ExecuteEvent.adapter during Execute streaming.
 * `data` corresponds to google.protobuf.Struct (a JSON object).
 */
export interface AdapterEvent {
  step?: string;
  adapter?: string;
  kind: string;
  data?: Record<string, unknown>;
}

/**
 * PermissionRequest - Request for user permission.
 */
export interface PermissionRequest {
  id: string;
  permission: string;
  details: Record<string, string>;
}

/**
 * ExecuteResult - Final execution result.
 */
export interface ExecuteResult {
  outcome: string;
  outputs: Record<string, string>;
}

/**
 * ExecuteEvent - One of several event types streamed during execution.
 */
export interface ExecuteEvent {
  log?: LogEvent;
  adapter?: AdapterEvent;
  permission?: PermissionRequest;
  result?: ExecuteResult;
}

/**
 * PermitRequest - Grant or deny a permission.
 */
export interface PermitRequest {
  sessionId: string;
  permissionId: string;
  allow: boolean;
  reason: string;
}

/**
 * PermitResponse - Empty success response.
 */
export interface PermitResponse {}

/**
 * CloseSessionRequest - Cleanup a session.
 */
export interface CloseSessionRequest {
  sessionId: string;
}

/**
 * CloseSessionResponse - Empty success response.
 */
export interface CloseSessionResponse {}
