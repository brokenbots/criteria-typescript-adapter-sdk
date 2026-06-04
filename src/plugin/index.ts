/**
 * Public API for the Criteria adapter plugin SDK (v2).
 *
 * This module provides the main entry points for building adapter plugins:
 * - `serve()` - Start from a v2 configuration object
 * - `validateAndExitOnFailure()` - Manual handshake validation
 */

import { startServerV2, stopServerV2 } from './server-v2.js';
import { validateAndExitOnFailure } from './handshake.js';
import type { ServeConfig } from './types-v2.js';

// Re-export v2 types
export type {
  ServeConfig,
  Helpers,
  SessionStore,
  SecretsHelper,
  OutcomesHelper,
  LogHelper,
  PermissionHelper,
  SecretDecl,
  SchemaDef,
  ConfigField,
  AdapterSchema,
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
} from './types-v2.js';

export {
  validateHandshake,
  validateAndExitOnFailure,
  isPluginInvocation,
  MAGIC_COOKIE_KEY,
  MAGIC_COOKIE_VALUE,
  PROTOCOL_VERSION,
} from './handshake.js';

export { startServerV2, stopServerV2 };

/**
 * Serve a v2 adapter configuration.
 *
 * Validates the go-plugin handshake, starts the gRPC server, and keeps the
 * process alive.  The adapter defines callbacks (`execute`, `snapshot`, etc.)
 * that receive the v2 `Helpers` surface (`session`, `secrets`, `outcomes`,
 * `log`, `permission`).
 *
 * @example
 * ```typescript
 * import { serve } from '@criteria/adapter-sdk';
 *
 * serve({
 *   name: 'my-adapter',
 *   version: '1.0.0',
 *   description: 'Does useful things',
 *   async execute(req, helpers) {
 *     helpers.log.stdout('Hello!');
 *     helpers.outcomes.finalize('success');
 *   }
 * });
 * ```
 */
export async function serve(config: ServeConfig): Promise<void> {
  validateAndExitOnFailure();

  const { server } = await startServerV2(config, () => process.exit(0));

  process.once('SIGTERM', () => { stopServerV2(server); process.exit(0); });
  process.once('SIGINT',  () => { stopServerV2(server); process.exit(0); });

  // Keep process alive
  await new Promise(() => {});
}
