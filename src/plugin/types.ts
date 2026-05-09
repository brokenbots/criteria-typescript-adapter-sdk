/**
 * Core types for Criteria adapter plugins.
 * 
 * This module re-exports the proto types and defines additional
 * TypeScript-friendly interfaces for adapter authors.
 */

import type {
  ConfigFieldProto,
  AdapterSchemaProto,
  InfoResponse,
  OpenSessionRequest,
  OpenSessionResponse,
  ExecuteRequest,
  ExecuteResult,
  PermitRequest,
  PermitResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  ExecuteEvent,
  LogEvent,
  PermissionRequest,
} from '../proto/criteria/v1/adapter_plugin.js';

// Re-export proto types
export type {
  ConfigFieldProto as ConfigField,
  AdapterSchemaProto as AdapterSchema,
  InfoResponse,
  OpenSessionRequest,
  OpenSessionResponse,
  ExecuteRequest,
  ExecuteResult,
  PermitRequest,
  PermitResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  ExecuteEvent,
  LogEvent,
  PermissionRequest,
};

/**
 * Event sender interface for streaming events back to the host.
 * 
 * This interface provides ergonomic methods for sending different event types
 * during the Execute RPC.
 */
export interface EventSender {
  /**
   * Send a log event.
   * @param stream - Either "stdout" or "stderr"
   * @param chunk - Log content (string or Buffer)
   */
  log(stream: 'stdout' | 'stderr', chunk: string | Uint8Array): Promise<void>;
  
  /**
   * Send an adapter-specific structured event.
   * @param kind - Event kind discriminator (e.g. "tool.invocation")
   * @param data - Opaque JSON-serialisable payload (should be an object)
   */
  adapterEvent(kind: string, data?: Record<string, unknown>): Promise<void>;
  
  /**
   * Request permission from the host.
   * @param permission - Permission identifier
   * @param details - Additional context
   * @returns Permission ID for tracking
   */
  permissionRequest(permission: string, details: Record<string, string>): Promise<string>;
  
  /**
   * Send the final result.
   * Must be called exactly once before returning from execute.
   * @param outcome - Outcome name
   * @param outputs - Output values
   */
  result(outcome: string, outputs: Record<string, string>): Promise<void>;
}

/**
 * The main service interface that adapter plugins must implement.
 * 
 * Example implementation:
 * ```typescript
 * class MyAdapter implements AdapterService {
 *   async info(): Promise<InfoResponse> {
 *     return { name: 'my-adapter', version: '1.0.0', capabilities: [] };
 *   }
 *   
 *   async openSession(req: OpenSessionRequest): Promise<OpenSessionResponse> {
 *     // Initialize session state
 *     return {};
 *   }
 *   
 *   async execute(req: ExecuteRequest, sender: EventSender): Promise<void> {
 *     await sender.log('stdout', 'Starting work...');
 *     // ... do work ...
 *     await sender.result('success', { output: 'done' });
 *   }
 *   
 *   async permit(req: PermitRequest): Promise<PermitResponse> {
 *     return {};
 *   }
 *   
 *   async closeSession(req: CloseSessionRequest): Promise<CloseSessionResponse> {
 *     // Cleanup session state
 *     return {};
 *   }
 * }
 * ```
 */
export interface AdapterService {
  /** Return adapter metadata */
  info(): Promise<InfoResponse>;
  
  /** Initialize a new session */
  openSession(req: OpenSessionRequest): Promise<OpenSessionResponse>;
  
  /** 
   * Execute a step.
   * Must call sender.result() exactly once before returning.
   */
  execute(req: ExecuteRequest, sender: EventSender): Promise<void>;
  
  /** Respond to a permission request */
  permit(req: PermitRequest): Promise<PermitResponse>;
  
  /** Cleanup a session */
  closeSession(req: CloseSessionRequest): Promise<CloseSessionResponse>;
}

/**
 * Simplified adapter configuration for the serve function.
 * Allows providing minimal required fields with sensible defaults.
 */
export interface SimpleAdapterConfig {
  /** Adapter name */
  name: string;
  /** Adapter version */
  version: string;
  /** Optional capabilities */
  capabilities?: string[];
  /** Optional config schema */
  configSchema?: AdapterSchemaProto;
  /** Optional input schema */
  inputSchema?: AdapterSchemaProto;
  
  /** Session initialization callback */
  onOpenSession?: (req: OpenSessionRequest) => Promise<void> | void;
  
  /** 
   * Main execution callback.
   * Use sender.log() for output and sender.result() for completion.
   */
  execute: (req: ExecuteRequest, sender: EventSender) => Promise<void>;
  
  /** Permission callback */
  onPermit?: (req: PermitRequest) => Promise<void> | void;
  
  /** Cleanup callback */
  onCloseSession?: (req: CloseSessionRequest) => Promise<void> | void;
}
