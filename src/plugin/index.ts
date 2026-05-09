/**
 * Public API for the Criteria adapter plugin SDK.
 * 
 * This module provides the main entry points for building adapter plugins:
 * - `serveAdapter()` - Start a full AdapterService implementation
 * - `serve()` - Start from a simplified configuration object
 * - `validateHandshake()` - Manual handshake validation
 * 
 * @example
 * ```typescript
 * import { serve } from '@criteria/adapter-sdk';
 * 
 * serve({
 *   name: 'my-adapter',
 *   version: '1.0.0',
 *   async execute(req, sender) {
 *     await sender.log('stdout', 'Hello!');
 *     await sender.result('success', { greeting: 'Hello' });
 *   }
 * });
 * ```
 */

import { startServer } from './server.js';
import { validateAndExitOnFailure } from './handshake.js';
import type { 
  AdapterService, 
  SimpleAdapterConfig, 
  InfoResponse,
  OpenSessionRequest,
  OpenSessionResponse,
  ExecuteRequest,
  PermitRequest,
  PermitResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  EventSender,
} from './types.js';

// Re-export types
export type {
  AdapterService,
  SimpleAdapterConfig,
  EventSender,
  InfoResponse,
  OpenSessionRequest,
  OpenSessionResponse,
  ExecuteRequest,
  PermitRequest,
  PermitResponse,
  CloseSessionRequest,
  CloseSessionResponse,
} from './types.js';

// Re-export proto types
export type {
  ConfigFieldProto as ConfigField,
  AdapterSchemaProto as AdapterSchema,
  AdapterEvent,
  ExecuteResult,
  ExecuteEvent,
  LogEvent,
  PermissionRequest,
} from '../proto/criteria/v1/adapter_plugin.js';

export { 
  validateHandshake, 
  validateAndExitOnFailure,
  isPluginInvocation,
  MAGIC_COOKIE_KEY,
  MAGIC_COOKIE_VALUE,
  PROTOCOL_VERSION,
} from './handshake.js';

export { startServer, stopServer } from './server.js';
export type { ServerOptions } from './server.js';

/**
 * Convert a SimpleAdapterConfig to a full AdapterService implementation.
 * 
 * This adapter fills in default implementations for optional callbacks.
 */
function toAdapterService(config: SimpleAdapterConfig): AdapterService {
  return {
    info: async (): Promise<InfoResponse> => ({
      name: config.name,
      version: config.version,
      capabilities: config.capabilities ?? [],
      configSchema: config.configSchema,
      inputSchema: config.inputSchema,
    }),
    
    openSession: async (req: OpenSessionRequest): Promise<OpenSessionResponse> => {
      if (config.onOpenSession) {
        await config.onOpenSession(req);
      }
      return {};
    },
    
    execute: async (req: ExecuteRequest, sender: EventSender): Promise<void> => {
      await config.execute(req, sender);
      
      // Note: Result sending is the responsibility of the adapter author.
      // The SDK will error if result() is not called before returning.
    },
    
    permit: async (req: PermitRequest): Promise<PermitResponse> => {
      if (config.onPermit) {
        await config.onPermit(req);
      }
      return {};
    },
    
    closeSession: async (req: CloseSessionRequest): Promise<CloseSessionResponse> => {
      if (config.onCloseSession) {
        await config.onCloseSession(req);
      }
      return {};
    },
  };
}

/**
 * Serve a simplified adapter configuration.
 * 
 * This is the easiest way to create an adapter plugin. It validates the
 * handshake, converts the config to a full service, and starts the gRPC server.
 * 
 * @param config - The adapter configuration
 * @example
 * ```typescript
 * serve({
 *   name: 'greeter',
 *   version: '1.0.0',
 *   capabilities: ['stream'],
 *   async execute(req, sender) {
 *     const name = req.config.name || 'world';
 *     await sender.log('stdout', 'Hello, ' + name + '!');
 *     await sender.result('success', { greeting: 'Hello, ' + name });
 *   }
 * });
 * ```
 */
export async function serve(config: SimpleAdapterConfig): Promise<void> {
  // Validate handshake first
  validateAndExitOnFailure();
  
  // Convert and start
  const service = toAdapterService(config);
  const server = await startServer(service);

  // Exit immediately on SIGTERM/SIGINT — go-plugin has a short grace window
  process.once('SIGTERM', () => { server.forceShutdown(); process.exit(0); });
  process.once('SIGINT',  () => { server.forceShutdown(); process.exit(0); });

  // Keep process alive
  await new Promise(() => {});
}

/**
 * Use this when you need more control over the service lifecycle or want
 * to implement custom session management.
 * 
 * @param service - The full adapter service implementation
 * @example
 * ```typescript
 * class MyAdapter implements AdapterService {
 *   async info() { return { name: 'my-adapter', version: '1.0.0', capabilities: [] }; }
 *   // Add openSession, execute, permit, closeSession implementations
 * }
 * 
 * serveAdapter(new MyAdapter());
 * ```
 */
export async function serveAdapter(service: AdapterService): Promise<void> {
  // Validate handshake first
  validateAndExitOnFailure();
  
  // Start server
  const server = await startServer(service);

  // Exit immediately on SIGTERM/SIGINT — go-plugin has a short grace window
  process.once('SIGTERM', () => { server.forceShutdown(); process.exit(0); });
  process.once('SIGINT',  () => { server.forceShutdown(); process.exit(0); });

  // Keep process alive
  await new Promise(() => {});
}
