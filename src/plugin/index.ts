/**
 * Public API for the Criteria adapter plugin SDK (v2).
 *
 * This module provides the main entry points for building adapter plugins:
 * - `serve()` - Start from a v2 configuration object
 * - `validateAndExitOnFailure()` - Manual handshake validation
 */

import { startServerV2, stopServerV2 } from './server-v2.js';
import { validateAndExitOnFailure } from './handshake.js';
import type { ServeConfig, SchemaDef } from './types-v2.js';

export { serveRemote } from './serveRemote.js';
export type {
  ServeRemoteOptions,
  ServeRemoteMTLS,
  ServeRemoteIdentity,
  ServeRemoteReconnect,
} from './serveRemote.js';

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
 * import { serve } from '@brokenbots/criteria-typescript-adapter-sdk';
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
// Map wire/SDK schema type spellings to the host manifest's well-known set
// (string | number | boolean | object | array). The wire also accepts "bool"
// and "list_string"; the manifest validator does not, so normalize here.
const MANIFEST_TYPE_ALIASES: Record<string, string> = {
  bool: 'boolean',
  list_string: 'array',
};

function normalizeSchema(schema?: SchemaDef): { fields: Record<string, unknown> } {
  const fields: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema?.fields ?? {})) {
    const f = field as Record<string, unknown>;
    const type = f.type as string | undefined;
    fields[name] = { ...f, type: type ? (MANIFEST_TYPE_ALIASES[type] ?? type) : type };
  }
  return { fields };
}

/**
 * Build the adapter.yaml manifest document from a ServeConfig, in the schema
 * the Criteria host's manifest parser consumes. Emitted as JSON, which is valid
 * YAML and parses identically.
 */
export function buildManifest(config: ServeConfig): Record<string, unknown> {
  return {
    schema_version: 1,
    name: config.name,
    version: config.version,
    description: config.description ?? '',
    source_url: config.source_url ?? '',
    capabilities: config.capabilities ?? [],
    platforms: (config.platforms ?? []).map((p) => {
      const [os, arch] = p.split('/');
      return { os, arch };
    }),
    sdk_protocol_version: 2,
    config_schema: normalizeSchema(config.config_schema),
    input_schema: normalizeSchema(config.input_schema),
    output_schema: normalizeSchema(config.output_schema),
    secrets: (config.secrets ?? []).map((s) =>
      typeof s === 'string'
        ? { name: s, description: '', required: true }
        : { name: s.name, description: s.description ?? '', required: s.required ?? true }
    ),
    permissions: (config.permissions ?? []).map((p) => (typeof p === 'string' ? p : p.name)),
  };
}

export async function serve(config: ServeConfig): Promise<void> {
  // When invoked with --emit-manifest, write adapter.yaml to stdout and exit.
  // The build pipeline (and `criteria adapter publish`) use this to extract the
  // manifest. Every adapter gets this for free via serve().
  if (process.argv.includes('--emit-manifest')) {
    console.log(JSON.stringify(buildManifest(config), null, 2));
    process.exit(0);
  }

  validateAndExitOnFailure();

  const { server } = await startServerV2(config);

  const shutdown = () => { stopServerV2(server); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  // Keep process alive
  await new Promise(() => {});
}
